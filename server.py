#!/usr/bin/env python3
"""
Lokalni offline server za Biblija KS / Biblija 365 web aplikaciju.
- Poslužuje statičko sučelje (iz korijenskog direktorija i /data/json/)
- Pruža brze SQLite + FTS5 API rute (/api/status, /api/search, /api/progress, /api/bookmarks)
  nad determinističkom bazom data/biblija.db.
- Aplikacija radi i čisto statički (bez ovog servera, čitanjem /data/json/ datoteka).
"""
import argparse
import datetime
import json
import os
import re
import sqlite3
import unicodedata
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(ROOT_DIR, "data", "biblija.db")

CROATIAN_FOLD = str.maketrans({
    "č": "c", "ć": "c", "ž": "z", "š": "s", "đ": "d",
    "Č": "C", "Ć": "C", "Ž": "Z", "Š": "S", "Đ": "D",
})


def fold_hr(text: str) -> str:
    s = text.translate(CROATIAN_FOLD)
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


class BiblijaRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT_DIR, **kwargs)

    def log_message(self, fmt, *args):
        # Quiet static asset logs unless error
        if len(args) >= 2 and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)

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
            conn.close()
            return self.send_json({
                "mode": "sqlite-server",
                "db_path": "data/biblija.db",
                "books": b_cnt,
                "verses": v_cnt,
                "fts5": True,
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

            # Build safe FTS5 query matching either text or text_folded
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

        if path == "/api/progress":
            conn = get_db()
            rows = conn.execute("SELECT plan_id, day, completed_at FROM user_progress").fetchall()
            conn.close()
            by_plan = {}
            for r in rows:
                by_plan.setdefault(r["plan_id"], {})[str(r["day"])] = r["completed_at"]
            return self.send_json({"progress": by_plan})

        if path == "/api/bookmarks":
            conn = get_db()
            rows = conn.execute("""
                SELECT b.id, b.book_order, b.chapter, b.verse, b.color, b.note, b.created_at,
                       v.book_abbr, v.book_title, v.book_id, v.text
                FROM user_bookmarks b
                LEFT JOIN verses v ON v.book_order = b.book_order AND v.chapter = b.chapter AND v.verse = b.verse
                ORDER BY b.created_at DESC
            """).fetchall()
            conn.close()
            return self.send_json({"bookmarks": [dict(r) for r in rows]})

        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = json.loads(self.rfile.read(length).decode("utf-8")) if length > 0 else {}

        if path == "/api/progress":
            plan_id = str(body.get("plan_id") or "")
            day = int(body.get("day") or 0)
            completed = bool(body.get("completed", True))
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            conn = get_db()
            if completed:
                conn.execute(
                    "INSERT OR REPLACE INTO user_progress (plan_id, day, completed_at) VALUES (?, ?, ?)",
                    (plan_id, day, now),
                )
            else:
                conn.execute("DELETE FROM user_progress WHERE plan_id = ? AND day = ?", (plan_id, day))
            conn.commit()
            conn.close()
            return self.send_json({"ok": True, "plan_id": plan_id, "day": day, "completed": completed})

        if path == "/api/bookmarks":
            action = body.get("action", "upsert")
            book_order = int(body.get("book_order") or 0)
            chapter = int(body.get("chapter") or 0)
            verse = int(body.get("verse") or 0)
            conn = get_db()
            if action == "delete":
                conn.execute(
                    "DELETE FROM user_bookmarks WHERE book_order = ? AND chapter = ? AND verse = ?",
                    (book_order, chapter, verse),
                )
            else:
                color = str(body.get("color") or "gold")
                note = str(body.get("note") or "")
                now = datetime.datetime.now(datetime.timezone.utc).isoformat()
                conn.execute(
                    """INSERT INTO user_bookmarks (book_order, chapter, verse, color, note, created_at)
                       VALUES (?, ?, ?, ?, ?, ?)
                       ON CONFLICT(book_order, chapter, verse)
                       DO UPDATE SET color=excluded.color, note=excluded.note, created_at=excluded.created_at""",
                    (book_order, chapter, verse, color, note, now),
                )
            conn.commit()
            conn.close()
            return self.send_json({"ok": True})

        return self.send_json({"error": "Not found"}, status=404)


def main():
    parser = argparse.ArgumentParser(description="Biblija 365 Lokalni Server (SQLite FTS5 + Static PWA)")
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
