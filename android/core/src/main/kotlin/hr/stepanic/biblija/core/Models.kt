package hr.stepanic.biblija.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

// ---------- Tekst (read-only, iz biblija-mobile.db) ----------

data class Book(
    val order: Int,
    /** Slug iz web URL-a, npr. `knjiga-postanka`. */
    val slug: String,
    val usfmId: String,
    val abbr: String,
    val title: String,
    val nameEn: String,
    /** `SZ` ili `NZ`. */
    val testament: String,
    val category: String,
    val deuterocanonical: Boolean,
    val deuterocanonicalParts: String?,
    val chapterCount: Int,
    val verseCount: Int,
)

data class ChapterInfo(val chapter: Int, val verseCount: Int) {
    /** Poglavlje 0 je Proslov (Sirah). */
    val shortLabel: String get() = if (chapter == 0) "Proslov" else chapter.toString()
}

@Serializable
data class Heading(
    /** `h2`, `h3` ili `h4`. */
    val level: String,
    val text: String,
)

data class Verse(
    val verse: Int,
    val label: String,
    val text: String,
    val paragraphStart: Boolean,
    val headings: List<Heading>,
    val references: List<String>,
    /** Pjesnički retci; više od jednog znači pjesnički blok. */
    val lines: List<String>,
) {
    val isPoetic: Boolean get() = lines.size > 1
}

@Serializable
data class ChapterRef(val bookOrder: Int, val chapter: Int)

data class ReadingPlan(
    val id: String,
    val title: String,
    val category: String,
    val daysCount: Int,
    val description: String,
)

@Serializable
data class PlanReading(
    @SerialName("book_order") val bookOrder: Int,
    @SerialName("book_id") val bookId: String,
    @SerialName("book_abbr") val bookAbbr: String,
    @SerialName("book_title") val bookTitle: String,
    @SerialName("chapter_start") val chapterStart: Int,
    @SerialName("chapter_end") val chapterEnd: Int,
    @SerialName("verse_count") val verseCount: Int,
    val label: String,
) {
    val chapters: List<ChapterRef>
        get() = if (chapterEnd >= chapterStart) {
            (chapterStart..chapterEnd).map { ChapterRef(bookOrder, it) }
        } else {
            listOf(ChapterRef(bookOrder, chapterStart))
        }
}

data class PlanDay(
    val day: Int,
    val label: String,
    val verseCount: Int,
    val readings: List<PlanReading>,
)

data class SearchHit(
    val bookOrder: Int,
    val bookAbbr: String,
    val bookTitle: String,
    val chapter: Int,
    val verse: Int,
    val text: String,
) {
    val key: String get() = "$bookOrder:$chapter:$verse"
}

data class SearchResult(val total: Int, val hits: List<SearchHit>) {
    companion object {
        val EMPTY = SearchResult(0, emptyList())
    }
}

// ---------- Korisničko stanje (isti oblik kao localStorage na webu i /api/sync) ----------

@Serializable
data class DayProgress(
    val completed: Boolean = true,
    @SerialName("updated_at") val updatedAt: String = Timestamp.EPOCH,
)

enum class BookmarkColor(val raw: String, val label: String) {
    GOLD("gold", "Zlatna"),
    GREEN("green", "Zelena"),
    BLUE("blue", "Plava"),
    PINK("pink", "Ružičasta");

    companion object {
        fun from(raw: String): BookmarkColor = entries.firstOrNull { it.raw == raw } ?: GOLD
    }
}

@Serializable
data class Bookmark(
    @SerialName("book_order") val bookOrder: Int,
    @SerialName("book_id") val bookId: String = "",
    @SerialName("book_abbr") val bookAbbr: String = "",
    @SerialName("book_title") val bookTitle: String = "",
    val chapter: Int,
    val verse: Int,
    /** Sirova vrijednost s poslužitelja; nepoznate boje prikazuju se kao zlatna. */
    val color: String = BookmarkColor.GOLD.raw,
    val note: String = "",
    val text: String = "",
    val deleted: Boolean = false,
    @SerialName("updated_at") val updatedAt: String = Timestamp.EPOCH,
) {
    val key: String get() = key(bookOrder, chapter, verse)
    val bookmarkColor: BookmarkColor get() = BookmarkColor.from(color)

    /** Citat kao na webu: »tekst« (Iv 3,16) */
    val quote: String get() = "»$text« ($bookAbbr $chapter,$verse)"

    companion object {
        fun key(bookOrder: Int, chapter: Int, verse: Int) = "$bookOrder:$chapter:$verse"
    }
}

