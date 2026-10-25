import Foundation

public struct BibleReference: Equatable, Sendable {
    public let book: Book
    public let chapter: Int
    public let verse: Int?

    public var label: String {
        "\(book.abbr) \(chapter)" + (verse.map { ",\($0)" } ?? "")
    }

    // Isti regex kao parseBibleReference u public/astro-client.js
    private static let pattern = try! NSRegularExpression(
        pattern: #"^([1-3]?\s*[a-zA-ZčćžšđČĆŽŠĐ.]+)\s+([0-9]+)(?:\s*[,:]\s*([0-9]+)(?:\s*[-–]\s*([0-9]+))?)?$"#
    )

    /// Prepoznaje „Iv 3,16", „1 Kor 13", „Ps 23". Vidi shared/test-vectors/bible_reference.json.
    public static func parse(_ raw: String, books: [Book]) -> BibleReference? {
        let q = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let ns = q as NSString
        guard let m = pattern.firstMatch(in: q, range: NSRange(location: 0, length: ns.length)) else { return nil }
        func group(_ i: Int) -> String? {
            let r = m.range(at: i)
            return r.location == NSNotFound ? nil : ns.substring(with: r)
        }
        guard let bookPart = group(1), let ch = group(2).flatMap(Int.init) else { return nil }
        let token = HrFold.fold(bookPart.replacingOccurrences(of: ".", with: "").trimmingCharacters(in: .whitespaces))
        let verse = group(3).flatMap(Int.init)

        guard let book = books.first(where: {
            let title = HrFold.fold($0.title)
            return HrFold.fold($0.abbr) == token || title == token || title.hasPrefix(token)
        }) else { return nil }
        guard ch >= 0, ch <= book.chapterCount else { return nil }
        return BibleReference(book: book, chapter: ch, verse: verse)
    }
}
