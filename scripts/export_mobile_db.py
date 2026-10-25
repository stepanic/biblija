#!/usr/bin/env python3
"""
Izvoz read-only mobilne baze iz data/biblija.db.

Mobilni klijenti (ios/, android/) dobivaju samo tekst, FTS5 indeks i planove čitanja.
Tablice user_* i sync_* ostaju izvan bundlea; korisničko stanje svaki klijent drži zasebno.

Upotreba:
    python3 scripts/export_mobile_db.py                  # → build/mobile/biblija-mobile.db
    python3 scripts/export_mobile_db.py --out a.db --out b.db
    python3 scripts/export_mobile_db.py --if-stale --out ios/Biblija/Resources/biblija-mobile.db

Shema verses_fts je ista kao u build_catalog_and_db.py (external content nad `verses`,
`unicode61 remove_diacritics 2`), pa upit treba foldati istim fold_hr pravilima
(vidi shared/test-vectors/fold_hr.json).
"""

import argparse
import hashlib
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DB = os.path.join(ROOT, "data", "biblija.db")
DEFAULT_OUT = os.path.join(ROOT, "build", "mobile", "biblija-mobile.db")

# Povećati kad se promijeni shema mobilne baze (klijenti to provjeravaju u mobile_meta).
SCHEMA_VERSION = 1

COPIED_TABLES = ["books", "chapters", "verses", "reading_plans", "reading_plan_days"]


def source_schema(conn, table):
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    if not row:
        sys.exit(f"Tablica {table} ne postoji u {SRC_DB}. Pokreni build_catalog_and_db.py.")
    return row[0]


def content_hash(conn):
    h = hashlib.sha256()
    for table in COPIED_TABLES:
        for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid"):
            h.update(repr(row).encode("utf-8"))
    return h.hexdigest()


def build(dest_path):
    src = sqlite3.connect(f"file:{SRC_DB}?mode=ro", uri=True)
    data_hash = content_hash(src)

    fd, tmp_path = tempfile.mkstemp(suffix=".db", dir=os.path.dirname(dest_path))
    os.close(fd)
    os.remove(tmp_path)

    out = sqlite3.connect(f"file:{tmp_path}", uri=True)
    out.execute("PRAGMA journal_mode = OFF")
    out.execute("PRAGMA page_size = 4096")

    for table in COPIED_TABLES:
        out.execute(source_schema(src, table))
    for (sql,) in src.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name IN (%s)"
        % ",".join("?" * len(COPIED_TABLES)),
        COPIED_TABLES,
    ):
        out.execute(sql)

    out.execute(f"ATTACH DATABASE 'file:{SRC_DB}?mode=ro' AS src")
    for table in COPIED_TABLES:
        out.execute(f"INSERT INTO main.{table} SELECT * FROM src.{table}")
    out.commit()
    out.execute("DETACH DATABASE src")

    out.execute(source_schema(src, "verses_fts").replace("CREATE VIRTUAL TABLE", "CREATE VIRTUAL TABLE IF NOT EXISTS"))
    out.execute("INSERT INTO verses_fts(verses_fts) VALUES ('rebuild')")
    out.execute("INSERT INTO verses_fts(verses_fts) VALUES ('optimize')")

    out.execute(
        """
        CREATE TABLE mobile_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )
    meta = {
        "schema_version": str(SCHEMA_VERSION),
        "data_hash": data_hash,
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "verse_count": str(out.execute("SELECT COUNT(*) FROM verses").fetchone()[0]),
    }
    out.executemany("INSERT INTO mobile_meta (key, value) VALUES (?, ?)", meta.items())
    out.commit()

    leaked = out.execute(
        "SELECT name FROM sqlite_master WHERE name LIKE 'user_%' OR name LIKE 'sync_%'"
    ).fetchall()
    if leaked:
        sys.exit(f"Mobilna baza ne smije sadržavati korisničke tablice: {leaked}")

    out.execute("VACUUM")
    out.close()
    src.close()

    os.replace(tmp_path, dest_path)
    return meta


def is_stale(path):
    return not os.path.exists(path) or os.path.getmtime(path) < os.path.getmtime(SRC_DB)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", action="append", help="odredišna datoteka (može više puta)")
    parser.add_argument("--if-stale", action="store_true", help="preskoči ako je odredište novije od data/biblija.db")
    args = parser.parse_args()

    if not os.path.exists(SRC_DB):
        sys.exit(f"Nema {SRC_DB}. Pokreni prvo: python3 scripts/build_catalog_and_db.py")

    targets = [os.path.abspath(p) for p in (args.out or [DEFAULT_OUT])]
    if args.if_stale and not any(is_stale(t) for t in targets):
        print("Mobilna baza je svježa, preskačem.")
        return

    for t in targets:
        os.makedirs(os.path.dirname(t), exist_ok=True)

    first, rest = targets[0], targets[1:]
    meta = build(first)
    for t in rest:
        shutil.copyfile(first, t)

    size_mb = os.path.getsize(first) / 1_000_000
    print(f"Mobilna baza: {meta['verse_count']} redaka, {size_mb:.1f} MB, hash {meta['data_hash'][:12]}")
    for t in targets:
        print(f"  → {os.path.relpath(t, ROOT)}")


if __name__ == "__main__":
    main()
