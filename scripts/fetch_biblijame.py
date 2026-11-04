#!/usr/bin/env python3
"""
Dohvaća cijeli tekst s biblija.me (JSON API, /api/biblija/knjiga/<oznaka>/glava/<n>)
u downloads/cache/biblijame/<oznaka>_<glava>.json (gitignored).

Popis knjiga (oznaka, ks-knjiga = naš `order`, brojGlava) izvučen je iz njihova
main.js u scripts/biblijame_books.json. Tekst je pod autorskim pravom: cache je
samo za lokalnu usporedbu s KS-online i nalazima audita, ne za objavu.

Nastavlja gdje je stao; 2 radnika s pauzom.

    python3 scripts/fetch_biblijame.py
"""
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT, "downloads", "cache", "biblijame")
BOOKS = os.path.join(ROOT, "scripts", "biblijame_books.json")
API = "https://biblija.me/api/biblija/knjiga/{}/glava/{}"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "Accept": "application/json"}
PAUSE = 0.3
WORKERS = 2


def fetch(job):
    oz, ch = job
    path = os.path.join(CACHE_DIR, f"{oz}_{ch}.json")
    if os.path.exists(path):
        return 0
    for attempt in range(4):
        try:
            req = urllib.request.Request(API.format(oz, ch), headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read().decode("utf-8"))
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp, path)
            time.sleep(PAUSE)
            return 1
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                print(f"GREŠKA {oz} {ch}: {e}", file=sys.stderr)
                return -1
            time.sleep(3.0 * (attempt + 1))


def main():
    os.makedirs(CACHE_DIR, exist_ok=True)
    books = json.load(open(BOOKS, encoding="utf-8"))
    jobs = [(b["oznaka"], ch) for b in books for ch in range(1, b["brojGlava"] + 1)]
    with ThreadPoolExecutor(WORKERS) as ex:
        res = list(ex.map(fetch, jobs))
    print(f"gotovo: {len(jobs)} poglavlja, novih {res.count(1)}, grešaka {res.count(-1)}")


if __name__ == "__main__":
    main()
