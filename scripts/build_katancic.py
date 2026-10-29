#!/usr/bin/env python3
"""
Builds the Katančić (1831) translation for the web reader from the FOI cache
(scripts/fetch_foi.py 74 76 && scripts/parse_foi.py 74 76) into
data/json/katancic/<NN>_<id>.json, one file per book, keyed like our books.json.

FOI book codes map to our `order` through FOI's own KS (74): its 73 books are in
the same order as ours. Katančić has 67 of them (1–2 Sam, 1–2 Kr, 1–2 Ljet are
missing on FOI), with Psalms already in Hebrew numbering like ours. Chapter and
verse numbers are kept as FOI has them, with two exceptions FOI left half-done
(see remap_chapter): the Vulgate psalm splits and merges from 114 on, and the
Sirach prologue, which FOI puts in front of chapter 1 with its own 1–11. Jl, Mal
and Est follow the Vulgate division, so the reader aligns by number and shows
what is there.

    python3 scripts/build_katancic.py
"""
import json
import os
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FOI_DIR = os.path.join(ROOT, "downloads", "cache", "foi")
OUT_DIR = os.path.join(ROOT, "data", "json", "katancic")

SOURCE = {
    "name": "Katančić",
    "title": "Sveto pismo (Matija Petar Katančić, Budim 1831.)",
    "via": "library.foi.hr/biblija (prijevod 76)",
}


def load(tra: str):
    path = os.path.join(FOI_DIR, f"{tra}.json")
    if not os.path.exists(path):
        sys.exit(f"Nema {path} — pokreni scripts/fetch_foi.py {tra} i scripts/parse_foi.py {tra}")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# FOI renumbered the Vulgate psalms to Hebrew numbers only up to 113. From there:
# 114 holds Hebr. 114 and 115 (verse numbers restart), 115–116 are the two halves
# of Hebr. 116, 147–148 the two halves of Hebr. 147, and 149–151 are Hebr. 148–150.
PSALM_REMAP = {(114, 1): 115, (115, 0): 116, (148, 0): 147, (149, 0): 148, (150, 0): 149, (151, 0): 150}


# Vulgate chapter divisions that differ from the Hebrew ones KS follows:
# (FOI book, Vulgate chapter, first verse, last verse) -> (our chapter, verse offset).
VERSE_REMAP = [
    ("002", 8, 1, 4, 7, 25), ("002", 8, 5, 32, 8, -4),        # Izl 7,26–29
    ("003", 6, 1, 7, 5, 19), ("003", 6, 8, 30, 6, -7),        # Lev 5,20–26
    ("004", 16, 36, 50, 17, -35), ("004", 17, 1, 13, 17, 15), # Br 17,1–15
    ("016", 4, 1, 6, 3, 32), ("016", 4, 7, 23, 4, -6),        # Neh 3,33–38
    ("026", 20, 45, 49, 21, -44), ("026", 21, 1, 32, 21, 5),  # Ez 21,1–5
    ("038", 1, 18, 21, 2, -17), ("038", 2, 1, 13, 2, 4),      # Zah 2,1–4
    ("029", 2, 28, 32, 3, -27), ("029", 3, 1, 21, 4, 0),      # Jl 3 i 4
    ("039", 4, 1, 6, 3, 18),                                  # Mal 3,19–24
]

# Katančić translates the Vulgate, whose Tobit, Judith, Esther (with the additions as
# chapters 10–16) and Sirach are a different text, not just a different numbering.
VULGATE_TEXT_NOTE = {
    "016a": "Tobija", "016b": "Judita", "017": "Estera", "022b": "Sirah",
}


def remap(bid: str, ch: int, v: int, run: int):
    """`run` counts restarts of verse numbering inside one FOI chapter page."""
    if bid == "019":
        return PSALM_REMAP.get((ch, run), ch), v
    if bid == "022b" and ch == 1 and run == 0:
        return 0, v  # Proslov, like our Sir 0
    for b, c, first, last, new_ch, offset in VERSE_REMAP:
        if b == bid and c == ch and first <= v <= last:
            return new_ch, v + offset
    return ch, v


def main():
    books = json.load(open(os.path.join(ROOT, "data", "json", "books.json"), encoding="utf-8"))
    ks = load("74")
    if len(ks["books"]) != len(books):
        sys.exit(f"FOI KS ima {len(ks['books'])} knjiga, očekivano {len(books)}")
    order_by_bid = {b["bid"]: books[i]["order"] for i, b in enumerate(ks["books"])}
    meta_by_order = {b["order"]: b for b in books}

    vulgate_text = {order_by_bid[b]: name for b, name in VULGATE_TEXT_NOTE.items()}

    kat = load("76")
    chapters = defaultdict(lambda: defaultdict(list))
    prev, run = None, 0
    for v in kat["verses"]:
        key = (v["bid"], v["ch"])
        if prev and prev[0] == key and v["v"] <= prev[1]:
            run += 1
        elif not prev or prev[0] != key:
            run = 0
        prev = (key, v["v"])
        ch, num = remap(v["bid"], v["ch"], v["v"], run)
        chapters[order_by_bid[v["bid"]]][ch].append([num, v["text"]])

    os.makedirs(OUT_DIR, exist_ok=True)
    for f in os.listdir(OUT_DIR):
        if f.endswith(".json"):
            os.remove(os.path.join(OUT_DIR, f))

    available, total = [], 0
    for order in sorted(chapters):
        meta = meta_by_order[order]
        chs = {str(ch): vs for ch, vs in sorted(chapters[order].items())}
        payload = {"order": order, "id": meta["id"], **SOURCE, "chapters": chs}
        if order in vulgate_text:
            payload["note"] = (f"Katančić prevodi Vulgatu, čija je knjiga {vulgate_text[order]} drugi tekst, "
                               "ne samo druga numeracija; retci se poravnavaju samo po broju.")
        name = f"{order:02d}_{meta['id']}.json"
        with open(os.path.join(OUT_DIR, name), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        available.append(order)
        total += sum(len(vs) for vs in chs.values())

    with open(os.path.join(OUT_DIR, "index.json"), "w", encoding="utf-8") as f:
        json.dump({**SOURCE, "books": available}, f, ensure_ascii=False, separators=(",", ":"))

    missing = [meta_by_order[o]["abbr"] for o in meta_by_order if o not in chapters]
    print(f"Katančić: {len(available)} knjiga, {total} redaka; nema: {', '.join(missing)}")


if __name__ == "__main__":
    main()
