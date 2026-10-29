import Foundation
import XCTest
@testable import BiblijaKit

/// Treba build/mobile/biblija-mobile.db (python3 scripts/export_mobile_db.py).
final class BibleDatabaseTests: XCTestCase {
    var db: BibleDatabase!

    override func setUpWithError() throws {
        try XCTSkipUnless(FileManager.default.fileExists(atPath: Repo.mobileDbPath), "nema mobilne baze")
        db = try BibleDatabase(path: Repo.mobileDbPath)
    }

    func testBooksAndChapters() throws {
        let books = try db.books()
        XCTAssertEqual(books.count, 73)
        XCTAssertEqual(books.first?.slug, "knjiga-postanka")
        XCTAssertEqual(books.filter { $0.testament == "NZ" }.count, 27)
        let sirach = try XCTUnwrap(books.first { $0.abbr == "Sir" })
        XCTAssertEqual(try db.chapters(bookOrder: sirach.order).first?.chapter, 0, "Sirah počinje Proslovom")
    }

    func testVersesWithHeadingsAndLines() throws {
        let john3 = try db.verses(bookOrder: 50, chapter: 3)
        XCTAssertEqual(john3.first(where: { $0.verse == 16 })?.text.contains("Bog je tako ljubio svijet"), true)
        let psalm23 = try db.verses(bookOrder: 23, chapter: 23)
        XCTAssertTrue(psalm23.contains { $0.isPoetic })
        XCTAssertFalse(try db.verses(bookOrder: 19, chapter: 1).first!.headings.isEmpty)
    }

    func testAltTranslations() throws {
        let all = try db.altTranslations()
        XCTAssertEqual(all.map(\.slug), ["saric", "katancic", "rupcic", "raspudic", "gusic"])
        let katancic = try XCTUnwrap(all.first { $0.slug == "katancic" })
        XCTAssertFalse(katancic.has(bookOrder: 9), "FOI nema 1 Sam")
        XCTAssertNotNil(katancic.bookNotes[17] ?? nil, "Tobija ima napomenu o Vulgati")
        let rupcic = try XCTUnwrap(all.first { $0.slug == "rupcic" })
        XCTAssertFalse(rupcic.has(bookOrder: 1))
        XCTAssertTrue(rupcic.has(bookOrder: 50))
        let john1 = try db.altVerses(slug: "saric", bookOrder: 50, chapter: 1)
        XCTAssertEqual(john1.first?.verse, 1)
        XCTAssertTrue(john1.first?.text.hasPrefix("U početku") ?? false)
    }

    func testSearchMatchesServerSemantics() throws {
        // isti broj kao server.py: verses_fts MATCH '"ljubav"*'
        XCTAssertEqual(try db.search("ljubav").total, 272)
        XCTAssertEqual(try db.search("LJUBAV").total, 272)
        let nt = try db.search("ljubav", testament: "NZ")
        XCTAssertTrue(nt.hits.allSatisfy { $0.bookOrder >= 47 })
        XCTAssertLessThan(nt.total, 272)
        XCTAssertEqual(try db.search("Duh Božji").total, try db.search("duh bozji").total)
        let phrase = try db.search("\"u početku\"")
        XCTAssertGreaterThan(phrase.total, 0)
        XCTAssertEqual(try db.search("!!!").total, 0)
        XCTAssertEqual(try db.search("ljubav", limit: 5).hits.count, 5)
    }

    func testPlans() throws {
        let plans = try db.plans()
        XCTAssertEqual(plans.count, 18)
        XCTAssertEqual(plans.first?.id, SyncMeta.defaultPlanId)
        let days = try db.planDays(planId: SyncMeta.defaultPlanId)
        XCTAssertEqual(days.count, 365)
        XCTAssertEqual(days.first?.readings.first?.bookAbbr, "Post")
        XCTAssertEqual(days.first?.readings.first?.chapters.count, 2)
    }
}

final class UserDataTests: XCTestCase {
    func testMutationsAndRoundTrip() throws {
        var data = UserData.empty
        data.toggleDay(planId: "p", day: 3, at: "2026-10-01T00:00:00.000Z")
        XCTAssertTrue(data.isDayDone(planId: "p", day: 3))
        data.toggleDay(planId: "p", day: 3, at: "2026-10-02T00:00:00.000Z")
        XCTAssertFalse(data.isDayDone(planId: "p", day: 3))

        let bm = Bookmark(bookOrder: 50, bookId: "evandelje-po-ivanu", bookAbbr: "Iv", bookTitle: "Evanđelje po Ivanu",
                          chapter: 3, verse: 16, color: "blue", note: "", text: "Bog je tako ljubio svijet", deleted: false,
                          updatedAt: Timestamp.epoch)
        data.upsertBookmark(bm, at: "2026-10-03T00:00:00.000Z")
        XCTAssertEqual(data.activeBookmarks.count, 1)
        data.removeBookmark(key: bm.key, at: "2026-10-04T00:00:00.000Z")
        XCTAssertTrue(data.activeBookmarks.isEmpty)
        XCTAssertEqual(data.bookmarks[bm.key]?.deleted, true, "brisanje je tombstone")

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("biblija-test-\(UUID().uuidString).json")
        let store = UserDataStore(url: url)
        try store.save(data)
        XCTAssertEqual(store.load(), data)
        store.reset()
        XCTAssertEqual(store.load(), .empty)
    }

    func testTimestampMatchesJavaScriptFormat() {
        let ts = Timestamp.now(Date(timeIntervalSince1970: 1_761_382_800.123))
        XCTAssertEqual(ts, "2025-10-25T09:00:00.123Z")
    }

    func testWebPath() {
        XCTAssertEqual(WebPath.chapter(bookSlug: "psalmi", chapter: 23), "/psalmi/23/")
        XCTAssertEqual(WebPath.parseChapter("/psalmi/23/")?.chapter, 23)
        XCTAssertNil(WebPath.parseChapter("/"))
    }
}

final class HighlightTests: XCTestCase {
    func testMatchRangesIgnoreDiacritics() {
        let text = "Duh Božji lebdio je nad vodama. Božji duh."
        let ranges = HrFold.matchRanges(in: text, query: "bozji")
        XCTAssertEqual(ranges.map { String(text[$0]) }, ["Božji", "Božji"])
        XCTAssertEqual(HrFold.matchRanges(in: "Đavao", query: "dav").map { String("Đavao"[$0]) }, ["Đav"])
        XCTAssertTrue(HrFold.matchRanges(in: text, query: "a").isEmpty, "tokeni kraći od 2 se ne označavaju")
    }
}
