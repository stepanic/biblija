import BiblijaKit
import SwiftUI

/// Popis 73 knjige po kategorijama s filtrom SZ/NZ/DK i pretragom (ladica knjiga na webu).
struct BookPickerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let current: ChapterRef
    let onSelect: (ChapterRef) -> Void

    enum Filter: String, CaseIterable, Identifiable {
        case all = "Sve", ot = "SZ", nt = "NZ", deut = "DK"
        var id: String { rawValue }
    }

    @State private var filter: Filter = .all
    @State private var query = ""

    private var filtered: [Book] {
        let q = HrFold.fold(query.trimmingCharacters(in: .whitespaces))
        return model.books.filter { b in
            switch filter {
            case .all: break
            case .ot: guard b.testament == "SZ" else { return false }
            case .nt: guard b.testament == "NZ" else { return false }
            case .deut: guard b.deuterocanonical else { return false }
            }
            guard !q.isEmpty else { return true }
            return HrFold.fold("\(b.abbr) \(b.title) \(b.category) \(b.usfmId) \(b.nameEn)").contains(q)
        }
    }

    private var groups: [(String, [Book])] {
        var order: [String] = []
        var map: [String: [Book]] = [:]
        for b in filtered {
            if map[b.category] == nil { order.append(b.category) }
            map[b.category, default: []].append(b)
        }
        return order.map { ($0, map[$0]!) }
    }

    var body: some View {
        NavigationStack {
            List {
                Picker("Filtar", selection: $filter) {
                    ForEach(Filter.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)

                ForEach(groups, id: \.0) { category, books in
                    Section(category) {
                        ForEach(books) { book in
                            NavigationLink(value: book) {
                                HStack {
                                    Text(book.abbr)
                                        .font(.subheadline.weight(.semibold))
                                        .frame(width: 52, alignment: .leading)
                                    Text(book.title)
                                    Spacer()
                                    Text("\(book.chapterCount)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                .fontWeight(book.order == current.bookOrder ? .bold : .regular)
                            }
                        }
                    }
                }
            }
            .searchable(text: $query, prompt: "Traži knjigu ili kraticu (Iv, Ps, Sir)")
            .navigationTitle("Knjige Svetoga pisma")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Book.self) { book in
                ChapterGridView(book: book, current: current, onSelect: onSelect)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Zatvori") { dismiss() }
                }
            }
        }
    }
}

struct ChapterGridView: View {
    @Environment(AppModel.self) private var model
    let book: Book
    let current: ChapterRef
    let onSelect: (ChapterRef) -> Void

    var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 56), spacing: 10)], spacing: 10) {
                ForEach(model.chapters(of: book), id: \.chapter) { ch in
                    let isCurrent = book.order == current.bookOrder && ch.chapter == current.chapter
                    Button {
                        onSelect(ChapterRef(bookOrder: book.order, chapter: ch.chapter))
                    } label: {
                        Text(ch.shortLabel)
                            .font(.body.weight(isCurrent ? .bold : .regular))
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .background(isCurrent ? Color.accentColor.opacity(0.25) : Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(ch.chapter == 0 ? "Proslov" : "Poglavlje \(ch.chapter), \(ch.verseCount) redaka")
                }
            }
            .padding()
        }
        .navigationTitle(book.title)
    }
}
