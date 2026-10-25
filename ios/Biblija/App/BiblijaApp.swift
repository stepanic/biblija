import SwiftUI

@main
struct BiblijaApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(model.theme.colorScheme)
        }
        .onChange(of: scenePhase) { _, phase in
            // kao visibilitychange na webu
            if phase == .active { Task { await model.syncNow() } }
        }
    }
}
