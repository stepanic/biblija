#!/usr/bin/env python3
"""
Automatska detekcija sumnjivih mjesta u KS tekstu (biblija.ks.hr) bez tiskanog izdanja.

Ništa se ne popravlja: rezultat je popis kandidata za ručnu provjeru prema tisku,
poredan po vjerojatnosti da je stvarna greška online izdanja.

Izvori:
  KS     data/json/books/            biblija.ks.hr (s našim errata.json)
  FOI    downloads/cache/foi/74.json  FOI-jeva neovisna digitalizacija istog KS teksta
  U68    domovinatv/.cache/saric/usfm hrv_usfm (eBible), digitalizacija Zagrebačke Biblije 1968.
  SARIC  data/json/saric/             drugi prijevod, samo za strukturu i poravnanje
  BSB    downloads/bsb/interlinear/   hebrejska/grčka numeracija (66 knjiga), samo struktura

Slojevi:
  struktura   rupe, duplikati, redoslijed, stihovi koje imaju ostali izvori a KS nema
  poravnanje  stih pod krivim brojem (tekst pripada drugom retku, npr. Job 26,5 = 27,5)
  tekst       razlika KS-online u odnosu na FOI i U68 (glasanje dvaju neovisnih prijepisa)
  tipografija »« neupareni, '?' u riječi, ponovljena riječ, razmaci oko interpunkcije
  paralele    dvostruki odlomci (Ps 14/53, Ps 40/70, 2 Sam 22/Ps 18 …) s malim razlikama

    python3 scripts/audit_tekst.py      # → data/audit/sumnjivi.json + data/audit/SAZETAK.md
"""
import difflib
import glob
import json
import os
import re
import sys
import unicodedata
from collections import Counter, defaultdict

from rapidfuzz import fuzz, process

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
J = os.path.join(ROOT, "data", "json")
OUT = os.path.join(ROOT, "data", "audit")
U68_DIR = os.environ.get("U68_DIR", "/Users/ms/git/domovinatv/biblija/.cache/saric/usfm")

# ---------------------------------------------------------------- učitavanje

books = json.load(open(os.path.join(J, "books.json"), encoding="utf-8"))
META = {b["order"]: b for b in books}
USFM2ORDER = {b["usfm_id"]: b["order"] for b in books}


def book_file(order, sub="books"):
    hits = glob.glob(os.path.join(J, sub, f"{order:02d}_*.json"))
    return hits[0] if hits else None


def load_ks():
    """{order: {ch: [(v, text, headings)]}} u redoslijedu kako ga daje biblija.ks.hr."""
    out = {}
    for b in books:
        d = json.load(open(book_file(b["order"]), encoding="utf-8"))
        out[b["order"]] = {
            c["chapter"]: [(v["verse"], v["text"], [h["text"] for h in v.get("headings", [])]) for v in c["verses"]]
            for c in d["chapters"]
        }
    return out


def load_foi_ks():
    d = json.load(open(os.path.join(ROOT, "downloads", "cache", "foi", "74.json"), encoding="utf-8"))
    order_by_bid = {b["bid"]: books[i]["order"] for i, b in enumerate(d["books"])}
    out = defaultdict(lambda: defaultdict(dict))
    for v in d["verses"]:
        if v["text"]:
            out[order_by_bid[v["bid"]]][v["ch"]][v["v"]] = v["text"]
    return out


