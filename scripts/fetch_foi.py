#!/usr/bin/env python3
"""
Fetches every translation from library.foi.hr/biblija (FOI Varaždin, "Biblijski
prijevodi") as raw HTML, one page per translation × book × chapter, into
downloads/cache/foi/<tra>/<bid>_<ch>.html.gz (gitignored).

The text is copyrighted ("Copyrights by Point d.o.o.") — the cache is for local
cross-checking (errata) only, not for publishing.

Resumable: pages already in the cache are skipped. Polite: 2 workers with a
pause between requests on a university server.

    python3 scripts/fetch_foi.py            # all translations
    python3 scripts/fetch_foi.py 74 75 76   # selected ones
"""
import gzip
import json
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT, "downloads", "cache", "foi")
BASE = "https://library.foi.hr/biblija/index.php?type=biblija"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
PAUSE = 0.4
WORKERS = 2

# Croatian first, then the original languages and the rest.
TRANSLATIONS = {
    "74": "Biblija KS (Duda - Fućak)",
    "75": "Biblija (Šarić)",
    "76": "Biblija (Katančić)",
    "14": "Duda - Fućak (NZ)",
    "11": "Novi zavjet (Rupčić)",
    "32": "Novi zavjet (Šarić)",
    "34": "Novi zavjet (Katančić)",
    "37": "Novi zavjet (Raspudić)",
    "35": "Novi zavjet (Gusić)",
    "72": "Biblia Sacra Vulgata",
    "73": "Berean Standard Bible (BSB)",
    "5": "Biblia Hebraica Stuttgartensia (BHS)",
    "7": "Septuaginta (LXX)",
    "8": "Greek New Testament (GNT)",
    "71": "Greek Bible (LXX + GNT)",
}


def url(tra: str, bid: str, ch: str) -> str:
    return f"{BASE}&bid={bid}&ch={ch}&tra1={tra}&tra2=999&tra3=999"


def fetch(u: str, retries: int = 5) -> str:
    for attempt in range(retries):
        try:
            req = urllib.request.Request(u, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(3.0 * (attempt + 1))


def page_path(tra: str, bid: str, ch: str) -> str:
    return os.path.join(CACHE_DIR, tra, f"{bid}_{ch}.html.gz")


def save(path: str, html: str):
    tmp = path + ".tmp"
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        f.write(html)
    os.replace(tmp, path)


def load(path: str) -> str:
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return f.read()


def get_page(tra: str, bid: str, ch: str) -> str:
    path = page_path(tra, bid, ch)
    if os.path.exists(path):
        return load(path)
    html = fetch(url(tra, bid, ch))
    save(path, html)
    time.sleep(PAUSE)
    return html


def parse_books(html: str):
    sel = re.search(r'<SELECT id="bid".*?</SELECT>', html, re.S | re.I)
    return re.findall(r'value="([^"]+)"[^>]*>\s*([^<]+?)\s*<', sel.group(0)) if sel else []


def parse_chapters(html: str, tra: str, bid: str):
    chs = re.findall(rf"type=biblija&bid={re.escape(bid)}&ch=(\d+)&tid=&zid=&tra1={tra}&", html)
    return sorted(set(chs))


def fetch_translation(tra: str):
    os.makedirs(os.path.join(CACHE_DIR, tra), exist_ok=True)
    manifest_path = os.path.join(CACHE_DIR, tra, "manifest.json")

    # The default page of a translation lists its books; its first chapter page lists the chapters.
    books = parse_books(fetch(f"{BASE}&tra1={tra}&tra2=999&tra3=999"))
    if not books:
        raise RuntimeError(f"tra={tra}: no books found")

    manifest = {"tra": tra, "name": TRANSLATIONS.get(tra, ""), "books": []}
    for bid, title in books:
        first = get_page(tra, bid, "0001")
        chapters = parse_chapters(first, tra, bid) or ["0001"]
        manifest["books"].append({"bid": bid, "title": title, "chapters": chapters})

    todo = [(b["bid"], ch) for b in manifest["books"] for ch in b["chapters"]
            if not os.path.exists(page_path(tra, b["bid"], ch))]
    total = sum(len(b["chapters"]) for b in manifest["books"])
    print(f"tra={tra} {manifest['name']}: {len(books)} knjiga, {total} poglavlja, preostalo {len(todo)}", flush=True)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        list(pool.map(lambda job: get_page(tra, *job), todo))

    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    print(f"tra={tra} gotovo", flush=True)


def main():
    selected = sys.argv[1:] or list(TRANSLATIONS)
    t0 = time.time()
    for tra in selected:
        fetch_translation(tra)
    print(f"SVE GOTOVO za {time.time() - t0:.0f} s", flush=True)


if __name__ == "__main__":
    main()
