import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        @Bindable var model = model
        Group {
            if let error = model.loadError {
                ContentUnavailableView("Tekst Biblije nije dostupan", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                TabView(selection: $model.selectedTab) {
                    ReaderView()
                        .tabItem { Label("Čitaj", systemImage: "book") }
                        .tag(AppTab.reader)
                    PlanView()
                        .tabItem { Label("Biblija 365", systemImage: "calendar") }
                        .tag(AppTab.plan)
                    SearchView()
                        .tabItem { Label("Pretraga", systemImage: "magnifyingglass") }
                        .tag(AppTab.search)
                    BookmarksView()
                        .tabItem { Label("Oznake", systemImage: "bookmark") }
                        .tag(AppTab.bookmarks)
                    SettingsView()
                        .tabItem { Label("Postavke", systemImage: "gearshape") }
                        .tag(AppTab.settings)
                }
            }
        }
        .overlay(alignment: .bottom) {
            if let offer = model.planCatchUp {
                PlanCatchUpBanner(offer: offer, palette: Palette.resolve(model.theme, scheme: scheme))
                    .padding(.horizontal, 12)
                    .padding(.bottom, 58)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.planCatchUp)
        .tint(Palette.resolve(model.theme, scheme: scheme).accent)
    }
}

/// Ponuda da se dani kanonskog plana prije linearnog kursora označe pročitanima, kao toast na webu.
struct PlanCatchUpBanner: View {
    @Environment(AppModel.self) private var model
    let offer: PlanCatchUpOffer
    let palette: Palette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("BIBLIJA 365 — KANONSKI REDOM", systemImage: "calendar.badge.checkmark")
                .font(.caption2.weight(.bold))
                .foregroundStyle(palette.accent)
            Text(offer.question)
                .font(.subheadline)
            HStack(spacing: 8) {
                Button {
                    model.acceptPlanCatchUp()
                } label: {
                    Label("Označi", systemImage: "checkmark")
                }
                .buttonStyle(.borderedProminent)
                .tint(palette.accent)
                Button {
                    model.planCatchUp = nil
                } label: {
                    Label("Ne", systemImage: "xmark")
                }
                .buttonStyle(.bordered)
            }
            .font(.subheadline)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .foregroundStyle(palette.text)
        .background(palette.background)
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.accent.opacity(0.4)))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
    }
}
