import BiblijaKit
import SwiftUI

/// Biblija 365: odabir plana, napredak, današnje čitanje i popis dana (stranica /plan/ na webu).
struct PlanView: View {
    @Environment(AppModel.self) private var model

    /// Horizontalni uvlak retka liste; retci s trakom ga postavljaju sami da traka ide do ruba kartice.
    static let rowInset: CGFloat = 20

    enum DayFilter: String, CaseIterable, Identifiable {
        case all = "Svi", todo = "Nepročitani", done = "Pročitani"
        var id: String { rawValue }
    }

    @State private var filter: DayFilter = .all
    @State private var query = ""

    private var plan: ReadingPlan? { model.plans.first { $0.id == model.activePlanId } ?? model.plans.first }

    var body: some View {
        NavigationStack {
            if let plan {
                content(plan)
            } else {
                ContentUnavailableView("Nema planova čitanja", systemImage: "calendar")
            }
        }
    }

    private func content(_ plan: ReadingPlan) -> some View {
        let days = model.planDays(plan.id)
        let doneCount = days.filter { model.isDayDone(plan.id, $0.day) }.count
        let next = days.first { !model.isDayDone(plan.id, $0.day) }
        let q = HrFold.fold(query.trimmingCharacters(in: .whitespaces))
        let visible = days.filter { d in
            let done = model.isDayDone(plan.id, d.day)
            if filter == .todo && done { return false }
            if filter == .done && !done { return false }
            return q.isEmpty || "dan \(d.day)".contains(q) || HrFold.fold(d.label).contains(q)
        }

        return ScrollViewReader { proxy in
            List {
                Section {
                    PlanPickerRow(plan: plan)
                    Text(plan.description)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 6) {
                        ProgressView(value: Double(doneCount), total: Double(max(plan.daysCount, 1)))
                        Text("Pročitano: \(doneCount) / \(plan.daysCount) dana (\(plan.daysCount > 0 ? doneCount * 100 / plan.daysCount : 0) %)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    if let next {
                        TodayCard(plan: plan, day: next)
                            .padding(.horizontal, PlanView.rowInset)
                            .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
                    } else {
                        Label("Čestitamo! Plan je u cijelosti pročitan.", systemImage: "party.popper")
                    }
                } header: {
                    Text("Današnje čitanje")
                } footer: {
                    if let next {
                        Button("Skoči na Dan \(next.day) u popisu") {
                            withAnimation { proxy.scrollTo(next.day, anchor: .center) }
                        }
                        .font(.footnote)
                    }
                }

                Section {
                    Picker("Filtar", selection: $filter) {
                        ForEach(DayFilter.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    ForEach(visible) { day in
                        PlanDayRow(plan: plan, day: day, isNext: day.day == next?.day)
                            .padding(.trailing, PlanView.rowInset)
                            .listRowInsets(EdgeInsets(top: 8, leading: PlanView.rowInset, bottom: 8, trailing: 0))
                            .id(day.day)
                    }
                } header: {
                    Text("Svi dani")
                }
            }
            .searchable(text: $query, prompt: "Traži dan ili knjigu (npr. Dan 40, Iv)")
            .navigationTitle("Biblija 365")
        }
    }
}

private struct PlanPickerRow: View {
    @Environment(AppModel.self) private var model
    let plan: ReadingPlan

    var body: some View {
        Menu {
            ForEach(model.plans) { p in
                Button {
                    model.setActivePlan(p.id)
                } label: {
                    if p.id == plan.id {
                        Label("\(p.title) (\(p.daysCount))", systemImage: "checkmark")
                    } else {
                        Text("\(p.title) (\(p.daysCount))")
                    }
                }
            }
        } label: {
            HStack {
                Text(plan.title)
                    .font(.headline)
                    .multilineTextAlignment(.leading)
                Spacer()
                Image(systemName: "chevron.up.chevron.down").foregroundStyle(.secondary)
            }
        }
        .accessibilityLabel("Plan čitanja: \(plan.title)")
    }
}

private struct TodayCard: View {
    @Environment(AppModel.self) private var model
    let plan: ReadingPlan
    let day: PlanDay

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Dan \(day.day) od \(plan.daysCount)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tint)
            Text(day.label).font(.title3.weight(.semibold))
            Text("Ukupno ~\(day.verseCount) redaka").font(.caption).foregroundStyle(.secondary)
            ReadingPills(plan: plan, day: day, bleedLeading: PlanView.rowInset, bleedTrailing: PlanView.rowInset)
            HStack {
                Button {
                    if let first = day.readings.first { model.open(day: day, planId: plan.id, reading: first) }
                } label: {
                    Label("Započni čitanje", systemImage: "book")
                }
                .buttonStyle(.borderedProminent)
                Button {
                    model.toggleDay(plan.id, day.day)
                } label: {
                    Label("Pročitano", systemImage: "checkmark")
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 4)
    }
}

private struct ReadingPills: View {
    @Environment(AppModel.self) private var model
    let plan: ReadingPlan
    let day: PlanDay
    let bleedLeading: CGFloat
    let bleedTrailing: CGFloat

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(day.readings.enumerated()), id: \.offset) { _, reading in
                    Button {
                        model.open(day: day, planId: plan.id, reading: reading)
                    } label: {
                        Text(reading.label)
                            .font(.caption.weight(.medium))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(Color.accentColor.opacity(0.14), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(reading.bookTitle)
                }
            }
        }
        .railBleed(leading: bleedLeading, trailing: bleedTrailing)
    }
}

private struct PlanDayRow: View {
    @Environment(AppModel.self) private var model
    let plan: ReadingPlan
    let day: PlanDay
    let isNext: Bool

    var body: some View {
        let done = model.isDayDone(plan.id, day.day)
        HStack(alignment: .top, spacing: 12) {
            Button {
                model.toggleDay(plan.id, day.day)
            } label: {
                Image(systemName: done ? "checkmark.circle.fill" : "circle")
                    .font(.title2)
                    .foregroundStyle(done ? Color.green : Color.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(done ? "Dan \(day.day) pročitan" : "Označi Dan \(day.day) pročitanim")

            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Dan \(day.day)").font(.subheadline.weight(.semibold))
                    if isNext {
                        Text("Danas").font(.caption2.weight(.bold)).padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Color.accentColor.opacity(0.2), in: Capsule())
                    }
                    Spacer()
                    Text("\(day.verseCount) redaka").font(.caption).foregroundStyle(.secondary)
                }
                // lijevo je kvačica, pa traka ide do ruba retka samo desno
                ReadingPills(plan: plan, day: day, bleedLeading: 0, bleedTrailing: PlanView.rowInset)
            }
        }
        .opacity(done && !isNext ? 0.7 : 1)
    }
}
