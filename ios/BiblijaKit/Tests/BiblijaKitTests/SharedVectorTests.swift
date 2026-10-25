import Foundation
import XCTest
@testable import BiblijaKit

/// shared/test-vectors/*.json: isti vektori vrijede za Python, worker, Swift i Kotlin.
enum Repo {
    static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // BiblijaKitTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // BiblijaKit
        .deletingLastPathComponent() // ios
        .deletingLastPathComponent()

    static func vectors(_ name: String) throws -> [[String: Any]] {
        let data = try Data(contentsOf: root.appendingPathComponent("shared/test-vectors/\(name)"))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        return json["cases"] as! [[String: Any]]
    }

    static func decodeUserData(_ any: Any) throws -> UserData {
        try JSONDecoder().decode(UserData.self, from: JSONSerialization.data(withJSONObject: any))
    }

    static var mobileDbPath: String { root.appendingPathComponent("build/mobile/biblija-mobile.db").path }
}

final class SharedVectorTests: XCTestCase {
    func testFoldHr() throws {
        for c in try Repo.vectors("fold_hr.json") {
            let input = c["input"] as! String
            XCTAssertEqual(HrFold.fold(input), c["expected"] as? String, "ulaz: \(input.debugDescription)")
        }
    }

    func testFtsExpression() throws {
        for c in try Repo.vectors("fts_query.json") {
            let input = c["input"] as! String
            XCTAssertEqual(HrFold.ftsExpression(input), c["expected"] as? String, "ulaz: \(input.debugDescription)")
        }
    }

    func testLwwMerge() throws {
        for c in try Repo.vectors("lww_merge.json") where c["server_only"] as? Bool != true {
            let name = c["name"] as! String
            let merged = LWW.merge(server: try Repo.decodeUserData(c["server"]!), client: try Repo.decodeUserData(c["client"]!))
            let expected = try Repo.decodeUserData(c["expected"]!)
            XCTAssertEqual(merged.meta, expected.meta, name)
            XCTAssertEqual(merged.progress, expected.progress, name)
            XCTAssertEqual(merged.bookmarks, expected.bookmarks, name)
        }
    }

    func testBibleReference() throws {
        let db = try BibleDatabase(path: Repo.mobileDbPath)
        let books = try db.books()
        for c in try Repo.vectors("bible_reference.json") {
            let input = c["input"] as! String
            let parsed = BibleReference.parse(input, books: books)
            guard let expected = c["expected"] as? [String: Any] else {
                XCTAssertNil(parsed, "ulaz: \(input)")
                continue
            }
            XCTAssertEqual(parsed?.book.order, expected["book_order"] as? Int, "ulaz: \(input)")
            XCTAssertEqual(parsed?.chapter, expected["chapter"] as? Int, "ulaz: \(input)")
            XCTAssertEqual(parsed?.verse, expected["verse"] as? Int, "ulaz: \(input)")
        }
    }
}