def load_u68():
    out = defaultdict(lambda: defaultdict(dict))
    for f in glob.glob(os.path.join(U68_DIR, "*.usfm")):
        m = re.search(r"\d+-(\w{3})hrv", os.path.basename(f))
        if not m or m.group(1) not in USFM2ORDER:
            continue
        order = USFM2ORDER[m.group(1)]
        t = open(f, encoding="utf-8").read()
        t = re.sub(r"\\f .*?\\f\*|\\x .*?\\x\*", " ", t, flags=re.S)
        ch, cur = 0, None
        for line in t.splitlines():
            if line.startswith("\\c "):
                ch = int(line.split()[1])
                continue
            mv = re.match(r"\\v (\d+)\S*\s*(.*)", line)
            if mv:
                cur = [ch, int(mv.group(1))]
                out[order][ch][cur[1]] = re.sub(r"\\[a-z0-9]+\*?", " ", mv.group(2)).strip()
            elif ch and line and not line.startswith(("\\s", "\\c", "\\h", "\\toc", "\\mt", "\\id", "\\ms", "\\r")) and cur:
                extra = re.sub(r"\\[a-z0-9]+\*?", " ", line).strip()
                if extra and cur[1] in out[order][cur[0]]:
                    out[order][cur[0]][cur[1]] += " " + extra
    return out


def load_saric():
    out = {}
    for b in books:
        f = book_file(b["order"], "saric")
        if f:
            d = json.load(open(f, encoding="utf-8"))
            out[b["order"]] = {int(c): {v: t for v, t in vs} for c, vs in d["chapters"].items()}
    return out


def load_bsb():
    out = {}
    en2order = {b["id"]: b["order"] for b in books}
    for f in glob.glob(os.path.join(ROOT, "downloads", "bsb", "interlinear", "*.json")):
        d = json.load(open(f, encoding="utf-8"))
        order = en2order.get(d["id"])
        if order:
            s = defaultdict(set)
            for ch, v, *_ in d["verses"]:
                s[ch].add(v)
            out[order] = s
    return out


# ---------------------------------------------------------------- pomoćno

def norm(s):
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.lower().replace("’", "'")
    s = re.sub(r"[^\w]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def ref(order, ch, v):
    return f"{META[order]['abbr']} {ch},{v}"


def word_diff(a, b):
    """Kratki opis razlike riječi: [(tip, KS, drugi)]."""
    wa, wb = a.split(), b.split()
    ops = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, wa, wb, autojunk=False).get_opcodes():
        if tag != "equal":
            ops.append([tag, " ".join(wa[i1:i2]), " ".join(wb[j1:j2])])
    return ops


findings = []


def flag(layer, kind, priority, order, ch, v, msg, **extra):
    findings.append({
        "ref": ref(order, ch, v) if v is not None else f"{META[order]['abbr']} {ch}",
        "book": order, "chapter": ch, "verse": v,
        "layer": layer, "kind": kind, "priority": priority, "msg": msg, **extra,
    })


# ---------------------------------------------------------------- slojevi

def check_structure(ks, u68, saric, bsb):
    for order, chs in ks.items():
        for ch, vs in chs.items():
            nums = [v for v, _, _ in vs]
            for n, c in Counter(nums).items():
                if c > 1:
                    flag("struktura", "duplikat", 1, order, ch, n, f"redak {n} se pojavljuje {c} puta")
            for v, t, _ in vs:
                if not t.strip():
                    flag("struktura", "prazan", 1, order, ch, v, "redak bez teksta")
            jumps = [(a, b) for a, b in zip(nums, nums[1:]) if b != a + 1]
            if jumps:
                flag("struktura", "redoslijed", 3, order, ch, None,
                     "nenizan redoslijed redaka: " + ", ".join(f"{a}→{b}" for a, b in jumps),
                     sequence=nums)
            have = set(nums)
            refs = [s for s in (
                set(u68.get(order, {}).get(ch, {})),
                set(saric.get(order, {}).get(ch, {})),
                bsb.get(order, {}).get(ch, set()),
            ) if s]
            if len(refs) < 2:
                continue
            votes = Counter(v for s in refs for v in s)
            missing = sorted(v for v, c in votes.items() if c >= 2 and v not in have)
            extra = sorted(v for v in have if votes.get(v, 0) == 0 and v != 0)
            if missing:
                flag("struktura", "nedostaje", 1, order, ch, None,
                     f"redci koje imaju bar dva usporedna izvora, a KS nema: {compact(missing)}", verses=missing)
            if extra:
                flag("struktura", "visak", 2, order, ch, None,
                     f"redci koje nema nijedan usporedni izvor: {compact(extra)}", verses=extra)
        missing_ch = sorted(set(u68.get(order, {})) - set(chs) - {0})
        if missing_ch:
            flag("struktura", "nedostaje_poglavlje", 1, order, missing_ch[0], None,
                 f"poglavlja u U68 kojih nema u KS: {missing_ch}")


