import BiblijaKit
import Foundation
import XCTest

final class ReadingLogTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

    func testFirstVisitSetsCursorAndJumpKeepsIt() {
        var d = UserData.empty
        d.beginVisit(url: "/izaija/11/", label: "Iz 11", previousUrl: "/izaija/10/", device: "iPhone", newId: "a", now: t0)
        XCTAssertEqual(d.linear?.url, "/izaija/11/")

        d.beginVisit(url: "/izaija/12/", label: "Iz 12", previousUrl: "/izaija/11/", device: "iPhone", newId: "b", now: t0 + 60)
        XCTAssertEqual(d.linear?.url, "/izaija/12/")
        XCTAssertEqual(d.readingLog["b"]?.linear, true)

        d.beginVisit(url: "/psalmi/23/", label: "Ps 23", previousUrl: "/psalmi/22/", device: "iPhone", newId: "c", now: t0 + 120)
        XCTAssertEqual(d.linear?.url, "/izaija/12/", "skok ne pomiče kursor")
        XCTAssertEqual(d.readingLog["c"]?.linear, false)
        XCTAssertEqual(d.logDirty, ["a", "b", "c"])
    }

    func testReopeningSameChapterSoonContinuesEntry() {
        var d = UserData.empty
        d.beginVisit(url: "/psalmi/23/", label: "Ps 23", previousUrl: nil, device: "iPhone", newId: "a", now: t0)
        let id = d.beginVisit(url: "/psalmi/23/", label: "Ps 23", previousUrl: nil, device: "iPhone", newId: "b", now: t0 + 600)
        XCTAssertEqual(id, "a")
        XCTAssertEqual(d.readingLog.count, 1)
        XCTAssertEqual(d.readingLog["a"]?.endedAt, Timestamp.now(t0 + 600))

        let later = d.beginVisit(url: "/psalmi/23/", label: "Ps 23", previousUrl: nil, device: "iPhone", newId: "c", now: t0 + 4000)
        XCTAssertEqual(later, "c")
        let other = d.beginVisit(url: "/psalmi/23/", label: "Ps 23", previousUrl: nil, device: "Web · Mac", newId: "d", now: t0 + 4010)
        XCTAssertEqual(other, "d", "drugi uređaj ima svoj zapis")
    }

    func testUpdateVisitMovesCursorOnlyOnItsChapter() {
        var d = UserData.empty
        d.beginVisit(url: "/izaija/12/", label: "Iz 12", previousUrl: nil, device: "iPhone", newId: "a", now: t0)
        d.updateVisit(id: "a", verse: 7, at: Timestamp.now(t0 + 30))
        XCTAssertEqual(d.readingLog["a"]?.verse, 7)
        XCTAssertEqual(d.linear?.verse, 7)

        d.beginVisit(url: "/psalmi/23/", label: "Ps 23", previousUrl: nil, device: "iPhone", newId: "b", now: t0 + 60)
        d.updateVisit(id: "b", verse: 4, at: Timestamp.now(t0 + 90))
        XCTAssertEqual(d.linear?.verse, 7)
        XCTAssertEqual(d.linear?.url, "/izaija/12/")

        let before = d.linear
        d.updateVisit(id: "a", verse: 7, at: Timestamp.now(t0 + 200))
        XCTAssertEqual(d.linear, before, "isti redak ne osvježava vrijeme kursora")
    }

    func testMergeKeepsNewerLocalLogAndCursor() {
        let old = ReadingLogEntry(id: "a", url: "/izaija/12/", label: "", verse: 2, startedAt: "2026-10-01T08:00:00.000Z", endedAt: "2026-10-01T08:01:00.000Z", linear: true, device: "Web", updatedAt: "2026-10-01T08:01:00.000Z")
        var newer = old
        newer.verse = 9
        newer.updatedAt = "2026-10-01T08:05:00.000Z"
        let fromServer = ReadingLogEntry(id: "b", url: "/psalmi/23/", label: "", verse: 0, startedAt: "2026-10-01T09:00:00.000Z", endedAt: "2026-10-01T09:00:00.000Z", linear: false, device: "Web", updatedAt: "2026-10-01T09:00:00.000Z")

        let server = UserData(meta: .empty, progress: [:], bookmarks: [:],
                              linear: LinearCursor(url: "/izaija/12/", label: "", verse: 2, updatedAt: "2026-10-01T08:01:00.000Z"),
                              readingLog: ["a": old, "b": fromServer], logCursor: "2026-10-01T10:00:00.000Z")
        let client = UserData(meta: .empty, progress: [:], bookmarks: [:],
                              linear: LinearCursor(url: "/izaija/12/", label: "", verse: 9, updatedAt: "2026-10-01T08:05:00.000Z"),
                              readingLog: ["a": newer], logDirty: ["a"])
        let merged = LWW.merge(server: server, client: client)
        XCTAssertEqual(merged.readingLog["a"]?.verse, 9)
        XCTAssertEqual(merged.readingLog["b"], fromServer)
        XCTAssertEqual(merged.linear?.verse, 9)
        XCTAssertEqual(merged.logCursor, "2026-10-01T10:00:00.000Z")
        XCTAssertEqual(merged.logDirty, ["a"])
    }

    func testOldStoredFileDecodes() throws {
        let json = #"{"meta":{"active_plan_id":"x","last_url":"/","last_label":"","last_updated_at":"1970-01-01T00:00:00.000Z"},"progress":{},"bookmarks":{}}"#
        let d = try JSONDecoder().decode(UserData.self, from: Data(json.utf8))
        XCTAssertNil(d.linear)
        XCTAssertTrue(d.readingLog.isEmpty)
        XCTAssertEqual(d.logCursor, "")
    }
}
