package hr.stepanic.biblija

import android.app.Application
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.edit
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import hr.stepanic.biblija.core.BibleRepository
import hr.stepanic.biblija.core.Book
import hr.stepanic.biblija.core.Bookmark
import hr.stepanic.biblija.core.BookmarkColor
import hr.stepanic.biblija.core.ChapterInfo
import hr.stepanic.biblija.core.ChapterRef
import hr.stepanic.biblija.core.Lww
import hr.stepanic.biblija.core.PlanDay
import hr.stepanic.biblija.core.PlanReading
import hr.stepanic.biblija.core.ReadingPlan
import hr.stepanic.biblija.core.SearchResult
import hr.stepanic.biblija.core.SyncClient
import hr.stepanic.biblija.core.SyncCredentials
import hr.stepanic.biblija.core.SyncException
import hr.stepanic.biblija.core.Timestamp
import hr.stepanic.biblija.core.UserData
import hr.stepanic.biblija.core.Verse
import hr.stepanic.biblija.core.WebPath
import hr.stepanic.biblija.data.DatabaseInstaller
import hr.stepanic.biblija.data.LiveConnection
import hr.stepanic.biblija.data.SavedProfile
import hr.stepanic.biblija.data.SecureStore
import hr.stepanic.biblija.data.UserDataFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

enum class AppTab { READER, PLAN, SEARCH, BOOKMARKS, SETTINGS }

enum class ReaderTheme(val label: String) { SYSTEM("Sustav"), LIGHT("Svijetla"), SEPIA("Sepia"), DARK("Tamna") }

enum class ReadingMode(val label: String) {
    /** Knjiški odlomci (koristi `paragraph_start` iz kataloga) */
    PARAGRAPHS("Odlomci"),

    /** Studijski prikaz, redak po redak */
    VERSES("Redak po redak"),
}

/** Plan i dan iz kojeg je čitač otvoren (traka „Dan N" u čitaču, kao `biblija_active_day_ctx` na webu). */
data class PlanDayContext(val planId: String, val day: PlanDay)

data class ReaderTarget(val chapter: ChapterRef, val verse: Int? = null)

