package hr.stepanic.biblija.core

import androidx.sqlite.SQLiteConnection
import androidx.sqlite.SQLiteStatement
import kotlinx.serialization.json.Json

class SchemaMismatchException(found: Int, expected: Int) :
    IllegalStateException("Mobilna baza ima shemu $found, aplikacija očekuje $expected.")

/**
 * Read-only pristup biblija-mobile.db (scripts/export_mobile_db.py).
 * Konekcija mora biti iz BundledSQLiteDriver: sistemski Android SQLite ne jamči FTS5.
 */
class BibleRepository(private val connection: SQLiteConnection) : AutoCloseable {
    companion object {
        /** Mora odgovarati SCHEMA_VERSION u scripts/export_mobile_db.py. */
        const val EXPECTED_SCHEMA_VERSION = 1
    }

    private val json = Json { ignoreUnknownKeys = true }
    private val lock = Any()

    init {
        val version = meta("schema_version")?.toIntOrNull() ?: 0
        if (version != EXPECTED_SCHEMA_VERSION) throw SchemaMismatchException(version, EXPECTED_SCHEMA_VERSION)
    }

    fun meta(key: String): String? =
        query("SELECT value FROM mobile_meta WHERE key = ?", listOf(key)) { it.getText(0) }.firstOrNull()

    fun books(): List<Book> = query(
        """
        SELECT book_order, id, usfm_id, abbr, title, name_en, testament, category,
               deuterocanonical, deuterocanonical_parts, chapter_count, verse_count
        FROM books ORDER BY book_order
        """,
    ) {
        Book(
            order = it.int(0), slug = it.getText(1), usfmId = it.getText(2), abbr = it.getText(3),
            title = it.getText(4), nameEn = it.getText(5), testament = it.getText(6), category = it.getText(7),
            deuterocanonical = it.int(8) != 0, deuterocanonicalParts = it.textOrNull(9),
            chapterCount = it.int(10), verseCount = it.int(11),
        )
    }

    fun chapters(bookOrder: Int): List<ChapterInfo> = query(
        "SELECT chapter, verse_count FROM chapters WHERE book_order = ? ORDER BY chapter",
        listOf(bookOrder),
    ) { ChapterInfo(it.int(0), it.int(1)) }

    fun verses(bookOrder: Int, chapter: Int): List<Verse> = query(
        """
        SELECT verse, verse_label, text, paragraph_start, headings_json, references_json, lines_json
        FROM verses WHERE book_order = ? AND chapter = ? ORDER BY verse
        """,
        listOf(bookOrder, chapter),
    ) {
        Verse(
            verse = it.int(0), label = it.getText(1), text = it.getText(2), paragraphStart = it.int(3) != 0,
            headings = it.textOrNull(4)?.let { s -> json.decodeFromString<List<Heading>>(s) } ?: emptyList(),
            references = it.textOrNull(5)?.let { s -> json.decodeFromString<List<String>>(s) } ?: emptyList(),
            lines = it.textOrNull(6)?.let { s -> json.decodeFromString<List<String>>(s) } ?: emptyList(),
        )
    }

    fun plans(): List<ReadingPlan> = query(
        "SELECT id, title, category, days_count, description FROM reading_plans ORDER BY rowid",
    ) { ReadingPlan(it.getText(0), it.getText(1), it.getText(2), it.int(3), it.getText(4)) }

    fun planDays(planId: String): List<PlanDay> = query(
        "SELECT day, label, verse_count, readings_json FROM reading_plan_days WHERE plan_id = ? ORDER BY day",
        listOf(planId),
    ) {
        PlanDay(it.int(0), it.getText(1), it.int(2), json.decodeFromString<List<PlanReading>>(it.getText(3)))
    }

    /** FTS5 pretraga kao /api/search u server.py. `testament` je `SZ`, `NZ` ili null. */
    fun search(rawQuery: String, testament: String? = null, bookOrder: Int? = null, limit: Int = 100): SearchResult {
        val expr = HrFold.ftsExpression(rawQuery) ?: return SearchResult.EMPTY
        val where = StringBuilder("verses_fts MATCH ?")
        val params = mutableListOf<Any>(expr)
        if (testament == "SZ" || testament == "NZ") {
            where.append(" AND v.testament = ?")
            params.add(testament)
        }
        if (bookOrder != null) {
            where.append(" AND v.book_order = ?")
            params.add(bookOrder)
        }
        val from = "FROM verses_fts JOIN verses v ON v.id = verses_fts.rowid WHERE $where"
        val total = query("SELECT COUNT(*) $from", params) { it.int(0) }.firstOrNull() ?: 0
        val hits = query(
            "SELECT v.book_order, v.book_abbr, v.book_title, v.chapter, v.verse, v.text $from " +
                "ORDER BY v.book_order, v.chapter, v.verse LIMIT ?",
            params + limit,
        ) { SearchHit(it.int(0), it.getText(1), it.getText(2), it.int(3), it.int(4), it.getText(5)) }
        return SearchResult(total, hits)
    }

    override fun close() = synchronized(lock) { connection.close() }

    // ---------- SQLite pomoćnici ----------

    private fun SQLiteStatement.int(i: Int): Int = getLong(i).toInt()
    private fun SQLiteStatement.textOrNull(i: Int): String? = if (isNull(i)) null else getText(i)

    private fun <T> query(sql: String, params: List<Any> = emptyList(), map: (SQLiteStatement) -> T): List<T> =
        synchronized(lock) {
            connection.prepare(sql.trimIndent()).use { stmt ->
                params.forEachIndexed { i, p ->
                    when (p) {
                        is Int -> stmt.bindLong(i + 1, p.toLong())
                        is Long -> stmt.bindLong(i + 1, p)
                        else -> stmt.bindText(i + 1, p.toString())
                    }
                }
                buildList { while (stmt.step()) add(map(stmt)) }
            }
        }
}