def compact(nums):
    out, start = [], None
    for i, n in enumerate(nums):
        if start is None:
            start = n
        if i + 1 == len(nums) or nums[i + 1] != n + 1:
            out.append(f"{start}–{n}" if n != start else f"{n}")
            start = None
    return ", ".join(out)


def check_alignment(ks, u68):
    """Tekst KS retka uspoređen s istim brojem u U68 i s najboljim retkom iste knjige."""
    for order, chs in ks.items():
        pool = {(c, v): norm(t) for c, vv in u68.get(order, {}).items() for v, t in vv.items() if t}
        if not pool:
            continue
        keys, texts = list(pool), list(pool.values())
        for ch, vs in chs.items():
            for v, t, _ in vs:
                a = norm(t)
                if len(a) < 25:
                    continue
                same = pool.get((ch, v))
                s_same = fuzz.ratio(a, same) if same else 0
                if s_same >= 70:
                    continue
                top = process.extract(a, texts, scorer=fuzz.ratio, limit=2)
                best = top[0] if top else None
                ambiguous = len(top) > 1 and top[1][1] >= best[1] - 5   # npr. isti natpis psalma
                if best and not ambiguous and best[1] >= 80 and best[1] - s_same >= 25:
                    bc, bv = keys[best[2]]
                    flag("poravnanje", "krivi_broj", 1, order, ch, v,
                         f"tekst odgovara retku {ref(order, bc, bv)} u U68 ({best[1]:.0f} %), "
                         f"a istom broju samo {s_same:.0f} %",
                         suggested=ref(order, bc, bv), ks_text=t)


def check_text(ks, foi, u68):
    stats = Counter()
    for order, chs in ks.items():
        for ch, vs in chs.items():
            fch = foi.get(order, {}).get(ch, {})
            uch = u68.get(order, {}).get(ch, {})
            for v, t, _ in vs:
                a = norm(t)
                f = fch.get(v)
                u = uch.get(v)
                # FOI ponegdje ima drukčiju numeraciju: traži se po tekstu u istom poglavlju
                if f is not None and fuzz.ratio(a, norm(f)) < 60 and fch:
                    alt = process.extractOne(a, {k: norm(x) for k, x in fch.items()}, scorer=fuzz.ratio)
                    if alt and alt[1] >= 80:
                        f = fch[alt[2]]
                fn = norm(f) if f else None
                un = norm(u) if u else None
                if fn is None and un is None:
                    stats["bez_usporedbe"] += 1
                    continue
                if a == fn or (fn is None and a == un):
                    stats["slaze_se"] += 1
                    continue
                if fn is not None and un is not None and fn == un:
                    d = word_diff(a, fn)
                    if all(x[0] == "delete" and x[1] in HEBREW_LETTERS for x in d):
                        stats["akrostih"] += 1
                        flag("tekst", "akrostih", 3, order, ch, v,
                             "KS-online ima ime hebrejskog slova akrostiha, FOI i U68 nemaju; provjeriti tisak",
                             ks_text=t, diff=d)
                        continue
                    stats["ks_u_manjini"] += 1
                    flag("tekst", "ks_u_manjini", 1, order, ch, v,
                         "FOI i U68 se slažu, KS-online se razlikuje",
                         ks_text=t, foi_text=f, diff=word_diff(a, fn))
                elif a == un:
                    stats["foi_odstupa"] += 1
                elif fn is not None:
                    d = word_diff(a, fn)
                    if "?" in f and re.fullmatch(re.escape(norm(f.replace("?", "QQQ"))).replace("qqq", r"\w{0,2}"), a):
                        # FOI je naglašeno slovo (npr. „Tâ”) zamijenio s '?': tisak ima naglasak, KS-online možda ne
                        stats["naglasak"] += 1
                        flag("tekst", "naglasak", 3, order, ch, v,
                             "FOI ovdje ima naglašeno slovo (pokvareno u '?'); provjeriti ima li tisak naglasak koji KS-online nema",
                             ks_text=t, foi_text=f)
                        continue
                    if d and all(x[1] in HEBREW_LETTERS | {""} and x[2] in HEBREW_LETTERS | {""} for x in d):
                        stats["akrostih"] += 1
                        continue
                    if fn and un and fuzz.ratio(fn, un) < 60 and fuzz.ratio(a, fn) < 60:
                        continue  # vjerojatno krivo poravnanje, hvata ga sloj poravnanje
                    stats["ks_razlicit_od_foi"] += 1
                    flag("tekst", "ks_razlicit_od_foi", 2, order, ch, v,
                         "KS-online i FOI se razlikuju (U68 je treći, starije izdanje)",
                         ks_text=t, foi_text=f, u68_text=u, diff=d)
    return stats


