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

    mutating func setLastRead(url: String, label: String, at now: String = Timestamp.now()) {
        guard meta.lastUrl != url else { return }
        meta.lastUrl = url
        meta.lastLabel = label
        meta.lastUpdatedAt = now
    }
}
