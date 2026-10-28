#!/usr/bin/env python3
"""
Parses the raw pages cached by scripts/fetch_foi.py into one JSON file per
translation: downloads/cache/foi/<tra>.json (gitignored, copyrighted text).

Each verse: {"bid", "ch", "v", "text", "lines"}. The site does not mark
headings separately — a heading is just one more <br>-separated line inside the
verse, so "lines" keeps the raw split and "text" joins it with spaces.

    python3 scripts/parse_foi.py            # every fetched translation
    python3 scripts/parse_foi.py 74 75
"""
import gzip
import html as htmlmod
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT, "downloads", "cache", "foi")

VERSE_RE = re.compile(
    r"type=bibdet&bid=(?P<bid>[^&]+)&ch=(?P<ch>\d+)&rch=(?P<v>\d+)&[^>]*>[^<]*</a>"
    r".*?bor-top bor-right\"[^>]*>(?P<body>.*?)</div>",
    re.S,
)


def clean_line(s: str) -> str:
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\s+", " ", htmlmod.unescape(s)).strip()


def parse_page(page: str):
    verses = []
    for m in VERSE_RE.finditer(page):
        lines = [l for l in (clean_line(p) for p in re.split(r"<br\s*/?>", m.group("body"), flags=re.I)) if l]
        verses.append({
            "bid": m.group("bid"),
            "ch": int(m.group("ch")),
            "v": int(m.group("v")),
            "text": " ".join(lines),
            "lines": lines,
        })
    return verses


def parse_translation(tra: str):
    with open(os.path.join(CACHE_DIR, tra, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    out, empty = [], []
    for book in manifest["books"]:
        for ch in book["chapters"]:
            with gzip.open(os.path.join(CACHE_DIR, tra, f"{book['bid']}_{ch}.html.gz"), "rt", encoding="utf-8") as f:
                verses = parse_page(f.read())
            if not verses:
                empty.append(f"{book['bid']}_{ch}")
            out.extend(verses)
    manifest["verses"] = out
    with open(os.path.join(CACHE_DIR, f"{tra}.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False)
    print(f"tra={tra} {manifest['name']}: {len(manifest['books'])} knjiga, {len(out)} redaka"
          + (f", prazna poglavlja: {empty}" if empty else ""))


def main():
    selected = sys.argv[1:] or sorted(
        d for d in os.listdir(CACHE_DIR) if os.path.exists(os.path.join(CACHE_DIR, d, "manifest.json"))
    )
    for tra in selected:
        parse_translation(tra)


if __name__ == "__main__":
    main()