class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences("biblija_settings", Context.MODE_PRIVATE)
    private val userFile = UserDataFile(app)
    private val secure = SecureStore(app)

    // ---------- Tekst ----------
    var repository: BibleRepository? by mutableStateOf(null)
        private set
    var loadError: String? by mutableStateOf(null)
        private set
    var books: List<Book> by mutableStateOf(emptyList())
        private set
    var plans: List<ReadingPlan> by mutableStateOf(emptyList())
        private set
    private var booksByOrder: Map<Int, Book> = emptyMap()
    private var booksBySlug: Map<String, Book> = emptyMap()
    private val chapterCache = mutableMapOf<Int, List<ChapterInfo>>()
    private val planDaysCache = mutableMapOf<String, List<PlanDay>>()

    // ---------- Navigacija ----------
    var selectedTab by mutableStateOf(AppTab.READER)
    var readerTarget by mutableStateOf(ReaderTarget(ChapterRef(1, 1)))
        private set
    var activeDay: PlanDayContext? by mutableStateOf(null)

    // ---------- Postavke čitanja ----------
    var fontSize by mutableStateOf(prefs.getFloat("fontsize", 19f))
        private set
    var theme by mutableStateOf(enumOr(prefs.getString("theme", null), ReaderTheme.SYSTEM))
        private set
    var readingMode by mutableStateOf(enumOr(prefs.getString("reading_mode", null), ReadingMode.PARAGRAPHS))
        private set

    // ---------- Korisničko stanje ----------
    var userData by mutableStateOf(userFile.load())
        private set

    // ---------- Sync ----------
    var credentials: SyncCredentials? by mutableStateOf(secure.loadCredentials())
        private set
    var savedProfiles: List<SavedProfile> by mutableStateOf(secure.loadProfiles())
        private set
    var isSyncing by mutableStateOf(false)
        private set
    var lastSyncedAt: String? by mutableStateOf(prefs.getString("last_synced_at", null))
        private set
    var syncError: String? by mutableStateOf(null)
    var serverUrl by mutableStateOf(prefs.getString("server_url", null) ?: BuildConfig.SYNC_BASE_URL)
        private set
    private var syncJob: Job? = null
    private var needsAnotherSync = false

    // Realtime: id ovog procesa (poslužitelj mu ne javlja vlastite promjene) i soba s /api/sync
    private val clientId = UUID.randomUUID().toString()
    private var liveRoom: String? = prefs.getString("live_room", null)
    private var inForeground = false
    private val live = LiveConnection { syncNow() }

    init {
        viewModelScope.launch {
            try {
                val (repo, loadedBooks, loadedPlans) = withContext(Dispatchers.IO) {
                    val file = DatabaseInstaller.install(getApplication())
                    val repo = BibleRepository(BundledSQLiteDriver().open(file.absolutePath))
                    Triple(repo, repo.books(), repo.plans())
                }
                repository = repo
                books = loadedBooks
                plans = loadedPlans
                booksByOrder = loadedBooks.associateBy { it.order }
                booksBySlug = loadedBooks.associateBy { it.slug }
                chapterRef(userData.meta.lastUrl)?.let { readerTarget = ReaderTarget(it) }
            } catch (e: Exception) {
                loadError = e.message ?: e.javaClass.simpleName
            }
        }
        syncNow()
    }

    override fun onCleared() {
        live.disconnect()
        repository?.close()
    }

    // ---------- Tekst ----------

    fun book(order: Int): Book? = booksByOrder[order]

    fun chapters(book: Book): List<ChapterInfo> =
        chapterCache.getOrPut(book.order) { repository?.chapters(book.order) ?: emptyList() }

    fun verses(ref: ChapterRef): List<Verse> = repository?.verses(ref.bookOrder, ref.chapter) ?: emptyList()

    fun planDays(planId: String): List<PlanDay> =
        planDaysCache.getOrPut(planId) { repository?.planDays(planId) ?: emptyList() }

    suspend fun search(query: String, testament: String?, bookOrder: Int?): SearchResult =
        withContext(Dispatchers.IO) { repository?.search(query, testament, bookOrder, 100) ?: SearchResult.EMPTY }

    /** Prethodno/sljedeće poglavlje preko granica knjiga. */
    fun neighbour(ref: ChapterRef, offset: Int): ChapterRef? {
        val book = book(ref.bookOrder) ?: return null
        val list = chapters(book)
        val idx = list.indexOfFirst { it.chapter == ref.chapter }.takeIf { it >= 0 } ?: return null
        list.getOrNull(idx + offset)?.let { return ChapterRef(book.order, it.chapter) }
        val other = book(book.order + offset) ?: return null
        val otherList = chapters(other)
        val ch = (if (offset > 0) otherList.firstOrNull() else otherList.lastOrNull()) ?: return null
        return ChapterRef(other.order, ch.chapter)
    }

    fun chapterRef(webPath: String): ChapterRef? {
        val (slug, ch) = WebPath.parseChapter(webPath) ?: return null
        val book = booksBySlug[slug] ?: return null
        return ChapterRef(book.order, ch)
    }

    fun label(ref: ChapterRef): String {
        val book = book(ref.bookOrder) ?: return ""
        return "${book.abbr} ${if (ref.chapter == 0) "Proslov" else ref.chapter}"
    }

    // ---------- Navigacija ----------

    fun open(ref: ChapterRef, verse: Int? = null, keepDay: Boolean = false) {
        if (!keepDay) activeDay = null
        readerTarget = ReaderTarget(ref, verse)
        selectedTab = AppTab.READER
    }

    fun openDay(day: PlanDay, planId: String, reading: PlanReading) {
        activeDay = PlanDayContext(planId, day)
        open(ChapterRef(reading.bookOrder, reading.chapterStart), keepDay = true)
    }

    /** Čitač javlja da je poglavlje prikazano: pamti se za „nastavi čitanje" na svim uređajima. */
    fun didShow(ref: ChapterRef) {
        val book = book(ref.bookOrder) ?: return
        mutate { it.withLastRead(WebPath.chapter(book.slug, ref.chapter), WebPath.label(book, ref.chapter)) }
    }

    // ---------- Postavke ----------

    fun updateFontSize(value: Float) {
        fontSize = value.coerceIn(14f, 32f)
        prefs.edit { putFloat("fontsize", fontSize) }
    }

    fun updateTheme(value: ReaderTheme) {
        theme = value
        prefs.edit { putString("theme", value.name) }
    }

    fun updateReadingMode(value: ReadingMode) {
        readingMode = value
        prefs.edit { putString("reading_mode", value.name) }
    }

    fun updateServerUrl(value: String) {
        serverUrl = value
        prefs.edit { putString("server_url", value) }
        rememberLiveRoom(null)
    }

    // ---------- Korisničko stanje ----------

    val activePlanId: String get() = userData.meta.activePlanId

    fun setActivePlan(id: String) {
        if (id != activePlanId) mutate { it.withActivePlan(id) }
    }

    fun isDayDone(planId: String, day: Int) = userData.isDayDone(planId, day)

    fun toggleDay(planId: String, day: Int) = mutate { it.toggledDay(planId, day) }

    fun bookmark(ref: ChapterRef, verse: Int): Bookmark? =
        userData.activeBookmark(Bookmark.key(ref.bookOrder, ref.chapter, verse))

    fun saveBookmark(ref: ChapterRef, verse: Verse, color: BookmarkColor, note: String) {
        val book = book(ref.bookOrder) ?: return
        val bm = Bookmark(
            bookOrder = book.order, bookId = book.slug, bookAbbr = book.abbr, bookTitle = book.title,
            chapter = ref.chapter, verse = verse.verse, color = color.raw, note = note.trim(), text = verse.text,
        )
        mutate { it.withBookmark(bm) }
    }

    fun removeBookmark(key: String) = mutate { it.withoutBookmark(key) }

    private fun mutate(change: (UserData) -> UserData) {
        val next = change(userData)
        if (next == userData) return
        userData = next
        persist()
        scheduleSync()
    }

    private fun persist() {
        val snapshot = userData
        viewModelScope.launch(Dispatchers.IO) { userFile.save(snapshot) }
    }

    // ---------- Sync ----------

    private val client: SyncClient?
        get() = serverUrl.trim().takeIf { it.startsWith("http://") || it.startsWith("https://") }?.let { SyncClient(it) }

    val isServerConfigured: Boolean get() = client != null

    /** Prijava ili stvaranje računa. Lokalni podaci (čitanje prije prijave) spajaju se s računom, kao na webu. */
    suspend fun signIn(userKey: String, pin: String) {
        val key = userKey.trim()
        val p = pin.trim()
        if (key.length < 3) throw SyncException.Server(400, "Korisničko ime / Sync kod mora imati barem 3 znaka.")
        if (p.length < 4) throw SyncException.Server(400, "PIN mora imati barem 4 znaka.")
        val c = client ?: throw SyncException.NotConfigured()
        val result = c.authenticate(key, p)
        rememberCredentials(result.credentials)
        runSync()
    }

    /** Promjena na spremljeni profil: lokalno stanje se briše da se podaci ne miješaju među korisnicima. */
    fun switchTo(profile: SavedProfile) {
        if (profile.credentials.userKey != credentials?.userKey) {
            resetLocalUserData()
            rememberCredentials(profile.credentials)
        }
        syncNow()
    }

    fun removeProfile(profile: SavedProfile) {
        savedProfiles = savedProfiles.filterNot { it.credentials.userKey == profile.credentials.userKey }
        secure.saveProfiles(savedProfiles)
    }

    fun signOut() {
        syncJob?.cancel()
        credentials = null
        secure.saveCredentials(null)
        resetLocalUserData()
    }

    /** Trajno brisanje računa na poslužitelju (Google Play i App Store traže brisanje iz aplikacije). */
    suspend fun deleteAccount() {
        val creds = credentials ?: return
        val c = client ?: throw SyncException.NotConfigured()
        c.deleteAccount(creds)
        savedProfiles.firstOrNull { it.credentials.userKey == creds.userKey }?.let { removeProfile(it) }
        signOut()
    }

    private fun rememberCredentials(creds: SyncCredentials) {
        credentials = creds
        secure.saveCredentials(creds)
        savedProfiles = (listOf(SavedProfile(creds, Timestamp.now())) + savedProfiles.filterNot { it.credentials.userKey == creds.userKey }).take(8)
        secure.saveProfiles(savedProfiles)
    }

    private fun resetLocalUserData() {
        userData = UserData()
        userFile.reset()
        lastSyncedAt = null
        prefs.edit { remove("last_synced_at") }
        activeDay = null
        rememberLiveRoom(null)
    }

    /** Iz MainActivity: realtime veza postoji samo dok je aplikacija u prvom planu (kao `visibilitychange` na webu). */
    fun setForeground(foreground: Boolean) {
        inForeground = foreground
        updateLive()
    }

    private fun rememberLiveRoom(room: String?) {
        if (room != liveRoom) {
            liveRoom = room
            prefs.edit { if (room == null) remove("live_room") else putString("live_room", room) }
        }
        updateLive()
    }

    private fun updateLive() {
        val room = liveRoom
        if (inForeground && credentials != null && room != null) live.connect(serverUrl, room, clientId) else live.disconnect()
    }

    fun scheduleSync(delayMs: Long = 800) {
        if (credentials == null) return
        syncJob?.cancel()
        syncJob = viewModelScope.launch {
            delay(delayMs)
            runSync()
        }
    }

    fun syncNow() {
        if (credentials == null) return
        viewModelScope.launch { runSync() }
    }

    private suspend fun runSync() {
        val creds = credentials ?: return
        val c = client ?: return
        if (isSyncing) {
            needsAnotherSync = true
            return
        }
        isSyncing = true
        try {
            val result = c.sync(creds, userData, clientId)
            if (credentials?.userKey != creds.userKey) return
            // Izmjene napravljene dok je zahtjev bio u letu su novije i ostaju.
            val merged = Lww.merge(result.data, userData)
            val hasNewerLocal = merged != result.data
            if (merged != userData) {
                val lastUrlChanged = merged.meta.lastUrl != userData.meta.lastUrl
                userData = merged
                persist()
                if (lastUrlChanged && selectedTab != AppTab.READER) {
                    chapterRef(merged.meta.lastUrl)?.let { if (it != readerTarget.chapter) readerTarget = ReaderTarget(it) }
                }
            }
            lastSyncedAt = result.syncedAt
            prefs.edit { putString("last_synced_at", result.syncedAt) }
            rememberLiveRoom(result.liveRoom)
            syncError = null
            if (hasNewerLocal) needsAnotherSync = true
        } catch (e: SyncException) {
            syncError = e.message
        } catch (e: Exception) {
            syncError = e.message ?: e.javaClass.simpleName
        } finally {
            isSyncing = false
        }
        if (needsAnotherSync) {
            needsAnotherSync = false
            scheduleSync(300)
        }
    }

    val dataVersion: String get() = repository?.meta("data_hash")?.take(12) ?: "—"
}

private inline fun <reified E : Enum<E>> enumOr(name: String?, fallback: E): E =
    name?.let { n -> enumValues<E>().firstOrNull { it.name == n } } ?: fallback
