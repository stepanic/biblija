import Foundation

// MARK: - Tekst (read-only, iz biblija-mobile.db)

public struct Book: Identifiable, Hashable, Sendable {
    public var id: Int { order }
    public let order: Int
    /// Slug iz web URL-a, npr. `knjiga-postanka`.
    public let slug: String
    public let usfmId: String
    public let abbr: String
    public let title: String
    public let nameEn: String
    /// `SZ` ili `NZ`.
    public let testament: String
    public let category: String
    public let deuterocanonical: Bool
    public let deuterocanonicalParts: String?
    public let chapterCount: Int
    public let verseCount: Int
}

public struct ChapterInfo: Hashable, Sendable {
    public let chapter: Int
    public let verseCount: Int

    /// Poglavlje 0 je Proslov (Sirah).
    public var shortLabel: String { chapter == 0 ? "Proslov" : String(chapter) }
}

public struct Heading: Codable, Hashable, Sendable {
    /// `h2`, `h3` ili `h4`.
    public let level: String
    public let text: String
}

public struct Verse: Identifiable, Hashable, Sendable {
    public var id: Int { verse }
    public let verse: Int
    public let label: String
    public let text: String
    public let paragraphStart: Bool
    public let headings: [Heading]
    public let references: [String]
    /// Pjesnički retci; više od jednog znači pjesnički blok.
    public let lines: [String]

    public var isPoetic: Bool { lines.count > 1 }
}

public struct ChapterRef: Hashable, Codable, Sendable {
    public let bookOrder: Int
    public let chapter: Int

    public init(bookOrder: Int, chapter: Int) {
        self.bookOrder = bookOrder
        self.chapter = chapter
    }
}

public struct ReadingPlan: Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let category: String
    public let daysCount: Int
    public let description: String
}

public struct PlanReading: Codable, Hashable, Sendable {
    public let bookOrder: Int
    public let bookId: String
    public let bookAbbr: String
    public let bookTitle: String
    public let chapterStart: Int
    public let chapterEnd: Int
    public let verseCount: Int
    public let label: String

    enum CodingKeys: String, CodingKey {
        case bookOrder = "book_order", bookId = "book_id", bookAbbr = "book_abbr", bookTitle = "book_title"
        case chapterStart = "chapter_start", chapterEnd = "chapter_end", verseCount = "verse_count", label
    }

    public var chapters: [ChapterRef] {
        guard chapterEnd >= chapterStart else { return [ChapterRef(bookOrder: bookOrder, chapter: chapterStart)] }
        return (chapterStart...chapterEnd).map { ChapterRef(bookOrder: bookOrder, chapter: $0) }
    }
}

public struct PlanDay: Identifiable, Hashable, Sendable {
    public var id: Int { day }
    public let day: Int
    public let label: String
    public let verseCount: Int
    public let readings: [PlanReading]
}

public struct SearchHit: Identifiable, Hashable, Sendable {
    public var id: String { "\(bookOrder):\(chapter):\(verse)" }
    public let bookOrder: Int
    public let bookAbbr: String
    public let bookTitle: String
    public let chapter: Int
    public let verse: Int
    public let text: String
}

public struct SearchResult: Sendable {
    public let total: Int
    public let hits: [SearchHit]

    public init(total: Int, hits: [SearchHit]) {
        self.total = total
        self.hits = hits
    }
}

// MARK: - Korisničko stanje (isti oblik kao localStorage na webu i /api/sync)

public struct DayProgress: Codable, Equatable, Sendable {
    public var completed: Bool
    public var updatedAt: String

    public init(completed: Bool, updatedAt: String) {
        self.completed = completed
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case completed, updatedAt = "updated_at"
    }
}

public enum BookmarkColor: String, CaseIterable, Codable, Sendable {
    case gold, green, blue, pink

    public var label: String {
        switch self {
        case .gold: "Zlatna"
        case .green: "Zelena"
        case .blue: "Plava"
        case .pink: "Ružičasta"
        }
    }
}

public struct Bookmark: Codable, Equatable, Sendable {
    public var bookOrder: Int
    public var bookId: String
    public var bookAbbr: String
    public var bookTitle: String
    public var chapter: Int
    public var verse: Int
    /// Sirova vrijednost s poslužitelja; nepoznate boje prikazuju se kao zlatna.
    public var color: String
    public var note: String
    public var text: String
    public var deleted: Bool
    public var updatedAt: String