HEBREW_LETTERS = set("alef bet gimel dalet he vav waw zajin het tet jod kaf lamed mem nun samek ajin pe sade kof kof res sin sin tau tav vau".split())

TYPO = [
    ("upitnik_u_rijeci", re.compile(r"(?:^|\s)\?\w|\w\?\w")),
    ("ponovljena_rijec", re.compile(r"\b(\w{3,})\s+\1\b", re.I)),
    ("razmak_prije_interpunkcije", re.compile(r"\w\s+[,.;:!?](?!\S*»)")),
    ("nema_razmaka_iza_interpunkcije", re.compile(r"[a-zčćžšđ][,;:][A-Za-zČĆŽŠĐčćžšđ]|[a-zčćžšđ]\.[A-ZČĆŽŠĐ]")),
    ("dvostruki_razmak", re.compile(r"\S  +\S")),
    ("znamenka", re.compile(r"\d")),
    ("cudan_znak", re.compile(r"[^\w\s.,;:!?»«‘’'\"()\[\]\-–—…/*]")),
]


def check_typography(ks):
    for order, chs in ks.items():
        for ch, vs in chs.items():
            for v, t, _ in vs:
                for kind, rx in TYPO:
                    m = rx.search(t)
                    if m:
                        flag("tipografija", kind, 2 if kind in ("upitnik_u_rijeci", "ponovljena_rijec") else 3,
                             order, ch, v, f"„…{t[max(0, m.start() - 20):m.end() + 20]}…”", ks_text=t)
            # navodnici se mogu protezati preko više redaka: provjera po poglavlju
            depth = 0
            for v, t, _ in vs:
                for c in t:
                    depth += (c == "»") - (c == "«")
                if depth < 0 or depth > 1:
                    flag("tipografija", "navodnici", 2, order, ch, v,
                         f"neupareni »« (dubina {depth} nakon ovog retka)", ks_text=t)
                    depth = max(0, min(depth, 1))
            if depth:
                flag("tipografija", "navodnici", 3, order, ch, None, "poglavlje završava s otvorenim »")


