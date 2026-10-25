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

data class SyncResult(val data: UserData, val syncedAt: String, val displayName: String)

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

    suspend fun sync(credentials: SyncCredentials, data: UserData): SyncResult {
        val body = SyncRequest(credentials.userKey, credentials.pin, data.meta, data.progress, data.bookmarks)
        val res: SyncResponse = post("api/sync", json.encodeToString(body))
        return SyncResult(
            data = UserData(res.meta, res.progress, res.bookmarks),
            syncedAt = res.syncedAt ?: Timestamp.now(),
            displayName = res.displayName ?: credentials.displayName,
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
    val meta: SyncMeta = SyncMeta(),
    val progress: ProgressMap = emptyMap(),
    val bookmarks: BookmarkMap = emptyMap(),
)

@Serializable
private data class DeleteResponse(val deleted: Boolean? = null)