@Serializable
data class SyncMeta(
    @SerialName("active_plan_id") val activePlanId: String = DEFAULT_PLAN_ID,
    /** Web URL zadnjeg poglavlja, npr. `/psalmi/23/`, da web i mobitel mogu nastaviti jedni od drugih. */
    @SerialName("last_url") val lastUrl: String = "/",
    @SerialName("last_label") val lastLabel: String = "",
    @SerialName("last_updated_at") val lastUpdatedAt: String = Timestamp.EPOCH,
) {
    companion object {
        const val DEFAULT_PLAN_ID = "mb-tematski-365"
    }
}

/** plan_id → dan (string, zbog JSON-a) → napredak */
typealias ProgressMap = Map<String, Map<String, DayProgress>>

/** `book_order:chapter:verse` → oznaka (i tombstone s deleted=true) */
typealias BookmarkMap = Map<String, Bookmark>

@Serializable
data class UserData(
    val meta: SyncMeta = SyncMeta(),
    val progress: ProgressMap = emptyMap(),
    val bookmarks: BookmarkMap = emptyMap(),
) {
    fun isDayDone(planId: String, day: Int): Boolean = progress[planId]?.get(day.toString())?.completed ?: false

    fun activeBookmark(key: String): Bookmark? = bookmarks[key]?.takeUnless { it.deleted }

    /** Najnovije prvo, kao na webu. */
    val activeBookmarks: List<Bookmark>
        get() = bookmarks.values.filterNot { it.deleted }.sortedByDescending { it.updatedAt }

    val completedDaysCount: Int
        get() = progress.values.sumOf { days -> days.values.count { it.completed } }

    // Izmjene s timestampom, kao na webu (togglePlanDayCompleted, saveBookmark…)

    fun withDay(planId: String, day: Int, completed: Boolean, now: String = Timestamp.now()): UserData {
        val plan = (progress[planId] ?: emptyMap()) + (day.toString() to DayProgress(completed, now))
        return copy(progress = progress + (planId to plan))
    }

    fun toggledDay(planId: String, day: Int, now: String = Timestamp.now()) =
        withDay(planId, day, !isDayDone(planId, day), now)

    fun withBookmark(bookmark: Bookmark, now: String = Timestamp.now()): UserData {
        val b = bookmark.copy(deleted = false, updatedAt = now)
        return copy(bookmarks = bookmarks + (b.key to b))
    }

    fun withoutBookmark(key: String, now: String = Timestamp.now()): UserData {
        val b = bookmarks[key] ?: return this
        return copy(bookmarks = bookmarks + (key to b.copy(deleted = true, updatedAt = now)))
    }

    fun withActivePlan(planId: String, now: String = Timestamp.now()) =
        copy(meta = meta.copy(activePlanId = planId, lastUpdatedAt = now))

    fun withLastRead(url: String, label: String, now: String = Timestamp.now()): UserData =
        if (meta.lastUrl == url) this else copy(meta = meta.copy(lastUrl = url, lastLabel = label, lastUpdatedAt = now))
}

object Timestamp {
    const val EPOCH = "1970-01-01T00:00:00.000Z"

    private val format = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    /** ISO-8601 UTC s milisekundama, isto kao `new Date().toISOString()`; LWW ga uspoređuje kao string. */
    fun now(instant: Instant = Instant.now()): String = format.format(instant)
}

/** Web URL-ovi `/<book-id>/<chapter>/`. */
object WebPath {
    fun chapter(bookSlug: String, chapter: Int) = "/$bookSlug/$chapter/"

    fun parseChapter(path: String): Pair<String, Int>? {
        val parts = path.split('/').filter { it.isNotEmpty() }
        if (parts.size < 2) return null
        val ch = parts[1].toIntOrNull() ?: return null
        return parts[0] to ch
    }

    fun label(book: Book, chapter: Int) = "${book.title} (${book.abbr} ${if (chapter == 0) "Proslov" else chapter})"
}
