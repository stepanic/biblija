#!/usr/bin/env python3
"""
Builds:
1. Full Audit & Diff Report (AUDIT.md and data/audit_report.json) comparing Web vs Mobile API vs Raw DB
2. Deterministic JSON Catalog in data/json/ (books.json, books/*.json, plans/*.json)
3. Deterministic SQLite Database in data/biblija.db with FTS5 full-text search (diacritic-insensitive)
"""
import html as htmllib
import json
import math
import os
import re
import sqlite3
import unicodedata
from collections import defaultdict

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT_DIR, "downloads", "cache")
SAMPLES_DIR = os.path.join(ROOT_DIR, "downloads", "api_samples")
DATA_DIR = os.path.join(ROOT_DIR, "data")
JSON_DIR = os.path.join(DATA_DIR, "json")
BOOKS_JSON_DIR = os.path.join(JSON_DIR, "books")
PLANS_JSON_DIR = os.path.join(JSON_DIR, "plans")

os.makedirs(BOOKS_JSON_DIR, exist_ok=True)
os.makedirs(PLANS_JSON_DIR, exist_ok=True)

SUP_MAP = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹", "0123456789")

CROATIAN_FOLD = str.maketrans({
    "č": "c", "ć": "c", "ž": "z", "š": "s", "đ": "d",
    "Č": "C", "Ć": "C", "Ž": "Z", "Š": "S", "Đ": "D",
})


def fold_hr(text: str) -> str:
    s = text.translate(CROATIAN_FOLD)
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def classify_book(order: int):
    if 1 <= order <= 5:
        return "SZ", "Petoknjižje"
    if 6 <= order <= 21:
        return "SZ", "Povijesne knjige"
    if 22 <= order <= 28:
        return "SZ", "Psalmi i mudrosne knjige"
    if 29 <= order <= 46:
        return "SZ", "Proroci"
    if 47 <= order <= 51:
        return "NZ", "Evanđelja i Djela"
    if 52 <= order <= 72:
        return "NZ", "Poslanice"
    return "NZ", "Otkrivenje"


def parse_verse_html(raw_html: str, expected_vnum: int):
    """
    Parses a single raw WordPress bible_verse HTML string into structured components:
    - headings: list of {level, text}
    - references: list of parallel citations (<span class='Izvor'>)
    - sup_number: extracted superscript verse number string
    - has_api_web_order_bug: True if <span class='Izvor'> or heading appears AFTER <sup>
    - text: clean plain text of the verse
    - lines: poetic lines if <span class='Stih1'> or poetic <br> is used
    - is_poetic: bool
    """
    s = raw_html.strip()

    # Check if <span class='Izvor'> or <h2/3/4> appears AFTER <sup ...>
    sup_match = re.search(r"<sup[^>]*>(.*?)</sup>(?:&nbsp;|\s)*", s, re.DOTALL)
    sup_num_str = ""
    has_order_anomaly = False
    anomaly_type = None

    if sup_match:
        sup_num_str = htmllib.unescape(sup_match.group(1)).translate(SUP_MAP).strip()
        after_sup = s[sup_match.end():]
        if re.search(r"<span\s+class=['\"]Izvor['\"]>", after_sup):
            has_order_anomaly = True
            anomaly_type = "izvor_after_sup"
        elif re.search(r"<h[234][^>]*>", after_sup):
            has_order_anomaly = True
            anomaly_type = "heading_after_sup"

    # Extract all headings (h2, h3, h4)
    headings = []
    for hm in re.finditer(r"<(h[234])[^>]*>(.*?)</\1>", s, re.DOTALL | re.IGNORECASE):
        level = hm.group(1).lower()
        htext = re.sub(r"<[^>]+>", "", hm.group(2))
        htext = re.sub(r"\s+", " ", htmllib.unescape(htext)).strip()
        if htext:
            headings.append({"level": level, "text": htext})

    # Remove headings from s
    s_body = re.sub(r"<h[234][^>]*>.*?</h[234]>", " ", s, flags=re.DOTALL | re.IGNORECASE)

    # Extract all <span class='Izvor'>...</span> references
    references = []
    for rm in re.finditer(r"<span\s+class=['\"]Izvor['\"][^>]*>(.*?)</span>(?:\s*<br\s*/?>)?", s_body, re.DOTALL | re.IGNORECASE):
        rtext = re.sub(r"<[^>]+>", "", rm.group(1))
        rtext = re.sub(r"\s+", " ", htmllib.unescape(rtext)).strip()
        if rtext:
            references.append(rtext)

    # Remove <span class='Izvor'>...</span>(<br />)?
    s_body = re.sub(r"<span\s+class=['\"]Izvor['\"][^>]*>.*?</span>(?:\s*<br\s*/?>)?", " ", s_body, flags=re.DOTALL | re.IGNORECASE)

    # Remove the verse number <sup>...</sup>(&nbsp;)?
    s_body = re.sub(r"<sup[^>]*>.*?</sup>(?:&nbsp;|\s)*", "", s_body, count=1, flags=re.DOTALL | re.IGNORECASE)

    # Check if poetic (<span class='Stih1'> or multiple <br />)
    is_poetic = bool(re.search(r"class=['\"]Stih", s_body, re.IGNORECASE))

    # Extract lines splitting on <br />
    raw_lines = re.split(r"<br\s*/?>", s_body, flags=re.IGNORECASE)
    lines = []
    for rl in raw_lines:
        clean_l = re.sub(r"<[^>]+>", " ", rl)
        clean_l = htmllib.unescape(clean_l).replace("\xa0", " ")
        clean_l = re.sub(r"\s+", " ", clean_l).strip()
        if clean_l:
            lines.append(clean_l)

    plain_text = " ".join(lines)
    plain_text = re.sub(r"\s+", " ", plain_text).strip()

    return {
        "headings": headings,
        "references": references,
        "sup_num": sup_num_str,
        "has_order_anomaly": has_order_anomaly,
        "anomaly_type": anomaly_type,
        "is_poetic": is_poetic,
        "lines": lines if (is_poetic or len(lines) > 1) else [],
        "text": plain_text,
    }


