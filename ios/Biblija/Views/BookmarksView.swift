import BiblijaKit
import SwiftUI

/// Moje oznake i bilješke (stranica /oznake/ na webu).
struct BookmarksView: View {
    @Environment(AppModel.self) private var model

    enum Filter: Hashable {
        case all, notes, color(BookmarkColor)
    }

    @State private var filter: Filter = .all

    private var bookmarks: [Bookmark] {
        model.userData.activeBookmarks.filter { b in
            switch filter {
            case .all: true
            case .notes: !b.note.isEmpty
            case .color(let c): b.bookmarkColor == c
            }
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if bookmarks.isEmpty {
                    ContentUnavailableView(
                        "Nema oznaka",
                        systemImage: "bookmark",
                        description: Text("Dodirni redak tijekom čitanja za označavanje bojom ili bilješku.")
                    )
                } else {
                    ForEach(bookmarks, id: \.key) { bm in
                        Button {
                            model.open(ChapterRef(bookOrder: bm.bookOrder, chapter: bm.chapter), verse: bm.verse)
                        } label: {
                            BookmarkRow(bookmark: bm)
                        }
                        .buttonStyle(.plain)
                        .swipeActions {
                            Button(role: .destructive) {
                                model.removeBookmark(key: bm.key)
                            } label: {
                                Label("Ukloni", systemImage: "trash")
                            }
                        }
                    }
                }
            }
            // Filteri su iznad liste, a ne u njezinu retku, da traka ide od ruba do ruba ekrana.
            .safeAreaInset(edge: .top, spacing: 0) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        chip("Sve", .all)
                        chip("S bilješkom", .notes)
                        ForEach(BookmarkColor.allCases, id: \.self) { c in
                            chip(c.label, .color(c), swatch: c.swatch)
                        }
                    }
                }
                .contentMargins(.horizontal, 20, for: .scrollContent)
                .padding(.vertical, 8)
                .background(.bar)
            }
            .navigationTitle("Oznake")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        ReadingLogView()
                    } label: {
                        Label("Dnevnik čitanja", systemImage: "clock.arrow.circlepath")
                    }
                }
            }
        }
    }

    private func chip(_ title: String, _ value: Filter, swatch: Color? = nil) -> some View {
        Button {
            filter = value
        } label: {
            HStack(spacing: 6) {
                if let swatch { Circle().fill(swatch).frame(width: 10, height: 10) }
                Text(title).font(.subheadline)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(filter == value ? Color.accentColor.opacity(0.25) : Color.secondary.opacity(0.12), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(filter == value ? .isSelected : [])
    }
}

private struct BookmarkRow: View {
    let bookmark: Bookmark

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            RoundedRectangle(cornerRadius: 2)
                .fill(bookmark.bookmarkColor.swatch)
                .frame(width: 4)
            VStack(alignment: .leading, spacing: 4) {
                Text("\(bookmark.bookAbbr) \(bookmark.chapter),\(bookmark.verse) — \(bookmark.bookTitle)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tint)
                Text(bookmark.text)
                    .font(ReadingFont.font(16))
                    .lineLimit(4)
                if !bookmark.note.isEmpty {
                    Label(bookmark.note, systemImage: "pencil")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}