# (knjiga, poglavlje, od, do) ↔ (knjiga, poglavlje, od, do): isti tekst na dva mjesta
PARALLELS = [
    (("Ps", 14, 1, 7), ("Ps", 53, 1, 7)),
    (("Ps", 40, 14, 18), ("Ps", 70, 2, 6)),
    (("Ps", 57, 8, 12), ("Ps", 108, 2, 6)),
    (("Ps", 60, 7, 14), ("Ps", 108, 7, 14)),
    (("2 Sam", 22, 1, 51), ("Ps", 18, 1, 51)),
    (("1 Ljet", 16, 8, 22), ("Ps", 105, 1, 15)),
    (("1 Ljet", 16, 23, 33), ("Ps", 96, 1, 13)),
    (("2 Kr", 18, 13, 37), ("Iz", 36, 1, 22)),
    (("2 Kr", 19, 1, 37), ("Iz", 37, 1, 38)),
    (("2 Kr", 24, 18, 20), ("Jr", 52, 1, 3)),
    (("Ezr", 2, 1, 70), ("Neh", 7, 6, 73)),
    (("Mih", 4, 1, 3), ("Iz", 2, 2, 4)),
]


def check_parallels(ks):
    abbr2order = {b["abbr"]: b["order"] for b in books}
    for (ab, ca, a1, a2), (bb, cb, b1, b2) in PARALLELS:
        oa, ob = abbr2order.get(ab), abbr2order.get(bb)
        if not oa or not ob:
            print(f"  paralela preskočena, nepoznata kratica: {ab}/{bb}", file=sys.stderr)
            continue
        A = [(v, t) for v, t, _ in ks[oa].get(ca, []) if a1 <= v <= a2]
        B = {v: norm(t) for v, t, _ in ks[ob].get(cb, []) if b1 <= v <= b2}
        for v, t in A:
            best = process.extractOne(norm(t), B, scorer=fuzz.ratio) if B else None
            if best and 85 <= best[1] < 100:
                d = word_diff(norm(t), best[0])
                if d and sum(len(x[1].split()) + len(x[2].split()) for x in d) <= 4:
                    flag("paralele", "mala_razlika", 3, oa, ca, v,
                         f"gotovo isto kao {ref(ob, cb, best[2])} ({best[1]:.0f} %); "
                         "provjeriti je li razlika u tisku ili prijepisu",
                         other=ref(ob, cb, best[2]), diff=d)


# Redci koje kritička izdanja (NA28) izostavljaju; KS ih tiska u bilješci ili ih nema.
NT_OMITTED = {
    "Mt": [(17, 21), (18, 11), (23, 14)], "Mk": [(7, 16), (9, 44), (9, 46), (11, 26), (15, 28)],
    "Lk": [(17, 36), (23, 17)], "Iv": [(5, 4)], "Dj": [(8, 37), (15, 34), (24, 7), (28, 29)],
    "Rim": [(16, 24)],
}


def refine():
    """Smanjuje lažne uzbune: sustavni pomak numeracije i tekstnokritički izostavljeni redci."""
    global findings
    omitted = {(b["order"], c, v) for b in books for c, v in NT_OMITTED.get(b["abbr"], [])}
    out = []
    for f in findings:
        if f["kind"] == "prazan" and (f["book"], f["chapter"], f["verse"]) in omitted:
            f.update(priority=3, kind="tekstnokriticki", msg="redak bez teksta; NA28 ga izostavlja, provjeriti kako je u tisku")
        if f["kind"] == "nedostaje" and f["book"] in {o for o, _, _ in omitted}:
            rest = [v for v in f["verses"] if (f["book"], f["chapter"], v) not in omitted]
            if not rest:
                f.update(priority=3, kind="tekstnokriticki",
                         msg="nema retka koji NA28 izostavlja (" + compact(f["verses"]) + "), provjeriti kako je u tisku")
        out.append(f)
    # pomak numeracije unutar poglavlja (npr. natpis psalma kao redak 1) → jedan nalaz P3
    groups = defaultdict(list)
    for f in out:
        if f["kind"] == "krivi_broj":
            sc, sv = map(int, f["suggested"].rsplit(" ", 1)[1].split(","))
            groups[(f["book"], f["chapter"])].append((f, sc, sv))
    drop = set()
    for (o, ch), items in groups.items():
        offsets = Counter(sv - f["verse"] for f, sc, sv in items if sc == ch)
        for f, sc, sv in items:
            if sc != ch:
                continue  # prijelaz u drugo poglavlje ostaje P1
            off = sv - f["verse"]
            if offsets[off] >= 2 or abs(off) == 1:
                f.update(priority=3, kind="pomak_numeracije",
                         msg=f"tekst je u U68 (1968.) pod {f['suggested']}: vjerojatno razlika numeracije izdanja")
            elif abs(off) > 1:
                f["priority"] = 2
    flagged_align = {(f["book"], f["chapter"], f["verse"]) for f in out if f["kind"] == "krivi_broj"}
    out = [f for f in out if not (f["layer"] == "tekst" and (f["book"], f["chapter"], f["verse"]) in flagged_align)]
    findings = out


