#!/usr/bin/env python3
"""
Builds Croatian Bible translations from the local FOI cache
(scripts/fetch_foi.py && scripts/parse_foi.py) into data/json/<slug>/<NN>_<id>.json,
one file per book, keyed like our data/json/books.json, plus data/json/translations.json.

Included translations from library.foi.hr/biblija:
  - saric     (FOI 75): Sveto pismo Staroga i Novoga zavjeta (Ivan Ev. Šarić, 1941.–1942.), 73 knjige
                        (FOI 32 "Novi zavjet (Šarić)" je 100 % identičan NZ-u iz 75)
  - katancic  (FOI 76): Sveto pismo (Matija Petar Katančić, Budim 1831.), 67 knjiga
                        (FOI 34 "Novi zavjet (Katančić)" je 100 % identičan NZ-u iz 76)
  - rupcic    (FOI 11): Novi zavjet (Ljudevit Rupčić, 1961.), 27 knjiga NZ
  - raspudic  (FOI 37): Novi zavjet (Gracijan Raspudić, 1987.), 27 knjiga NZ
  - gusic     (FOI 35): Novi zakon (Ivan Rupert Gusić, kajkavski Novi zavjet, 1821.), 27 knjiga NZ

FOI 74 (Biblija KS) i 14 (Duda–Fućak NZ) se ne uvoze jer već imamo čišći primarni KS
iz biblija.ks.hr.

    python3 scripts/build_foi_translations.py                # svi prijevodi
    python3 scripts/build_foi_translations.py saric katancic # odabrani
"""
import json
import os
import re
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FOI_DIR = os.path.join(ROOT, "downloads", "cache", "foi")
JSON_DIR = os.path.join(ROOT, "data", "json")

TRANSLATION_SPECS = [
    {
        "slug": "saric",
        "foi_id": "75",
        "name": "Šarić",
        "short_label": "Šarić",
        "title": "Sveto pismo Staroga i Novoga zavjeta (Ivan Ev. Šarić, Sarajevo 1941.–1942.)",
        "notice": "Šarić, Sveto pismo (1941.–1942.) · digitalizacija library.foi.hr",
        "scope": "all",
        "via": "library.foi.hr/biblija (prijevod 75)",
    },
    {
        "slug": "katancic",
        "foi_id": "76",
        "name": "Katančić",
        "short_label": "Katančić",
        "title": "Sveto pismo (Matija Petar Katančić, Budim 1831.)",
        "notice": "Katančić, Sveto pismo (Budim 1831.) · digitalizacija library.foi.hr · stari pravopis",
        "scope": "all",
        "via": "library.foi.hr/biblija (prijevod 76)",
    },
    {
        "slug": "rupcic",
        "foi_id": "11",
        "name": "Rupčić",
        "short_label": "Rupčić (NZ)",
        "title": "Novi zavjet (Ljudevit Rupčić, 1961.)",
        "notice": "Rupčić, Novi zavjet (1961.) · digitalizacija library.foi.hr",
        "scope": "nt",
        "via": "library.foi.hr/biblija (prijevod 11)",
    },
    {
        "slug": "raspudic",
        "foi_id": "37",
        "name": "Raspudić",
        "short_label": "Raspudić (NZ)",
        "title": "Novi zavjet (Gracijan Raspudić, 1987.)",
        "notice": "Raspudić, Novi zavjet (1987.) · digitalizacija library.foi.hr",
        "scope": "nt",
        "via": "library.foi.hr/biblija (prijevod 37)",
    },
    {
        "slug": "gusic",
        "foi_id": "35",
        "name": "Gusić",
        "short_label": "Gusić (kajk. NZ)",
        "title": "Novi zakon (Ivan Rupert Gusić, kajkavski rukopis 1821.)",
        "notice": "Gusić, kajkavski Novi zavjet (1821.) · digitalizacija library.foi.hr · stari kajkavski pravopis",
        "scope": "nt",
        "via": "library.foi.hr/biblija (prijevod 35)",
    },
]


def load_foi(tra: str):
    path = os.path.join(FOI_DIR, f"{tra}.json")
    if not os.path.exists(path):
        sys.exit(f"Nema {path} — pokreni scripts/fetch_foi.py {tra} i scripts/parse_foi.py {tra}")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# --- Vulgata (Katančić 76 & Gusić 35) preslikavanje na KS (hebrejska / kritička numeracija) ---

