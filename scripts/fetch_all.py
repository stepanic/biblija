#!/usr/bin/env python3
"""
Fetches all canonical Bible data from biblija.ks.hr REST API with deterministic
ordering (orderby=id&order=asc) into downloads/cache/ (gitignored).
"""
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "downloads", "cache")
os.makedirs(CACHE_DIR, exist_ok=True)

HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}


def fetch_json(url: str, retries: int = 4):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8")), dict(resp.headers)
        except Exception as e:
            if attempt == retries - 1:
                raise
            time.sleep(1.0 * (attempt + 1))


def fetch_all_verses():
    out_path = os.path.join(CACHE_DIR, "raw_verses.json")
    if os.path.exists(out_path):
        with open(out_path, "r", encoding="utf-8") as f:
            existing = json.load(f)
        if len(existing) >= 35390:
            print(f"[cache] Using existing {out_path} ({len(existing)} verses)")
            return existing

    first_url = "https://biblija.ks.hr/wp-json/wp/v2/bible_verse?_fields=id,verse_book_id,verse_chapter_id,verse_number,title,content&per_page=100&orderby=id&order=asc&page=1"
    first_data, headers = fetch_json(first_url)
    total_pages = int(headers.get("X-WP-TotalPages") or headers.get("x-wp-totalpages") or 354)
    total_items = int(headers.get("X-WP-Total") or headers.get("x-wp-total") or 35394)
    print(f"Fetching {total_items} verses across {total_pages} pages...")

    pages_data = {1: first_data}
    t0 = time.time()

    def get_page(p: int):
        u = f"https://biblija.ks.hr/wp-json/wp/v2/bible_verse?_fields=id,verse_book_id,verse_chapter_id,verse_number,title,content&per_page=100&orderby=id&order=asc&page={p}"
        data, _ = fetch_json(u)
        return p, data

    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = [pool.submit(get_page, p) for p in range(2, total_pages + 1)]
        done_count = 1
        for fut in as_completed(futures):
            p, data = fut.result()
            pages_data[p] = data
            done_count += 1
            if done_count % 50 == 0 or done_count == total_pages:
                print(f"  Progress: {done_count}/{total_pages} pages ({time.time() - t0:.1f}s)")

    all_verses = []
    seen_ids = set()
    for p in range(1, total_pages + 1):
        for v in pages_data.get(p, []):
            vid = v["id"]
            if vid not in seen_ids:
                seen_ids.add(vid)
                all_verses.append(v)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(all_verses, f, ensure_ascii=False)
    print(f"Saved {len(all_verses)} unique verses to {out_path} in {time.time() - t0:.1f}s")
    return all_verses


def fetch_all_plans():
    out_path = os.path.join(CACHE_DIR, "raw_ks_plans.json")
    plans, _ = fetch_json("https://biblija.ks.hr/wp-json/kk/v1/reading-plans")
    for p in plans:
        pid = p["id"]
        days_data, _ = fetch_json(f"https://biblija.ks.hr/wp-json/kk/v1/reading-plans/{pid}/days")
        p["days_detail"] = days_data.get("days", [])
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(plans, f, indent=2, ensure_ascii=False)
    print(f"Saved {len(plans)} KS reading plans to {out_path}")


if __name__ == "__main__":
    fetch_all_verses()
    fetch_all_plans()
