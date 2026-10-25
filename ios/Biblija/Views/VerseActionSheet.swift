import BiblijaKit
import SwiftUI
import UIKit

/// Oznaka bojom, bilješka, kopiranje i dijeljenje retka (popover na webu).
struct VerseActionSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let ref: ChapterRef
    let verse: Verse

    @State private var note = ""
    @State private var color: BookmarkColor = .gold
    @State private var copied = false

    private var existing: Bookmark? { model.bookmark(ref, verse: verse.verse) }

    private var quote: String {
        "»\(verse.text)« (\(model.book(order: ref.bookOrder)?.abbr ?? "") \(ref.chapter),\(verse.verse))"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(verse.text)
                        .font(ReadingFont.font(17))
                        .textSelection(.enabled)
                }
                Section("Boja oznake") {
                    HStack(spacing: 18) {
                        ForEach(BookmarkColor.allCases, id: \.self) { c in
                            Button {
                                color = c
                                model.saveBookmark(ref, verse: verse, color: c, note: note)
                            } label: {
                                Circle()
                                    .fill(c.swatch)
                                    .frame(width: 36, height: 36)
                                    .overlay {
                                        if existing?.bookmarkColor == c {
                                            Image(systemName: "checkmark").font(.headline).foregroundStyle(.white)
                                        }
                                    }
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(c.label) oznaka")
                            .accessibilityAddTraits(existing?.bookmarkColor == c ? .isSelected : [])
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
                }
                Section("Bilješka") {
                    TextField("Osobna bilješka uz redak…", text: $note, axis: .vertical)
                        .lineLimit(2...6)
                    Button(existing == nil ? "Spremi oznaku" : "Spremi bilješku") {
                        model.saveBookmark(ref, verse: verse, color: existing?.bookmarkColor ?? color, note: note)
                        dismiss()
                    }
                }
                Section {
                    Button {
                        UIPasteboard.general.string = quote
                        copied = true
                    } label: {
                        Label(copied ? "Kopirano" : "Kopiraj citat", systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                    ShareLink(item: quote) {
                        Label("Podijeli", systemImage: "square.and.arrow.up")
                    }
                    if let existing {
                        Button(role: .destructive) {
                            model.removeBookmark(key: existing.key)
                            dismiss()
                        } label: {
                            Label("Ukloni oznaku", systemImage: "bookmark.slash")
                        }
                    }
                }
            }
            .navigationTitle("\(model.label(ref)),\(verse.verse)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Gotovo") { dismiss() }
                }
            }
            .onAppear {
                note = existing?.note ?? ""
                color = existing?.bookmarkColor ?? .gold
            }
        }
    }
}