# FOI je Vulgatine psalme u Katančiću prenumerirao na hebrejske brojeve samo do 113. Od 114 nadalje:
# 114 drži hebr. 114 i 115 (brojevi redaka kreću ispočetka), 115–116 su dvije polovice hebr. 116,
# 147–148 dvije polovice hebr. 147, a 149–151 su hebr. 148–150.
KATANCIC_PSALM_REMAP = {
    (114, 1): 115,
    (115, 0): 116,
    (148, 0): 147,
    (149, 0): 148,
    (150, 0): 149,
    (151, 0): 150,
}

# Vulgatine podjele poglavlja i redaka (SZ i NZ) koje odstupaju od KS-a:
# (FOI bid, Vulgata ch, prvi redak, zadnji redak, naš ch, pomak retka)
VULGATE_VERSE_REMAP = [
    # SZ (Katančić)
    ("002", 8, 1, 4, 7, 25), ("002", 8, 5, 32, 8, -4),          # Izl 7,26–29
    ("003", 6, 1, 7, 5, 19), ("003", 6, 8, 30, 6, -7),          # Lev 5,20–26
    ("004", 16, 36, 50, 17, -35), ("004", 17, 1, 13, 17, 15),   # Br 17,1–15
    ("016", 4, 1, 6, 3, 32), ("016", 4, 7, 23, 4, -6),          # Neh 3,33–38
    ("026", 20, 45, 49, 21, -44), ("026", 21, 1, 32, 21, 5),    # Ez 21,1–5
    ("038", 1, 18, 21, 2, -17), ("038", 2, 1, 13, 2, 4),        # Zah 2,1–4
    ("029", 2, 28, 32, 3, -27), ("029", 3, 1, 21, 4, 0),        # Jl 3 i 4
    ("039", 4, 1, 6, 3, 18),                                    # Mal 3,19–24
    # NZ (Katančić i Gusić): Vulgata spaja ili dijeli pojedine retke
    ("040", 17, 15, 26, 17, 1),                                 # Mt 17: Vulgata spaja 14+15 u 14
    ("041", 8, 39, 39, 9, -38), ("041", 9, 1, 49, 9, 1),        # Mk 8,39 -> Mk 9,1; Mk 9,1–49 -> 9,2–50
    ("043", 6, 52, 72, 6, -1),                                  # Iv 6: Vulgata dijeli 51 na 51+52
    ("044", 7, 56, 59, 7, 1),                                   # Dj 7: Vulgata spaja 55+56 u 55
    ("044", 14, 7, 27, 14, 1),                                  # Dj 14: Vulgata spaja 6+7 u 6
    ("052", 4, 12, 17, 4, 1),                                   # 1 Sol 4: Vulgata spaja 11+12 u 11
    ("053", 2, 11, 16, 2, 1),                                   # 2 Sol 2: Vulgata spaja 10+11 u 10
]

VULGATE_TEXT_NOTE = {
    "016a": "Tobija",
    "016b": "Judita",
    "017": "Estera",
    "022b": "Sirah",
}

# --- Šarić (75): čišćenje zalutalih međunaslova i oznaka fusnota (*) te preslikavanje ---

SARIC_LEAKED_HEADING_RE = re.compile(
    r"^\("
    r"(?:Psalam\s+\d"
    r"|[IVX]+\.\s"
    r"|\d+\.\s"
    r"|(?:Prvo|Drugo|Treće|Četvrto|Peto|Šesto)\s+pjevanje:"
    r"|GOVOR\s"
    r"|Čitanje Zakona|Poslanje dvanaestorice|Hvalospjev Marijin|Drugi navještaj muke"
    r"|Poruka s praznoga groba|Djelovanje Duha|Isus osuđen na smrt"
    r"|Savao progoni Crkvu|Savao propovijeda u Damasku|Prava pobožnost)"
)

SARIC_VERSE_REMAP = [
    ("016", 7, 68, 73, 7, -1),   # Neh 7: KS spaja 67+68 u 67, pa su 69–73 kod nas 68–72
    ("019", 127, 6, 6, 127, -1), # Ps 127: Šarić dijeli 5 na 5+6
    ("027", 3, 24, 33, 3, 67),   # Dn 3: bez deuterokanonskih 24–90, retci 24–33 su kod nas 91–100
]

SARIC_BOOK_NOTES = {
    "018": "Šarić u Job 24–27 zadržava kanonski redoslijed redaka, dok ih KS preslaguje po govornicima.",
    "027": "Šarićev prijevod Daniela ne sadrži deuterokanonske dodatke u Dn 3,24–90 te poglavlja Dn 13 i 14.",
}

