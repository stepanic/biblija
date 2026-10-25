import BiblijaKit
import SwiftUI

/// Pretraga: lokalni SQLite FTS5 bez mreže, plus prepoznavanje kratica („Iv 3,16").
struct SearchView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var testament = ""
    @State private var bookOrder: Int?
    @State private var result = SearchResult(total: 0, hits: [])
    @State private var elapsedMs: Double = 0

    private static let examples = ["ljubav", "\"u početku\"", "Duh Božji", "Iv 3,16", "Ps 23", "pastir"]

    private var reference: BibleReference? { BibleReference.parse(query, books: model.books) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Zavjet", selection: $testament) {
                        Text("Cijela Biblija").tag("")
                        Text("Stari zavjet").tag("SZ")
                        Text("Novi zavjet").tag("NZ")
                    }
                    Picker("Knjiga", selection: $bookOrder) {
                        Text("Sve knjige").tag(Int?.none)
                        ForEach(model.books.filter { testament.isEmpty || $0.testament == testament }) { b in
                            Text("\(b.abbr) — \(b.title)").tag(Int?.some(b.order))
                        }
                    }
                }

                if let reference {
                    Section("Prepoznata biblijska kratica") {
                        Button {
                            model.open(ChapterRef(bookOrder: reference.book.order, chapter: reference.chapter), verse: reference.verse)
                        } label: {
                            Label("Otvori \(reference.label) — \(reference.book.title)", systemImage: "book")
                        }
                    }
                }

                if query.trimmingCharacters(in: .whitespaces).isEmpty {
                    Section("Primjeri") {
                        ForEach(Self.examples, id: \.self) { ex in
                            Button(ex) { query = ex }
                        }
                    }
                } else {
                    Section {
                        ForEach(result.hits) { hit in
                            Button {
                                model.open(ChapterRef(bookOrder: hit.bookOrder, chapter: hit.chapter), verse: hit.verse)
                            } label: {
                                SearchHitRow(hit: hit, query: query)
                            }
                            .buttonStyle(.plain)
                        }
                    } header: {
                        Text("Pronađeno \(result.total) pogodaka (\(String(format: "%.0f", elapsedMs)) ms)" + (result.total > result.hits.count ? " — prikazano prvih \(result.hits.count)" : ""))
                    }
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Pojam, \"fraza\" ili kratica (Iv 3,16)")
            .autocorrectionDisabled()
            .navigationTitle("Pretraga")
            .task(id: SearchKey(query: query, testament: testament, bookOrder: bookOrder)) {
                // debounce kao na webu (240 ms)
                try? await Task.sleep(for: .milliseconds(240))
                guard !Task.isCancelled else { return }
                let start = Date()
                result = model.search(query, testament: testament.isEmpty ? nil : testament, bookOrder: bookOrder)
                elapsedMs = Date().timeIntervalSince(start) * 1000
            }
            .onChange(of: testament) { _, t in
                if let bo = bookOrder, let b = model.book(order: bo), !t.isEmpty, b.testament != t { bookOrder = nil }
            }
        }
    }

    private struct SearchKey: Equatable {
        let query: String
        let testament: String
        let bookOrder: Int?
    }
}

private struct SearchHitRow: View {
    let hit: SearchHit
    let query: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(hit.bookAbbr) \(hit.chapter),\(hit.verse) — \(hit.bookTitle)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tint)
            Text(highlighted)
                .font(ReadingFont.font(16))
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private var highlighted: AttributedString {
        var attr = AttributedString(hit.text)
        for range in HrFold.matchRanges(in: hit.text, query: query) {
            guard let lower = AttributedString.Index(range.lowerBound, within: attr),
                  let upper = AttributedString.Index(range.upperBound, within: attr) else { continue }
            attr[lower..<upper].backgroundColor = Color.yellow.opacity(0.4)
            attr[lower..<upper].inlinePresentationIntent = .stronglyEmphasized
        }
        return attr
    }
}
