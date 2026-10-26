import BiblijaKit
import SwiftUI

struct ReaderView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var scheme
    @State private var showBookPicker = false
    @State private var selectedVerse: Verse?

    private var ref: ChapterRef { model.readerTarget.chapter }
    private var palette: Palette { Palette.resolve(model.theme, scheme: scheme) }

    var body: some View {
        NavigationStack {
            ChapterScrollView(ref: ref, scrollTarget: model.readerTarget.verse, palette: palette, selectedVerse: $selectedVerse)
                .id(ref)
                .background(palette.background.ignoresSafeArea())
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(palette.background, for: .navigationBar)
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        Button { showBookPicker = true } label: {
                            HStack(spacing: 4) {
                                Text(model.label(ref)).font(.headline)
                                Image(systemName: "chevron.down").font(.caption.weight(.semibold))
                            }
                            .foregroundStyle(palette.text)
                        }
                        .accessibilityHint("Odaberi knjigu i poglavlje")
                    }
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        ReaderDisplayMenu()
                    }
                    ToolbarItemGroup(placement: .topBarLeading) {
                        Button { go(-1) } label: { Image(systemName: "chevron.left") }
                            .disabled(model.neighbour(of: ref, offset: -1) == nil)
                            .accessibilityLabel("Prethodno poglavlje")
                        Button { go(1) } label: { Image(systemName: "chevron.right") }
                            .disabled(model.neighbour(of: ref, offset: 1) == nil)
                            .accessibilityLabel("Sljedeće poglavlje")
                    }
                }
                .sheet(isPresented: $showBookPicker) {
                    BookPickerView(current: ref) { picked in
                        showBookPicker = false
                        model.open(picked, keepDay: model.activeDay != nil)
                    }
                }
                .sheet(item: $selectedVerse) { verse in
                    VerseActionSheet(ref: ref, verse: verse)
                        .presentationDetents([.medium, .large])
                }
                .onAppear { model.didShow(ref) }
                .onChange(of: ref) { _, newRef in model.didShow(newRef) }
        }
    }

    private func go(_ offset: Int) {
        if let next = model.neighbour(of: ref, offset: offset) {
            model.open(next, keepDay: model.activeDay != nil)
        }
    }
}

// MARK: - Sadržaj poglavlja

/// Blokovi za prikaz, kao ChapterView.astro: naslovi, reference, odlomci ili pjesnički blokovi.
enum ChapterBlock: Identifiable {
    case heading(id: String, level: String, text: String)
    case reference(id: String, text: String)
    case prose(id: String, verses: [Verse])
    case poetic(id: String, verse: Verse)

    var id: String {
        switch self {
        case .heading(let id, _, _), .reference(let id, _), .prose(let id, _), .poetic(let id, _): id
        }
    }

    /// Redak bloka na vrhu ekrana iz njegova id-a („p12", „v12", „h12-0", „r12-0"); 0 za zaglavlje.
    static func verse(fromId id: String?) -> Int {
        guard let id, let first = id.first, "pvhr".contains(first) else { return 0 }
        return Int(id.dropFirst().prefix { $0.isNumber }) ?? 0
    }

    var verseNumbers: [Int] {
        switch self {
        case .prose(_, let verses): verses.map(\.verse)
        case .poetic(_, let verse): [verse.verse]
        default: []
        }
    }

    static func build(_ verses: [Verse], mode: ReadingMode) -> [ChapterBlock] {
        var blocks: [ChapterBlock] = []
        var paragraph: [Verse] = []

        func flush() {
            if let first = paragraph.first {
                blocks.append(.prose(id: "p\(first.verse)", verses: paragraph))
                paragraph = []
            }
        }

        for (idx, v) in verses.enumerated() {
            if !v.headings.isEmpty || !v.references.isEmpty || v.isPoetic || mode == .verses || (v.paragraphStart && idx > 0) {
                flush()
            }
            for (i, h) in v.headings.enumerated() {
                blocks.append(.heading(id: "h\(v.verse)-\(i)", level: h.level, text: h.text))
            }
            for (i, r) in v.references.enumerated() {
                blocks.append(.reference(id: "r\(v.verse)-\(i)", text: r))
            }
            if v.isPoetic {
                blocks.append(.poetic(id: "v\(v.verse)", verse: v))
            } else {
                paragraph.append(v)
            }
        }
        flush()
        return blocks
    }
}

