import BiblijaKit
import Foundation
import Observation
import SwiftUI

enum AppTab: Hashable {
    case reader, plan, search, bookmarks, settings
}

enum ReaderTheme: String, CaseIterable, Identifiable {
    case system, light, sepia, dark
    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "Sustav"
        case .light: "Svijetla"
        case .sepia: "Sepia"
        case .dark: "Tamna"
        }
    }
}

enum ReadingMode: String, CaseIterable, Identifiable {
    /// Knjiški odlomci (koristi `paragraph_start` iz kataloga)
    case paragraphs
    /// Studijski prikaz, redak po redak
    case verses
    var id: String { rawValue }

    var label: String { self == .paragraphs ? "Odlomci" : "Redak po redak" }
}

/// Plan i dan iz kojeg je čitač otvoren (traka „Dan N" u čitaču, kao `biblija_active_day_ctx` na webu).
struct PlanDayContext: Equatable {
    let planId: String
    let day: PlanDay
}

struct ReaderTarget: Equatable {
    var chapter: ChapterRef
    /// Redak na koji treba skrolati (iz pretrage ili oznaka).
    var verse: Int?
}

struct SavedProfile: Codable, Identifiable, Equatable {
    var id: String { credentials.userKey }
    var credentials: SyncCredentials
    var savedAt: String
}

@MainActor
@Observable
final class AppModel {
    // MARK: Tekst
    private(set) var database: BibleDatabase?
    private(set) var loadError: String?
    private(set) var books: [Book] = []
    private(set) var plans: [ReadingPlan] = []
    private var booksByOrder: [Int: Book] = [:]
    private var booksBySlug: [String: Book] = [:]
    private var chapterCache: [Int: [ChapterInfo]] = [:]
    private var planDaysCache: [String: [PlanDay]] = [:]

    // MARK: Navigacija
    var selectedTab: AppTab = .reader
    var readerTarget = ReaderTarget(chapter: ChapterRef(bookOrder: 1, chapter: 1))
    var activeDay: PlanDayContext?

    // MARK: Postavke čitanja
    var fontSize: Double { didSet { defaults.set(fontSize, forKey: Keys.fontSize) } }
    var theme: ReaderTheme { didSet { defaults.set(theme.rawValue, forKey: Keys.theme) } }
    var readingMode: ReadingMode { didSet { defaults.set(readingMode.rawValue, forKey: Keys.readingMode) } }

    // MARK: Korisničko stanje
    private(set) var userData: UserData
    private let store: UserDataStore?

    // MARK: Sync
    private(set) var credentials: SyncCredentials?
    private(set) var savedProfiles: [SavedProfile] = []
    private(set) var isSyncing = false
    private(set) var lastSyncedAt: String?
    var syncError: String?
    var serverURLString: String { didSet { defaults.set(serverURLString, forKey: Keys.serverURL) } }
    private var syncTask: Task<Void, Never>?
    private var needsAnotherSync = false

    private let defaults = UserDefaults.standard

    private enum Keys {
        static let fontSize = "biblija_fontsize"
        static let theme = "biblija_theme"
        static let readingMode = "biblija_reading_mode"
        static let serverURL = "biblija_server_url"
        static let lastSyncedAt = "biblija_last_synced_at"
    }

    init() {
        fontSize = defaults.object(forKey: Keys.fontSize) as? Double ?? 19
        theme = ReaderTheme(rawValue: defaults.string(forKey: Keys.theme) ?? "") ?? .system
        readingMode = ReadingMode(rawValue: defaults.string(forKey: Keys.readingMode) ?? "") ?? .paragraphs
        serverURLString = defaults.string(forKey: Keys.serverURL)
            ?? (Bundle.main.object(forInfoDictionaryKey: "BiblijaSyncBaseURL") as? String ?? "")
        lastSyncedAt = defaults.string(forKey: Keys.lastSyncedAt)

        store = try? UserDataStore.inApplicationSupport()
        userData = store?.load() ?? .empty
        credentials = Keychain.loadCredentials()
        savedProfiles = Keychain.loadProfiles()

        loadDatabase()
        if let ref = chapterRef(fromWebPath: userData.meta.lastUrl) {
            readerTarget = ReaderTarget(chapter: ref)
        }
    }

    private func loadDatabase() {
        guard let path = Bundle.main.path(forResource: "biblija-mobile", ofType: "db") else {
            loadError = "U aplikaciji nema biblija-mobile.db. Pokreni `npm run mobile-db` i ponovno buildaj."
            return
        }
        do {
            let db = try BibleDatabase(path: path)
            database = db
            books = try db.books()
            plans = try db.plans()
            booksByOrder = Dictionary(uniqueKeysWithValues: books.map { ($0.order, $0) })
            booksBySlug = Dictionary(uniqueKeysWithValues: books.map { ($0.slug, $0) })
        } catch {
            loadError = error.localizedDescription
        }
    }

