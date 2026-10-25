import Foundation
import SQLite3

public enum BibleDatabaseError: Error, LocalizedError {
    case open(String)
    case query(String)
    case schema(found: Int, expected: Int)

    public var errorDescription: String? {
        switch self {
        case .open(let msg): "Ne mogu otvoriti bazu: \(msg)"
        case .query(let msg): "Greška u upitu: \(msg)"
        case .schema(let found, let expected): "Mobilna baza ima shemu \(found), aplikacija očekuje \(expected)."
        }
    }
}

/// Read-only pristup biblija-mobile.db (scripts/export_mobile_db.py).
/// Sistemski SQLite na iOS-u ima FTS5.
public final class BibleDatabase: @unchecked Sendable {
    /// Mora odgovarati SCHEMA_VERSION u scripts/export_mobile_db.py.
    public static let expectedSchemaVersion = 1

    private var db: OpaquePointer?
    private let lock = NSLock()

    public init(path: String) throws {
        // immutable=1: datoteka je u bundleu, bez zaključavanja i journala
        let uri = "file:\(path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path)?immutable=1"
        let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_URI | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(uri, &db, flags, nil) == SQLITE_OK else {
            let msg = db.map { String(cString: sqlite3_errmsg($0)) } ?? "nepoznato"
            sqlite3_close(db)
            throw BibleDatabaseError.open(msg)
        }
        let version = Int(try meta("schema_version") ?? "0") ?? 0
        guard version == Self.expectedSchemaVersion else {
            throw BibleDatabaseError.schema(found: version, expected: Self.expectedSchemaVersion)
        }
    }

    deinit {
        sqlite3_close(db)
    }

    // MARK: - Upiti

    public func meta(_ key: String) throws -> String? {
        try query("SELECT value FROM mobile_meta WHERE key = ?", [.text(key)]) { $0.text(0) }.first
    }

    public func books() throws -> [Book] {
        try query("""
            SELECT book_order, id, usfm_id, abbr, title, name_en, testament, category,
                   deuterocanonical, deuterocanonical_parts, chapter_count, verse_count
            FROM books ORDER BY book_order
            """) { r in
            Book(
                order: r.int(0), slug: r.text(1), usfmId: r.text(2), abbr: r.text(3), title: r.text(4),
                nameEn: r.text(5), testament: r.text(6), category: r.text(7), deuterocanonical: r.int(8) != 0,
                deuterocanonicalParts: r.optionalText(9), chapterCount: r.int(10), verseCount: r.int(11)
            )
        }
    }

    public func chapters(bookOrder: Int) throws -> [ChapterInfo] {
        try query(
            "SELECT chapter, verse_count FROM chapters WHERE book_order = ? ORDER BY chapter",
            [.int(bookOrder)]
        ) { ChapterInfo(chapter: $0.int(0), verseCount: $0.int(1)) }
    }

    public func verses(bookOrder: Int, chapter: Int) throws -> [Verse] {
        let decoder = JSONDecoder()
        return try query("""
            SELECT verse, verse_label, text, paragraph_start, headings_json, references_json, lines_json
            FROM verses WHERE book_order = ? AND chapter = ? ORDER BY verse
            """, [.int(bookOrder), .int(chapter)]) { r in
            func json<T: Decodable>(_ i: Int) -> T? {
                r.optionalText(i).flatMap { try? decoder.decode(T.self, from: Data($0.utf8)) }
            }
            return Verse(
                verse: r.int(0), label: r.text(1), text: r.text(2), paragraphStart: r.int(3) != 0,
                headings: json(4) ?? [], references: json(5) ?? [], lines: json(6) ?? []
            )
        }
    }

    public func plans() throws -> [ReadingPlan] {
        try query("SELECT id, title, category, days_count, description FROM reading_plans ORDER BY rowid") { r in
            ReadingPlan(id: r.text(0), title: r.text(1), category: r.text(2), daysCount: r.int(3), description: r.text(4))
        }
    }

    public func planDays(planId: String) throws -> [PlanDay] {
        let decoder = JSONDecoder()
        return try query(
            "SELECT day, label, verse_count, readings_json FROM reading_plan_days WHERE plan_id = ? ORDER BY day",
            [.text(planId)]
        ) { r in
            PlanDay(
                day: r.int(0), label: r.text(1), verseCount: r.int(2),
                readings: (try? decoder.decode([PlanReading].self, from: Data(r.text(3).utf8))) ?? []
            )
        }
    }

    /// FTS5 pretraga kao /api/search u server.py. `testament` je `SZ`, `NZ` ili nil.
    public func search(_ rawQuery: String, testament: String? = nil, bookOrder: Int? = nil, limit: Int = 100) throws -> SearchResult {
        guard let expr = HrFold.ftsExpression(rawQuery) else { return SearchResult(total: 0, hits: []) }
        var whereSql = "verses_fts MATCH ?"
        var params: [SQLValue] = [.text(expr)]
        if let testament, testament == "SZ" || testament == "NZ" {
            whereSql += " AND v.testament = ?"
            params.append(.text(testament))
        }
        if let bookOrder {
            whereSql += " AND v.book_order = ?"
            params.append(.int(bookOrder))
        }
        let from = "FROM verses_fts JOIN verses v ON v.id = verses_fts.rowid WHERE \(whereSql)"
        let total = try query("SELECT COUNT(*) \(from)", params) { $0.int(0) }.first ?? 0
        let hits = try query("""
            SELECT v.book_order, v.book_abbr, v.book_title, v.chapter, v.verse, v.text \(from)
            ORDER BY v.book_order, v.chapter, v.verse LIMIT ?
            """, params + [.int(limit)]) { r in
            SearchHit(bookOrder: r.int(0), bookAbbr: r.text(1), bookTitle: r.text(2), chapter: r.int(3), verse: r.int(4), text: r.text(5))
        }
        return SearchResult(total: total, hits: hits)
    }

    // MARK: - SQLite pomoćnici

    enum SQLValue {
        case int(Int)
        case text(String)
    }

    struct Row {
        let stmt: OpaquePointer

        func int(_ i: Int) -> Int { Int(sqlite3_column_int64(stmt, Int32(i))) }
        func text(_ i: Int) -> String { optionalText(i) ?? "" }
        func optionalText(_ i: Int) -> String? {
            guard let c = sqlite3_column_text(stmt, Int32(i)) else { return nil }
            return String(cString: c)
        }
    }

    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    private func query<T>(_ sql: String, _ params: [SQLValue] = [], map: (Row) throws -> T) throws -> [T] {
        lock.lock()
        defer { lock.unlock() }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw BibleDatabaseError.query(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        for (i, p) in params.enumerated() {
            let idx = Int32(i + 1)
            switch p {
            case .int(let v): sqlite3_bind_int64(stmt, idx, Int64(v))
            case .text(let v): sqlite3_bind_text(stmt, idx, v, -1, Self.transient)
            }
        }
        var out: [T] = []
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_ROW {
                out.append(try map(Row(stmt: stmt)))
            } else if rc == SQLITE_DONE {
                break
            } else {
                throw BibleDatabaseError.query(String(cString: sqlite3_errmsg(db)))
            }
        }
        return out
    }
}