# --- Rupčić (11): popravak FOI-jevih grešaka (3 Iv spremljen kao pogl. 2, (N) M prefiksi) ---
RUPCIC_OMITTED_PREFIX_RE = re.compile(r"^\((\d+)\)\s*(\d+)\s+")


def append_or_merge(verse_list: list, num: int, text: str):
    if not text:
        return
    if verse_list and verse_list[-1][0] == num:
        verse_list[-1][1] = f"{verse_list[-1][1]} {text}"
    else:
        verse_list.append([num, text])


def clean_asterisks(text: str) -> str:
    text = text.replace("*", "")
    text = re.sub(r"\s+([!?,.;:»”])", r"\1", text)
    return re.sub(r"\s+", " ", text).strip()


def remap_vulgate(bid: str, ch: int, v: int, run: int):
    if bid == "019":
        return KATANCIC_PSALM_REMAP.get((ch, run), ch), v
    if bid == "022b" and ch == 1 and run == 0:
        return 0, v  # Proslov Siraha -> poglavlje 0
    for b, c, first, last, new_ch, offset in VULGATE_VERSE_REMAP:
        if b == bid and c == ch and first <= v <= last:
            return new_ch, v + offset
    return ch, v


def build_saric(foi_data: dict, order_by_bid: dict):
    chapters = defaultdict(lambda: defaultdict(list))
    for v in foi_data["verses"]:
        bid, ch, num = v["bid"], v["ch"], v["v"]
        lines = []
        for l in v["lines"]:
            if SARIC_LEAKED_HEADING_RE.match(l):
                continue
            if bid == "040" and ch == 13 and num == 3 and l == "(»Izađe sijač da sije.)":
                l = "»Izađe sijač da sije."
            lines.append(l)
        text = clean_asterisks(" ".join(lines))
        for b, c, first, last, new_ch, offset in SARIC_VERSE_REMAP:
            if b == bid and c == ch and first <= num <= last:
                ch, num = new_ch, num + offset
                break
        append_or_merge(chapters[order_by_bid[bid]][ch], num, text)
    notes = {order_by_bid[b]: note for b, note in SARIC_BOOK_NOTES.items()}
    return chapters, notes


def build_katancic(foi_data: dict, order_by_bid: dict):
    chapters = defaultdict(lambda: defaultdict(list))
    prev, run = None, 0
    for v in foi_data["verses"]:
        bid, ch, num = v["bid"], v["ch"], v["v"]
        key = (bid, ch)
        if prev and prev[0] == key and num <= prev[1]:
            run += 1
        elif not prev or prev[0] != key:
            run = 0
        prev = (key, num)
        lines = [
            l for l in v["lines"]
            if not (bid == "024" and ch == 52 and num == 34 and l != v["lines"][0])
            and not (bid == "066" and ch == 22 and num == 21 and l == "S V E R H A")
        ]
        text = " ".join(lines).strip()
        ch, num = remap_vulgate(bid, ch, num, run)
        append_or_merge(chapters[order_by_bid[bid]][ch], num, text)
    notes = {
        order_by_bid[b]: (
            f"Katančić prevodi Vulgatu, čija je knjiga {name} drugi tekst, "
            "ne samo druga numeracija; retci se poravnavaju samo po broju."
        )
        for b, name in VULGATE_TEXT_NOTE.items()
    }
    return chapters, notes


def build_rupcic(foi_data: dict, order_by_bid: dict):
    chapters = defaultdict(lambda: defaultdict(list))
    seen_counts = defaultdict(int)
    for v in foi_data["verses"]:
        bid, ch, num = v["bid"], v["ch"], v["v"]
        text = v["text"].strip()
        # FOI je 3. Ivanovu (064) spremio kao poglavlje 2 umjesto 1
        if bid == "064" and ch == 2:
            ch = 1
        # FOI je kod ispuštenih redaka "(44) 45 Tekst..." uzeo 44 kao broj retka umjesto 45
        m = RUPCIC_OMITTED_PREFIX_RE.match(text)
        if m and int(m.group(1)) == num:
            num = int(m.group(2))
            text = text[m.end():].strip()
        seen_counts[(bid, ch, num)] += 1
        occ = seen_counts[(bid, ch, num)]
        # U 1 Iv 5,12 drugi zapis s brojem 12 je zalutali međunaslov
        if bid == "062" and ch == 5 and num == 12 and occ == 2:
            continue
        # U Lk 14,11 drugi zapis s brojem 11 je zapravo redak 12
        if bid == "042" and ch == 14 and num == 11 and occ == 2:
            num = 12
        append_or_merge(chapters[order_by_bid[bid]][ch], num, text)
    return chapters, {}


