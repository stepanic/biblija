import Foundation

public struct SyncCredentials: Codable, Equatable, Sendable {
    public var userKey: String
    public var pin: String
    public var displayName: String

    public init(userKey: String, pin: String, displayName: String) {
        self.userKey = userKey
        self.pin = pin
        self.displayName = displayName
    }
}

public enum SyncError: Error, LocalizedError, Equatable {
    case notConfigured
    case server(status: Int, message: String)
    case locked(until: String)
    case network(String)
    case decoding

    public var errorDescription: String? {
        switch self {
        case .notConfigured: "Adresa poslužitelja za sinkronizaciju nije postavljena."
        case .server(_, let message): message
        case .locked: "Previše pogrešnih PIN-ova. Pokušaj ponovno za 15 minuta."
        case .network(let message): "Nema veze s poslužiteljem: \(message)"
        case .decoding: "Neočekivan odgovor poslužitelja."
        }
    }

    /// 401: pogrešan PIN (ili PIN promijenjen s drugog uređaja)
    public var isAuthFailure: Bool {
        if case .server(let status, _) = self { return status == 401 }
        return false
    }
}

public struct AuthResult: Sendable, Equatable {
    public let created: Bool
    public let credentials: SyncCredentials
}

public struct SyncResult: Sendable, Equatable {
    public let data: UserData
    public let syncedAt: String
    public let displayName: String
    /// Soba za realtime obavijesti (`/api/live`), nil ako je poslužitelj nema.
    public let liveRoom: String?
}

/// HTTP ugovor iz src/worker.ts: POST /api/auth, /api/sync, /api/account/delete.
public struct SyncClient: Sendable {
    public let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func authenticate(userKey: String, pin: String) async throws -> AuthResult {
        let res: AuthResponse = try await post("api/auth", AuthRequest(userKey: userKey, pin: pin))
        return AuthResult(
            created: res.created ?? false,
            credentials: SyncCredentials(userKey: res.userKey ?? userKey, pin: pin, displayName: res.displayName ?? userKey)
        )
    }

    /// `clientId` je id ovog uređaja; poslužitelj mu ne vraća realtime obavijest o vlastitoj promjeni.
    public func sync(_ credentials: SyncCredentials, data: UserData, clientId: String? = nil) async throws -> SyncResult {
        let body = SyncRequest(userKey: credentials.userKey, pin: credentials.pin, meta: data.meta, progress: data.progress, bookmarks: data.bookmarks, clientId: clientId)
        let res: SyncResponse = try await post("api/sync", body)
        return SyncResult(
            data: UserData(meta: res.meta, progress: res.progress, bookmarks: res.bookmarks),
            syncedAt: res.syncedAt ?? Timestamp.now(),
            displayName: res.displayName ?? credentials.displayName,
            liveRoom: res.liveRoom
        )
    }

    public func deleteAccount(_ credentials: SyncCredentials) async throws {
        let _: DeleteResponse = try await post("api/account/delete", AuthRequest(userKey: credentials.userKey, pin: credentials.pin))
    }

    // MARK: - Transport

    private func post<Body: Encodable, Response: Decodable>(_ path: String, _ body: Body) async throws -> Response {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 20
        req.httpBody = try JSONEncoder().encode(body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw SyncError.network(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
        if status == 429 {
            throw SyncError.locked(until: envelope?.lockedUntil ?? "")
        }
        guard (200..<300).contains(status), envelope?.ok != false else {
            throw SyncError.server(status: status, message: envelope?.error ?? "Pogreška poslužitelja (\(status)).")
        }
        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw SyncError.decoding
        }
    }
}

private struct AuthRequest: Encodable {
    let userKey: String
    let pin: String
    enum CodingKeys: String, CodingKey { case userKey = "user_key", pin }
}

private struct SyncRequest: Encodable {
    let userKey: String
    let pin: String
    let meta: SyncMeta
    let progress: ProgressMap
    let bookmarks: BookmarkMap
    let clientId: String?
    enum CodingKeys: String, CodingKey { case userKey = "user_key", pin, meta, progress, bookmarks, clientId = "client_id" }
}

private struct ErrorEnvelope: Decodable {
    let ok: Bool?
    let error: String?
    let lockedUntil: String?
    enum CodingKeys: String, CodingKey { case ok, error, lockedUntil = "locked_until" }
}

private struct AuthResponse: Decodable {
    let created: Bool?
    let userKey: String?
    let displayName: String?
    enum CodingKeys: String, CodingKey { case created, userKey = "user_key", displayName = "display_name" }
}

private struct SyncResponse: Decodable {
    let displayName: String?
    let syncedAt: String?
    let liveRoom: String?
    let meta: SyncMeta
    let progress: ProgressMap
    let bookmarks: BookmarkMap
    enum CodingKeys: String, CodingKey {
        case displayName = "display_name", syncedAt = "synced_at", liveRoom = "live_room", meta, progress, bookmarks
    }
}

private struct DeleteResponse: Decodable {
    let deleted: Bool?
}
