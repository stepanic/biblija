#!/usr/bin/env python3
"""
Fetches the Berean interlinear (BSB tables, CC0) and writes it per book to
downloads/bsb/interlinear/<NN>_<id>.json (gitignored, ~754.000 words).

This is the same interlinear that library.foi.hr shows on its verse pages
(type=bibdet): source word, transliteration, morphology, Strong's number and the
BSB English gloss. Taking it from Berean is one 55 MB download instead of ~31.000
requests to FOI, and the data is public domain.

Verse numbers are BSB's (English versification: Psalm titles are not verse 1,
Jl 2,28–32, Mal 4 …), not KS's. Words are in BSB (English) order; `o` is the
position in the Hebrew/Greek word order.

Each verse: [chapter, verse, [[o, text, translit, morph, strong, gloss], ...]]
with strong as "H7225" / "G976".

    python3 scripts/fetch_bsb_interlinear.py            # download (if missing) and parse
    python3 scripts/fetch_bsb_interlinear.py --refresh  # download again
"""
import json
import os
import sys
import urllib.request

import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BSB_DIR = os.path.join(ROOT, "downloads", "bsb")
XLSX = os.path.join(BSB_DIR, "bsb_tables.xlsx")
OUT_DIR = os.path.join(BSB_DIR, "interlinear")
URL = "https://bereanbible.com/bsb_tables.xlsx"
SHEET = "biblosinterlinear96"

# Columns of the interlinear sheet (0-based).
HEB_SORT, GRK_SORT, LANG, TEXT, TRANSLIT, MORPH, STR_HEB, STR_GRK, VERSE_ID, GLOSS = 0, 1, 4, 5, 7, 8, 10, 11, 12, 18


def download():
    os.makedirs(BSB_DIR, exist_ok=True)
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(XLSX + ".tmp", "wb") as f:
        f.write(resp.read())
    os.replace(XLSX + ".tmp", XLSX)


def clean(s) -> str:
    return " ".join(str(s).split()) if s is not None else ""


def main():
    if "--refresh" in sys.argv or not os.path.exists(XLSX):
        download()

    books = json.load(open(os.path.join(ROOT, "data", "json", "books.json"), encoding="utf-8"))
    by_name = {b["name_en"]: b for b in books}
    by_name["Song of Solomon"] = by_name["Song of Songs"]
    by_name["Psalm"] = by_name["Psalms"]

    ws = openpyxl.load_workbook(XLSX, read_only=True)[SHEET]
    out = {}  # order -> list of verses
    verse = None
    words = 0
    for r in ws.iter_rows(min_row=2, values_only=True):
        if r[VERSE_ID]:
            name, ref = str(r[VERSE_ID]).rsplit(" ", 1)
            ch, v = (int(x) for x in ref.split(":"))
            book = by_name[name]
            verse = [ch, v, []]
            out.setdefault(book["order"], []).append(verse)
        if verse is None or not r[TEXT]:
            continue
        hebrew = r[LANG] == "Hebrew" or r[LANG] == "Aramaic"
        strong = r[STR_HEB] if hebrew else r[STR_GRK]
        verse[2].append([
            r[HEB_SORT] if hebrew else r[GRK_SORT],
            clean(r[TEXT]),
            clean(r[TRANSLIT]),
            clean(r[MORPH]),
            f"{'H' if hebrew else 'G'}{strong}" if strong else "",
            clean(r[GLOSS]),
        ])
        words += 1

    os.makedirs(OUT_DIR, exist_ok=True)
    meta = {b["order"]: b for b in books}
    for order, verses in sorted(out.items()):
        with open(os.path.join(OUT_DIR, f"{order:02d}_{meta[order]['id']}.json"), "w", encoding="utf-8") as f:
            json.dump({"order": order, "id": meta[order]["id"], "source": URL, "license": "CC0",
                       "versification": "BSB", "verses": verses}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"BSB interlinear: {len(out)} knjiga, {sum(len(v) for v in out.values())} redaka, {words} riječi")


if __name__ == "__main__":
    main()
