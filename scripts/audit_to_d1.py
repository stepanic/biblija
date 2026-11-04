#!/usr/bin/env python3
"""
data/audit/sumnjivi.json → data/audit/d1_seed.sql za tablicu audit_findings (migrations/0004).

Dodaje i nasumični uzorak neoznačenih KS redaka (is_sample = 1) iz kojeg se računa udio grešaka
koje automatska provjera ne vidi. Uzorak je stalan (seed), pa ponovno pokretanje ne mijenja ID-eve.
Nalazi koje nova verzija skripte više ne prijavljuje dobivaju active = 0 (recenzije ostaju).

    python3 scripts/audit_tekst.py && python3 scripts/audit_to_d1.py
    npx wrangler d1 execute biblija-365-db --remote --file data/audit/d1_seed.sql
"""
import glob
import hashlib
import json
import os
import random
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLE_SIZE = int(os.environ.get("SAMPLE_SIZE", "300"))


def q(s):
    return "NULL" if s is None else "'" + str(s).replace("'", "''") + "'"


def fid(*parts):
    return hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:12]


def main():
    data = json.load(open(os.path.join(ROOT, "data", "audit", "sumnjivi.json"), encoding="utf-8"))
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows, flagged = [], set()
    for f in data["findings"]:
        flagged.add((f["book"], f["chapter"], f["verse"]))
        extra = {k: f[k] for k in ("diff", "suggested", "other", "verses", "sequence") if k in f}
        rows.append(dict(id=fid(f["layer"], f["kind"], f["ref"], f["msg"]), ref=f["ref"], book_order=f["book"],
                         chapter=f["chapter"], verse=f["verse"], layer=f["layer"], kind=f["kind"],
                         priority=f["priority"], is_sample=0, msg=f["msg"], ks_text=f.get("ks_text", ""),
                         foi_text=f.get("foi_text") or "", u68_text=f.get("u68_text") or "",
                         extra_json=json.dumps(extra, ensure_ascii=False), in_errata=int(f["in_errata"])))

    books = json.load(open(os.path.join(ROOT, "data", "json", "books.json"), encoding="utf-8"))
    pool = []
    for b in books:
        d = json.load(open(glob.glob(os.path.join(ROOT, "data", "json", "books", f"{b['order']:02d}_*.json"))[0], encoding="utf-8"))
        for c in d["chapters"]:
            for v in c["verses"]:
                if (b["order"], c["chapter"], v["verse"]) not in flagged and (b["order"], c["chapter"], None) not in flagged and v["text"].strip():
                    pool.append((b, c["chapter"], v["verse"], v["text"]))
    rnd = random.Random(20261104)
    for b, ch, v, t in rnd.sample(pool, SAMPLE_SIZE):
        ref = f"{b['abbr']} {ch},{v}"
        rows.append(dict(id=fid("uzorak", ref), ref=ref, book_order=b["order"], chapter=ch, verse=v,
                         layer="uzorak", kind="uzorak", priority=2, is_sample=1,
                         msg="Usporedi redak s tiskom.", ks_text=t, foi_text="", u68_text="",
                         extra_json="{}", in_errata=0))

    cols = list(rows[0].keys()) + ["active", "updated_at"]
    out = ["UPDATE audit_findings SET active = 0;"]
    for r in rows:
        vals = [q(r[c]) if isinstance(r[c], str) else ("NULL" if r[c] is None else str(r[c])) for c in rows[0]]
        out.append(f"INSERT INTO audit_findings ({', '.join(cols)}) VALUES ({', '.join(vals)}, 1, {q(now)}) "
                   f"ON CONFLICT(id) DO UPDATE SET " +
                   ", ".join(f"{c} = excluded.{c}" for c in cols if c != "id") + ";")
    path = os.path.join(ROOT, "data", "audit", "d1_seed.sql")
    open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
    print(f"{len(rows)} redaka ({SAMPLE_SIZE} uzorak) → {os.path.relpath(path, ROOT)}")


if __name__ == "__main__":
    main()