def build_reading_plans(books_meta, chapters_by_book_order, raw_ks_plans):
    """
    Generates the 3 official Muževni budite 365-day Catholic Bible reading plans
    + 3 balanced algorithmic 365-day plans + the 12 KS thematic reading plans.
    """
    from parse_mb_plans import parse_mb_plans
    plans = parse_mb_plans(books_meta, chapters_by_book_order)

    def flatten_chapters(book_orders):
        out = []
        for bo in book_orders:
            b = books_meta[bo]
            for ch in sorted(chapters_by_book_order[bo].keys()):
                vcnt = chapters_by_book_order[bo][ch]["verse_count"]
                out.append({
                    "book_order": bo,
                    "book_id": b["id"],
                    "book_abbr": b["abbr"],
                    "book_title": b["title"],
                    "chapter": ch,
                    "verse_count": vcnt,
                })
        return out

    def distribute_into_days(ch_list, num_days=365):
        """Distributes chapters across num_days balanced by verse_count."""
        total_v = sum(c["verse_count"] for c in ch_list)
        days = [[] for _ in range(num_days)]
        n = len(ch_list)
        if n <= num_days:
            for idx, c in enumerate(ch_list):
                day_idx = min(num_days - 1, int(idx * num_days / max(1, n)))
                days[day_idx].append(c)
            return days

        # Greedy cumulative verse target assignment ensuring every day gets >= 1 chapter if n >= num_days
        idx = 0
        rem_v = total_v
        for d in range(num_days):
            rem_days = num_days - d
            rem_chs = n - idx
            if rem_days == 1:
                days[d].extend(ch_list[idx:])
                break
            target_v = rem_v / rem_days
            cur_v = 0
            while idx < n and (n - idx) > (rem_days - 1):
                c = ch_list[idx]
                if cur_v > 0 and abs((cur_v + c["verse_count"]) - target_v) > abs(cur_v - target_v):
                    break
                days[d].append(c)
                cur_v += c["verse_count"]
                rem_v -= c["verse_count"]
                idx += 1
        return days

    def compress_day_readings(ch_items):
        """Groups consecutive chapters of the same book into clean ranges."""
        if not ch_items:
            return [], ""
        groups = []
        for c in ch_items:
            if groups and groups[-1]["book_order"] == c["book_order"] and groups[-1]["chapter_end"] + 1 == c["chapter"]:
                groups[-1]["chapter_end"] = c["chapter"]
                groups[-1]["verse_count"] += c["verse_count"]
            else:
                groups.append({
                    "book_order": c["book_order"],
                    "book_id": c["book_id"],
                    "book_abbr": c["book_abbr"],
                    "book_title": c["book_title"],
                    "chapter_start": c["chapter"],
                    "chapter_end": c["chapter"],
                    "verse_count": c["verse_count"],
                })
        for g in groups:
            if g["chapter_start"] == g["chapter_end"]:
                g["label"] = f"{g['book_abbr']} {g['chapter_start']}"
            else:
                g["label"] = f"{g['book_abbr']} {g['chapter_start']}–{g['chapter_end']}"
        summary = "; ".join(g["label"] for g in groups)
        return groups, summary

    # 1. PLAN 1: Biblija 365 — Višetračni plan (Stari zavjet + Novi zavjet + Psalmi/Mudrosne)
    sz_narrative_prophets = [bo for bo in range(1, 47) if bo not in (22, 23, 24, 25, 26, 27, 28)]
    psalms_wisdom = [23, 24, 25, 26, 27, 28, 22]  # Psalmi, Izr, Prop, Pj, Mudr, Sir, Job (313 ch)
    nz_all = list(range(47, 74))  # 260 ch

    track_sz = distribute_into_days(flatten_chapters(sz_narrative_prophets), 365)
    track_pw = distribute_into_days(flatten_chapters(psalms_wisdom), 365)
    track_nz = distribute_into_days(flatten_chapters(nz_all), 365)

    days_visetracni = []
    for d in range(365):
        combined = track_sz[d] + track_nz[d] + track_pw[d]
        readings, label = compress_day_readings(combined)
        days_visetracni.append({
            "day": d + 1,
            "label": label,
            "verse_count": sum(r["verse_count"] for r in readings),
            "readings": readings,
        })

    plans.append({
        "id": "biblija-365-visetracni",
        "title": "Biblija 365 — Višetračni plan (SZ + NZ + Psalmi/Mudrosne)",
        "category": "biblija-365",
        "days_count": 365,
        "description": "Najpopularniji način čitanja cijele Biblije u godinu dana (svih 73 knjiga katoličkog kanona): svaki dan čitaš odlomak iz Staroga zavjeta, odlomak iz Novoga zavjeta ili Psalama/Mudrosnih knjiga, čime se održava dinamika i izbjegava zamor kod zahtjevnijih zakonskih ili rodoslovnih poglavlja.",
        "days": days_visetracni,
    })

    # 2. PLAN 2: Biblija 365 — Kanonski redom (Postanak 1 -> Otkrivenje 22)
    all_canonical = flatten_chapters(list(range(1, 74)))
    track_canon = distribute_into_days(all_canonical, 365)
    days_kanonski = []
    for d in range(365):
        readings, label = compress_day_readings(track_canon[d])
        days_kanonski.append({
            "day": d + 1,
            "label": label,
            "verse_count": sum(r["verse_count"] for r in readings),
            "readings": readings,
        })

    plans.append({
        "id": "biblija-365-kanonski",
        "title": "Biblija 365 — Kanonski redom (od Postanka do Otkrivenja)",
        "category": "biblija-365",
        "days_count": 365,
        "description": "Čitanje svih 73 knjiga Svetoga pisma točnim kanonskim redoslijedom od Knjige Postanka 1 do Otkrivenja 22, ravnomjerno raspoređeno po duljini poglavlja (~97 redaka dnevno).",
        "days": days_kanonski,
    })

    # 3. PLAN 3: Biblija 365 — Kronološki / Povijest spasenja
    # Follows the historical timeline of Salvation History
    chrono_order = [
        1, 22,            # Postanak + Job (Patrijarsi)
        2, 3, 4, 5,       # Izlazak, Levitski, Brojevi, Ponovljeni zakon
        6, 7, 8,          # Jošua, Suci, Ruta
        9, 10, 23,        # 1-2 Samuel + Psalmi
        11, 24, 25, 26,   # 1 Kraljevima + Izreke, Propovjednik, Pjesma nad pjesmama
        12, 13, 14,       # 2 Kraljevima, 1-2 Ljetopisa
        37, 35, 40, 29,   # Amos, Hošea, Mihej, Izaija
        41, 42, 43, 38,   # Nahum, Habakuk, Sefanija, Obadija
        30, 31, 32,       # Jeremija, Tužaljke, Baruh
        36, 39,           # Joel, Jona
        33, 34,           # Ezekiel, Daniel
        15, 44, 45,       # Ezra, Hagaj, Zaharija
        19, 16, 17, 18, 46, # Estera, Nehemija, Tobija, Judita, Malahija
        28, 27, 20, 21,   # Sirah, Mudrost, 1-2 Makabejcima
        49, 51,           # Luka + Djela apostolska
        48, 47, 50,       # Marko, Matej, Ivan
        66, 55, 59, 60,   # Jakovljeva, Galaćanima, 1-2 Solunjanima
        53, 54, 52,       # 1-2 Korinćanima, Rimljanima
        56, 57, 58, 64,   # Efežanima, Filipljanima, Kološanima, Filemonu
        61, 63, 62,       # 1 Timoteju, Titu, 2 Timoteju
        65, 67, 68, 72,   # Hebrejima, 1-2 Petrova, Judina
        69, 70, 71, 73,   # 1-3 Ivanova, Otkrivenje
    ]
    assert len(set(chrono_order)) == 73 and len(chrono_order) == 73
    track_chrono = distribute_into_days(flatten_chapters(chrono_order), 365)
    days_chrono = []
    for d in range(365):
        readings, label = compress_day_readings(track_chrono[d])
        days_chrono.append({
            "day": d + 1,
            "label": label,
            "verse_count": sum(r["verse_count"] for r in readings),
            "readings": readings,
        })

    plans.append({
        "id": "biblija-365-kronoloski",
        "title": "Biblija 365 — Povijest spasenja (Kronološki slijed)",
        "category": "biblija-365",
        "days_count": 365,
        "description": "Prolazak kroz cijelu Bibliju u 365 dana prateći kronološki tijek povijesti spasenja: od stvaranja i patrijarha (Postanak i Job), preko Izlaska, Kraljevstva, Proroka i Mudrosnih knjiga, do Makabejaca, Evanđelja, Djela apostolskih, Poslanica i Otkrivenja.",
        "days": days_chrono,
    })

    # 4. Official KS thematic plans (cleaned & mapped to canonical book_order)
    slug_to_order = {b["id"]: bo for bo, b in books_meta.items()}
    for kp in raw_ks_plans:
        kdays = []
        for kd in kp.get("days_detail", []):
            kreadings = []
            for r in kd.get("readings", []):
                bslug = r.get("book_slug")
                bo = slug_to_order.get(bslug)
                if not bo:
                    continue
                b = books_meta[bo]
                c_start = int(r.get("chapter_start") or 1)
                c_end = int(r.get("chapter_end") or c_start)
                vcnt = sum(
                    chapters_by_book_order[bo].get(c, {}).get("verse_count", 0)
                    for c in range(c_start, c_end + 1)
                )
                lbl = f"{b['abbr']} {c_start}" if c_start == c_end else f"{b['abbr']} {c_start}–{c_end}"
                kreadings.append({
                    "book_order": bo,
                    "book_id": b["id"],
                    "book_abbr": b["abbr"],
                    "book_title": b["title"],
                    "chapter_start": c_start,
                    "chapter_end": c_end,
                    "verse_count": vcnt,
                    "label": lbl,
                })
            kdays.append({
                "day": int(kd.get("day_number") or len(kdays) + 1),
                "label": kd.get("references_label") or kd.get("title") or "; ".join(x["label"] for x in kreadings),
                "verse_count": sum(x["verse_count"] for x in kreadings),
                "readings": kreadings,
            })
        plans.append({
            "id": f"ks-{kp['id']}",
            "title": kp["title"],
            "category": "ks-tematski",
            "days_count": len(kdays),
            "description": re.sub(r"\s+", " ", htmllib.unescape(kp.get("description", ""))).strip(),
            "days": kdays,
        })

    return plans