# ---------------------------------------------------------------- izlaz

def main():
    print("učitavam izvore…", file=sys.stderr)
    ks, foi, u68, saric, bsb = load_ks(), load_foi_ks(), load_u68(), load_saric(), load_bsb()
    print(f"  KS {sum(len(v) for c in ks.values() for v in c.values())} redaka, "
          f"FOI {sum(len(v) for c in foi.values() for v in c.values())}, "
          f"U68 {sum(len(v) for c in u68.values() for v in c.values())}, "
          f"Šarić {len(saric)} knjiga, BSB {len(bsb)} knjiga", file=sys.stderr)

    errata = json.load(open(os.path.join(ROOT, "data", "errata.json"), encoding="utf-8"))
    errata = errata if isinstance(errata, list) else errata.get("errata", [])
    known = {(e["book_order"], e["chapter"], e["verse"]) for e in errata}

    print("struktura…", file=sys.stderr); check_structure(ks, u68, saric, bsb)
    print("poravnanje…", file=sys.stderr); check_alignment(ks, u68)
    print("tekst…", file=sys.stderr); stats = check_text(ks, foi, u68)
    print("tipografija…", file=sys.stderr); check_typography(ks)
    print("paralele…", file=sys.stderr); check_parallels(ks)

    refine()
    for f in findings:
        f["in_errata"] = (f["book"], f["chapter"], f["verse"]) in known
    findings.sort(key=lambda f: (f["priority"], f["book"], f["chapter"], f["verse"] or 0))

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "sumnjivi.json"), "w", encoding="utf-8") as fh:
        json.dump({"text_stats": stats, "errata_known": len(known), "findings": findings},
                  fh, ensure_ascii=False, indent=1)

    by = Counter((f["layer"], f["kind"], f["priority"]) for f in findings)
    lines = ["# Automatska provjera KS teksta: sažetak", "",
             "Generira `scripts/audit_tekst.py`. Kandidati za ručnu provjeru prema tisku, ne potvrđene greške.", "",
             "| Sloj | Vrsta | Prioritet | Broj |", "|---|---|---|---|"]
    lines += [f"| {l} | {k} | {p} | {n} |" for (l, k, p), n in sorted(by.items(), key=lambda x: (x[0][2], x[0][0]))]
    lines += ["", "Usporedba teksta (redaka): " + ", ".join(f"{k} {v}" for k, v in stats.most_common()), "",
              "## Prioritet 1", ""]
    for f in findings:
        if f["priority"] == 1:
            lines.append(f"- **{f['ref']}** · {f['layer']}/{f['kind']}{' · već u errata' if f['in_errata'] else ''}: {f['msg']}")
    with open(os.path.join(OUT, "SAZETAK.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"{len(findings)} nalaza → data/audit/sumnjivi.json, data/audit/SAZETAK.md", file=sys.stderr)
    for (l, k, p), n in sorted(by.items(), key=lambda x: (x[0][2], x[0][0])):
        print(f"  P{p} {l}/{k}: {n}", file=sys.stderr)


if __name__ == "__main__":
    main()
