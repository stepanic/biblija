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
        .onChange(of: scenePhase, initial: true) { _, phase in
            // kao visibilitychange na webu; dok je aktivna, realtime veza na /api/live
            if phase == .active { Task { await model.syncNow() } }
            model.setActive(phase == .active)
        }
    }
}
