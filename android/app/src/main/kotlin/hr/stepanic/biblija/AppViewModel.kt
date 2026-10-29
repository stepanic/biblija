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
import hr.stepanic.biblija.core.AltTranslation
import hr.stepanic.biblija.core.AltVerse
import hr.stepanic.biblija.core.BibleRepository
import hr.stepanic.biblija.core.Book
import hr.stepanic.biblija.core.Bookmark
import hr.stepanic.biblija.core.BookmarkColor
import hr.stepanic.biblija.core.ChapterInfo
import hr.stepanic.biblija.core.ChapterRef
import hr.stepanic.biblija.core.LinearCursor
import hr.stepanic.biblija.core.Lww
import hr.stepanic.biblija.core.PlanCatchUp
import hr.stepanic.biblija.core.PlanDay
import hr.stepanic.biblija.core.PlanReading
import hr.stepanic.biblija.core.ReadingLogEntry
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

/** Kako se prikazuje drugi prijevod: ispod svakog retka KS-a ili umjesto KS-a (kao na webu). */
enum class TranslationLayout(val label: String) {
    PARALLEL("Usporedno uz KS"),
    ONLY("Samostalno"),
}

/** Drugi prijevod za poglavlje u čitaču: napomena iznad teksta i retci (prazno = prikazuje se samo KS). */
data class AltChapter(val notice: String? = null, val verses: List<AltVerse> = emptyList())

/** Plan i dan iz kojeg je čitač otvoren (traka „Dan N" u čitaču, kao `biblija_active_day_ctx` na webu). */
data class PlanDayContext(val planId: String, val day: PlanDay)

