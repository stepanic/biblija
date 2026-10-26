#!/usr/bin/env python3
"""
Lokalni offline / multi-user server za Biblija KS / Biblija 365 web aplikaciju.
- Poslužuje statičko Astro sučelje (iz dist/ ili korijenskog direktorija)
- Pruža brze SQLite + FTS5 API rute (/api/status, /api/search, /api/auth, /api/sync, /api/progress, /api/bookmarks)
  nad determinističkom bazom data/biblija.db.
- Podržava višekorisničku sinkronizaciju (N korisnika na M uređaja) putem Sync Koda + PIN-a,
  identično Cloudflare Workers + D1 produkcijskoj arhitekturi (src/worker.ts).
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import sqlite3
import unicodedata
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(ROOT_DIR, "dist")
DB_PATH = os.path.join(ROOT_DIR, "data", "biblija.db")

CROATIAN_FOLD = str.maketrans({
    "č": "c", "ć": "c", "ž": "z", "š": "s", "đ": "d",
    "Č": "C", "Ć": "C", "Ž": "Z", "Š": "S", "Đ": "D",
})


def fold_hr(text: str) -> str:
    s = text.translate(CROATIAN_FOLD)
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def normalize_user_key(raw: str) -> str:
    folded = fold_hr(raw or "").strip()
    return re.sub(r"[^a-z0-9_-]", "", folded)[:40]


def hash_pin(user_key: str, pin: str) -> str:
    payload = f"biblija365:{user_key}:{pin.strip()}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


EPOCH = "1970-01-01T00:00:00.000Z"
MAX_LOG_PER_REQUEST = 500
CHAPTER_URL = re.compile(r"^/[a-z0-9-]{1,60}/\d{1,3}/$")
ISO_TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$")
LOG_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def iso_now() -> str:
    """Isti oblik kao `new Date().toISOString()` u workeru, da se kursori mogu uspoređivati kao stringovi."""
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def to_verse(v) -> int:
    try:
        n = int(float(v or 0))
    except (TypeError, ValueError):
        return 0
    return n if 0 < n < 1000 else 0


def parse_linear(raw):
    if not isinstance(raw, dict):
        return None
    url = str(raw.get("url") or "")
    updated_at = str(raw.get("updated_at") or "")
    if not CHAPTER_URL.match(url) or not ISO_TS.match(updated_at):
        return None
    return {"url": url, "label": str(raw.get("label") or "")[:120], "verse": to_verse(raw.get("verse")), "updated_at": updated_at}


def parse_log_entry(raw):
    if not isinstance(raw, dict):
        return None
    eid = str(raw.get("id") or "")
    url = str(raw.get("url") or "")
    started_at = str(raw.get("started_at") or "")
    ended_at = str(raw.get("ended_at") or started_at)
    updated_at = str(raw.get("updated_at") or "")
    if not LOG_ID.match(eid) or not CHAPTER_URL.match(url):
        return None
    if not (ISO_TS.match(started_at) and ISO_TS.match(ended_at) and ISO_TS.match(updated_at)):
        return None
    return {
        "id": eid,
        "url": url,
        "label": str(raw.get("label") or "")[:120],
        "verse": to_verse(raw.get("verse")),
        "started_at": started_at,
        "ended_at": max(ended_at, started_at),
        "linear": bool(raw.get("linear")),
        "device": str(raw.get("device") or "")[:40],
        "updated_at": updated_at,
    }


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_sync_tables():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sync_users (
            user_key TEXT PRIMARY KEY,
            pin_hash TEXT NOT NULL,
            display_name TEXT NOT NULL,
            active_plan_id TEXT NOT NULL DEFAULT 'mb-tematski-365',
            last_url TEXT NOT NULL DEFAULT '/',
            last_label TEXT NOT NULL DEFAULT '',
            last_updated_at TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sync_progress (
            user_key TEXT NOT NULL,
            plan_id TEXT NOT NULL,
            day INTEGER NOT NULL,
            completed INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_key, plan_id, day),
            FOREIGN KEY (user_key) REFERENCES sync_users(user_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_sync_progress_user ON sync_progress(user_key);

        CREATE TABLE IF NOT EXISTS sync_bookmarks (
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

        CREATE INDEX IF NOT EXISTS idx_sync_bookmarks_user ON sync_bookmarks(user_key);

        CREATE TABLE IF NOT EXISTS sync_reading_log (
            user_key TEXT NOT NULL,
            id TEXT NOT NULL,
            url TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '',
            verse INTEGER NOT NULL DEFAULT 0,
            started_at TEXT NOT NULL,
            ended_at TEXT NOT NULL,
            linear INTEGER NOT NULL DEFAULT 0,
            device TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL,
            received_at TEXT NOT NULL,
            PRIMARY KEY (user_key, id)
        );

        CREATE INDEX IF NOT EXISTS idx_sync_reading_log_received ON sync_reading_log(user_key, received_at);

        CREATE TABLE IF NOT EXISTS sync_linear (
            user_key TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '',
            verse INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );
    """)
    conn.commit()
    conn.close()


class BiblijaRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        serve_dir = DIST_DIR if os.path.isdir(DIST_DIR) else ROOT_DIR
        super().__init__(*args, directory=serve_dir, **kwargs)

    def log_message(self, fmt, *args):
        if len(args) >= 2 and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/api/status":
            conn = get_db()
            cur = conn.cursor()
            v_cnt = cur.execute("SELECT COUNT(*) FROM verses").fetchone()[0]
            b_cnt = cur.execute("SELECT COUNT(*) FROM books").fetchone()[0]
            u_cnt = cur.execute("SELECT COUNT(*) FROM sync_users").fetchone()[0]
            conn.close()
            return self.send_json({
                "mode": "sqlite-server",
                "db_path": "data/biblija.db",
                "books": b_cnt,
                "verses": v_cnt,
                "users": u_cnt,
                "fts5": True,
                "sync_enabled": True,
            })

        if path == "/api/search":
            q = (qs.get("q", [""])[0] or "").strip()
            testament = (qs.get("testament", [""])[0] or "").strip()
            book_order = qs.get("book_order", [""])[0]
            limit = min(200, max(1, int(qs.get("limit", ["80"])[0] or 80)))

            if not q:
                return self.send_json({"results": [], "total": 0, "engine": "sqlite-fts5"})

            conn = get_db()
            cur = conn.cursor()

            folded_q = fold_hr(q)
            tokens = [t for t in re.findall(r"[\w]+", folded_q) if t]
            if not tokens:
                conn.close()
                return self.send_json({"results": [], "total": 0, "engine": "sqlite-fts5"})

            if q.startswith('"') and q.endswith('"') and len(tokens) > 1:
                fts_expr = f'"{ " ".join(tokens) }"'
            else:
                fts_expr = " AND ".join(f'"{t}"*' for t in tokens)

            where_clauses = ["verses_fts MATCH ?"]
            params = [fts_expr]

            if testament in ("SZ", "NZ"):
                where_clauses.append("v.testament = ?")
                params.append(testament)
            if book_order and book_order.isdigit():
                where_clauses.append("v.book_order = ?")
                params.append(int(book_order))

            where_sql = " AND ".join(where_clauses)
            count_sql = f"""
                SELECT COUNT(*)
                FROM verses_fts
                JOIN verses v ON v.id = verses_fts.rowid
                WHERE {where_sql}
            """
            total = cur.execute(count_sql, params).fetchone()[0]

            sql = f"""
                SELECT v.book_order, v.book_id, v.book_abbr, v.book_title,
                       v.testament, v.chapter, v.verse, v.verse_label, v.text
                FROM verses_fts
                JOIN verses v ON v.id = verses_fts.rowid
                WHERE {where_sql}
                ORDER BY v.book_order ASC, v.chapter ASC, v.verse ASC
                LIMIT ?
            """
            rows = cur.execute(sql, params + [limit]).fetchall()
            conn.close()

            return self.send_json({
                "query": q,
                "total": total,
                "engine": "sqlite-fts5",
                "results": [dict(r) for r in rows],
            })

        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = json.loads(self.rfile.read(length).decode("utf-8")) if length > 0 else {}

        if path == "/api/auth":
            raw_key = str(body.get("user_key") or "").strip()
            user_key = normalize_user_key(raw_key)
            pin = str(body.get("pin") or "").strip()

            if len(user_key) < 3:
                return self.send_json({"ok": False, "error": "Korisničko ime / Sync kod mora imati barem 3 znaka."}, status=400)
            if len(pin) < 4:
                return self.send_json({"ok": False, "error": "PIN mora imati barem 4 znaka."}, status=400)

            pin_h = hash_pin(user_key, pin)
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()

            conn = get_db()
            row = conn.execute("SELECT * FROM sync_users WHERE user_key = ?", (user_key,)).fetchone()
            if not row:
                conn.execute(
                    """INSERT INTO sync_users (
                        user_key, pin_hash, display_name, active_plan_id,
                        last_url, last_label, last_updated_at, created_at
                    ) VALUES (?, ?, ?, 'mb-tematski-365', '/', '', '1970-01-01T00:00:00.000Z', ?)""",
                    (user_key, pin_h, raw_key, now),
                )
                conn.commit()
                conn.close()
                return self.send_json({
                    "ok": True,
                    "created": True,
                    "user_key": user_key,
                    "display_name": raw_key,
                })

            if row["pin_hash"] != pin_h:
                conn.close()
                return self.send_json({"ok": False, "error": "Pogrešan PIN za postojeći Sync kod."}, status=401)

            conn.close()
            return self.send_json({
                "ok": True,
                "created": False,
                "user_key": user_key,
                "display_name": row["display_name"],
            })

        if path == "/api/sync":
            raw_key = str(body.get("user_key") or "").strip()
            user_key = normalize_user_key(raw_key)
            pin = str(body.get("pin") or "").strip()

            if len(user_key) < 3 or len(pin) < 4:
                return self.send_json({"ok": False, "error": "Neispravan Sync kod ili PIN."}, status=400)

            pin_h = hash_pin(user_key, pin)
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()

            conn = get_db()
            user = conn.execute("SELECT * FROM sync_users WHERE user_key = ?", (user_key,)).fetchone()
            if not user:
                conn.execute(
                    """INSERT INTO sync_users (
                        user_key, pin_hash, display_name, active_plan_id,
                        last_url, last_label, last_updated_at, created_at
                    ) VALUES (?, ?, ?, 'mb-tematski-365', '/', '', '1970-01-01T00:00:00.000Z', ?)""",
                    (user_key, pin_h, raw_key, now),
                )
                conn.commit()
                user = conn.execute("SELECT * FROM sync_users WHERE user_key = ?", (user_key,)).fetchone()
            elif user["pin_hash"] != pin_h:
                conn.close()
                return self.send_json({"ok": False, "error": "Pogrešan PIN za ovaj Sync kod."}, status=401)

            # 1. Merge user meta (active_plan_id, last_url, last_label) via Last-Write-Wins
            c_meta = body.get("meta") or {}
            c_meta_ts = str(c_meta.get("last_updated_at") or "1970-01-01T00:00:00.000Z")
            s_meta_ts = str(user["last_updated_at"] or "1970-01-01T00:00:00.000Z")

            if c_meta_ts > s_meta_ts:
                active_plan_id = str(c_meta.get("active_plan_id") or user["active_plan_id"] or "mb-tematski-365")
                last_url = str(c_meta.get("last_url") or user["last_url"] or "/")
                last_label = str(c_meta.get("last_label") or user["last_label"] or "")
                conn.execute(
                    """UPDATE sync_users
                       SET active_plan_id = ?, last_url = ?, last_label = ?, last_updated_at = ?
                       WHERE user_key = ?""",
                    (active_plan_id, last_url, last_label, c_meta_ts, user_key),
                )
                merged_meta = {
                    "active_plan_id": active_plan_id,
                    "last_url": last_url,
                    "last_label": last_label,
                    "last_updated_at": c_meta_ts,
                }
            else:
                merged_meta = {
                    "active_plan_id": user["active_plan_id"],
                    "last_url": user["last_url"],
                    "last_label": user["last_label"],
                    "last_updated_at": s_meta_ts,
                }

            # 2. Merge reading plan progress (LWW per plan_id + day)
            s_prog_rows = conn.execute(
                "SELECT plan_id, day, completed, updated_at FROM sync_progress WHERE user_key = ?",
                (user_key,),
            ).fetchall()
            prog_map = {}
            for r in s_prog_rows:
                prog_map[(r["plan_id"], int(r["day"]))] = {
                    "completed": bool(r["completed"]),
                    "updated_at": str(r["updated_at"]),
                }

            c_progress = body.get("progress") or {}
            for plan_id, days_dict in c_progress.items():
                if not isinstance(days_dict, dict):
                    continue
                for day_str, val in days_dict.items():
                    if not str(day_str).isdigit():
                        continue
                    day_num = int(day_str)
                    if isinstance(val, str):
                        c_comp = True
                        c_ts = val
                    elif isinstance(val, dict):
                        c_comp = bool(val.get("completed", True))
                        c_ts = str(val.get("updated_at") or "1970-01-01T00:00:00.000Z")
                    else:
                        continue

                    existing = prog_map.get((plan_id, day_num))
                    if not existing or c_ts > existing["updated_at"]:
                        prog_map[(plan_id, day_num)] = {"completed": c_comp, "updated_at": c_ts}
                        conn.execute(
                            """INSERT INTO sync_progress (user_key, plan_id, day, completed, updated_at)
                               VALUES (?, ?, ?, ?, ?)
                               ON CONFLICT(user_key, plan_id, day)
                               DO UPDATE SET completed = excluded.completed, updated_at = excluded.updated_at""",
                            (user_key, plan_id, day_num, 1 if c_comp else 0, c_ts),
                        )

            merged_progress = {}
            for (plan_id, day_num), info in prog_map.items():
                merged_progress.setdefault(plan_id, {})[str(day_num)] = info

            # 3. Merge bookmarks & notes (LWW per book_order:chapter:verse with tombstone support)
            s_bm_rows = conn.execute(
                """SELECT book_order, book_id, book_abbr, book_title, chapter, verse,
                          color, note, text, deleted, updated_at
                   FROM sync_bookmarks WHERE user_key = ?""",
                (user_key,),
            ).fetchall()
            bm_map = {}
            for r in s_bm_rows:
                k = f"{r['book_order']}:{r['chapter']}:{r['verse']}"
                bm_map[k] = {
                    "book_order": int(r["book_order"]),
                    "book_id": r["book_id"],
                    "book_abbr": r["book_abbr"],
                    "book_title": r["book_title"],
                    "chapter": int(r["chapter"]),
                    "verse": int(r["verse"]),
                    "color": r["color"],
                    "note": r["note"],
                    "text": r["text"],
                    "deleted": bool(r["deleted"]),
                    "updated_at": str(r["updated_at"]),
                }

            c_bookmarks = body.get("bookmarks") or {}
            for k, bm in c_bookmarks.items():
                if not isinstance(bm, dict):
                    continue
                parts = str(k).split(":")
                bo = int(bm.get("book_order") or (parts[0] if len(parts) == 3 and parts[0].isdigit() else 0))
                ch = int(bm.get("chapter") or (parts[1] if len(parts) == 3 and parts[1].isdigit() else 0))
                vnum = int(bm.get("verse") or (parts[2] if len(parts) == 3 and parts[2].isdigit() else 0))
                if not bo or not vnum:
                    continue
                norm_k = f"{bo}:{ch}:{vnum}"
                c_ts = str(bm.get("updated_at") or bm.get("created_at") or "1970-01-01T00:00:00.000Z")
                c_del = bool(bm.get("deleted", False))

                existing = bm_map.get(norm_k)
                if not existing or c_ts > existing["updated_at"]:
                    entry = {
                        "book_order": bo,
                        "book_id": str(bm.get("book_id") or (existing and existing["book_id"]) or ""),
                        "book_abbr": str(bm.get("book_abbr") or (existing and existing["book_abbr"]) or ""),
                        "book_title": str(bm.get("book_title") or (existing and existing["book_title"]) or ""),
                        "chapter": ch,
                        "verse": vnum,
                        "color": str(bm.get("color") or "gold"),
                        "note": str(bm.get("note") or ""),
                        "text": str(bm.get("text") or (existing and existing["text"]) or ""),
                        "deleted": c_del,
                        "updated_at": c_ts,
                    }
                    bm_map[norm_k] = entry
                    conn.execute(
                        """INSERT INTO sync_bookmarks (
                               user_key, book_order, book_id, book_abbr, book_title,
                               chapter, verse, color, note, text, deleted, updated_at
                           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                           ON CONFLICT(user_key, book_order, chapter, verse)
                           DO UPDATE SET
                               book_id = excluded.book_id,
                               book_abbr = excluded.book_abbr,
                               book_title = excluded.book_title,
                               color = excluded.color,
                               note = excluded.note,
                               text = excluded.text,
                               deleted = excluded.deleted,
                               updated_at = excluded.updated_at""",
                        (
                            user_key, bo, entry["book_id"], entry["book_abbr"], entry["book_title"],
                            ch, vnum, entry["color"], entry["note"], entry["text"],
                            1 if c_del else 0, c_ts,
                        ),
                    )

            # 4. Linearni kursor (LWW po updated_at)
            lin_row = conn.execute(
                "SELECT url, label, verse, updated_at FROM sync_linear WHERE user_key = ?", (user_key,)
            ).fetchone()
            merged_linear = dict(lin_row) if lin_row else None
            c_linear = parse_linear(body.get("linear"))
            if c_linear and (not merged_linear or c_linear["updated_at"] > merged_linear["updated_at"]):
                merged_linear = c_linear
                conn.execute(
                    """INSERT INTO sync_linear (user_key, url, label, verse, updated_at) VALUES (?, ?, ?, ?, ?)
                       ON CONFLICT(user_key) DO UPDATE SET
                           url = excluded.url, label = excluded.label, verse = excluded.verse, updated_at = excluded.updated_at""",
                    (user_key, c_linear["url"], c_linear["label"], c_linear["verse"], c_linear["updated_at"]),
                )

            # 5. Dnevnik čitanja (LWW po id-u, inkrementalno po log_since / log_cursor)
            received_at = iso_now()
            c_log = body.get("log") if isinstance(body.get("log"), list) else []
            for raw in c_log[:MAX_LOG_PER_REQUEST]:
                e = parse_log_entry(raw)
                if not e:
                    continue
                conn.execute(
                    """INSERT INTO sync_reading_log (
                           user_key, id, url, label, verse, started_at, ended_at, linear, device, updated_at, received_at
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(user_key, id) DO UPDATE SET
                           url = excluded.url, label = excluded.label, verse = excluded.verse,
                           started_at = excluded.started_at, ended_at = excluded.ended_at, linear = excluded.linear,
                           device = excluded.device, updated_at = excluded.updated_at, received_at = excluded.received_at
                       WHERE excluded.updated_at > sync_reading_log.updated_at""",
                    (user_key, e["id"], e["url"], e["label"], e["verse"], e["started_at"], e["ended_at"],
                     1 if e["linear"] else 0, e["device"], e["updated_at"], received_at),
                )

            log_since = str(body.get("log_since") or "")
            if not ISO_TS.match(log_since):
                log_since = EPOCH
            log_rows = conn.execute(
                """SELECT id, url, label, verse, started_at, ended_at, linear, device, updated_at
                   FROM sync_reading_log WHERE user_key = ? AND received_at >= ? ORDER BY started_at""",
                (user_key, log_since),
            ).fetchall()

            conn.commit()
            conn.close()

            return self.send_json({
                "ok": True,
                "user_key": user_key,
                "display_name": user["display_name"],
                "synced_at": now,
                "meta": merged_meta,
                "progress": merged_progress,
                "bookmarks": bm_map,
                "linear": merged_linear,
                "log": [{**dict(r), "linear": bool(r["linear"])} for r in log_rows],
                "log_cursor": received_at,
            })

        return self.send_json({"error": "Not found"}, status=404)


def main():
    ensure_sync_tables()
    parser = argparse.ArgumentParser(description="Biblija 365 Lokalni Server (SQLite FTS5 + Multi-Device Sync)")
    parser.add_argument("--port", type=int, default=8088, help="Port za lokalni web server (default: 8088)")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host (default: 127.0.0.1)")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), BiblijaRequestHandler)
    print(f"Biblija 365 server pokrenut na: http://{args.host}:{args.port}")
    print(f"SQLite baza: {DB_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nZaustavljanje servera...")
        server.server_close()


if __name__ == "__main__":
    main()
