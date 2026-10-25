import BiblijaKit
import SwiftUI
import UIKit

/// Postavke čitanja, Sync kod + PIN, spremljeni profili, brisanje računa.
struct SettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section("Čitanje") {
                    Stepper("Veličina slova: \(Int(model.fontSize))", value: $model.fontSize, in: 14...32, step: 1)
                    Picker("Prikaz", selection: $model.readingMode) {
                        ForEach(ReadingMode.allCases) { Text($0.label).tag($0) }
                    }
                    Picker("Tema", selection: $model.theme) {
                        ForEach(ReaderTheme.allCases) { Text($0.label).tag($0) }
                    }
                }

                SyncSection()

                Section {
                    TextField("https://…", text: $model.serverURLString)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Poslužitelj")
                } footer: {
                    Text("Adresa Cloudflare Workera s /api/sync. Ista je kao adresa web aplikacije.")
                }

                Section("O aplikaciji") {
                    LabeledContent("Verzija", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—")
                    LabeledContent("Verzija teksta", value: model.dataVersion)
                    LabeledContent("Tekst", value: "Zagrebačka Biblija (KS)")
                }
            }
            .navigationTitle("Postavke")
        }
    }
}

private struct SyncSection: View {
    @Environment(AppModel.self) private var model
    @State private var userKey = ""
    @State private var pin = ""
    @State private var busy = false
    @State private var message: String?
    @State private var confirmDelete = false
    @State private var copied = false

    var body: some View {
        if let creds = model.credentials {
            Section {
                LabeledContent("Prijavljen", value: "@\(creds.userKey)")
                LabeledContent("Zadnja sinkronizacija", value: formatted(model.lastSyncedAt))
                LabeledContent("Pročitanih dana", value: "\(model.completedDaysCount)")
                LabeledContent("Oznaka i bilješki", value: "\(model.userData.activeBookmarks.count)")
                if let error = model.syncError {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
                Button {
                    Task { await model.syncNow() }
                } label: {
                    HStack {
                        Label("Sinkroniziraj sada", systemImage: "arrow.triangle.2.circlepath")
                        if model.isSyncing { Spacer(); ProgressView() }
                    }
                }
                .disabled(model.isSyncing)
                Button {
                    UIPasteboard.general.string = "Biblija 365 Sync podaci:\nSync kod (korisničko ime): \(creds.userKey)\nPIN: \(creds.pin)"
                    copied = true
                } label: {
                    Label(copied ? "Kopirano" : "Kopiraj podatke za drugi uređaj", systemImage: "doc.on.doc")
                }
                Button("Odjava s ovog uređaja", role: .destructive) { model.signOut() }
            } header: {
                Text("Sinkronizacija")
            } footer: {
                Text("Odjava briše napredak i oznake s ovog uređaja; na poslužitelju ostaju.")
            }
            profilesSection
            Section {
                Button("Trajno izbriši račun", role: .destructive) { confirmDelete = true }
                    .confirmationDialog("Izbrisati račun @\(creds.userKey)?", isPresented: $confirmDelete, titleVisibility: .visible) {
                        Button("Izbriši račun i sve podatke", role: .destructive) { delete() }
                    } message: {
                        Text("Napredak u planovima i sve oznake brišu se s poslužitelja za sve uređaje. Ovo se ne može poništiti.")
                    }
                if let message { Text(message).font(.footnote).foregroundStyle(.red) }
            }
        } else {
            Section {
                TextField("Sync kod (korisničko ime)", text: $userKey)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("PIN (barem 4 znamenke)", text: $pin)
                    .textContentType(.password)
                    .keyboardType(.numberPad)
                Button {
                    signIn()
                } label: {
                    HStack {
                        Label("Poveži uređaj i sinkroniziraj", systemImage: "icloud")
                        if busy { Spacer(); ProgressView() }
                    }
                }
                .disabled(busy || !model.isServerConfigured)
                if let message { Text(message).font(.footnote).foregroundStyle(.red) }
            } header: {
                Text("Sinkronizacija")
            } footer: {
                Text(model.isServerConfigured
                     ? "Novi Sync kod stvara se automatski. Isti kod i PIN upiši na webu ili drugom uređaju."
                     : "Prvo upiši adresu poslužitelja ispod.")
            }
            profilesSection
        }
    }

    @ViewBuilder
    private var profilesSection: some View {
        if !model.savedProfiles.isEmpty {
            Section("Spremljeni profili na ovom uređaju") {
                ForEach(model.savedProfiles) { profile in
                    Button {
                        Task { await model.switchTo(profile) }
                    } label: {
                        HStack {
                            Text("@\(profile.credentials.userKey)")
                            Spacer()
                            if profile.id == model.credentials?.userKey {
                                Image(systemName: "checkmark").foregroundStyle(.tint)
                            }
                        }
                    }
                    .swipeActions {
                        Button("Ukloni", role: .destructive) { model.removeProfile(profile) }
                    }
                }
            }
        }
    }

    private func signIn() {
        busy = true
        message = nil
        Task {
            defer { busy = false }
            do {
                try await model.signIn(userKey: userKey, pin: pin)
                pin = ""
            } catch {
                message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func delete() {
        Task {
            do {
                try await model.deleteAccount()
                message = nil
            } catch {
                message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func formatted(_ iso: String?) -> String {
        guard let iso else { return "—" }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso) else { return iso }
        return date.formatted(.dateTime.locale(Locale(identifier: "hr_HR")))
    }
}
