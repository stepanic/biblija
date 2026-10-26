import Foundation

/// Lokalno korisničko stanje kao JSON datoteka (ista struktura kao /api/sync), odvojeno od read-only teksta.
public struct UserDataStore: Sendable {
    public let url: URL

    public init(url: URL) {
        self.url = url
    }

    public static func inApplicationSupport(fileName: String = "user-data.json") throws -> UserDataStore {
        let dir = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return UserDataStore(url: dir.appendingPathComponent(fileName))
    }

    public func load() -> UserData {
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode(UserData.self, from: data)
        else { return .empty }
        return decoded
    }

    public func save(_ userData: UserData) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(userData).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    public func reset() {
        try? FileManager.default.removeItem(at: url)
    }
}

/// Izmjene korisničkog stanja s timestampom, kao na webu (togglePlanDayCompleted, saveBookmark…).
public extension UserData {
    mutating func setDay(planId: String, day: Int, completed: Bool, at now: String = Timestamp.now()) {
        progress[planId, default: [:]][String(day)] = DayProgress(completed: completed, updatedAt: now)
    }

    mutating func toggleDay(planId: String, day: Int, at now: String = Timestamp.now()) {
        setDay(planId: planId, day: day, completed: !isDayDone(planId: planId, day: day), at: now)
    }

    mutating func upsertBookmark(_ bookmark: Bookmark, at now: String = Timestamp.now()) {
        var b = bookmark
        b.deleted = false
        b.updatedAt = now
        bookmarks[b.key] = b
    }

    mutating func removeBookmark(key: String, at now: String = Timestamp.now()) {
        guard var b = bookmarks[key] else { return }
        b.deleted = true
        b.updatedAt = now
        bookmarks[key] = b
    }

    mutating func setActivePlan(_ planId: String, at now: String = Timestamp.now()) {
        meta.activePlanId = planId
        meta.lastUpdatedAt = now
    }

    mutating func setLinear(url: String, label: String, verse: Int, at now: String = Timestamp.now()) {
        linear = LinearCursor(url: url, label: label, verse: verse, updatedAt: now)
    }

    mutating func upsertLog(_ entry: ReadingLogEntry) {
        readingLog[entry.id] = entry
        logDirty.insert(entry.id)
    }

    /// Otvoreno poglavlje, kao `initReadingTracker` u public/astro-client.js: kursor se pomiče ako je ovo
    /// isto ili sljedeće poglavlje (ili kursora još nema), a zapis istog poglavlja s ovog uređaja mlađi
    /// od `continueWithin` se nastavlja umjesto novog. Vraća id zapisa.
    @discardableResult
    mutating func beginVisit(
        url: String, label: String, previousUrl: String?, device: String,
        newId: String = UUID().uuidString.lowercased(), now: Date = Date(), continueWithin: TimeInterval = 30 * 60
    ) -> String {
        let nowIso = Timestamp.now(now)
        if linear == nil || (previousUrl != nil && linear?.url == previousUrl) {
            setLinear(url: url, label: label, verse: 0, at: nowIso)
        }
        let isLinear = linear?.url == url
        if var recent = readingLog.values
            .filter({ $0.url == url && $0.device == device })
            .max(by: { $0.endedAt < $1.endedAt }),
           let ended = Timestamp.parse(recent.endedAt), now.timeIntervalSince(ended) < continueWithin {
            recent.endedAt = nowIso
            recent.updatedAt = nowIso
            recent.linear = recent.linear || isLinear
            upsertLog(recent)
            return recent.id
        }
        upsertLog(ReadingLogEntry(
            id: newId, url: url, label: label, verse: 0, startedAt: nowIso, endedAt: nowIso,
            linear: isLinear, device: device, updatedAt: nowIso
        ))
        return newId
    }

    /// Redak na vrhu se promijenio (ili samo vrijeme, ako je `verse` isti). Kursor prati redak samo dok je
    /// na ovom poglavlju i samo kad se redak stvarno promijeni, kao na webu.
    mutating func updateVisit(id: String, verse: Int, at now: String = Timestamp.now(), moveLinear: Bool = true) {
        guard var entry = readingLog[id] else { return }
        let isLinear = linear?.url == entry.url
        entry.verse = verse
        entry.endedAt = max(now, entry.startedAt)
        entry.updatedAt = now
        entry.linear = entry.linear || isLinear
        upsertLog(entry)
        if moveLinear, isLinear, var cursor = linear, cursor.verse != verse {
            cursor.verse = verse
            cursor.updatedAt = now
            linear = cursor
        }
    }

    mutating func setLastRead(url: String, label: String, at now: String = Timestamp.now()) {
        guard meta.lastUrl != url else { return }
        meta.lastUrl = url
        meta.lastLabel = label
        meta.lastUpdatedAt = now
    }
}