struct ChapterScrollView: View {
    @Environment(AppModel.self) private var model
    let ref: ChapterRef
    let scrollTarget: Int?
    let palette: Palette
    @Binding var selectedVerse: Verse?

    @State private var verses: [Verse] = []
    @State private var blocks: [ChapterBlock] = []
    @State private var topBlockId: String?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if model.activeDay == nil, let cursor = model.linear, !model.isLinear(ref) {
                        LinearReturnBanner(cursor: cursor, current: ref, palette: palette)
                            .padding(.bottom, 12)
                    }
                    if let day = model.activeDay {
                        PlanDayBanner(context: day, current: ref, palette: palette)
                            .padding(.bottom, 12)
                    }
                    ChapterHeader(ref: ref, palette: palette)
                        .padding(.bottom, 16)
                        .id("top")
                    ForEach(blocks) { block in
                        blockView(block)
                            .id(block.id)
                    }
                    ChapterFooter(ref: ref, palette: palette)
                        .padding(.top, 28)
                }
                .scrollTargetLayout()
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .frame(maxWidth: 720, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .scrollPosition(id: $topBlockId, anchor: .top)
            .onChange(of: topBlockId) { _, id in
                model.didScroll(to: ChapterBlock.verse(fromId: id))
            }
            .task(id: TaskKey(ref: ref, mode: model.readingMode)) {
                verses = model.verses(ref)
                blocks = ChapterBlock.build(verses, mode: model.readingMode)
                if let target = scrollTarget, let block = blocks.first(where: { $0.verseNumbers.contains(target) }) {
                    try? await Task.sleep(for: .milliseconds(80))
                    withAnimation { proxy.scrollTo(block.id, anchor: .top) }
                }
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == "biblija-verse", let n = Int(url.host() ?? ""), let v = verses.first(where: { $0.verse == n }) else {
                return .systemAction
            }
            selectedVerse = v
            return .handled
        })
    }

    private struct TaskKey: Equatable {
        let ref: ChapterRef
        let mode: ReadingMode
    }

    private var fontSize: Double { model.fontSize }

    @ViewBuilder
    private func blockView(_ block: ChapterBlock) -> some View {
        switch block {
        case .heading(_, let level, let text):
            Text(text)
                .font(.custom("Iowan Old Style", size: ReadingFont.size(level == "h2" ? fontSize * 1.25 : level == "h3" ? fontSize * 1.1 : fontSize)).weight(level == "h4" ? .semibold : .bold))
                .foregroundStyle(level == "h2" ? palette.accent : palette.text)
                .padding(.top, 18)
                .padding(.bottom, 6)
                .accessibilityAddTraits(.isHeader)
        case .reference(_, let text):
            Text(text)
                .font(.footnote.italic())
                .foregroundStyle(palette.muted)
                .padding(.bottom, 6)
        case .prose(_, let verses):
            Text(proseText(verses))
                .lineSpacing(ReadingFont.size(fontSize) * 0.45)
                .tint(palette.text)
                .textSelection(.enabled)
                .padding(.bottom, model.readingMode == .verses ? 8 : 14)
        case .poetic(_, let verse):
            poeticView(verse)
                .padding(.bottom, 10)
        }
    }

    private func verseNumber(_ v: Verse) -> AttributedString {
        var num = AttributedString(v.label + "\u{00A0}")
        num.font = .system(size: ReadingFont.size(fontSize) * 0.58, weight: .semibold)
        num.baselineOffset = ReadingFont.size(fontSize) * 0.38
        num.foregroundColor = palette.accent
        return num
    }

    private func styled(_ text: String, verse: Int) -> AttributedString {
        var body = AttributedString(text)
        body.font = ReadingFont.font(fontSize)
        body.foregroundColor = palette.text
        if let bm = model.bookmark(ref, verse: verse) {
            body.backgroundColor = palette.highlight(bm.bookmarkColor)
        }
        if selectedVerse?.verse == verse {
            body.underlineStyle = .single
        }
        body.link = URL(string: "biblija-verse://\(verse)")
        return body
    }

    private func proseText(_ verses: [Verse]) -> AttributedString {
        var out = AttributedString()
        for (i, v) in verses.enumerated() {
            out += verseNumber(v)
            out += styled(v.text, verse: v.verse)
            if i < verses.count - 1 { out += AttributedString(" ") }
        }
        return out
    }

    private func poeticView(_ v: Verse) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(v.lines.enumerated()), id: \.offset) { idx, line in
                Text((idx == 0 ? verseNumber(v) : AttributedString()) + styled(line, verse: v.verse))
                    .lineSpacing(ReadingFont.size(fontSize) * 0.3)
                    .tint(palette.text)
                    .padding(.leading, idx == 0 ? 0 : 18)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Zaglavlje, traka plana, podnožje

struct ChapterHeader: View {
    @Environment(AppModel.self) private var model
    let ref: ChapterRef
    let palette: Palette

    var body: some View {
        if let book = model.book(order: ref.bookOrder) {
            let chapters = model.chapters(of: book)
            let info = chapters.first { $0.chapter == ref.chapter }
            VStack(alignment: .leading, spacing: 6) {
                Text("\(book.testament == "SZ" ? "Stari zavjet" : "Novi zavjet") • \(book.category)")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(palette.muted)
                Text(book.title)
                    .font(.custom("Iowan Old Style", size: ReadingFont.size(30)).weight(.bold))
                    .foregroundStyle(palette.text)
                Text(ref.chapter == 0 ? "Proslov" : "\(ref.chapter). poglavlje" + (info.map { " • \($0.verseCount) redaka" } ?? ""))
                    .font(.subheadline)
                    .foregroundStyle(palette.muted)
                ChapterStrip(book: book, chapters: chapters, current: ref.chapter, palette: palette)
                    .padding(.top, 6)
            }
        }
    }
}

struct ChapterStrip: View {
    @Environment(AppModel.self) private var model
    let book: Book
    let chapters: [ChapterInfo]
    let current: Int
    let palette: Palette

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 6) {
                    ForEach(chapters, id: \.chapter) { ch in
                        Button {
                            model.open(ChapterRef(bookOrder: book.order, chapter: ch.chapter), keepDay: model.activeDay != nil)
                        } label: {
                            Text(ch.shortLabel)
                                .font(.subheadline.weight(ch.chapter == current ? .bold : .regular))
                                .frame(minWidth: 34, minHeight: 34)
                                .padding(.horizontal, 4)
                                .background(ch.chapter == current ? palette.accent : palette.muted.opacity(0.12), in: Capsule())
                                .foregroundStyle(ch.chapter == current ? palette.background : palette.text)
                        }
                        .buttonStyle(.plain)
                        .id(ch.chapter)
                        .accessibilityLabel(ch.chapter == 0 ? "Proslov" : "Poglavlje \(ch.chapter)")
                    }
                }
            }
            .railBleed(20) // padding LazyVStacka u ChapterView
            .onAppear { proxy.scrollTo(current, anchor: .center) }
        }
        .frame(height: 38)
    }
}

