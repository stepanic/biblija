package hr.stepanic.biblija.core

/**
 * Last-Write-Wins spajanje, isto pravilo kao /api/sync u src/worker.ts:
 * klijentski zapis pobjeđuje samo ako je strogo noviji. Vidi shared/test-vectors/lww_merge.json.
 *
 * Klijent ga koristi nad odgovorom poslužitelja (`server`) i lokalnim stanjem (`client`),
 * tako da izmjene napravljene dok je zahtjev bio u letu ne nestanu.
 */
object Lww {
    fun merge(server: UserData, client: UserData) = UserData(
        meta = mergeMeta(server.meta, client.meta),
        progress = mergeProgress(server.progress, client.progress),
        bookmarks = mergeBookmarks(server.bookmarks, client.bookmarks),
        linear = mergeLinear(server.linear, client.linear),
        readingLog = mergeLog(server.readingLog, client.readingLog),
        logDirty = client.logDirty,
        logCursor = server.logCursor.ifEmpty { client.logCursor },
    )

    fun mergeLinear(server: LinearCursor?, client: LinearCursor?): LinearCursor? = when {
        client == null -> server
        server == null -> client
        client.updatedAt > server.updatedAt -> client
        else -> server
    }

    /** Server vraća samo zapise od `log_cursor`, pa se spaja u lokalni dnevnik, ne obrnuto. */
    fun mergeLog(server: Map<String, ReadingLogEntry>, client: Map<String, ReadingLogEntry>): Map<String, ReadingLogEntry> {
        val merged = client.toMutableMap()
        for ((id, entry) in server) {
            val local = merged[id]
            if (local != null && local.updatedAt > entry.updatedAt) continue
            merged[id] = entry
        }
        return merged
    }

    fun mergeMeta(server: SyncMeta, client: SyncMeta): SyncMeta {
        if (client.lastUpdatedAt <= server.lastUpdatedAt) return server
        return SyncMeta(
            activePlanId = client.activePlanId.ifEmpty { server.activePlanId },
            lastUrl = client.lastUrl.ifEmpty { server.lastUrl },
            lastLabel = client.lastLabel.ifEmpty { server.lastLabel },
            lastUpdatedAt = client.lastUpdatedAt,
        )
    }

    fun mergeProgress(server: ProgressMap, client: ProgressMap): ProgressMap {
        val merged = server.mapValues { it.value.toMutableMap() }.toMutableMap()
        for ((planId, days) in client) {
            val plan = merged.getOrPut(planId) { mutableMapOf() }
            for ((day, entry) in days) {
                val existing = plan[day]
                if (existing != null && entry.updatedAt <= existing.updatedAt) continue
                plan[day] = entry
            }
        }
        return merged
    }

    fun mergeBookmarks(server: BookmarkMap, client: BookmarkMap): BookmarkMap {
        val merged = server.toMutableMap()
        for ((key, entry) in client) {
            val existing = merged[key]
            if (existing != null && entry.updatedAt <= existing.updatedAt) continue
            merged[key] = entry
        }
        return merged
    }
}