/** Ponuda da se dani kanonskog plana prije kursora označe pročitanima; [place] je npr. „2 Kr 6". */
data class PlanCatchUpOffer(val planId: String, val days: List<PlanDay>, val place: String) {
    val question: String
        get() = if (days.size == 1) {
            "Označiti ${days[0].day}. dan (${days[0].label}) pročitanim?"
        } else {
            "Označiti pročitanim ${days.size} dana, od ${days.first().day}. do ${days.last().day}. (prije $place)?"
        }
}

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
    var altTranslations: List<AltTranslation> by mutableStateOf(emptyList())
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

    /** `ks` ili slug iz alt_translations; oznake, plan i dnevnik ostaju na retcima KS-a. */
    var translation by mutableStateOf(prefs.getString("translation", null) ?: "ks")
        private set
    var translationLayout by mutableStateOf(enumOr(prefs.getString("translation_layout", null), TranslationLayout.PARALLEL))
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
                altTranslations = withContext(Dispatchers.IO) { repo.altTranslations() }
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

    /** Odabrani drugi prijevod; null za KS. */
    val activeAltTranslation: AltTranslation? get() = altTranslations.firstOrNull { it.slug == translation }

    /** Drugi prijevod za poglavlje, s porukama kao applyTranslation() u astro-client.js. */
    fun altChapter(ref: ChapterRef): AltChapter {
        val tr = activeAltTranslation ?: return AltChapter()
        if (!tr.has(ref.bookOrder)) {
            return AltChapter(
                if (tr.scope == "nt") "${tr.name} obuhvaća samo Novi zavjet (27 knjiga). Za Stari zavjet prikazan je tekst KS-a."
                else "Prijevod ${tr.name} nema ovu knjigu u izvoru (library.foi.hr). Prikazan je tekst KS-a.",
            )
        }
        val verses = repository?.altVerses(tr.slug, ref.bookOrder, ref.chapter) ?: emptyList()
        if (verses.isEmpty()) {
            val place = if (ref.chapter == 0) "proslov" else "${ref.chapter}. poglavlje"
            return AltChapter("${tr.name} nema $place pod ovim brojem. Prikazan je tekst KS-a.")
        }
        val note = tr.bookNotes[ref.bookOrder]
        return AltChapter(tr.notice + (note?.let { ". $it" } ?: ""), verses)
    }

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

    /**
     * Čitač javlja da je poglavlje prikazano: pamti se za „nastavi čitanje" na svim uređajima,
     * otvara se zapis u dnevniku i, ako je ovo isto ili sljedeće poglavlje, pomiče linearni kursor.
     */
    fun didShow(ref: ChapterRef) {
        val book = book(ref.bookOrder) ?: return
        val url = WebPath.chapter(book.slug, ref.chapter)
        val label = WebPath.label(book, ref.chapter)
        val previousUrl = neighbour(ref, -1)?.let { prev -> book(prev.bookOrder)?.let { WebPath.chapter(it.slug, prev.chapter) } }
        visitJob?.cancel()
        linearPin = null
        val cursorBefore = linearRef
        var visitId = ""
        mutate {
            val (next, id) = it.withLastRead(url, label).beginVisit(url, label, previousUrl, DEVICE_LABEL)
            visitId = id
            next
        }
        currentVisit = visitId to 0
        if (cursorBefore != null && cursorBefore != linearRef) offerPlanCatchUp(cursorBefore)
    }

    // ---------- Dnevnik čitanja i linearno čitanje ----------

    /** Otvoreni zapis dnevnika i redak na vrhu ekrana */
    private var currentVisit: Pair<String, Int>? = null
    private var visitJob: Job? = null

    /** Ručno „Ovdje sam stao": kursor ne prati skrolanje dok se redak na vrhu ne pomakne s `top`. */
    private var linearPin: Int? = null

    val linear: LinearCursor? get() = userData.linear
    val linearRef: ChapterRef? get() = userData.linear?.let { chapterRef(it.url) }
    val readingLog: List<ReadingLogEntry> get() = userData.readingLogNewestFirst

    fun isLinear(ref: ChapterRef) = linearRef == ref

    /** Čitač javlja redak na vrhu ekrana; zapisuje se kad se skrolanje smiri. */
    fun didScroll(verse: Int) {
        val (id, last) = currentVisit ?: return
        if (last == verse) return
        currentVisit = id to verse
        visitJob?.cancel()
        visitJob = viewModelScope.launch {
            delay(700)
            val keepPin = linearPin == verse
            if (!keepPin) linearPin = null
            mutate(syncAfterMs = 4000) { it.withVisitUpdate(id, verse, moveLinear = !keepPin) }
        }
    }

    /** Aplikacija ide u pozadinu: kraj zapisa = sada, i odmah sync. */
    private fun closeVisit() {
        val (id, verse) = currentVisit ?: return
        visitJob?.cancel()
        mutate(syncAfterMs = 100) { it.withVisitUpdate(id, verse, moveLinear = linearPin == null) }
    }

    fun openLinear() {
        val cursor = userData.linear ?: return
        val ref = linearRef ?: return
        open(ref, verse = cursor.verse.takeIf { it > 1 })
    }

    fun open(entry: ReadingLogEntry) {
        val ref = chapterRef(entry.url) ?: return
        open(ref, verse = entry.verse.takeIf { it > 1 })
    }

    /** „Ovdje sam stao" iz izbornika retka, ili ručno postavljeno mjesto u dnevniku. */
    fun setLinear(ref: ChapterRef, verse: Int) {
        val book = book(ref.bookOrder) ?: return
        mutate { it.withLinear(WebPath.chapter(book.slug, ref.chapter), WebPath.label(book, ref.chapter), verse) }
        if (ref == readerTarget.chapter) linearPin = currentVisit?.second ?: 0
        offerPlanCatchUp(null)
    }

    /** „Nastavi redom odavde": kursor na otvoreno poglavlje i redak na vrhu. */
    fun continueLinearHere(ref: ChapterRef) {
        setLinear(ref, currentVisit?.second ?: 0)
        linearPin = null
        currentVisit?.let { (id, verse) -> mutate { it.withVisitUpdate(id, verse) } }
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

    fun updateTranslation(slug: String) {
        translation = slug
        prefs.edit { putString("translation", slug) }
    }

    fun updateTranslationLayout(value: TranslationLayout) {
        translationLayout = value
        prefs.edit { putString("translation_layout", value.name) }
    }

    fun updateServerUrl(value: String) {
        serverUrl = value
        prefs.edit { putString("server_url", value) }
        rememberLiveRoom(null)
    }

    // ---------- Kursor i kanonski plan Biblije 365 ----------

    /** Ponuda da se dani kanonskog plana prije kursora označe pročitanima (uvijek uz potvrdu). */
    var planCatchUp by mutableStateOf<PlanCatchUpOffer?>(null)

    /**
     * Ručno postavljen kursor (`from == null`) nudi sve neoznačene dane prije njega; linearno čitanje samo
     * dane koje je pomak s [from] završio.
     */
    private fun offerPlanCatchUp(from: ChapterRef?) {
        if (activePlanId != PlanCatchUp.CANON_PLAN_ID) return
        val cursor = linearRef ?: return
        val planId = PlanCatchUp.CANON_PLAN_ID
        val days = PlanCatchUp.daysToOffer(planDays(planId), from, cursor) { isDayDone(planId, it) }
        planCatchUp = if (days.isEmpty()) null else PlanCatchUpOffer(planId, days, label(cursor))
    }

    fun acceptPlanCatchUp() {
        val offer = planCatchUp ?: return
        planCatchUp = null
        mutate { data ->
            offer.days.filterNot { data.isDayDone(offer.planId, it.day) }
                .fold(data) { acc, day -> acc.withDay(offer.planId, day.day, true) }
        }
    }

    fun dismissPlanCatchUp() {
        planCatchUp = null
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

    private fun mutate(syncAfterMs: Long = 800, change: (UserData) -> UserData) {
        val next = change(userData)
        if (next == userData) return
        userData = next
        persist()
        scheduleSync(syncAfterMs)
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
        if (inForeground && !foreground) closeVisit()
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
            var merged = Lww.merge(result.data, userData)
            val acknowledged = result.acknowledgedLog.filter { (id, version) -> merged.readingLog[id]?.updatedAt?.let { it == version } ?: true }
            merged = merged.copy(logDirty = merged.logDirty - acknowledged.keys)
            // Server vraća samo novi dio dnevnika, pa se uspoređuje ono što vraća cijelo.
            val supportsLog = result.data.logCursor.isNotEmpty()
            val hasNewerLocal = merged.meta != result.data.meta || merged.progress != result.data.progress ||
                merged.bookmarks != result.data.bookmarks ||
                (supportsLog && (merged.linear != result.data.linear || (merged.logDirty.isNotEmpty() && result.acknowledgedLog.isNotEmpty())))
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

/** Uređaj u dnevniku čitanja („Android", „Web · Mac", „iPhone") */
private val DEVICE_LABEL = android.os.Build.MODEL?.takeIf { it.isNotBlank() } ?: "Android"

private inline fun <reified E : Enum<E>> enumOr(name: String?, fallback: E): E =
    name?.let { n -> enumValues<E>().firstOrNull { it.name == n } } ?: fallback