/// Čitanje izvan reda: povratak na mjesto linearnog čitanja ili pomicanje kursora ovamo (traka na webu).
struct LinearReturnBanner: View {
    @Environment(AppModel.self) private var model
    let cursor: LinearCursor
    let current: ChapterRef
    let palette: Palette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("ČITAŠ IZVAN REDA", systemImage: "shoeprints.fill")
                .font(.caption2.weight(.bold))
                .foregroundStyle(palette.accent)
            (Text("Redom si stigao do ") + Text(placeLabel(cursor.label, cursor.verse)).bold())
                .font(.subheadline)
            HStack(spacing: 8) {
                Button {
                    model.openLinear()
                } label: {
                    Label("Vrati se", systemImage: "arrow.uturn.left")
                }
                .buttonStyle(.borderedProminent)
                .tint(palette.accent)
                Button {
                    model.continueLinearHere(current)
                } label: {
                    Label("Nastavi redom odavde", systemImage: "forward.end")
                }
                .buttonStyle(.bordered)
            }
            .font(.subheadline)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .foregroundStyle(palette.text)
        .background(palette.accent.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

struct PlanDayBanner: View {
    @Environment(AppModel.self) private var model
    let context: PlanDayContext
    let current: ChapterRef
    let palette: Palette

    var body: some View {
        let done = model.isDayDone(context.planId, context.day.day)
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Dan \(context.day.day): \(context.day.label)")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Button { model.activeDay = nil } label: { Image(systemName: "xmark") }
                    .accessibilityLabel("Sakrij traku plana")
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(context.day.readings.flatMap(\.chapters), id: \.self) { ch in
                        Button {
                            model.open(ch, keepDay: true)
                        } label: {
                            Text(model.label(ch))
                                .font(.caption.weight(ch == current ? .bold : .regular))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(ch == current ? palette.accent.opacity(0.25) : palette.muted.opacity(0.12), in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .railBleed(12)
            Button {
                model.toggleDay(context.planId, context.day.day)
            } label: {
                Label(done ? "Dan je označen pročitanim" : "Označi Dan \(context.day.day) pročitanim", systemImage: done ? "checkmark.circle.fill" : "circle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(done ? .green : palette.accent)
        }
        .padding(12)
        .foregroundStyle(palette.text)
        .background(palette.accent.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

struct ChapterFooter: View {
    @Environment(AppModel.self) private var model
    let ref: ChapterRef
    let palette: Palette

    var body: some View {
        HStack(spacing: 12) {
            navButton(offset: -1, title: "Prethodno", systemImage: "chevron.left")
            navButton(offset: 1, title: "Sljedeće", systemImage: "chevron.right")
        }
    }

    @ViewBuilder
    private func navButton(offset: Int, title: String, systemImage: String) -> some View {
        if let target = model.neighbour(of: ref, offset: offset) {
            Button {
                model.open(target, keepDay: model.activeDay != nil)
            } label: {
                VStack(alignment: offset < 0 ? .leading : .trailing, spacing: 2) {
                    Label(title, systemImage: systemImage).font(.caption).foregroundStyle(palette.muted)
                    Text(model.label(target)).font(.headline).foregroundStyle(palette.text)
                }
                .frame(maxWidth: .infinity, alignment: offset < 0 ? .leading : .trailing)
                .padding(12)
                .background(palette.muted.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
        } else {
            Spacer().frame(maxWidth: .infinity)
        }
    }
}

// MARK: - Izbornik prikaza (Aa)

struct ReaderDisplayMenu: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Menu {
            Section("Veličina slova: \(Int(model.fontSize))") {
                Button { model.fontSize = min(32, model.fontSize + 1) } label: { Label("Veća slova", systemImage: "textformat.size.larger") }
                Button { model.fontSize = max(14, model.fontSize - 1) } label: { Label("Manja slova", systemImage: "textformat.size.smaller") }
            }
            Picker("Prikaz", selection: $model.readingMode) {
                ForEach(ReadingMode.allCases) { Text($0.label).tag($0) }
            }
            Picker("Tema", selection: $model.theme) {
                ForEach(ReaderTheme.allCases) { Text($0.label).tag($0) }
            }
        } label: {
            Image(systemName: "textformat.size")
        }
        .accessibilityLabel("Prikaz teksta")
    }
}