    // MARK: - Tekst

    func book(order: Int) -> Book? { booksByOrder[order] }

    func chapters(of book: Book) -> [ChapterInfo] {
        if let cached = chapterCache[book.order] { return cached }
        let list = (try? database?.chapters(bookOrder: book.order)) ?? []
        chapterCache[book.order] = list
        return list
    }

    func verses(_ ref: ChapterRef) -> [Verse] {
        (try? database?.verses(bookOrder: ref.bookOrder, chapter: ref.chapter)) ?? []
    }

    func planDays(_ planId: String) -> [PlanDay] {
        if let cached = planDaysCache[planId] { return cached }
        let days = (try? database?.planDays(planId: planId)) ?? []
        planDaysCache[planId] = days
        return days
    }

    func search(_ query: String, testament: String?, bookOrder: Int?) -> SearchResult {
        (try? database?.search(query, testament: testament, bookOrder: bookOrder, limit: 100)) ?? SearchResult(total: 0, hits: [])
    }

    /// Prethodno/sljedeće poglavlje preko granica knjiga.
    func neighbour(of ref: ChapterRef, offset: Int) -> ChapterRef? {
        guard let book = book(order: ref.bookOrder) else { return nil }
        let list = chapters(of: book)
        guard let idx = list.firstIndex(where: { $0.chapter == ref.chapter }) else { return nil }
        let target = idx + offset
        if list.indices.contains(target) {
            return ChapterRef(bookOrder: book.order, chapter: list[target].chapter)
        }
        guard let other = self.book(order: book.order + offset) else { return nil }
        let otherList = chapters(of: other)
        guard let ch = offset > 0 ? otherList.first : otherList.last else { return nil }
        return ChapterRef(bookOrder: other.order, chapter: ch.chapter)
    }

    func chapterRef(fromWebPath path: String) -> ChapterRef? {
        guard let parsed = WebPath.parseChapter(path), let book = booksBySlug[parsed.slug] else { return nil }
        return ChapterRef(bookOrder: book.order, chapter: parsed.chapter)
    }

    func label(_ ref: ChapterRef) -> String {
        guard let book = book(order: ref.bookOrder) else { return "" }
        return "\(book.abbr) \(ref.chapter == 0 ? "Proslov" : String(ref.chapter))"
    }

    // MARK: - Navigacija

    func open(_ ref: ChapterRef, verse: Int? = nil, keepDay: Bool = false) {
        if !keepDay { activeDay = nil }
        readerTarget = ReaderTarget(chapter: ref, verse: verse)
        selectedTab = .reader
    }

    func open(day: PlanDay, planId: String, reading: PlanReading) {
        activeDay = PlanDayContext(planId: planId, day: day)
        open(ChapterRef(bookOrder: reading.bookOrder, chapter: reading.chapterStart), keepDay: true)
    }

    /// Čitač javlja da je poglavlje prikazano: pamti se za „nastavi čitanje" na svim uređajima.
    func didShow(_ ref: ChapterRef) {
        guard let book = book(order: ref.bookOrder) else { return }
        mutate { $0.setLastRead(url: WebPath.chapter(bookSlug: book.slug, chapter: ref.chapter), label: WebPath.label(book: book, chapter: ref.chapter)) }
    }

    // MARK: - Korisničko stanje

    var activePlanId: String { userData.meta.activePlanId }

    func setActivePlan(_ id: String) {
        guard id != activePlanId else { return }
        mutate { $0.setActivePlan(id) }
    }

    func isDayDone(_ planId: String, _ day: Int) -> Bool { userData.isDayDone(planId: planId, day: day) }

    func toggleDay(_ planId: String, _ day: Int) {
        mutate { $0.toggleDay(planId: planId, day: day) }
    }

    func bookmark(_ ref: ChapterRef, verse: Int) -> Bookmark? {
        userData.activeBookmark(Bookmark.key(bookOrder: ref.bookOrder, chapter: ref.chapter, verse: verse))
    }

    func saveBookmark(_ ref: ChapterRef, verse: Verse, color: BookmarkColor, note: String) {
        guard let book = book(order: ref.bookOrder) else { return }
        let bm = Bookmark(
            bookOrder: book.order, bookId: book.slug, bookAbbr: book.abbr, bookTitle: book.title,
            chapter: ref.chapter, verse: verse.verse, color: color.rawValue,
            note: note.trimmingCharacters(in: .whitespacesAndNewlines), text: verse.text,
            deleted: false, updatedAt: Timestamp.epoch
        )
        mutate { $0.upsertBookmark(bm) }
    }

    func removeBookmark(key: String) {
        mutate { $0.removeBookmark(key: key) }
    }

