#!/usr/bin/env python3
"""
Usporedba teksta s biblija.me (downloads/cache/biblijame/, scripts/fetch_biblijame.py)
s KS-online (data/json/books, s našim errata), FOI-jevom digitalizacijom KS-a,
Zagrebačkom 1968. (U68, eBible) i nalazima audita (data/audit/sumnjivi.json).

Pitanja:
  1. Koji je to prijevod i iz kojeg je izvora (kopija biblija.ks.hr ili neovisan prijepis)?
  2. Za svaki nalaz audita: s kim se biblija.me slaže?

Izlaz ne sadrži tekst s biblija.me (autorsko pravo), samo mjesta i presude.

    python3 scripts/compare_biblijame.py   # → data/audit/biblijame.json + data/audit/BIBLIJAME.md
"""
import glob
import json
import os
import re
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import audit_tekst as A  # noqa: E402  (učitavanje izvora i norm())

ROOT = A.ROOT
CACHE = os.path.join(ROOT, "downloads", "cache", "biblijame")
BOOKS = json.load(open(os.path.join(ROOT, "scripts", "biblijame_books.json"), encoding="utf-8"))
OZ2ORDER = {b["oznaka"]: int(b["ks-knjiga"]) for b in BOOKS}


def clean(t):
    return re.sub(r"\s+", " ", t or "").strip()


def load_bme():
    """{order: {ch: {v: text}}}; v je int kad je redak broj, inače string (npr. '1a')."""
    out = defaultdict(lambda: defaultdict(dict))
    raw_spaces = Counter()
    dup = []
    for f in glob.glob(os.path.join(CACHE, "*.json")):
        oz, ch = os.path.basename(f)[:-5].split("_")
        order = OZ2ORDER[oz]
        d = json.load(open(f, encoding="utf-8"))
        for r in d.get("content", []):
            v = r["redak"]
            v = int(v) if str(v).isdigit() else str(v)
            c = int(r["glava"]) if str(r["glava"]).isdigit() else r["glava"]
            raw_spaces["dvostruki"] += "  " in r["text"]
            raw_spaces["ukupno"] += 1
            if v in out[order][c]:
                dup.append(f"{oz} {c},{v}")
                continue
            out[order][c][v] = clean(r["text"])
    return out, raw_spaces, dup


