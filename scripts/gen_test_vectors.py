#!/usr/bin/env python3
"""
Generira shared/test-vectors/fold_hr.json, fts_query.json i bible_reference.json.

Izvor istine je fold_hr iz build_catalog_and_db.py, jer su njime foldani `verses.text_folded`
i FTS indeks. Swift i Kotlin port moraju dati isti izlaz za svaki vektor.
lww_merge.json se piše ručno (scenariji), a provjerava ga shared/tests/contract.test.mjs
protiv pravog src/worker.ts.
"""

import json
import os
import re
import sqlite3
import sys
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from build_catalog_and_db import fold_hr  # noqa: E402

OUT_DIR = os.path.join(ROOT, "shared", "test-vectors")

FOLD_INPUTS = [
    "",
    "Biblija",
    "ČĆŽŠĐ čćžšđ",
    "Đakovo",
    "đavao",
    "Duh Božji",
    "Gospodin je pastir moj",
    "Ljubav je strpljiva, dobrostiva je ljubav",
    "Isus Krist",
    "Knjiga Sirahova",
    "Matej 5,3-12",
    "»Blago siromasima duhom« (Mt 5,3)",
    "Prva poslanica Korinćanima",
    "Ps 23",
    "Ezekiel",
    "Žalosnica",
    "Pjesma nad pjesmama",
    "Djela apostolska",
    "Ćaćа",  # latinično 'Ćać' + ćirilično 'а' (ne smije se foldati u 'a')
    "Mojsije — Izlazak",
    "café",  # e + kombinirajući akut (NFD unos)
    "café",  # precomposed é
    "Ñandú Über Ångström",
    "ÆØ œ ß",
    "ﬁ ﬂ",  # ligature: NFKD ih rastavlja, NFD ne
    "x²",  # superscript: NFKD → 2
    "  razmaci   ostaju  ",
    "ĐAVO",  # Đ preko escapea
    "İstanbul",
]

FTS_INPUTS = [
    "ljubav",
    "Duh Božji",
    '"u početku"',
    '"ljubav"',
    "Đavao",
    "  pastir   moj ",
    "Mt 5,3",
    "!!!",
    "",
    "riječ, tijelom",
    "Isus-Krist",
    'neparni "navodnik',
    "a_b c",
]

# Isti regex kao parseBibleReference u public/astro-client.js
REF_RE = re.compile(r"^([1-3]?\s*[a-zA-ZčćžšđČĆŽŠĐ.]+)\s+(\d+)(?:\s*[,:]\s*(\d+)(?:\s*[-–]\s*(\d+))?)?$")

REF_INPUTS = [
    "Iv 3,16",
    "iv 3:16",
    "Post 1",
    "Ps 23",
    "Mt 5,3-12",
    "1 Kor 13",
    "1Kor 13,4",
    "Otk 22,21",
    "Sir 1",
    "Ivan 1",
    "Knjiga Postanka 2",
    "Mudre izreke 3",
    "Post 51",
    "Xyz 1",
    "ljubav",
    "Iv",
    "Mk. 1,1",
    "Dj 2,1–4",
    "Est 0",
]


def fold_nfd(s):
    """Varijanta iz src/worker.ts i public/astro-client.js (NFD umjesto NFKD)."""
    m = {"č": "c", "ć": "c", "ž": "z", "š": "s", "đ": "d", "Č": "c", "Ć": "c", "Ž": "z", "Š": "s", "Đ": "d"}
    s = "".join(m.get(c, c) for c in s)
    s = unicodedata.normalize("NFD", s)
    return "".join(c for c in s if not ("̀" <= c <= "ͯ")).lower()


def fts_expression(q):
    """Isto kao /api/search u server.py; None znači 'nema upita'."""
    q = q.strip()
    folded = fold_hr(q)
    tokens = [t for t in re.findall(r"[\w]+", folded) if t]
    if not tokens:
        return None
    if q.startswith('"') and q.endswith('"') and len(tokens) > 1:
        return '"' + " ".join(tokens) + '"'
    return " AND ".join(f'"{t}"*' for t in tokens)


def parse_reference(raw, books):
    m = REF_RE.match(raw.strip())
    if not m:
        return None
    token = fold_hr(m.group(1).replace(".", "").strip())
    ch = int(m.group(2))
    verse = int(m.group(3)) if m.group(3) else None
    for b in books:
        if fold_hr(b["abbr"]) == token or fold_hr(b["title"]) == token or fold_hr(b["title"]).startswith(token):
            if ch < 0 or ch > b["chapter_count"]:
                return None
            return {"book_order": b["book_order"], "book_abbr": b["abbr"], "chapter": ch, "verse": verse}
    return None


def write(name, payload):
    path = os.path.join(OUT_DIR, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"  → {os.path.relpath(path, ROOT)} ({len(payload['cases'])} slučajeva)")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    fold_cases = []
    for s in FOLD_INPUTS:
        expected = fold_hr(s)
        case = {"input": s, "expected": expected}
        if fold_nfd(s) != expected:
            # Web klijent i worker koriste NFD; za upite nad indeksom vrijedi NFKD.
            case["nfkd_only"] = True
        fold_cases.append(case)
    write(
        "fold_hr.json",
        {
            "description": "fold_hr: č/ć→c, ž→z, š→s, đ→d, zatim NFKD, uklanjanje kombinirajućih znakova (combining class ≠ 0), lower(). Slučajevi s nfkd_only=true razlikuju se od NFD varijante u src/worker.ts.",
            "cases": fold_cases,
        },
    )

    write(
        "fts_query.json",
        {
            "description": "Korisnički upit → FTS5 MATCH izraz nad verses_fts. Tokeni su nizovi [\\w]+ (Unicode slova, znamenke, _) nakon fold_hr. Upit u navodnicima s više tokena je fraza; inače AND prefiks-upit. expected=null znači da se upit ne šalje.",
            "cases": [{"input": q, "expected": fts_expression(q)} for q in FTS_INPUTS],
        },
    )

    conn = sqlite3.connect(os.path.join(ROOT, "data", "biblija.db"))
    conn.row_factory = sqlite3.Row
    books = [dict(r) for r in conn.execute("SELECT book_order, abbr, title, chapter_count FROM books ORDER BY book_order")]
    write(
        "bible_reference.json",
        {
            "description": "Prepoznavanje biblijske kratice u tražilici (parseBibleReference iz public/astro-client.js). Prva knjiga po book_order čiji fold(abbr)==token, fold(title)==token ili fold(title) počinje tokenom. expected=null kad nije referenca.",
            "cases": [{"input": r, "expected": parse_reference(r, books)} for r in REF_INPUTS],
        },
    )


if __name__ == "__main__":
    main()
