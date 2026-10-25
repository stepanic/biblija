package hr.stepanic.biblija.data

import android.content.Context
import android.content.pm.PackageManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import hr.stepanic.biblija.core.SyncCredentials
import hr.stepanic.biblija.core.UserData
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

/**
 * biblija-mobile.db je u assets; BundledSQLiteDriver treba pravu datoteku, pa se kopira u filesDir
 * kad se aplikacija instalira ili ažurira.
 */
object DatabaseInstaller {
    private const val ASSET = "biblija-mobile.db"

    fun install(context: Context): File {
        val target = File(context.filesDir, ASSET)
        val prefs = context.getSharedPreferences("db_install", Context.MODE_PRIVATE)
        val stamp = packageStamp(context)
        if (!target.exists() || prefs.getLong("stamp", -1) != stamp) {
            val tmp = File(context.filesDir, "$ASSET.tmp")
            context.assets.open(ASSET).use { input -> tmp.outputStream().use { input.copyTo(it) } }
            if (!tmp.renameTo(target)) {
                tmp.copyTo(target, overwrite = true)
                tmp.delete()
            }
            prefs.edit { putLong("stamp", stamp) }
        }
        return target
    }

    private fun packageStamp(context: Context): Long = try {
        context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime
    } catch (_: PackageManager.NameNotFoundException) {
        0
    }
}

/** Korisničko stanje kao JSON datoteka (ista struktura kao /api/sync), odvojeno od read-only teksta. */
class UserDataFile(context: Context) {
    private val file = File(context.filesDir, "user-data.json")

    fun load(): UserData = runCatching { json.decodeFromString(UserData.serializer(), file.readText()) }.getOrDefault(UserData())

    fun save(data: UserData) {
        val tmp = File(file.parentFile, "user-data.json.tmp")
        tmp.writeText(json.encodeToString(UserData.serializer(), data))
        if (!tmp.renameTo(file)) {
            tmp.copyTo(file, overwrite = true)
            tmp.delete()
        }
    }

    fun reset() {
        file.delete()
    }
}

@Serializable
data class SavedProfile(val credentials: SyncCredentials, val savedAt: String)

/**
 * Sync kod + PIN i spremljeni profili, šifrirani AES-GCM ključem iz Android Keystorea
 * (ekvivalent iOS Keychaina). Datoteka je isključena iz backupa.
 */
class SecureStore(context: Context) {
    private val prefs = context.getSharedPreferences("sync_secure", Context.MODE_PRIVATE)

    fun loadCredentials(): SyncCredentials? =
        read("current")?.let { runCatching { json.decodeFromString(SyncCredentials.serializer(), it) }.getOrNull() }

    fun saveCredentials(credentials: SyncCredentials?) =
        write("current", credentials?.let { json.encodeToString(SyncCredentials.serializer(), it) })

    fun loadProfiles(): List<SavedProfile> =
        read("profiles")?.let { runCatching { json.decodeFromString<List<SavedProfile>>(it) }.getOrNull() } ?: emptyList()

    fun saveProfiles(profiles: List<SavedProfile>) =
        write("profiles", profiles.takeIf { it.isNotEmpty() }?.let { json.encodeToString(it) })

    private fun read(name: String): String? {
        val stored = prefs.getString(name, null) ?: return null
        return runCatching {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_SIZE))
            String(cipher.doFinal(bytes, IV_SIZE, bytes.size - IV_SIZE), Charsets.UTF_8)
        }.getOrNull()
    }

    private fun write(name: String, value: String?) {
        if (value == null) {
            prefs.edit { remove(name) }
            return
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val payload = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        prefs.edit { putString(name, Base64.encodeToString(payload, Base64.NO_WRAP)) }
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val KEY_ALIAS = "biblija365_sync"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_SIZE = 12
    }
}