def build_raspudic(foi_data: dict, order_by_bid: dict):
    chapters = defaultdict(lambda: defaultdict(list))
    seen_counts = defaultdict(int)
    for v in foi_data["verses"]:
        bid, ch, num = v["bid"], v["ch"], v["v"]
        seen_counts[(bid, ch, num)] += 1
        occ = seen_counts[(bid, ch, num)]
        # FOI je Mt 22,12 spremio kao drugi 22,11, a Mt 23,17 kao drugi 23,16
        if bid == "040" and ch == 22 and num == 11 and occ == 2:
            num = 12
        elif bid == "040" and ch == 23 and num == 16 and occ == 2:
            num = 17
        text = clean_asterisks(v["text"])
        append_or_merge(chapters[order_by_bid[bid]][ch], num, text)
    return chapters, {}


def build_gusic(foi_data: dict, order_by_bid: dict):
    chapters = defaultdict(lambda: defaultdict(list))
    for v in foi_data["verses"]:
        bid, ch, num = v["bid"], v["ch"], v["v"]
        ch, num = remap_vulgate(bid, ch, num, 0)
        append_or_merge(chapters[order_by_bid[bid]][ch], num, v["text"].strip())
    return chapters, {}


BUILDERS = {
    "saric": build_saric,
    "katancic": build_katancic,
    "rupcic": build_rupcic,
    "raspudic": build_raspudic,
    "gusic": build_gusic,
}


def write_translation(spec: dict, chapters: dict, notes: dict, meta_by_order: dict):
    slug = spec["slug"]
    out_dir = os.path.join(JSON_DIR, slug)
    os.makedirs(out_dir, exist_ok=True)
    for fname in os.listdir(out_dir):
        if fname.endswith(".json"):
            os.remove(os.path.join(out_dir, fname))

    source_meta = {
        "slug": slug,
        "name": spec["name"],
        "short_label": spec["short_label"],
        "title": spec["title"],
        "notice": spec["notice"],
        "scope": spec["scope"],
        "via": spec["via"],
    }

    available, total_verses = [], 0
    for order in sorted(chapters):
        meta = meta_by_order[order]
        chs = {str(ch): vs for ch, vs in sorted(chapters[order].items())}
        payload = {
            "order": order,
            "id": meta["id"],
            "name": spec["name"],
            "title": spec["title"],
            "via": spec["via"],
            "chapters": chs,
        }
        if order in notes:
            payload["note"] = notes[order]
        name = f"{order:02d}_{meta['id']}.json"
        with open(os.path.join(out_dir, name), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        available.append(order)
        total_verses += sum(len(vs) for vs in chs.values())

    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump({**source_meta, "books": available}, f, ensure_ascii=False, separators=(",", ":"))

    missing = [meta_by_order[o]["abbr"] for o in meta_by_order if o not in chapters]
    missing_str = "sve knjige" if not missing else (
        "samo NZ (47–73)" if available == list(range(47, 74)) else f"nema: {', '.join(missing)}"
    )
    print(f"{spec['name']:<10} ({slug}): {len(available):>2} knjiga, {total_verses:>6} redaka ({missing_str})")
    return {**source_meta, "books": available, "book_count": len(available), "verse_count": total_verses}


def main():
    books = json.load(open(os.path.join(JSON_DIR, "books.json"), encoding="utf-8"))
    ks = load_foi("74")
    if len(ks["books"]) != len(books):
        sys.exit(f"FOI KS ima {len(ks['books'])} knjiga, očekivano {len(books)}")
    order_by_bid = {b["bid"]: books[i]["order"] for i, b in enumerate(ks["books"])}
    meta_by_order = {b["order"]: b for b in books}

    selected = set(sys.argv[1:]) if len(sys.argv) > 1 else {s["slug"] for s in TRANSLATION_SPECS}
    catalog = []
    for spec in TRANSLATION_SPECS:
        slug = spec["slug"]
        if slug in selected:
            foi_data = load_foi(spec["foi_id"])
            chapters, notes = BUILDERS[slug](foi_data, order_by_bid)
            info = write_translation(spec, chapters, notes, meta_by_order)
            catalog.append(info)
        else:
            idx_path = os.path.join(JSON_DIR, slug, "index.json")
            if os.path.exists(idx_path):
                catalog.append(json.load(open(idx_path, encoding="utf-8")))

    with open(os.path.join(JSON_DIR, "translations.json"), "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
