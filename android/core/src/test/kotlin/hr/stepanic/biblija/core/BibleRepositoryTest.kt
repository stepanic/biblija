package hr.stepanic.biblija.core

import kotlinx.serialization.json.Json
import java.time.Instant
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Treba build/mobile/biblija-mobile.db (python3 scripts/export_mobile_db.py). */
class BibleRepositoryTest {
    private lateinit var repo: BibleRepository

    @BeforeTest
    fun open() {
        repo = Repo.openRepository()
    }

    @AfterTest
    fun close() = repo.close()

    @Test
    fun booksAndChapters() {
        val books = repo.books()
        assertEquals(73, books.size)
        assertEquals("knjiga-postanka", books.first().slug)
        assertEquals(27, books.count { it.testament == "NZ" })
        val sirach = books.first { it.abbr == "Sir" }
        assertEquals(0, repo.chapters(sirach.order).first().chapter, "Sirah počinje Proslovom")
    }

    @Test
    fun altTranslations() {
        val all = repo.altTranslations()
        assertEquals(listOf("saric", "katancic", "rupcic", "raspudic", "gusic"), all.map { it.slug })
        val katancic = all.first { it.slug == "katancic" }
        assertFalse(katancic.has(9), "FOI nema 1 Sam")
        assertTrue(katancic.bookNotes[17] != null, "Tobija ima napomenu o Vulgati")
        val rupcic = all.first { it.slug == "rupcic" }
        assertFalse(rupcic.has(1))
        assertTrue(rupcic.has(50))
        val john1 = repo.altVerses("saric", 50, 1)
        assertEquals(1, john1.first().verse)
        assertTrue(john1.first().text.startsWith("U početku"))
    }

    @Test
    fun versesWithHeadingsAndLines() {
        assertTrue(repo.verses(50, 3).first { it.verse == 16 }.text.contains("Bog je tako ljubio svijet"))
        assertTrue(repo.verses(23, 23).any { it.isPoetic })
        assertFalse(repo.verses(19, 1).first().headings.isEmpty())
    }

    @Test
    fun searchMatchesServerSemantics() {
        // isti broj kao server.py: verses_fts MATCH '"ljubav"*'
        assertEquals(272, repo.search("ljubav").total)
        assertEquals(272, repo.search("LJUBAV").total)
        val nt = repo.search("ljubav", testament = "NZ")
        assertTrue(nt.hits.all { it.bookOrder >= 47 })
        assertTrue(nt.total < 272)
        assertEquals(repo.search("duh bozji").total, repo.search("Duh Božji").total)
        assertTrue(repo.search("\"u početku\"").total > 0)
        assertEquals(0, repo.search("!!!").total)
        assertEquals(5, repo.search("ljubav", limit = 5).hits.size)
    }

    @Test
    fun plans() {
        val plans = repo.plans()
        assertEquals(18, plans.size)
        assertEquals(SyncMeta.DEFAULT_PLAN_ID, plans.first().id)
        val days = repo.planDays(SyncMeta.DEFAULT_PLAN_ID)
        assertEquals(365, days.size)
        assertEquals("Post", days.first().readings.first().bookAbbr)
        assertEquals(2, days.first().readings.first().chapters.size)
    }
}

class UserDataTest {
    @Test
    fun mutationsAndJsonRoundTrip() {
        var data = UserData()
        data = data.toggledDay("p", 3, "2026-10-01T00:00:00.000Z")
        assertTrue(data.isDayDone("p", 3))
        data = data.toggledDay("p", 3, "2026-10-02T00:00:00.000Z")
        assertFalse(data.isDayDone("p", 3))

        val bm = Bookmark(50, "evandelje-po-ivanu", "Iv", "Evanđelje po Ivanu", 3, 16, "blue", "", "Bog je tako ljubio svijet")
        data = data.withBookmark(bm, "2026-10-03T00:00:00.000Z")
        assertEquals(1, data.activeBookmarks.size)
        data = data.withoutBookmark(bm.key, "2026-10-04T00:00:00.000Z")
        assertTrue(data.activeBookmarks.isEmpty())
        assertEquals(true, data.bookmarks[bm.key]?.deleted, "brisanje je tombstone")

        val json = Json { encodeDefaults = true }
        assertEquals(data, json.decodeFromString(UserData.serializer(), json.encodeToString(UserData.serializer(), data)))
    }

    @Test
    fun timestampMatchesJavaScriptFormat() {
        assertEquals("2025-10-25T09:00:00.123Z", Timestamp.now(Instant.ofEpochMilli(1_761_382_800_123)))
    }

    @Test
    fun webPath() {
        assertEquals("/psalmi/23/", WebPath.chapter("psalmi", 23))
        assertEquals(23, WebPath.parseChapter("/psalmi/23/")?.second)
        assertNull(WebPath.parseChapter("/"))
    }

    @Test
    fun matchRangesIgnoreDiacritics() {
        val text = "Duh Božji lebdio je nad vodama. Božji duh."
        assertEquals(listOf("Božji", "Božji"), HrFold.matchRanges(text, "bozji").map { text.substring(it) })
        assertEquals(listOf("Đav"), HrFold.matchRanges("Đavao", "dav").map { "Đavao".substring(it) })
        assertTrue(HrFold.matchRanges(text, "a").isEmpty())
    }
}
