import BiblijaKit
import SwiftUI

/// Dnevnik čitanja i mjesto linearnog čitanja (stranica /dnevnik/ na webu).
struct ReadingLogView: View {
    @Environment(AppModel.self) private var model

    enum Filter: String, CaseIterable, Identifiable {
        case all = "Sve", linear = "Redom", jump = "Skokovi"
        var id: String { rawValue }
    }

    @State private var filter: Filter = .all
    @State private var showSetLinear = false

    private var entries: [ReadingLogEntry] {
        model.readingLog.filter { e in
            switch filter {
            case .all: true
            case .linear: e.linear
            case .jump: !e.linear
            }
        }
    }

    private var days: [(day: Date, entries: [ReadingLogEntry])] {
        let cal = Calendar.current
        var out: [(Date, [ReadingLogEntry])] = []
        for e in entries {
            guard let started = Timestamp.parse(e.startedAt) else { continue }
            let day = cal.startOfDay(for: started)
            if out.last?.0 == day { out[out.count - 1].1.append(e) } else { out.append((day, [e])) }
        }
        return out
    }

    var body: some View {
        List {
            Section {
                LinearCard(showSetLinear: $showSetLinear)
            }
            Section {
                Picker("Filtar", selection: $filter) {
                    ForEach(Filter.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            if days.isEmpty {
                ContentUnavailableView(
                    model.readingLog.isEmpty ? "Dnevnik je prazan" : "Nema zapisa",
                    systemImage: "clock.arrow.circlepath",
                    description: Text(model.readingLog.isEmpty ? "Svako poglavlje koje otvoriš ovdje će se zapisati." : "Nema zapisa u odabranom filtru.")
                )
            }
            ForEach(days, id: \.day) { group in
                Section {
                    ForEach(group.entries) { e in
                        Button { model.open(e) } label: { LogRow(entry: e) }
                            .buttonStyle(.plain)
                    }
                } header: {
                    HStack {
                        Text(group.day.formatted(.dateTime.weekday(.wide).day().month(.wide).year().locale(Locale(identifier: "hr_HR"))))
                        Spacer()
                        Text(LogRow.duration(group.entries.reduce(0) { $0 + LogRow.minutes($1) }))
                    }
                }
            }
        }
        .navigationTitle("Dnevnik čitanja")
        .sheet(isPresented: $showSetLinear) {
            SetLinearView()
        }
    }
}

private struct LinearCard: View {
    @Environment(AppModel.self) private var model
    @Binding var showSetLinear: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("REDOM SI STIGAO DO")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.tint)
            if let cursor = model.linear {
                Text(placeLabel(cursor.label, cursor.verse)).font(.headline)
                Button {
                    model.openLinear()
                } label: {
                    Label("Nastavi čitanje", systemImage: "arrow.right")
                }
                .buttonStyle(.borderedProminent)
            } else {
                Text("Još nije postavljeno").font(.headline)
                Text("Otvori bilo koje poglavlje ili postavi mjesto ispod.").font(.footnote).foregroundStyle(.secondary)
            }
            Button {
                showSetLinear = true
            } label: {
                Label("Postavi mjesto od kojeg čitaš redom", systemImage: "flag")
            }
            .buttonStyle(.bordered)
        }
        .padding(.vertical, 4)
    }
}

/// Ručni početak linearnog čitanja: knjiga, poglavlje i redak, bez listanja poglavlje po poglavlje.
private struct SetLinearView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var ref: ChapterRef?
    @State private var verse = 1
    @State private var showPicker = false

    private var verseCount: Int {
        guard let ref, let book = model.book(order: ref.bookOrder) else { return 1 }
        return model.chapters(of: book).first { $0.chapter == ref.chapter }?.verseCount ?? 1
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Ako si čitao izvan aplikacije ili na starom profilu, odaberi gdje si stao i nastavi odande.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Section("Mjesto") {
                    Button {
                        showPicker = true
                    } label: {
                        LabeledContent("Knjiga i poglavlje", value: ref.map { model.label($0) } ?? "Odaberi")
                    }
                    Stepper("Redak \(verse)", value: $verse, in: 1...max(1, verseCount))
                }
            }
            .navigationTitle("Postavi mjesto")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Odustani") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Postavi") {
                        if let ref { model.setLinear(ref, verse: verse > 1 ? verse : 0) }
                        dismiss()
                    }
                    .disabled(ref == nil)
                }
            }
            .sheet(isPresented: $showPicker) {
                BookPickerView(current: ref ?? model.linearRef ?? model.readerTarget.chapter) { picked in
                    ref = picked
                    verse = 1
                    showPicker = false
                }
            }
            .onAppear {
                ref = model.linearRef
                verse = max(1, model.linear?.verse ?? 1)
            }
        }
    }
}

private struct LogRow: View {
    let entry: ReadingLogEntry

    static func minutes(_ e: ReadingLogEntry) -> Int {
        guard let s = Timestamp.parse(e.startedAt), let end = Timestamp.parse(e.endedAt) else { return 0 }
        return max(0, Int((end.timeIntervalSince(s) / 60).rounded()))
    }

    static func duration(_ min: Int) -> String {
        min < 60 ? "\(min) min" : "\(min / 60) h \(min % 60) min"
    }

    private func time(_ iso: String) -> String {
        Timestamp.parse(iso)?.formatted(date: .omitted, time: .shortened) ?? ""
    }

    var body: some View {
        let min = Self.minutes(entry)
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(min > 0 ? "\(time(entry.startedAt))–\(time(entry.endedAt))" : time(entry.startedAt))
                .font(.footnote.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 96, alignment: .leading)
            VStack(alignment: .leading, spacing: 4) {
                Text(placeLabel(entry.label, entry.verse)).font(.body.weight(.semibold))
                HStack(spacing: 8) {
                    Text(entry.linear ? "Redom" : "Skok")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(entry.linear ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.14), in: Capsule())
                    if min > 0 { Text(Self.duration(min)) }
                    if !entry.device.isEmpty { Text(entry.device) }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .contentShape(Rectangle())
    }
}

/// „Izaija (Iz 12) · redak 5", kao placeLabel u public/astro-client.js
func placeLabel(_ label: String, _ verse: Int) -> String {
    verse > 1 ? "\(label) · redak \(verse)" : label
}
