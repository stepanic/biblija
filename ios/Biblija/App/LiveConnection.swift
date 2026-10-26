import Foundation

/// Realtime obavijesti s `/api/live` (Durable Object `SyncRoom` u src/worker.ts), kao `connectLive()` na webu.
/// Veza ne nosi podatke: na `{"type":"changed"}` pozove `onChanged`, a model napravi običan sync.
/// Drži se samo dok je aplikacija aktivna; prekid se ponavlja uz backoff do 30 s.
@MainActor
final class LiveConnection {
    private let onChanged: () -> Void
    private var socket: URLSessionWebSocketTask?
    private var url: URL?
    private var loop: Task<Void, Never>?
    private var retry = 0

    init(onChanged: @escaping () -> Void) {
        self.onChanged = onChanged
    }

    /// Spoji na sobu (ili ostani spojen ako je ista).
    func connect(serverURL: String, room: String, clientId: String) {
        var base = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while base.hasSuffix("/") { base.removeLast() }
        guard var components = URLComponents(string: base + "/api/live") else { return }
        switch components.scheme {
        case "https": components.scheme = "wss"
        case "http": components.scheme = "ws"
        default: return
        }
        components.queryItems = [URLQueryItem(name: "room", value: room), URLQueryItem(name: "client", value: clientId)]
        guard let next = components.url else { return }
        if next == url, loop != nil { return }
        disconnect()
        url = next
        retry = 0
        loop = Task { [weak self] in await self?.run(next) }
    }

    func disconnect() {
        url = nil
        loop?.cancel()
        loop = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
    }

    private func run(_ target: URL) async {
        while !Task.isCancelled, url == target {
            let ws = URLSession.shared.webSocketTask(with: target)
            socket = ws
            ws.resume()
            // protokolni ping: odgovara runtime, objekt se ne budi
            let pinger = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(30))
                    ws.sendPing { _ in }
                }
            }
            do {
                try await ping(ws)
                // nakon prekida je možda propuštena obavijest
                if retry > 0 { onChanged() }
                retry = 0
                while true {
                    if case .string(let text) = try await ws.receive(), text.contains("\"changed\"") {
                        onChanged()
                    }
                }
            } catch {}
            pinger.cancel()
            ws.cancel(with: .goingAway, reason: nil)
            if socket === ws { socket = nil }
            guard !Task.isCancelled, url == target else { return }
            let delay = min(30, 1 << min(retry, 5))
            retry += 1
            try? await Task.sleep(for: .seconds(delay))
        }
    }

    private func ping(_ ws: URLSessionWebSocketTask) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            ws.sendPing { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }
}
