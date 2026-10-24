#!/usr/bin/env python3
"""
Parses the 3 official 'Biblija kroz 365 dana' PDFs from Muževni budite
(https://muzevnibudite.com/1163/biblija_kroz_365_dana):
1. mb-tematski-365 (Tematski plan / Velika avantura s Biblijom - Jeff Cavins & o. Mike Schmitz)
2. mb-usporedni-365 (Usporedni plan čitanja Biblije - SZ + Mudrosne/Psalmi + NZ)
3. mb-linearni-365 (Linearni plan čitanja Biblije - od Postanka do Otkrivenja)
"""
import json
import os
import re
import pdfplumber

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT_DIR, "downloads", "cache")

MONTHS_GEN = {
    "SIJEČANJ": "siječnja",
    "VELJAČA": "veljače",
    "OŽUJAK": "ožujka",
    "TRAVANJ": "travnja",
    "SVIBANJ": "svibnja",
    "LIPANJ": "lipnja",
    "SRPANJ": "srpnja",
    "KOLOVOZ": "kolovoza",
    "RUJAN": "rujna",
    "LISTOPAD": "listopada",
    "STUDENI": "studenoga",
    "PROSINAC": "prosinca",
}
MONTHS = list(MONTHS_GEN.keys())


def parse_mb_plans(books_meta, chapters_by_book_order):
    abbr_to_book = {b["abbr"].lower(): b for b in books_meta.values()}
    abbr_to_book["jer"] = abbr_to_book["jr"]

    def parse_ref_tokens(text):
        # Strip footnote numbers attached to book abbreviations (Post1, Pnz1, Est3, Sir5, Rim1)
        s = re.sub(
            r"\b(Post|Izl|Lev|Br|Pnz|Jš|Suci|Rut|Sam|Kr|Ljet|Ezr|Neh|Tob|Jdt|Est|Mak|Job|Ps|PS|Izr|Prop|Pj|Mudr|Sir|Iz|Jer|Jr|Tuž|Bar|Ez|Dn|Hoš|Jl|Am|Ob|Jon|Mih|Nah|Hab|Sef|Hag|Zah|Mal|Mt|Mk|Lk|Iv|Dj|Rim|Kor|Gal|Ef|Fil|Kol|Sol|Tim|Tit|Flm|Heb|Jak|Pt|Jd|Otk)[1-9](?=\s+\d|\s*$)",
            r"\1",
            text,
        )
        # Also strip trailing footnote superscript after chapter ranges like "10, 1-103" in Est or "29.2"
        book_pattern = r"([1-3]\s*(?:Sam|Kr|Ljet|Mak|Kor|Sol|Tim|Pt|Iv)|Post|Izl|Lev|Br|Pnz|Jš|Suci|Rut|Ezr|Neh|Tob|Jdt|Est|Job|Ps|PS|Izr|Prop|Pj|Mudr|Sir|Iz|Jer|Jr|Tuž|Bar|Ez|Dn|Hoš|Jl|Am|Ob|Jon|Mih|Nah|Hab|Sef|Hag|Zah|Mal|Mt|Mk|Lk|Iv|Dj|Rim|Gal|Ef|Fil|Kol|Tit|Flm|Heb|Jak|Jd|Otk)\b"
        matches = list(re.finditer(book_pattern, s))
        results = []
        for i, m in enumerate(matches):
            b_raw = re.sub(r"\s+", " ", m.group(1)).strip()
            b = abbr_to_book.get(b_raw.lower())
            if not b:
                continue
            bo = b["order"]
            start_pos = m.end()
            end_pos = matches[i + 1].start() if i + 1 < len(matches) else len(s)
            rest = s[start_pos:end_pos].strip(" ,;.\t")

            if not rest or rest.lower().startswith("proslov"):
                if b["abbr"] == "Sir":
                    # "Sir" alone or "Sir Proslov" is Chapter 0 (Proslov prevodiočev)
                    ch_start, ch_end = 0, 0
                    lbl = "Sir Proslov"
                else:
                    ch_start, ch_end = 1, b["chapter_count"]
                    lbl = b["abbr"] if b["chapter_count"] == 1 else f"{b['abbr']} 1–{b['chapter_count']}"
            else:
                nums = [int(x) for x in re.findall(r"\d+", rest)]
                if not nums:
                    ch_start, ch_end = 1, b["chapter_count"]
                elif re.match(r"^\d+\s*[-–]\s*\d+\s*$", rest):
                    ch_start, ch_end = nums[0], nums[1]
                elif re.match(r"^(\d+)\s*,\s*\d+\s*[-–]\s*(\d+)\s*,\s*\d+", rest):
                    m2 = re.match(r"^(\d+)\s*,\s*\d+\s*[-–]\s*(\d+)\s*,\s*\d+", rest)
                    ch_start, ch_end = int(m2.group(1)), int(m2.group(2))
                elif re.match(r"^(\d+)\s*[-–]\s*(\d+)\s*,\s*\d+", rest):
                    m2 = re.match(r"^(\d+)\s*[-–]\s*(\d+)\s*,\s*\d+", rest)
                    ch_start, ch_end = int(m2.group(1)), int(m2.group(2))
                else:
                    ch_start = nums[0]
                    ch_end = nums[0]

                ch_start = max(0, min(ch_start, b["chapter_count"]))
                ch_end = max(ch_start, min(ch_end, b["chapter_count"]))
                clean_rest = re.sub(r"\s+", " ", rest).strip()
                lbl = f"{b['abbr']} {clean_rest}"

            vcnt = sum(
                chapters_by_book_order[bo].get(c, {}).get("verse_count", 0)
                for c in range(ch_start, ch_end + 1)
            )
            results.append({
                "book_order": bo,
                "book_id": b["id"],
                "book_abbr": b["abbr"],
                "book_title": b["title"],
                "chapter_start": ch_start,
                "chapter_end": ch_end,
                "verse_count": vcnt,
                "label": lbl,
            })
        return results

    plans = []

    # 1. TEMATSKI PLAN (Velika avantura s Biblijom / o. Mike Schmitz & Jeff Cavins)
    tem_txt_path = os.path.join(CACHE_DIR, "mb_tematski.txt")
    if os.path.exists(tem_txt_path):
        tem_txt = open(tem_txt_path, encoding="utf-8").read()
        dan_lines = re.findall(r"^\s*Dan\s+(\d+)\s+(.*)$", tem_txt, re.MULTILINE)
        days_tem = []
        for d_str, line in dan_lines:
            dnum = int(d_str)
            clean_line = line
            for kw in [
                "Rani svijet", "Patrijarsi", "Egipat i Izlazak", "Lutanje pustinjom",
                "Osvajanje i Suci", "Kraljevstvo", "Podijeljeno kraljevstvo",
                "Izgnanstvo", "Povratak", "Makabejski ustanak", "Mesijansko ispunjenje",
                "Crkva", "Prvo čitanje", "Drugo čitanje",
            ]:
                clean_line = re.sub(kw, " ", clean_line, flags=re.IGNORECASE)
            readings = parse_ref_tokens(clean_line)
            label = "; ".join(r["label"] for r in readings)
            days_tem.append({
                "day": dnum,
                "label": label,
                "verse_count": sum(r["verse_count"] for r in readings),
                "readings": readings,
            })
        plans.append({
            "id": "mb-tematski-365",
            "title": "Muževni budite — Tematski plan (Velika avantura s Biblijom / Bible in a Year)",
            "category": "biblija-365",
            "days_count": len(days_tem),
            "description": "Službeni tematski plan čitanja katoličke Biblije kroz 365 dana (Muževni budite / Ascension — Jeff Cavins i o. Mike Schmitz). Svaki dan čitaju se 2–3 odlomka iz Staroga/Novoga zavjeta uz Psalme i Mudre izreke, prateći 12 razdoblja povijesti spasenja.",
            "days": days_tem,
        })

    # 2. USPOREDNI PLAN (Muževni budite: Stari zavjet + Mudrosne/Psalmi + Novi zavjet)
    usp_pdf_path = os.path.join(CACHE_DIR, "mb_usporedni.pdf")
    if os.path.exists(usp_pdf_path):
        by_month_u = {m: [] for m in MONTHS}
        cur_m = None
        with pdfplumber.open(usp_pdf_path) as pdf:
            for page in pdf.pages:
                for table in page.extract_tables():
                    for row in table:
                        cells = [(x or "").strip() for x in row if (x or "").strip()]
                        if not cells:
                            continue
                        for m in MONTHS:
                            if m in cells[0]:
                                cur_m = m
                        m_day = re.match(r"^(\d+)\s*\.?$", cells[0])
                        if m_day and cur_m and len(cells) >= 2:
                            d_in_m = int(m_day.group(1))
                            by_month_u[cur_m].append((d_in_m, " ; ".join(cells[1:])))

        days_usp = []
        seq_day = 1
        for m in MONTHS:
            for d_in_m, raw_r in by_month_u[m]:
                readings = parse_ref_tokens(raw_r)
                date_lbl = f"{d_in_m}. {MONTHS_GEN[m]}"
                r_lbl = "; ".join(r["label"] for r in readings)
                days_usp.append({
                    "day": seq_day,
                    "date_label": date_lbl,
                    "label": f"{date_lbl} — {r_lbl}",
                    "verse_count": sum(r["verse_count"] for r in readings),
                    "readings": readings,
                })
                seq_day += 1

        plans.append({
            "id": "mb-usporedni-365",
            "title": "Muževni budite — Usporedni plan (SZ + Psalmi/Mudrosne + NZ)",
            "category": "biblija-365",
            "days_count": len(days_usp),
            "description": "Službeni usporedni plan čitanja Biblije kroz 365 dana portala Muževni budite: svakog se dana čitaju po dva čitanja iz Staroga zavjeta (povijesne/proročke + psalmi/mudrosne knjige) i jedno čitanje iz Novoga zavjeta.",
            "days": days_usp,
        })

    # 3. LINEARNI PLAN (Muževni budite: od Postanka do Otkrivenja)
    lin_pdf_path = os.path.join(CACHE_DIR, "mb_linearni.pdf")
    if os.path.exists(lin_pdf_path):
        by_month_l = {m: [] for m in MONTHS}
        left_m, right_m = None, None
        with pdfplumber.open(lin_pdf_path) as pdf:
            for page in pdf.pages:
                for table in page.extract_tables():
                    for row in table:
                        if not row or len(row) < 4:
                            continue
                        c0, c1, c2, c3 = [(x or "").strip() for x in row[:4]]
                        if c0 in MONTHS:
                            left_m = c0
                        if c2 in MONTHS:
                            right_m = c2
                        m0 = re.match(r"^(\d+)\.", c0)
                        if m0 and c1 and left_m:
                            by_month_l[left_m].append((int(m0.group(1)), c1))
                        m2 = re.match(r"^(\d+)\.", c2)
                        if m2 and c3 and right_m:
                            by_month_l[right_m].append((int(m2.group(1)), c3))

        days_lin = []
        seq_day = 1
        for m in MONTHS:
            for d_in_m, raw_r in by_month_l[m]:
                readings = parse_ref_tokens(raw_r)
                date_lbl = f"{d_in_m}. {MONTHS_GEN[m]}"
                r_lbl = "; ".join(r["label"] for r in readings)
                days_lin.append({
                    "day": seq_day,
                    "date_label": date_lbl,
                    "label": f"{date_lbl} — {r_lbl}",
                    "verse_count": sum(r["verse_count"] for r in readings),
                    "readings": readings,
                })
                seq_day += 1

        plans.append({
            "id": "mb-linearni-365",
            "title": "Muževni budite — Linearni plan (od Postanka do Otkrivenja)",
            "category": "biblija-365",
            "days_count": len(days_lin),
            "description": "Službeni linearni plan čitanja Biblije portala Muževni budite: svakog dana čita se nekoliko poglavlja redom od Knjige Postanka do Otkrivenja (5–10 minuta dnevno).",
            "days": days_lin,
        })

    return plans
