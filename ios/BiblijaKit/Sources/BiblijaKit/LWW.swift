import Foundation

/// Last-Write-Wins spajanje, isto pravilo kao /api/sync u src/worker.ts:
/// klijentski zapis pobjeđuje samo ako je strogo noviji. Vidi shared/test-vectors/lww_merge.json.
///
/// Klijent ga koristi nad odgovorom poslužitelja (`server`) i lokalnim stanjem (`client`),
/// tako da izmjene napravljene dok je zahtjev bio u letu ne nestanu.
public enum LWW {
    public static func merge(server: UserData, client: UserData) -> UserData {
        UserData(
            meta: mergeMeta(server: server.meta, client: client.meta),
            progress: mergeProgress(server: server.progress, client: client.progress),
            bookmarks: mergeBookmarks(server: server.bookmarks, client: client.bookmarks)
        )
    }

    public static func mergeMeta(server: SyncMeta, client: SyncMeta) -> SyncMeta {
        guard client.lastUpdatedAt > server.lastUpdatedAt else { return server }
        return SyncMeta(
            activePlanId: client.activePlanId.isEmpty ? server.activePlanId : client.activePlanId,
            lastUrl: client.lastUrl.isEmpty ? server.lastUrl : client.lastUrl,
            lastLabel: client.lastLabel.isEmpty ? server.lastLabel : client.lastLabel,
            lastUpdatedAt: client.lastUpdatedAt
        )
    }

    public static func mergeProgress(server: ProgressMap, client: ProgressMap) -> ProgressMap {
        var merged = server
        for (planId, days) in client {
            var planMap = merged[planId] ?? [:]
            for (day, entry) in days {
                if let existing = planMap[day], entry.updatedAt <= existing.updatedAt { continue }
                planMap[day] = entry
            }
            merged[planId] = planMap
        }
        return merged
    }

    public static func mergeBookmarks(server: BookmarkMap, client: BookmarkMap) -> BookmarkMap {
        var merged = server
        for (key, entry) in client {
            if let existing = merged[key], entry.updatedAt <= existing.updatedAt { continue }
            merged[key] = entry
        }
        return merged
    }
}
