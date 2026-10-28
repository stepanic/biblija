#!/usr/bin/env python3
"""
Builds:
1. Full Audit & Diff Report (AUDIT.md, data/audit_report.json, data/errata.json) comparing:
   - Web (biblija.ks.hr) vs Mobile API vs Raw WP DB
   - Cross-source verification against eBible.org (hrv_usfm) / CrossWire (CroSaric) from domovinatv/biblija
2. Deterministic JSON Catalog in data/json/ (books.json, books/*.json, plans/*.json)
   with USFM book codes (GEN..REV), English names, deuterocanonical flags, paragraph markers, and reconstructed errata
3. Deterministic SQLite Database in data/biblija.db with FTS5 full-text search + multi-user sync tables
"""
import glob
import html as htmllib
import json
import os
import re
import sqlite3
import unicodedata
from collections import defaultdict

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOMOVINA_DIR = "/Users/ms/git/domovinatv/biblija"
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

# Standard USFM 3-letter codes, English names & Deuterocanonical classification (KKC 120)
USFM_CATALOG = {
    1: ("GEN", "Genesis", False, None),
    2: ("EXO", "Exodus", False, None),
    3: ("LEV", "Leviticus", False, None),
    4: ("NUM", "Numbers", False, None),
    5: ("DEU", "Deuteronomy", False, None),
    6: ("JOS", "Joshua", False, None),
    7: ("JDG", "Judges", False, None),
    8: ("RUT", "Ruth", False, None),
    9: ("1SA", "1 Samuel", False, None),
    10: ("2SA", "2 Samuel", False, None),
    11: ("1KI", "1 Kings", False, None),
    12: ("2KI", "2 Kings", False, None),
    13: ("1CH", "1 Chronicles", False, None),
    14: ("2CH", "2 Chronicles", False, None),
    15: ("EZR", "Ezra", False, None),
    16: ("NEH", "Nehemiah", False, None),
    17: ("TOB", "Tobit", True, None),
    18: ("JDT", "Judith", True, None),
    19: ("EST", "Esther", False, "grčki dodaci A–F"),
    20: ("1MA", "1 Maccabees", True, None),
    21: ("2MA", "2 Maccabees", True, None),
    22: ("JOB", "Job", False, None),
    23: ("PSA", "Psalms", False, None),
    24: ("PRO", "Proverbs", False, None),
    25: ("ECC", "Ecclesiastes", False, None),
    26: ("SNG", "Song of Songs", False, None),
    27: ("WIS", "Wisdom", True, None),
    28: ("SIR", "Sirach", True, None),
    29: ("ISA", "Isaiah", False, None),
    30: ("JER", "Jeremiah", False, None),
    31: ("LAM", "Lamentations", False, None),
    32: ("BAR", "Baruch", True, None),
    33: ("EZK", "Ezekiel", False, None),
    34: ("DAN", "Daniel", False, "3,24–90; 13; 14"),
    35: ("HOS", "Hosea", False, None),
    36: ("JOL", "Joel", False, None),
    37: ("AMO", "Amos", False, None),
    38: ("OBA", "Obadiah", False, None),
    39: ("JON", "Jonah", False, None),
    40: ("MIC", "Micah", False, None),
    41: ("NAM", "Nahum", False, None),
    42: ("HAB", "Habakkuk", False, None),
    43: ("ZEP", "Zephaniah", False, None),
    44: ("HAG", "Haggai", False, None),
    45: ("ZEC", "Zechariah", False, None),
    46: ("MAL", "Malachi", False, None),
    47: ("MAT", "Matthew", False, None),
    48: ("MRK", "Mark", False, None),
    49: ("LUK", "Luke", False, None),
    50: ("JHN", "John", False, None),
    51: ("ACT", "Acts", False, None),
    52: ("ROM", "Romans", False, None),
    53: ("1CO", "1 Corinthians", False, None),
    54: ("2CO", "2 Corinthians", False, None),
    55: ("GAL", "Galatians", False, None),
    56: ("EPH", "Ephesians", False, None),
    57: ("PHP", "Philippians", False, None),
    58: ("COL", "Colossians", False, None),
    59: ("1TH", "1 Thessalonians", False, None),
    60: ("2TH", "2 Thessalonians", False, None),
    61: ("1TI", "1 Timothy", False, None),
    62: ("2TI", "2 Timothy", False, None),
    63: ("TIT", "Titus", False, None),
    64: ("PHM", "Philemon", False, None),
    65: ("HEB", "Hebrews", False, None),
    66: ("JAS", "James", False, None),
    67: ("1PE", "1 Peter", False, None),
    68: ("2PE", "2 Peter", False, None),
    69: ("1JN", "1 John", False, None),
    70: ("2JN", "2 John", False, None),
    71: ("3JN", "3 John", False, None),
    72: ("JUD", "Jude", False, None),
    73: ("REV", "Revelation", False, None),
}


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
    - sup_num: extracted superscript verse number string
    - has_order_anomaly: True if <span class='Izvor'> or heading appears AFTER <sup>
    - text: clean plain text of the verse
    - lines: poetic lines if <span class='Stih1'> or poetic <br> is used
    - is_poetic: bool
    """
    s = raw_html.strip()

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

    headings = []
    for hm in re.finditer(r"<(h[234])[^>]*>(.*?)</\1>", s, re.DOTALL | re.IGNORECASE):
        level = hm.group(1).lower()
        htext = re.sub(r"<[^>]+>", "", hm.group(2))
        htext = re.sub(r"\s+", " ", htmllib.unescape(htext)).strip()
        if htext:
            headings.append({"level": level, "text": htext})

    s_body = re.sub(r"<h[234][^>]*>.*?</h[234]>", " ", s, flags=re.DOTALL | re.IGNORECASE)

    references = []
    for rm in re.finditer(r"<span\s+class=['\"]Izvor['\"][^>]*>(.*?)</span>(?:\s*<br\s*/?>)?", s_body, re.DOTALL | re.IGNORECASE):
        rtext = re.sub(r"<[^>]+>", "", rm.group(1))
        rtext = re.sub(r"\s+", " ", htmllib.unescape(rtext)).strip()
        if rtext:
            references.append(rtext)

    s_body = re.sub(r"<span\s+class=['\"]Izvor['\"][^>]*>.*?</span>(?:\s*<br\s*/?>)?", " ", s_body, flags=re.DOTALL | re.IGNORECASE)
    s_body = re.sub(r"<sup[^>]*>.*?</sup>(?:&nbsp;|\s)*", "", s_body, count=1, flags=re.DOTALL | re.IGNORECASE)

    is_poetic = bool(re.search(r"class=['\"]Stih", s_body, re.IGNORECASE))

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


def apply_cross_source_errata(all_book_payloads, chapters_by_book_order):
    """
    Applies verified text reconstructions & OCR cleanups discovered by comparing
    biblija.ks.hr against the independent eBible (hrv_usfm) / CrossWire digitization
    of the Zagrebačka Biblija. Returns the list of structured errata entries.
    """
    errata = []

    def log_errata(book_order, abbr, ch, v, issue_type, raw_ks, fixed_val, reason):
        errata.append({
            "book_order": book_order,
            "usfm_id": USFM_CATALOG[book_order][0],
            "reference": f"{abbr} {ch},{v}",
            "chapter": ch,
            "verse": v,
            "type": issue_type,
            "ks_raw": raw_ks,
            "fixed": fixed_val,
            "reason": reason,
        })

    # 1. Poslanica Titu 1 (book_order = 63):
    #    - Tit 1,1 was overwritten with "On koji ne laže," (the end of Tit 1,2) in KS WP DB
    #    - Tit 1,2 was missing "On koji ne laže," at the end
    #    - Tit 1,5 and Tit 1,10 had un-tagged h4 headings glued into the verse text
    tit_ch1 = chapters_by_book_order[63][1]
    for v_obj in tit_ch1["verses"]:
        if v_obj["verse"] == 1:
            old_t = v_obj["text"]
            v_obj["text"] = "Pavao, sluga Božji i apostol Isusa Krista poradi vjere izabranika Božjih i spoznanja istine usmjerene k pobožnosti"
            v_obj["headings"] = [{"level": "h4", "text": "Naslov"}]
            log_errata(
                63, "Tit", 1, 1, "corrupted_verse_restored",
                old_t, v_obj["text"],
                "Na biblija.ks.hr stih Tit 1,1 pregažen je završetkom 2. stiha ('On koji ne laže,'). Rekonstruiran izvorni tekst Zagrebačke Biblije."
            )
        elif v_obj["verse"] == 2:
            old_t = v_obj["text"]
            v_obj["text"] = "u nadi života vječnoga što ga, prije vremenâ vjekovječnih, obeća Bog, On koji ne laže,"
            log_errata(
                63, "Tit", 1, 2, "truncated_verse_restored",
                old_t, v_obj["text"],
                "Na biblija.ks.hr završetak stiha Tit 1,2 ('On koji ne laže,') premješten je u Tit 1,1."
            )
        elif v_obj["verse"] == 5 and v_obj["text"].startswith("Postavljanje starješina "):
            old_t = v_obj["text"]
            v_obj["text"] = v_obj["text"][len("Postavljanje starješina "):].strip()
            v_obj["headings"] = [{"level": "h4", "text": "Postavljanje starješina"}]
            log_errata(
                63, "Tit", 1, 5, "glued_heading_extracted",
                old_t, v_obj["text"],
                "U bazi biblija.ks.hr međunaslov 'Postavljanje starješina' unesen je bez <h4> oznake izravno u tekst stiha."
            )
        elif v_obj["verse"] == 10 and v_obj["text"].startswith("Borba protiv krivih učitelja "):
            old_t = v_obj["text"]
            v_obj["text"] = v_obj["text"][len("Borba protiv krivih učitelja "):].strip()
            v_obj["headings"] = [{"level": "h4", "text": "Borba protiv krivih učitelja"}]
            log_errata(
                63, "Tit", 1, 10, "glued_heading_extracted",
                old_t, v_obj["text"],
                "U bazi biblija.ks.hr međunaslov 'Borba protiv krivih učitelja' unesen je bez <h4> oznake izravno u tekst stiha."
            )

    # 2. Knjiga o Danielu 3,91-100 (book_order = 34):
    #    On biblija.ks.hr, Daniel 3 stops at verse 90 (missing verses 91-100).
    dan_ch3 = chapters_by_book_order[34][3]
    existing_dan3_vnums = {v["verse"] for v in dan_ch3["verses"]}
    missing_dan3 = [
        (91, [{"level": "h4", "text": "Nabukodonozor priznaje čudo"}],
         "Tada se kralj Nabukodonozor zaprepasti i brzo ustade. Zapita svoje savjetnike: »Nismo li bacili ova tri čovjeka svezana u oganj?« Oni odgovoriše: »Jesmo, kralju!«"),
        (92, None,
         "On reče: »Ali ja vidim četiri čovjeka, odriješeni šeću po vatri i ništa im se zlo ne događa; četvrti je sličan sinu Božjemu.«"),
        (93, None,
         "Nabukodonozor priđe vratima užarene peći i viknu: »Šadrače, Mešače i Abed Nego, sluge Boga Višnjega, iziđite i dođite ovamo!« Tada iziđoše iz ognja Šadrak, Mešak i Abed Nego."),
        (94, None,
         "Sakupiše se satrapi, starješine, upravitelji i kraljevi savjetnici da vide te ljude: oganj ne bijaše naudio njihovu tijelu, kosa im na glavi neopaljena, plaštevi im neoštećeni, nikakav se zadah ognja ne bijaše uhvatio njih."),
        (95, None,
         "Nabukodonozor viknu: »Blagoslovljen bio Bog Šadrakov, Mešakov i Abed Negov, koji je poslao svog anđela i izbavio svoje sluge, one koji se uzdahu u njega te se ne pokoriše kraljevoj naredbi, već radije predadoše svoje tijelo ognju negoli da štuju ili se klanjaju drugome osim svome Bogu!"),
        (96, None,
         "Naređujem dakle: O narodi, plemena i jezici, svatko između vas tko bi pogrdio Boga Šadrakova, Mešakova i Abed Negova neka bude raskomadan, a njegova kuća pretvorena u smetlište, jer nema boga koji bi mogao izbaviti kao ovaj.«"),
        (97, None,
         "Tada kralj uzvisi Šadraka, Mešaka i Abed Nega na visoke položaje u pokrajini babilonskoj."),
        (98, [{"level": "h3", "text": "4. NABUKODONOZOROV SAN O VELIKOM STABLU"}, {"level": "h4", "text": "Kraljeva poslanica"}],
         "Nabukodonozor, kralj, svim plemenima, narodima i jezicima po svoj zemlji: Obilovali mirom!"),
        (99, None,
         "Svidjelo mi se obznaniti vam znakove i čudesa što ih na meni učini Bog Svevišnji."),
        (100, None,
         "Znakovi njegovi kako su veliki! Čudesa njegova kako silna! Kraljevstvo njegovo – kraljevstvo vječno! Vlast njegova za sva pokoljenja!"),
    ]
    for vnum, hdgs, txt in missing_dan3:
        if vnum not in existing_dan3_vnums:
            v_entry = {"verse": vnum, "text": txt}
            if hdgs:
                v_entry["headings"] = hdgs
            dan_ch3["verses"].append(v_entry)
            log_errata(
                34, "Dn", 3, vnum, "missing_verse_restored",
                None, txt,
                "Na biblija.ks.hr 3. poglavlje Daniela prekida se na 90. stihu; rekonstruirani stihovi Dn 3,91–100 prema tiskanom izdanju Zagrebačke Biblije."
            )
    dan_ch3["verse_count"] = len(dan_ch3["verses"])

    # 3. Knjiga o Jobu 25 i 27 (book_order = 22):
    #    - Job 25,1 is empty on biblija.ks.hr and Job 25,2-4 were dropped during KS's import of Jerusalem Bible rearranged blocks
    #    - Job 27,1 is empty on biblija.ks.hr and Job 27,2-4 were dropped
    job_ch25 = chapters_by_book_order[22][25]
    for v_obj in job_ch25["verses"]:
        if v_obj["verse"] == 1 and not v_obj["text"]:
            v_obj["text"] = "Bildad iz Šuaha progovori tad i reče:"
            log_errata(
                22, "Job", 25, 1, "empty_verse_restored",
                "", v_obj["text"],
                "Na biblija.ks.hr stih Job 25,1 ima samo broj stiha bez teksta."
            )
    existing_job25 = {v["verse"] for v in job_ch25["verses"]}
    job25_missing = [
        (2, "»Gospodstvo i strah u njegovoj su ruci i on stvara mir u svojim visinama."),
        (3, "Zar se njemu čete izbrojiti mogu i svjetlo njegovo nad kim ne izlazi?"),
        (4, "Pa kako da čovjek prav bude pred Bogom i od žene rođen kako da čist bude?"),
    ]
    for vnum, txt in job25_missing:
        if vnum not in existing_job25:
            job_ch25["verses"].append({"verse": vnum, "text": txt})
            log_errata(
                22, "Job", 25, vnum, "missing_verse_restored",
                None, txt,
                "Ispušteni stihovi Bildadova govora u Job 25,2–4 pri KS-ovom prijelomu premještenih redaka."
            )
    job_ch25["verses"].sort(key=lambda x: x["verse"])
    job_ch25["verse_count"] = len(job_ch25["verses"])

    job_ch27 = chapters_by_book_order[22][27]
    for v_obj in job_ch27["verses"]:
        if v_obj["verse"] == 1 and not v_obj["text"]:
            v_obj["text"] = "Job nastavi svoju besjedu i reče:"
            log_errata(
                22, "Job", 27, 1, "empty_verse_restored",
                "", v_obj["text"],
                "Na biblija.ks.hr stih Job 27,1 ima samo broj stiha bez teksta."
            )
    existing_job27 = {v["verse"] for v in job_ch27["verses"]}
    job27_missing = [
        (2, "»Živoga mi Boga što mi pravdu krati i Svesilnog koji dušu mi zagorča:"),
        (3, "sve dok duha moga bude još u meni, dok mi dah Božji u nosnicama bude,"),
        (4, "usne moje neće izustiti zloću niti će laž kakva doći na moj jezik."),
    ]
    for vnum, txt in job27_missing:
        if vnum not in existing_job27:
            job_ch27["verses"].append({"verse": vnum, "text": txt})
            log_errata(
                22, "Job", 27, vnum, "missing_verse_restored",
                None, txt,
                "Ispušteni stihovi Jobova govora u Job 27,2–4 pri KS-ovom prijelomu premještenih redaka."
            )
    job_ch27["verses"].sort(key=lambda x: x["verse"])
    job_ch27["verse_count"] = len(job_ch27["verses"])

    # 4. OCR & Typo cleanups in KS verses (?Job, ?Jao, spremi sena propast)
    ocr_fixes = [
        (19, "Est", 1, 1, "spremi sena propast", "spremi se na propast", "Spojene riječi ('sena' -> 'se na') u grčkom dodatku Est 1,1h."),
        (22, "Job", 19, 1, "?Job progovori i reče:", "Job progovori i reče:", "Zaostali znak '?' na početku stiha u bazi biblija.ks.hr."),
        (22, "Job", 29, 1, "?Job nastavi svoju besjedu i reče:", "Job nastavi svoju besjedu i reče:", "Zaostali znak '?' na početku stiha u bazi biblija.ks.hr."),
        (29, "Iz", 10, 1, "?Jao onima koji izdaju", "Jao onima koji izdaju", "Zaostali znak '?' na početku stiha u bazi biblija.ks.hr."),
        # Three-way vote against library.foi.hr (Biblija KS) and hrv_usfm: both other digitizations agree.
        (1, "Post", 50, 14, "u Egi pat", "u Egipat", "Razdvojena riječ ('Egi pat' -> 'Egipat'); FOI i hrv_usfm se slažu."),
        (3, "Lev", 4, 12, "mjestoizvan", "mjesto izvan", "Spojene riječi ('mjestoizvan' -> 'mjesto izvan'); FOI i hrv_usfm se slažu."),
        (8, "Rut", 4, 5, "iRutu", "i Rutu", "Spojene riječi ('iRutu' -> 'i Rutu'); FOI i hrv_usfm se slažu."),
        (15, "Ezr", 1, 1, "kralja Ki- ra", "kralja Kira", "Zaostala crtica prijeloma retka ('Ki- ra' -> 'Kira'); FOI i hrv_usfm se slažu."),
        (23, "Ps", 17, 10, "zatvarajui ustima", "zatvaraju i ustima", "Spojene riječi ('zatvarajui' -> 'zatvaraju i'); FOI i hrv_usfm se slažu."),
        (23, "Ps", 113, 3, "zalaskahvaljeno", "zalaska hvaljeno", "Spojene riječi ('zalaskahvaljeno' -> 'zalaska hvaljeno'); FOI i hrv_usfm se slažu."),
        (23, "Ps", 119, 80, "pravilimada", "pravilima da", "Spojene riječi ('pravilimada' -> 'pravilima da'); FOI i hrv_usfm se slažu."),
    ]
    for bo, abbr, ch, vnum, bad_sub, good_sub, reason in ocr_fixes:
        ch_obj = chapters_by_book_order[bo][ch]
        for v_obj in ch_obj["verses"]:
            if v_obj["verse"] == vnum and bad_sub in v_obj["text"]:
                old_t = v_obj["text"]
                v_obj["text"] = v_obj["text"].replace(bad_sub, good_sub)
                if "lines" in v_obj:
                    v_obj["lines"] = [ln.replace(bad_sub, good_sub) for ln in v_obj["lines"]]
                log_errata(bo, abbr, ch, vnum, "ocr_typo_fixed", old_t, v_obj["text"], reason)

    # Recalculate total verse counts for modified books
    for bo in (19, 22, 29, 34, 63):
        bp = all_book_payloads[bo]
        bp["verse_count"] = sum(c["verse_count"] for c in bp["chapters"])

    # 5. Enrich with USFM paragraph markers ("p": True) if domovinatv/biblija is available locally
    saric_dir = os.path.join(DOMOVINA_DIR, "data", "saric")
    if os.path.isdir(saric_dir):
        for sf in sorted(glob.glob(os.path.join(saric_dir, "*.json"))):
            sd = json.load(open(sf, encoding="utf-8"))
            bo = int(sd["order"])
            if bo not in chapters_by_book_order:
                continue
            for sch in sd["chapters"]:
                cnum = int(sch["chapter"])
                if cnum not in chapters_by_book_order[bo]:
                    continue
                p_vnums = {int(sv["v"]) for sv in sch["verses"] if sv.get("p") and "part" not in sv}
                for kv in chapters_by_book_order[bo][cnum]["verses"]:
                    if kv["verse"] in p_vnums:
                        kv["p"] = True

    return errata


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
        total_v = sum(c["verse_count"] for c in ch_list)
        days = [[] for _ in range(num_days)]
        n = len(ch_list)
        if n <= num_days:
            for idx, c in enumerate(ch_list):
                day_idx = min(num_days - 1, int(idx * num_days / max(1, n)))
                days[day_idx].append(c)
            return days

        idx = 0
        rem_v = total_v
        for d in range(num_days):
            rem_days = num_days - d
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

    sz_narrative_prophets = [bo for bo in range(1, 47) if bo not in (22, 23, 24, 25, 26, 27, 28)]
    psalms_wisdom = [23, 24, 25, 26, 27, 28, 22]
    nz_all = list(range(47, 74))

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

    chrono_order = [
        1, 22,
        2, 3, 4, 5,
        6, 7, 8,
        9, 10, 23,
        11, 24, 25, 26,
        12, 13, 14,
        37, 35, 40, 29,
        41, 42, 43, 38,
        30, 31, 32,
        36, 39,
        33, 34,
        15, 44, 45,
        19, 16, 17, 18, 46,
        28, 27, 20, 21,
        49, 51,
        48, 47, 50,
        66, 55, 59, 60,
        53, 54, 52,
        56, 57, 58, 64,
        61, 63, 62,
        65, 67, 68, 72,
        69, 70, 71, 73,
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

    if 871 not in ch_by_id:
        sir_proslov = {"wp_id": 871, "wp_book_id": 39, "chapter": 0, "declared_verse_count": 8, "verses": []}
        ch_by_id[871] = sir_proslov
        chs_by_wp_book[39].append(sir_proslov)

    audit = {
        "total_books": len(raw_books),
        "total_chapters": len(raw_chapters) + 1,
        "total_verses": 0,
        "book_metadata_bugs": [],
        "web_vs_mobile_api_discrepancies": [],
        "cross_source_errata_fixed": [],
        "verse_count_mismatches": [],
        "skipped_or_nonsequential_verses": [],
        "ks_reading_plan_bugs": [],
    }

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
        usfm_id, name_en, is_deutero, deutero_parts = USFM_CATALOG[order]
        meta_entry = {
            "order": order,
            "id": rb["slug"],
            "usfm_id": usfm_id,
            "ks_book_id": wp_id,
            "abbr": rb["book_short_name"].strip(),
            "title": clean_title,
            "name_en": name_en,
            "testament": testament,
            "category": category,
            "deuterocanonical": is_deutero,
            "chapter_count": actual_ch_cnt,
            "verse_count": 0,
        }
        if deutero_parts:
            meta_entry["deuterocanonical_parts"] = deutero_parts
        books_meta[order] = meta_entry

    for rv in raw_verses:
        cid = int(rv["verse_chapter_id"])
        if cid in ch_by_id:
            ch_by_id[cid]["verses"].append(rv)

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

    # Apply cross-source errata reconstructions (Tit 1, Dn 3:91-100, Job 25 & 27, OCR typos, USFM paragraph markers)
    errata_list = apply_cross_source_errata(all_book_Payloads, chapters_by_book_order)
    audit["cross_source_errata_fixed"] = errata_list
    for order in sorted(books_meta.keys()):
        books_meta[order]["verse_count"] = all_book_Payloads[order]["verse_count"]
        fname = f"{order:02d}_{books_meta[order]['id']}.json"
        with open(os.path.join(BOOKS_JSON_DIR, fname), "w", encoding="utf-8") as f:
            json.dump(all_book_Payloads[order], f, indent=2, ensure_ascii=False)

    with open(os.path.join(DATA_DIR, "errata.json"), "w", encoding="utf-8") as f:
        json.dump(errata_list, f, indent=2, ensure_ascii=False)

    # Audit KS reading plans
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
            expected_c = set(range(1, b["chapter_count"] + 1))
            missing_c = sorted(expected_c - ch_set)
            if missing_c and len(missing_c) <= 5:
                audit["ks_reading_plan_bugs"].append({
                    "plan_id": kp["id"],
                    "plan_title": kp["title"],
                    "book": b["title"],
                    "missing_chapters": missing_c,
                })

    books_index = [books_meta[o] for o in sorted(books_meta.keys())]
    with open(os.path.join(JSON_DIR, "books.json"), "w", encoding="utf-8") as f:
        json.dump(books_index, f, indent=2, ensure_ascii=False)

    compact_verses = []
    for order in sorted(all_book_Payloads.keys()):
        bp = all_book_Payloads[order]
        for ch in bp["chapters"]:
            cnum = ch["chapter"]
            for v in ch["verses"]:
                compact_verses.append([order, cnum, v["verse"], v["text"]])
    with open(os.path.join(JSON_DIR, "verses_compact.json"), "w", encoding="utf-8") as f:
        json.dump(compact_verses, f, ensure_ascii=False, separators=(",", ":"))

    audit["total_verses"] = len(compact_verses)

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

    with open(os.path.join(DATA_DIR, "audit_report.json"), "w", encoding="utf-8") as f:
        json.dump(audit, f, indent=2, ensure_ascii=False)

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
            usfm_id TEXT UNIQUE NOT NULL,
            ks_book_id INTEGER NOT NULL,
            abbr TEXT NOT NULL,
            title TEXT NOT NULL,
            name_en TEXT NOT NULL,
            testament TEXT NOT NULL,
            category TEXT NOT NULL,
            deuterocanonical INTEGER NOT NULL DEFAULT 0,
            deuterocanonical_parts TEXT,
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
            usfm_id TEXT NOT NULL,
            book_abbr TEXT NOT NULL,
            book_title TEXT NOT NULL,
            testament TEXT NOT NULL,
            chapter INTEGER NOT NULL,
            verse INTEGER NOT NULL,
            verse_label TEXT NOT NULL,
            text TEXT NOT NULL,
            text_folded TEXT NOT NULL,
            paragraph_start INTEGER NOT NULL DEFAULT 0,
            headings_json TEXT,
            references_json TEXT,
            lines_json TEXT,
            UNIQUE(book_order, chapter, verse),
            FOREIGN KEY(book_order) REFERENCES books(book_order)
        );

        CREATE INDEX idx_verses_book_ch ON verses(book_order, chapter);
        CREATE INDEX idx_verses_abbr ON verses(book_abbr, chapter, verse);
        CREATE INDEX idx_verses_usfm ON verses(usfm_id, chapter, verse);

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
            "INSERT INTO books VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                b["order"], b["id"], b["usfm_id"], b["ks_book_id"], b["abbr"],
                b["title"], b["name_en"], b["testament"], b["category"],
                1 if b["deuterocanonical"] else 0, b.get("deuterocanonical_parts"),
                b["chapter_count"], b["verse_count"],
            ),
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
                p_start = 1 if v.get("p") else 0
                h_json = json.dumps(v["headings"], ensure_ascii=False) if "headings" in v else None
                r_json = json.dumps(v["references"], ensure_ascii=False) if "references" in v else None
                l_json = json.dumps(v["lines"], ensure_ascii=False) if "lines" in v else None
                verse_rows.append((
                    order, bp["id"], bp["usfm_id"], bp["abbr"], bp["title"], bp["testament"],
                    cnum, vnum, vlbl, txt, txt_folded, p_start, h_json, r_json, l_json
                ))

    cur.executemany(
        """INSERT INTO verses (
            book_order, book_id, usfm_id, book_abbr, book_title, testament,
            chapter, verse, verse_label, text, text_folded, paragraph_start,
            headings_json, references_json, lines_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
    print(f"Books: {len(books_index)} | Chapters: {len(raw_chapters) + 1} | Verses: {len(verse_rows)}")
    print(f"Book metadata bugs found & fixed: {len(audit['book_metadata_bugs'])}")
    print(f"Web vs Mobile API verse rendering discrepancies found & fixed: {len(audit['web_vs_mobile_api_discrepancies'])}")
    print(f"Cross-source errata reconstructed & fixed (Tit 1, Dn 3:91-100, Job 25 & 27, OCR): {len(errata_list)}")
    print(f"KS reading plan bugs found: {len(audit['ks_reading_plan_bugs'])}")
    print(f"SQLite DB size: {os.path.getsize(db_path) / (1024*1024):.2f} MB")


if __name__ == "__main__":
    main()
