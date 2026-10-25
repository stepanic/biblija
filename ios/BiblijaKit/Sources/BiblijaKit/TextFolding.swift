import Foundation

/// Port `fold_hr` iz scripts/build_catalog_and_db.py (njime su foldani `verses.text_folded` i FTS indeks).
/// Ponašanje je zaključano vektorima u shared/test-vectors/fold_hr.json.
public enum HrFold {
    private static let croatian: [Character: Character] = [
        "č": "c", "ć": "c", "ž": "z", "š": "s", "đ": "d",
        "Č": "C", "Ć": "C", "Ž": "Z", "Š": "S", "Đ": "D",
    ]

    public static func fold(_ text: String) -> String {
        var mapped = String()
        mapped.reserveCapacity(text.utf8.count)
        for ch in text {
            mapped.append(croatian[ch] ?? ch)
        }
        var kept = String.UnicodeScalarView()
        for scalar in mapped.decomposedStringWithCompatibilityMapping.unicodeScalars
        where scalar.properties.canonicalCombiningClass == .notReordered {
            kept.append(scalar)
        }
        return String(kept).lowercased()
    }

    /// Tokeni kao Pythonov `re.findall(r"[\w]+", ...)`: slova, znamenke i `_`.
    public static func tokens(_ folded: String) -> [String] {
        var result: [String] = []
        var current = String()
        for ch in folded {
            if ch.isLetter || ch.isNumber || ch == "_" {
                current.append(ch)
            } else if !current.isEmpty {
                result.append(current)
                current = String()
            }
        }
        if !current.isEmpty { result.append(current) }
        return result
    }

    /// Korisnički upit → FTS5 MATCH izraz (isto kao /api/search u server.py).
    /// `nil` znači da nema što tražiti. Vidi shared/test-vectors/fts_query.json.
    public static func ftsExpression(_ query: String) -> String? {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let toks = tokens(fold(q))
        guard !toks.isEmpty else { return nil }
        if q.hasPrefix("\""), q.hasSuffix("\""), toks.count > 1 {
            return "\"" + toks.joined(separator: " ") + "\""
        }
        return toks.map { "\"\($0)\"*" }.joined(separator: " AND ")
    }
}

public extension HrFold {
    /// Rasponi u izvornom tekstu gdje se pojavljuju tokeni upita (tokeni ≥ 2 znaka, kao highlightMatch na webu).
    /// Uspoređuje se foldani tekst, pa „bozji" označi „Božji".
    static func matchRanges(in text: String, query: String) -> [Range<String.Index>] {
        let needles = Set(tokens(fold(query)).filter { $0.count >= 2 })
        guard !needles.isEmpty else { return [] }

        // foldani tekst + za svaki foldani znak indeks izvornog znaka
        var folded: [Character] = []
        var origin: [String.Index] = []
        var idx = text.startIndex
        while idx < text.endIndex {
            for f in fold(String(text[idx])) {
                folded.append(f)
                origin.append(idx)
            }
            idx = text.index(after: idx)
        }

        var ranges: [Range<String.Index>] = []
        for needle in needles {
            let n = Array(needle)
            guard n.count <= folded.count else { continue }
            var i = 0
            while i + n.count <= folded.count {
                if Array(folded[i..<(i + n.count)]) == n {
                    let start = origin[i]
                    let lastOrigin = origin[i + n.count - 1]
                    ranges.append(start..<text.index(after: lastOrigin))
                    i += n.count
                } else {
                    i += 1
                }
            }
        }
        ranges.sort { $0.lowerBound < $1.lowerBound }
        // spoji preklapanja
        var mergedRanges: [Range<String.Index>] = []
        for r in ranges {
            if let last = mergedRanges.last, r.lowerBound <= last.upperBound {
                mergedRanges[mergedRanges.count - 1] = last.lowerBound..<max(last.upperBound, r.upperBound)
            } else {
                mergedRanges.append(r)
            }
        }
        return mergedRanges
    }
}
