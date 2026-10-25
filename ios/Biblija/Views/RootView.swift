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
        .tint(Palette.resolve(model.theme, scheme: scheme).accent)
    }
}