def main():
    bme, spaces, dup = load_bme()
    ks, foi, u68 = A.load_ks(), A.load_foi_ks(), A.load_u68()
    n = A.norm

    # ---- 1. sličnost s izvorima po retku
    agree = Counter()
    only_bme, only_ks = [], []
    for order, chs in ks.items():
        for ch, verses in chs.items():
            for v, t, _ in verses:
                b = bme.get(order, {}).get(ch, {}).get(v)
                if b is None:
                    only_ks.append(A.ref(order, ch, v))
                    continue
                agree["redaka"] += 1
                nb = n(b)
                agree["= KS-online"] += nb == n(t)
                f = foi.get(order, {}).get(ch, {}).get(v)
                if f:
                    agree["ima FOI"] += 1
                    agree["= FOI"] += nb == n(f)
                u = u68.get(order, {}).get(ch, {}).get(v)
                if u:
                    agree["ima U68"] += 1
                    agree["= U68"] += nb == n(u)
    for order, chs in bme.items():
        for ch, vs in chs.items():
            for v in vs:
                if not any(x[0] == v for x in ks.get(order, {}).get(ch, [])):
                    only_bme.append(f"{A.META[order]['abbr']} {ch},{v}")

    # ---- 2. errata: je li biblija.me naslijedio greške biblija.ks.hr?
    errata = json.load(open(os.path.join(ROOT, "data", "errata.json"), encoding="utf-8"))
    err_rows = []
    for e in errata:
        b = bme.get(e["book_order"], {}).get(e["chapter"], {}).get(e["verse"])
        raw, fixed = e.get("ks_raw") or "", e.get("fixed") or ""
        if b is None:
            st = "nema retka"
        elif fixed and clean(b) == clean(fixed):
            st = "ispravno (kao naš popravak)"
        elif raw and clean(b) == clean(raw):
            st = "ista greška kao KS-online"
        elif raw and n(b) == n(raw):
            st = "ista greška kao KS-online"
        elif fixed and n(b) == n(fixed):
            st = "ispravno (kao naš popravak)"
        else:
            st = "drukčije"
        err_rows.append({"ref": e["reference"], "type": e["type"], "biblijame": st})

    # ---- 3. nalazi audita
    audit = json.load(open(os.path.join(ROOT, "data", "audit", "sumnjivi.json"), encoding="utf-8"))["findings"]
    rows, by_kind = [], defaultdict(Counter)
    for fnd in audit:
        o, c, v = fnd["book"], fnd["chapter"], fnd["verse"]
        if v is None:
            have = sorted(x for x in bme.get(o, {}).get(c, {}) if isinstance(x, int))
            ksv = [x[0] for x in ks.get(o, {}).get(c, [])]
            missing = [x for x in fnd.get("verses", []) if x not in have]
            verdict = "poglavlje: " + ("ima sve sporne retke" if not missing else f"nema {missing}")
            if set(have) == set(ksv):
                verdict += ", isti redci kao KS"
        else:
            b = bme.get(o, {}).get(c, {}).get(v)
            kst = next((x[1] for x in ks.get(o, {}).get(c, []) if x[0] == v), "")
            f = foi.get(o, {}).get(c, {}).get(v, "")
            u = u68.get(o, {}).get(c, {}).get(v, "")
            if b is None:
                verdict = "nema retka"
            else:
                m = [name for name, t in (("KS", kst), ("FOI", f), ("U68", u)) if t and n(b) == n(t)]
                verdict = "= " + "+".join(m) if m else "razlikuje se od svih"
            fnd = {**fnd, "bme_text": b or ""}
        by_kind[fnd["kind"]][verdict.split(",")[0] if v is None else verdict] += 1
        rows.append({"ref": fnd["ref"], "kind": fnd["kind"], "priority": fnd["priority"], "biblijame": verdict})

    out = {
        "agree": agree, "raw_double_spaces": spaces, "duplicates": dup[:50],
        "only_in_ks": only_ks, "only_in_biblijame": only_bme,
        "errata": err_rows, "findings": rows, "findings_by_kind": {k: dict(v) for k, v in by_kind.items()},
    }
    json.dump(out, open(os.path.join(A.OUT, "biblijame.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    pct = lambda a, b: f"{100 * a / b:.2f} %" if b else "-"  # noqa: E731
    L = ["# biblija.me prema KS-online, FOI, U68 i nalazima audita", "",
         f"Redaka u oba: {agree['redaka']}; samo KS-online: {len(only_ks)}; samo biblija.me: {len(only_bme)}", "",
         "| usporedba | isto |", "|---|---|",
         f"| KS-online (s našim errata) | {agree['= KS-online']} / {agree['redaka']} ({pct(agree['= KS-online'], agree['redaka'])}) |",
         f"| FOI (druga digitalizacija KS-a) | {agree['= FOI']} / {agree['ima FOI']} ({pct(agree['= FOI'], agree['ima FOI'])}) |",
         f"| U68 (Zagrebačka 1968., eBible) | {agree['= U68']} / {agree['ima U68']} ({pct(agree['= U68'], agree['ima U68'])}) |",
         "", f"Redaka s dvostrukim razmakom u izvorniku: {spaces['dvostruki']} / {spaces['ukupno']}", "",
         "## Errata (poznate greške biblija.ks.hr)", "", "| mjesto | biblija.me |", "|---|---|"]
    L += [f"| {r['ref']} | {r['biblijame']} |" for r in err_rows]
    L += ["", "## Nalazi audita po vrsti", ""]
    for k, c in sorted(by_kind.items()):
        L.append(f"- **{k}**: " + ", ".join(f"{v} {kk}" for kk, v in c.most_common()))
    L += ["", f"Samo u KS-online (prvih 40): {', '.join(only_ks[:40])}", "",
          f"Samo na biblija.me (prvih 40): {', '.join(only_bme[:40])}"]
    open(os.path.join(A.OUT, "BIBLIJAME.md"), "w", encoding="utf-8").write("\n".join(L) + "\n")
    print("\n".join(L[:12]))


if __name__ == "__main__":
    main()