    public init(
        bookOrder: Int, bookId: String, bookAbbr: String, bookTitle: String,
        chapter: Int, verse: Int, color: String, note: String, text: String,
        deleted: Bool, updatedAt: String
    ) {
        self.bookOrder = bookOrder
        self.bookId = bookId
        self.bookAbbr = bookAbbr
        self.bookTitle = bookTitle
        self.chapter = chapter
        self.verse = verse
        self.color = color
        self.note = note
        self.text = text
        self.deleted = deleted
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case bookOrder = "book_order", bookId = "book_id", bookAbbr = "book_abbr", bookTitle = "book_title"
        case chapter, verse, color, note, text, deleted, updatedAt = "updated_at"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        bookOrder = try c.decode(Int.self, forKey: .bookOrder)
        bookId = try c.decodeIfPresent(String.self, forKey: .bookId) ?? ""
        bookAbbr = try c.decodeIfPresent(String.self, forKey: .bookAbbr) ?? ""
        bookTitle = try c.decodeIfPresent(String.self, forKey: .bookTitle) ?? ""
        chapter = try c.decode(Int.self, forKey: .chapter)
        verse = try c.decode(Int.self, forKey: .verse)
        color = try c.decodeIfPresent(String.self, forKey: .color) ?? BookmarkColor.gold.rawValue
        note = try c.decodeIfPresent(String.self, forKey: .note) ?? ""
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        deleted = try c.decodeIfPresent(Bool.self, forKey: .deleted) ?? false
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? Timestamp.epoch
    }

    public static func key(bookOrder: Int, chapter: Int, verse: Int) -> String {
        "\(bookOrder):\(chapter):\(verse)"
    }

    public var key: String { Self.key(bookOrder: bookOrder, chapter: chapter, verse: verse) }
    public var bookmarkColor: BookmarkColor { BookmarkColor(rawValue: color) ?? .gold }
    /// Citat kao na webu: »tekst« (Iv 3,16)
    public var quote: String { "»\(text)« (\(bookAbbr) \(chapter),\(verse))" }
}

public struct SyncMeta: Codable, Equatable, Sendable {
    public var activePlanId: String
    /// Web URL zadnjeg poglavlja, npr. `/psalmi/23/`, da web i mobitel mogu nastaviti jedni od drugih.
    public var lastUrl: String
    public var lastLabel: String
    public var lastUpdatedAt: String

    public static let defaultPlanId = "mb-tematski-365"
    public static let empty = SyncMeta(activePlanId: defaultPlanId, lastUrl: "/", lastLabel: "", lastUpdatedAt: Timestamp.epoch)

    public init(activePlanId: String, lastUrl: String, lastLabel: String, lastUpdatedAt: String) {
        self.activePlanId = activePlanId
        self.lastUrl = lastUrl
        self.lastLabel = lastLabel
        self.lastUpdatedAt = lastUpdatedAt
    }

    enum CodingKeys: String, CodingKey {
        case activePlanId = "active_plan_id", lastUrl = "last_url", lastLabel = "last_label"
        case lastUpdatedAt = "last_updated_at"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        activePlanId = try c.decodeIfPresent(String.self, forKey: .activePlanId) ?? Self.defaultPlanId
        lastUrl = try c.decodeIfPresent(String.self, forKey: .lastUrl) ?? "/"
        lastLabel = try c.decodeIfPresent(String.self, forKey: .lastLabel) ?? ""
        lastUpdatedAt = try c.decodeIfPresent(String.self, forKey: .lastUpdatedAt) ?? Timestamp.epoch
    }
}

/// plan_id → dan (kao string, zbog JSON-a) → napredak
public typealias ProgressMap = [String: [String: DayProgress]]
/// `book_order:chapter:verse` → oznaka (i tombstone s deleted=true)
public typealias BookmarkMap = [String: Bookmark]

public struct UserData: Codable, Equatable, Sendable {
    public var meta: SyncMeta
    public var progress: ProgressMap
    public var bookmarks: BookmarkMap

    public static let empty = UserData(meta: .empty, progress: [:], bookmarks: [:])

    public init(meta: SyncMeta, progress: ProgressMap, bookmarks: BookmarkMap) {
        self.meta = meta
        self.progress = progress
        self.bookmarks = bookmarks
    }

    public func isDayDone(planId: String, day: Int) -> Bool {
        progress[planId]?[String(day)]?.completed ?? false
    }

    public func activeBookmark(_ key: String) -> Bookmark? {
        guard let b = bookmarks[key], !b.deleted else { return nil }
        return b
    }

    /// Najnovije prvo, kao na webu.
    public var activeBookmarks: [Bookmark] {
        bookmarks.values.filter { !$0.deleted }.sorted { $0.updatedAt > $1.updatedAt }
    }
}

public enum Timestamp {
    public static let epoch = "1970-01-01T00:00:00.000Z"

    /// ISO-8601 UTC s milisekundama, isto kao `new Date().toISOString()`; LWW ga uspoređuje kao string.
    public static func now(_ date: Date = Date()) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f.string(from: date)
    }
}

// MARK: - Web URL-ovi (`/<book-id>/<chapter>/`)

public enum WebPath {
    public static func chapter(bookSlug: String, chapter: Int) -> String { "/\(bookSlug)/\(chapter)/" }

    public static func parseChapter(_ path: String) -> (slug: String, chapter: Int)? {
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count >= 2, let ch = Int(parts[1]) else { return nil }
        return (parts[0], ch)
    }

    public static func label(book: Book, chapter: Int) -> String {
        "\(book.title) (\(book.abbr) \(chapter == 0 ? "Proslov" : String(chapter)))"
    }
}
