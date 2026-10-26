package hr.stepanic.biblija.core

import kotlinx.serialization.json.Json
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Isti scenariji kao ios/BiblijaKit/Tests/BiblijaKitTests/ReadingLogTests.swift */
class ReadingLogTest {
    private val t0 = Instant.ofEpochSecond(1_790_000_000)

    @Test
    fun firstVisitSetsCursorAndJumpKeepsIt() {
        var d = UserData()
        d = d.beginVisit("/izaija/11/", "Iz 11", "/izaija/10/", "Android", "a", t0).first
        assertEquals("/izaija/11/", d.linear?.url)
        d = d.beginVisit("/izaija/12/", "Iz 12", "/izaija/11/", "Android", "b", t0.plusSeconds(60)).first
        assertEquals("/izaija/12/", d.linear?.url)
        assertEquals(true, d.readingLog["b"]?.linear)
        d = d.beginVisit("/psalmi/23/", "Ps 23", "/psalmi/22/", "Android", "c", t0.plusSeconds(120)).first
        assertEquals("/izaija/12/", d.linear?.url, "skok ne pomiče kursor")
        assertEquals(false, d.readingLog["c"]?.linear)
        assertEquals(setOf("a", "b", "c"), d.logDirty)
    }

    @Test
    fun reopeningSameChapterSoonContinuesEntry() {
        var d = UserData().beginVisit("/psalmi/23/", "Ps 23", null, "Android", "a", t0).first
        val (d2, id) = d.beginVisit("/psalmi/23/", "Ps 23", null, "Android", "b", t0.plusSeconds(600))
        d = d2
        assertEquals("a", id)
        assertEquals(1, d.readingLog.size)
        assertEquals(Timestamp.now(t0.plusSeconds(600)), d.readingLog["a"]?.endedAt)
        assertEquals("c", d.beginVisit("/psalmi/23/", "Ps 23", null, "Android", "c", t0.plusSeconds(4000)).second)
        assertEquals("d", d.beginVisit("/psalmi/23/", "Ps 23", null, "Web · Mac", "d", t0.plusSeconds(610)).second)
    }

    @Test
    fun updateVisitMovesCursorOnlyOnItsChapter() {
        var d = UserData().beginVisit("/izaija/12/", "Iz 12", null, "Android", "a", t0).first
        d = d.withVisitUpdate("a", 7, Timestamp.now(t0.plusSeconds(30)))
        assertEquals(7, d.readingLog["a"]?.verse)
        assertEquals(7, d.linear?.verse)
        d = d.beginVisit("/psalmi/23/", "Ps 23", null, "Android", "b", t0.plusSeconds(60)).first
        d = d.withVisitUpdate("b", 4, Timestamp.now(t0.plusSeconds(90)))
        assertEquals(7, d.linear?.verse)
        val before = d.linear
        d = d.withVisitUpdate("a", 7, Timestamp.now(t0.plusSeconds(200)))
        assertEquals(before, d.linear, "isti redak ne osvježava vrijeme kursora")
    }

    @Test
    fun mergeKeepsNewerLocalLogAndCursor() {
        val old = ReadingLogEntry("a", "/izaija/12/", "", 2, "2026-10-01T08:00:00.000Z", "2026-10-01T08:01:00.000Z", true, "Web", "2026-10-01T08:01:00.000Z")
        val newer = old.copy(verse = 9, updatedAt = "2026-10-01T08:05:00.000Z")
        val fromServer = ReadingLogEntry("b", "/psalmi/23/", "", 0, "2026-10-01T09:00:00.000Z", "2026-10-01T09:00:00.000Z", false, "Web", "2026-10-01T09:00:00.000Z")
        val server = UserData(
            linear = LinearCursor("/izaija/12/", "", 2, "2026-10-01T08:01:00.000Z"),
            readingLog = mapOf("a" to old, "b" to fromServer),
            logCursor = "2026-10-01T10:00:00.000Z",
        )
        val client = UserData(
            linear = LinearCursor("/izaija/12/", "", 9, "2026-10-01T08:05:00.000Z"),
            readingLog = mapOf("a" to newer),
            logDirty = setOf("a"),
        )
        val merged = Lww.merge(server, client)
        assertEquals(9, merged.readingLog["a"]?.verse)
        assertEquals(fromServer, merged.readingLog["b"])
        assertEquals(9, merged.linear?.verse)
        assertEquals("2026-10-01T10:00:00.000Z", merged.logCursor)
        assertEquals(setOf("a"), merged.logDirty)
    }

    @Test
    fun oldStoredFileDecodes() {
        val json = """{"meta":{"active_plan_id":"x","last_url":"/","last_label":"","last_updated_at":"1970-01-01T00:00:00.000Z"},"progress":{},"bookmarks":{}}"""
        val d = Json { ignoreUnknownKeys = true }.decodeFromString<UserData>(json)
        assertNull(d.linear)
        assertTrue(d.readingLog.isEmpty())
        assertEquals("", d.logCursor)
    }
}
