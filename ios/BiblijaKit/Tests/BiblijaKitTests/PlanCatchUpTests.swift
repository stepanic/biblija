import Foundation
import XCTest
@testable import BiblijaKit

/// Treba build/mobile/biblija-mobile.db (python3 scripts/export_mobile_db.py).
final class PlanCatchUpTests: XCTestCase {
    var days: [PlanDay] = []
    var kings2 = 0

    override func setUpWithError() throws {
        try XCTSkipUnless(FileManager.default.fileExists(atPath: Repo.mobileDbPath), "nema mobilne baze")
        let db = try BibleDatabase(path: Repo.mobileDbPath)
        days = try db.planDays(planId: PlanCatchUp.canonPlanId)
        kings2 = try XCTUnwrap(db.books().first { $0.abbr == "2 Kr" }).order
    }

    func testManualCursorOffersDaysEndingBeforeIt() {
        let offer = PlanCatchUp.daysToOffer(days: days, from: nil, to: ChapterRef(bookOrder: kings2, chapter: 6)) { _ in false }
        XCTAssertEqual(offer.map(\.day), Array(1...102))
        XCTAssertEqual(offer.last?.label, "2 Kr 3–5", "dan s 2 Kr 6 ostaje neoznačen")
    }

    func testAlreadyDoneDaysAreSkipped() {
        let offer = PlanCatchUp.daysToOffer(days: days, from: nil, to: ChapterRef(bookOrder: kings2, chapter: 6)) { $0 <= 100 }
        XCTAssertEqual(offer.map(\.day), [101, 102])
    }

    func testLinearStepOffersOnlyTheDayItFinished() {
        // Dan 102 je 2 Kr 3–5: prijelaz s 2 Kr 5 na 2 Kr 6 ga završava, prijelaz s 4 na 5 ne.
        let step = PlanCatchUp.daysToOffer(
            days: days, from: ChapterRef(bookOrder: kings2, chapter: 5), to: ChapterRef(bookOrder: kings2, chapter: 6)
        ) { _ in false }
        XCTAssertEqual(step.map(\.day), [102])
        let mid = PlanCatchUp.daysToOffer(
            days: days, from: ChapterRef(bookOrder: kings2, chapter: 4), to: ChapterRef(bookOrder: kings2, chapter: 5)
        ) { _ in false }
        XCTAssertTrue(mid.isEmpty)
    }

    func testBackwardsCursorOffersNothing() {
        let back = PlanCatchUp.daysToOffer(
            days: days, from: ChapterRef(bookOrder: kings2, chapter: 6), to: ChapterRef(bookOrder: 1, chapter: 3)
        ) { _ in false }
        XCTAssertTrue(back.isEmpty)
    }
}
