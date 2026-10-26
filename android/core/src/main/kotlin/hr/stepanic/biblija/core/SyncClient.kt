package hr.stepanic.biblija.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI

@Serializable
data class SyncCredentials(
    @SerialName("user_key") val userKey: String,
    val pin: String,
    @SerialName("display_name") val displayName: String,
)

sealed class SyncException(message: String) : Exception(message) {
    class NotConfigured : SyncException("Adresa poslužitelja za sinkronizaciju nije postavljena.")
    class Server(val status: Int, message: String) : SyncException(message)
    class Locked(val until: String) : SyncException("Previše pogrešnih PIN-ova. Pokušaj ponovno za 15 minuta.")
    class Network(detail: String) : SyncException("Nema veze s poslužiteljem: $detail")
    class Decoding : SyncException("Neočekivan odgovor poslužitelja.")

    /** 401: pogrešan PIN (ili PIN promijenjen s drugog uređaja) */
    val isAuthFailure: Boolean get() = this is Server && status == 401
}

data class AuthResult(val created: Boolean, val credentials: SyncCredentials)

/**
 * [liveRoom]: soba za realtime obavijesti (`/api/live`), null ako je poslužitelj nema.
 * [acknowledgedLog]: poslani zapisi dnevnika (id → updated_at); potvrđeni su ako se lokalno nisu mijenjali
 * u međuvremenu. Prazno ako poslužitelj ne podržava dnevnik (nema `log_cursor`), pa ostaju za idući put.
 */
data class SyncResult(
    val data: UserData,
    val syncedAt: String,
    val displayName: String,
    val liveRoom: String? = null,
    val acknowledgedLog: Map<String, String> = emptyMap(),
)

/** Najviše zapisa dnevnika po zahtjevu (isto ograničenje kao MAX_LOG_PER_REQUEST u workeru). */
const val MAX_LOG_PER_SYNC = 500

/** HTTP ugovor iz src/worker.ts: POST /api/auth, /api/sync, /api/account/delete. */
class SyncClient(baseUrl: String) {
    private val base = baseUrl.trim().trimEnd('/')
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }

    suspend fun authenticate(userKey: String, pin: String): AuthResult {
        val res: AuthResponse = post("api/auth", json.encodeToString(AuthRequest(userKey, pin)))
        return AuthResult(
            created = res.created ?: false,
            credentials = SyncCredentials(res.userKey ?: userKey, pin, res.displayName ?: userKey),
        )
    }

    /** [clientId] je id ovog uređaja; poslužitelj mu ne vraća realtime obavijest o vlastitoj promjeni. */
    suspend fun sync(credentials: SyncCredentials, data: UserData, clientId: String? = null): SyncResult {
        val sentLog = data.logDirty.mapNotNull { data.readingLog[it] }.sortedBy { it.startedAt }.take(MAX_LOG_PER_SYNC)
        val body = SyncRequest(
            credentials.userKey, credentials.pin, data.meta, data.progress, data.bookmarks,
            data.linear, sentLog, data.logCursor, clientId,
        )
        val res: SyncResponse = post("api/sync", json.encodeToString(body))
        val supportsLog = res.logCursor != null
        return SyncResult(
            data = UserData(
                res.meta, res.progress, res.bookmarks,
                linear = res.linear,
                readingLog = res.log.orEmpty().associateBy { it.id },
                logCursor = res.logCursor ?: "",
            ),
            syncedAt = res.syncedAt ?: Timestamp.now(),
            displayName = res.displayName ?: credentials.displayName,
            liveRoom = res.liveRoom,
            acknowledgedLog = if (supportsLog) sentLog.associate { it.id to it.updatedAt } else emptyMap(),
        )
    }

    suspend fun deleteAccount(credentials: SyncCredentials) {
        post<DeleteResponse>("api/account/delete", json.encodeToString(AuthRequest(credentials.userKey, credentials.pin)))
    }

    private suspend inline fun <reified R> post(path: String, body: String): R {
        val (status, text) = withContext(Dispatchers.IO) { send(path, body) }
        val envelope = runCatching { json.decodeFromString<ErrorEnvelope>(text) }.getOrNull()
        if (status == 429) throw SyncException.Locked(envelope?.lockedUntil ?: "")
        if (status !in 200..299 || envelope?.ok == false) {
            throw SyncException.Server(status, envelope?.error ?: "Pogreška poslužitelja ($status).")
        }
        return try {
            json.decodeFromString<R>(text)
        } catch (_: Exception) {
            throw SyncException.Decoding()
        }
    }

    private fun send(path: String, body: String): Pair<Int, String> {
        val conn = try {
            URI("$base/$path").toURL().openConnection() as HttpURLConnection
        } catch (e: Exception) {
            throw SyncException.Network(e.message ?: "neispravna adresa")
        }
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 15_000
            conn.readTimeout = 20_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            return status to text
        } catch (e: IOException) {
            throw SyncException.Network(e.message ?: e.javaClass.simpleName)
        } finally {
            conn.disconnect()
        }
    }
}

@Serializable
private data class AuthRequest(@SerialName("user_key") val userKey: String, val pin: String)

@Serializable
private data class SyncRequest(
    @SerialName("user_key") val userKey: String,
    val pin: String,
    val meta: SyncMeta,
    val progress: ProgressMap,
    val bookmarks: BookmarkMap,
    val linear: LinearCursor? = null,
    val log: List<ReadingLogEntry> = emptyList(),
    @SerialName("log_since") val logSince: String = "",
    @SerialName("client_id") val clientId: String? = null,
)

@Serializable
private data class ErrorEnvelope(
    val ok: Boolean? = null,
    val error: String? = null,
    @SerialName("locked_until") val lockedUntil: String? = null,
)

@Serializable
private data class AuthResponse(
    val created: Boolean? = null,
    @SerialName("user_key") val userKey: String? = null,
    @SerialName("display_name") val displayName: String? = null,
)

@Serializable
private data class SyncResponse(
    @SerialName("display_name") val displayName: String? = null,
    @SerialName("synced_at") val syncedAt: String? = null,
    @SerialName("live_room") val liveRoom: String? = null,
    val meta: SyncMeta = SyncMeta(),
    val progress: ProgressMap = emptyMap(),
    val bookmarks: BookmarkMap = emptyMap(),
    val linear: LinearCursor? = null,
    val log: List<ReadingLogEntry>? = null,
    @SerialName("log_cursor") val logCursor: String? = null,
)

@Serializable
private data class DeleteResponse(val deleted: Boolean? = null)