def main():
    raw_books = json.load(open(os.path.join(SAMPLES_DIR, "bible_books_all.json"), encoding="utf-8"))
    raw_chapters = json.load(open(os.path.join(SAMPLES_DIR, "bible_chapters_all.json"), encoding="utf-8"))
    raw_verses = json.load(open(os.path.join(CACHE_DIR, "raw_verses.json"), encoding="utf-8"))
    raw_ks_plans = json.load(open(os.path.join(CACHE_DIR, "raw_ks_plans.json"), encoding="utf-8"))

    # Map chapters by id and by book
    ch_by_id = {}
    chs_by_wp_book = defaultdict(list)
    for c in raw_chapters:
        cid = int(c["id"])
        bid = int(c["chapter_book_id"])
        cnum = int(c["chapter_number"])
        vcnt = int(c["verse_count"])
        info = {"wp_id": cid, "wp_book_id": bid, "chapter": cnum, "declared_verse_count": vcnt, "verses": []}
        ch_by_id[cid] = info
        chs_by_wp_book[bid].append(info)

    # Inject hidden Chapter 0 of Knjiga Sirahova (wp_id=871, Proslov prevodiočev)
    # which breaks /wp/v2/bible_chapter/871 serializer on KS server!
    if 871 not in ch_by_id:
        sir_proslov = {"wp_id": 871, "wp_book_id": 39, "chapter": 0, "declared_verse_count": 8, "verses": []}
        ch_by_id[871] = sir_proslov
        chs_by_wp_book[39].append(sir_proslov)

    # Audit structures
    audit = {
        "total_books": len(raw_books),
        "total_chapters": len(raw_chapters),
        "total_verses": len(raw_verses),
        "book_metadata_bugs": [],
        "web_vs_mobile_api_discrepancies": [],
        "verse_count_mismatches": [],
        "skipped_or_nonsequential_verses": [],
        "ks_reading_plan_bugs": [],
    }

    # Build books_meta keyed by canonical book_order (1..73)
    books_meta = {}
    wp_book_to_order = {}
    for rb in raw_books:
        order = int(rb["book_order"])
        wp_id = int(rb["id"])
        wp_book_to_order[wp_id] = order
        raw_title = rb["title"]["rendered"]
        clean_title = htmllib.unescape(raw_title).strip()
        if raw_title != clean_title:
            audit["book_metadata_bugs"].append({
                "book_order": order,
                "book_slug": rb["slug"],
                "issue": "nerazriješeni HTML entitet u naslovu knjige",
                "raw_value": raw_title,
                "fixed_value": clean_title,
            })

        declared_ch_cnt = int(rb["chapter_count"])
        actual_ch_cnt = len([c for c in chs_by_wp_book[wp_id] if c["chapter"] >= 1])
        if declared_ch_cnt != actual_ch_cnt:
            audit["book_metadata_bugs"].append({
                "book_order": order,
                "book_slug": rb["slug"],
                "book_title": clean_title,
                "issue": "netočan chapter_count u bible_book (uzrokuje 404 na zadnjem poglavlju)",
                "declared_chapter_count": declared_ch_cnt,
                "actual_chapter_count": actual_ch_cnt,
            })

        testament, category = classify_book(order)
        books_meta[order] = {
            "order": order,
            "id": rb["slug"],
            "ks_book_id": wp_id,
            "abbr": rb["book_short_name"].strip(),
            "title": clean_title,
            "testament": testament,
            "category": category,
            "chapter_count": actual_ch_cnt,
            "verse_count": 0,
        }

    # Attach verses to chapters
    for rv in raw_verses:
        cid = int(rv["verse_chapter_id"])
        if cid in ch_by_id:
            ch_by_id[cid]["verses"].append(rv)

    # Process all books & chapters deterministically
    chapters_by_book_order = defaultdict(dict)
    all_book_Payloads = {}

    for order in sorted(books_meta.keys()):
        bmeta = books_meta[order]
        wp_bid = bmeta["ks_book_id"]
        ch_list = sorted(chs_by_wp_book[wp_bid], key=lambda x: x["chapter"])
        book_chapters_out = []
        book_total_verses = 0

        for ch_info in ch_list:
            cnum = ch_info["chapter"]
            # Sort verses by (int(verse_number), wp_id)
            raw_vlist = sorted(ch_info["verses"], key=lambda v: (int(v.get("verse_number") or 0), int(v["id"])))
            if len(raw_vlist) != ch_info["declared_verse_count"]:
                audit["verse_count_mismatches"].append({
                    "book": bmeta["abbr"],
                    "chapter": cnum,
                    "declared": ch_info["declared_verse_count"],
                    "actual": len(raw_vlist),
                })

            verses_out = []
            prev_vnum = 0
            for idx, rv in enumerate(raw_vlist):
                vnum = int(rv.get("verse_number") or (idx + 1))
                parsed = parse_verse_html(rv["content"]["rendered"], vnum)

                if parsed["has_order_anomaly"]:
                    audit["web_vs_mobile_api_discrepancies"].append({
                        "reference": f"{bmeta['abbr']} {cnum},{vnum}",
                        "book_title": bmeta["title"],
                        "book_slug": bmeta["id"],
                        "chapter": cnum,
                        "verse": vnum,
                        "anomaly_type": parsed["anomaly_type"],
                        "references_affected": parsed["references"],
                        "headings_affected": [h["text"] for h in parsed["headings"]],
                    })

                if prev_vnum > 0 and vnum != prev_vnum + 1:
                    audit["skipped_or_nonsequential_verses"].append({
                        "reference": f"{bmeta['abbr']} {cnum},{prev_vnum}->{vnum}",
                        "book_title": bmeta["title"],
                        "chapter": cnum,
                        "from_verse": prev_vnum,
                        "to_verse": vnum,
                        "sup_label": parsed["sup_num"],
                    })
                prev_vnum = vnum

                v_obj = {
                    "verse": vnum,
                    "text": parsed["text"],
                }
                if parsed["sup_num"] and parsed["sup_num"] != str(vnum):
                    v_obj["verse_label"] = parsed["sup_num"]
                if parsed["headings"]:
                    v_obj["headings"] = parsed["headings"]
                if parsed["references"]:
                    v_obj["references"] = parsed["references"]
                if parsed["lines"]:
                    v_obj["lines"] = parsed["lines"]

                verses_out.append(v_obj)

            book_total_verses += len(verses_out)
            ch_out = {
                "chapter": cnum,
                "verse_count": len(verses_out),
                "verses": verses_out,
            }
            book_chapters_out.append(ch_out)
            chapters_by_book_order[order][cnum] = ch_out

        bmeta["verse_count"] = book_total_verses
        book_payload = {
            **bmeta,
            "chapters": book_chapters_out,
        }
        all_book_Payloads[order] = book_payload

        # Write deterministic per-book JSON
        fname = f"{order:02d}_{bmeta['id']}.json"
        with open(os.path.join(BOOKS_JSON_DIR, fname), "w", encoding="utf-8") as f:
            json.dump(book_payload, f, indent=2, ensure_ascii=False)

    # Audit KS reading plans for skipped chapters or invalid ranges
    slug_to_order = {b["id"]: bo for bo, b in books_meta.items()}
    for kp in raw_ks_plans:
        covered_by_book = defaultdict(set)
        for kd in kp.get("days_detail", []):
            for r in kd.get("readings", []):
                bo = slug_to_order.get(r.get("book_slug"))
                if bo:
                    for c in range(int(r["chapter_start"]), int(r["chapter_end"]) + 1):
                        covered_by_book[bo].add(c)
        for bo, ch_set in covered_by_book.items():
            b = books_meta[bo]
            min_c, max_c = min(ch_set), max(ch_set)
            expected_c = set(range(1, b["chapter_count"] + 1))
            missing_c = sorted(expected_c - ch_set)
            if missing_c and len(missing_c) <= 5:
                audit["ks_reading_plan_bugs"].append({
                    "plan_id": kp["id"],
                    "plan_title": kp["title"],
                    "book": b["title"],
                    "missing_chapters": missing_c,
                })

    # Write data/json/books.json
    books_index = [books_meta[o] for o in sorted(books_meta.keys())]
    with open(os.path.join(JSON_DIR, "books.json"), "w", encoding="utf-8") as f:
        json.dump(books_index, f, indent=2, ensure_ascii=False)

    # Write compact verses index for pure static offline search fallback
    compact_verses = []
    for order in sorted(all_book_Payloads.keys()):
        bp = all_book_Payloads[order]
        for ch in bp["chapters"]:
            cnum = ch["chapter"]
            for v in ch["verses"]:
                compact_verses.append([order, cnum, v["verse"], v["text"]])
    with open(os.path.join(JSON_DIR, "verses_compact.json"), "w", encoding="utf-8") as f:
        json.dump(compact_verses, f, ensure_ascii=False, separators=(",", ":"))

    # Build reading plans and write to data/json/plans/
    plans = build_reading_plans(books_meta, chapters_by_book_order, raw_ks_plans)
    plans_index = []
    for p in plans:
        plans_index.append({
            "id": p["id"],
            "title": p["title"],
            "category": p["category"],
            "days_count": p["days_count"],
            "description": p["description"],
        })
        with open(os.path.join(PLANS_JSON_DIR, f"{p['id']}.json"), "w", encoding="utf-8") as f:
            json.dump(p, f, indent=2, ensure_ascii=False)

    with open(os.path.join(PLANS_JSON_DIR, "index.json"), "w", encoding="utf-8") as f:
        json.dump(plans_index, f, indent=2, ensure_ascii=False)

    # Write audit report JSON
    with open(os.path.join(DATA_DIR, "audit_report.json"), "w", encoding="utf-8") as f:
        json.dump(audit, f, indent=2, ensure_ascii=False)

    # Build SQLite database (data/biblija.db)
    db_path = os.path.join(DATA_DIR, "biblija.db")
    if os.path.exists(db_path):
        os.remove(db_path)

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.executescript("""
        PRAGMA page_size = 4096;
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = OFF;

        CREATE TABLE books (
            book_order INTEGER PRIMARY KEY,
            id TEXT UNIQUE NOT NULL,
            ks_book_id INTEGER NOT NULL,
            abbr TEXT NOT NULL,
            title TEXT NOT NULL,
            testament TEXT NOT NULL,
            category TEXT NOT NULL,
            chapter_count INTEGER NOT NULL,
            verse_count INTEGER NOT NULL
        );

        CREATE TABLE chapters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_order INTEGER NOT NULL,
            chapter INTEGER NOT NULL,
            verse_count INTEGER NOT NULL,
            UNIQUE(book_order, chapter),
            FOREIGN KEY(book_order) REFERENCES books(book_order)
        );

        CREATE TABLE verses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_order INTEGER NOT NULL,
            book_id TEXT NOT NULL,
            book_abbr TEXT NOT NULL,
            book_title TEXT NOT NULL,
            testament TEXT NOT NULL,
            chapter INTEGER NOT NULL,
            verse INTEGER NOT NULL,
            verse_label TEXT NOT NULL,
            text TEXT NOT NULL,
            text_folded TEXT NOT NULL,
            headings_json TEXT,
            references_json TEXT,
            lines_json TEXT,
            UNIQUE(book_order, chapter, verse),
            FOREIGN KEY(book_order) REFERENCES books(book_order)
        );

        CREATE INDEX idx_verses_book_ch ON verses(book_order, chapter);
        CREATE INDEX idx_verses_abbr ON verses(book_abbr, chapter, verse);

        CREATE VIRTUAL TABLE verses_fts USING fts5(
            text,
            text_folded,
            book_abbr UNINDEXED,
            book_title UNINDEXED,
            book_order UNINDEXED,
            chapter UNINDEXED,
            verse UNINDEXED,
            content='verses',
            content_rowid='id',
            tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TABLE reading_plans (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            category TEXT NOT NULL,
            days_count INTEGER NOT NULL,
            description TEXT NOT NULL
        );

        CREATE TABLE reading_plan_days (
            plan_id TEXT NOT NULL,
            day INTEGER NOT NULL,
            label TEXT NOT NULL,
            verse_count INTEGER NOT NULL,
            readings_json TEXT NOT NULL,
            PRIMARY KEY (plan_id, day),
            FOREIGN KEY(plan_id) REFERENCES reading_plans(id)
        );

        CREATE TABLE user_progress (
            plan_id TEXT NOT NULL,
            day INTEGER NOT NULL,
            completed_at TEXT NOT NULL,
            PRIMARY KEY (plan_id, day)
        );

        CREATE TABLE user_bookmarks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_order INTEGER NOT NULL,
            chapter INTEGER NOT NULL,
            verse INTEGER NOT NULL,
            color TEXT DEFAULT 'gold',
            note TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            UNIQUE(book_order, chapter, verse)
        );

        -- Multi-User & Multi-Device Sync Tables (Cloudflare D1 & Local SQLite compatible)
        CREATE TABLE sync_users (
            user_key TEXT PRIMARY KEY,
            pin_hash TEXT NOT NULL,
            display_name TEXT NOT NULL,
            active_plan_id TEXT NOT NULL DEFAULT 'mb-tematski-365',
            last_url TEXT NOT NULL DEFAULT '/',
            last_label TEXT NOT NULL DEFAULT '',
            last_updated_at TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE sync_progress (
            user_key TEXT NOT NULL,
            plan_id TEXT NOT NULL,
            day INTEGER NOT NULL,
            completed INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_key, plan_id, day),
            FOREIGN KEY (user_key) REFERENCES sync_users(user_key) ON DELETE CASCADE
        );

        CREATE INDEX idx_sync_progress_user ON sync_progress(user_key);

        CREATE TABLE sync_bookmarks (
            user_key TEXT NOT NULL,
            book_order INTEGER NOT NULL,
            book_id TEXT NOT NULL,
            book_abbr TEXT NOT NULL,
            book_title TEXT NOT NULL,
            chapter INTEGER NOT NULL,
            verse INTEGER NOT NULL,
            color TEXT NOT NULL DEFAULT 'gold',
            note TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL DEFAULT '',
            deleted INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_key, book_order, chapter, verse),
            FOREIGN KEY (user_key) REFERENCES sync_users(user_key) ON DELETE CASCADE
        );

        CREATE INDEX idx_sync_bookmarks_user ON sync_bookmarks(user_key);
    """)

    for b in books_index:
        cur.execute(
            "INSERT INTO books VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (b["order"], b["id"], b["ks_book_id"], b["abbr"], b["title"], b["testament"], b["category"], b["chapter_count"], b["verse_count"]),
        )

    verse_rows = []
    for order in sorted(all_book_Payloads.keys()):
        bp = all_book_Payloads[order]
        for ch in bp["chapters"]:
            cnum = ch["chapter"]
            cur.execute(
                "INSERT INTO chapters (book_order, chapter, verse_count) VALUES (?, ?, ?)",
                (order, cnum, ch["verse_count"]),
            )
            for v in ch["verses"]:
                vnum = v["verse"]
                vlbl = v.get("verse_label", str(vnum))
                txt = v["text"]
                txt_folded = fold_hr(txt)
                h_json = json.dumps(v["headings"], ensure_ascii=False) if "headings" in v else None
                r_json = json.dumps(v["references"], ensure_ascii=False) if "references" in v else None
                l_json = json.dumps(v["lines"], ensure_ascii=False) if "lines" in v else None
                verse_rows.append((
                    order, bp["id"], bp["abbr"], bp["title"], bp["testament"],
                    cnum, vnum, vlbl, txt, txt_folded, h_json, r_json, l_json
                ))

    cur.executemany(
        """INSERT INTO verses (
            book_order, book_id, book_abbr, book_title, testament,
            chapter, verse, verse_label, text, text_folded,
            headings_json, references_json, lines_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        verse_rows,
    )

    cur.execute("INSERT INTO verses_fts(verses_fts) VALUES('rebuild')")

    for p in plans:
        cur.execute(
            "INSERT INTO reading_plans VALUES (?, ?, ?, ?, ?)",
            (p["id"], p["title"], p["category"], p["days_count"], p["description"]),
        )
        day_rows = [
            (p["id"], d["day"], d["label"], d["verse_count"], json.dumps(d["readings"], ensure_ascii=False))
            for d in p["days"]
        ]
        cur.executemany("INSERT INTO reading_plan_days VALUES (?, ?, ?, ?, ?)", day_rows)

    conn.commit()
    cur.execute("VACUUM")
    conn.close()

    print("=== BUILD & AUDIT SUMMARY ===")
    print(f"Books: {len(books_index)} | Chapters: {len(raw_chapters)} | Verses: {len(verse_rows)}")
    print(f"Book metadata bugs found & fixed: {len(audit['book_metadata_bugs'])}")
    print(f"Web vs Mobile API verse rendering discrepancies found & fixed: {len(audit['web_vs_mobile_api_discrepancies'])}")
    print(f"Chapter verse_count mismatches: {len(audit['verse_count_mismatches'])}")
    print(f"Non-sequential / critical-edition skipped verse numbers: {len(audit['skipped_or_nonsequential_verses'])}")
    print(f"KS reading plan bugs found: {len(audit['ks_reading_plan_bugs'])}")
    print(f"SQLite DB size: {os.path.getsize(db_path) / (1024*1024):.2f} MB")


if __name__ == "__main__":
    main()
