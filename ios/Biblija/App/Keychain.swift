import BiblijaKit
import Foundation
import Security

/// Sync kod + PIN i spremljeni profili žive u Keychainu, ne u UserDefaults.
enum Keychain {
    private static let service = "hr.stepanic.biblija365.sync"
    private static let currentAccount = "current"
    private static let profilesAccount = "profiles"

    static func loadCredentials() -> SyncCredentials? {
        read(currentAccount).flatMap { try? JSONDecoder().decode(SyncCredentials.self, from: $0) }
    }

    static func saveCredentials(_ credentials: SyncCredentials?) {
        write(currentAccount, credentials.flatMap { try? JSONEncoder().encode($0) })
    }

    static func loadProfiles() -> [SavedProfile] {
        read(profilesAccount).flatMap { try? JSONDecoder().decode([SavedProfile].self, from: $0) } ?? []
    }

    static func saveProfiles(_ profiles: [SavedProfile]) {
        write(profilesAccount, profiles.isEmpty ? nil : try? JSONEncoder().encode(profiles))
    }

    private static func baseQuery(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private static func read(_ account: String) -> Data? {
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    private static func write(_ account: String, _ data: Data?) {
        let query = baseQuery(account)
        SecItemDelete(query as CFDictionary)
        guard let data else { return }
        var attrs = query
        attrs[kSecValueData as String] = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(attrs as CFDictionary, nil)
    }
}