    private func mutate(_ change: (inout UserData) -> Void) {
        var next = userData
        change(&next)
        guard next != userData else { return }
        userData = next
        persist()
        scheduleSync()
    }

    private func persist() {
        try? store?.save(userData)
    }

    // MARK: - Sync

    var isSignedIn: Bool { credentials != nil }

    private var client: SyncClient? {
        let trimmed = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed), url.scheme != nil else { return nil }
        return SyncClient(baseURL: url)
    }

    var isServerConfigured: Bool { client != nil }

    /// Prijava ili stvaranje računa. Lokalni podaci (čitanje prije prijave) spajaju se s računom, kao na webu.
    func signIn(userKey: String, pin: String) async throws {
        let key = userKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let p = pin.trimmingCharacters(in: .whitespacesAndNewlines)
        guard key.count >= 3 else { throw SyncError.server(status: 400, message: "Korisničko ime / Sync kod mora imati barem 3 znaka.") }
        guard p.count >= 4 else { throw SyncError.server(status: 400, message: "PIN mora imati barem 4 znaka.") }
        guard let client else { throw SyncError.notConfigured }

        let result = try await client.authenticate(userKey: key, pin: p)
        setCredentials(result.credentials)
        await syncNow()
    }

    /// Promjena na spremljeni profil: lokalno stanje se briše da se podaci ne miješaju među korisnicima.
    func switchTo(_ profile: SavedProfile) async {
        if profile.credentials.userKey == credentials?.userKey {
            await syncNow()
            return
        }
        resetLocalUserData()
        setCredentials(profile.credentials)
        await syncNow()
    }

    func removeProfile(_ profile: SavedProfile) {
        savedProfiles.removeAll { $0.id == profile.id }
        Keychain.saveProfiles(savedProfiles)
    }

    func signOut() {
        syncTask?.cancel()
        credentials = nil
        Keychain.saveCredentials(nil)
        resetLocalUserData()
    }

    /// Trajno brisanje računa na poslužitelju (App Store 5.1.1(v)).
    func deleteAccount() async throws {
        guard let credentials, let client else { throw SyncError.notConfigured }
        try await client.deleteAccount(credentials)
        if let profile = savedProfiles.first(where: { $0.id == credentials.userKey }) {
            removeProfile(profile)
        }
        signOut()
    }

    private func setCredentials(_ creds: SyncCredentials) {
        credentials = creds
        Keychain.saveCredentials(creds)
        savedProfiles.removeAll { $0.id == creds.userKey }
        savedProfiles.insert(SavedProfile(credentials: creds, savedAt: Timestamp.now()), at: 0)
        savedProfiles = Array(savedProfiles.prefix(8))
        Keychain.saveProfiles(savedProfiles)
    }

    private func resetLocalUserData() {
        userData = .empty
        store?.reset()
        lastSyncedAt = nil
        defaults.removeObject(forKey: Keys.lastSyncedAt)
        activeDay = nil
    }

    func scheduleSync(after delay: Duration = .milliseconds(800)) {
        guard credentials != nil else { return }
        syncTask?.cancel()
        syncTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.syncNow()
        }
    }

    func syncNow() async {
        guard let credentials, let client else { return }
        if isSyncing {
            needsAnotherSync = true
            return
        }
        isSyncing = true
        defer { isSyncing = false }

        do {
            let result = try await client.sync(credentials, data: userData)
            guard self.credentials?.userKey == credentials.userKey else { return }
            // Izmjene napravljene dok je zahtjev bio u letu su novije i ostaju.
            let merged = LWW.merge(server: result.data, client: userData)
            let hasNewerLocal = merged != result.data
            if merged != userData {
                let lastUrlChanged = merged.meta.lastUrl != userData.meta.lastUrl
                userData = merged
                persist()
                if lastUrlChanged, let ref = chapterRef(fromWebPath: merged.meta.lastUrl), ref != readerTarget.chapter, selectedTab != .reader {
                    readerTarget = ReaderTarget(chapter: ref)
                }
            }
            lastSyncedAt = result.syncedAt
            defaults.set(result.syncedAt, forKey: Keys.lastSyncedAt)
            syncError = nil
            if hasNewerLocal { needsAnotherSync = true }
        } catch let error as SyncError {
            syncError = error.errorDescription
        } catch {
            syncError = error.localizedDescription
        }

        if needsAnotherSync {
            needsAnotherSync = false
            scheduleSync(after: .milliseconds(300))
        }
    }

    // MARK: - Statistika za postavke

    var completedDaysCount: Int {
        userData.progress.values.reduce(0) { $0 + $1.values.filter(\.completed).count }
    }

    var dataVersion: String {
        let hash = (try? database?.meta("data_hash")) ?? nil
        return hash.map { String($0.prefix(12)) } ?? "—"
    }
}
