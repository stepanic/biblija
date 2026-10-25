package hr.stepanic.biblija.core

import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assume.assumeTrue
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Datoteke iz shared/test-vectors: isti vektori vrijede za Python, worker, Swift i Kotlin. */
object Repo {
    val root = File(System.getProperty("biblija.repoRoot") ?: "../..")
    val json = Json { ignoreUnknownKeys = true }
    val mobileDb = File(root, "build/mobile/biblija-mobile.db")

    fun cases(name: String): JsonArray =
        json.parseToJsonElement(File(root, "shared/test-vectors/$name").readText()).jsonObject["cases"]!!.jsonArray

    fun userData(el: JsonElement): UserData = json.decodeFromJsonElement(UserData.serializer(), el)

    fun openRepository(): BibleRepository {
        assumeTrue("nema ${mobileDb.path} (python3 scripts/export_mobile_db.py)", mobileDb.exists())
        return BibleRepository(BundledSQLiteDriver().open(mobileDb.absolutePath))
    }
}

private fun JsonElement.stringOrNull(): String? = if (this is JsonNull) null else jsonPrimitive.content

class SharedVectorTest {
    @Test
    fun foldHr() {
        for (c in Repo.cases("fold_hr.json")) {
            val o = c.jsonObject
            val input = o["input"]!!.jsonPrimitive.content
            assertEquals(o["expected"]!!.jsonPrimitive.content, HrFold.fold(input), "ulaz: \"$input\"")
        }
    }

    @Test
    fun ftsExpression() {
        for (c in Repo.cases("fts_query.json")) {
            val o = c.jsonObject
            val input = o["input"]!!.jsonPrimitive.content
            assertEquals(o["expected"]!!.stringOrNull(), HrFold.ftsExpression(input), "ulaz: \"$input\"")
        }
    }

    @Test
    fun lwwMerge() {
        for (c in Repo.cases("lww_merge.json")) {
            val o = c.jsonObject
            if (o["server_only"]?.jsonPrimitive?.booleanOrNull == true) continue
            val name = o["name"]!!.jsonPrimitive.content
            val merged = Lww.merge(Repo.userData(o["server"]!!), Repo.userData(o["client"]!!))
            val expected = Repo.userData(o["expected"]!!)
            assertEquals(expected.meta, merged.meta, name)
            assertEquals(expected.progress, merged.progress, name)
            assertEquals(expected.bookmarks, merged.bookmarks, name)
        }
    }

    @Test
    fun bibleReference() {
        Repo.openRepository().use { repo ->
            val books = repo.books()
            for (c in Repo.cases("bible_reference.json")) {
                val o = c.jsonObject
                val input = o["input"]!!.jsonPrimitive.content
                val parsed = BibleReference.parse(input, books)
                val expected = o["expected"]
                if (expected == null || expected is JsonNull) {
                    assertNull(parsed, "ulaz: $input")
                    continue
                }
                val e = expected as JsonObject
                assertEquals(e["book_order"]!!.jsonPrimitive.int, parsed?.book?.order, "ulaz: $input")
                assertEquals(e["chapter"]!!.jsonPrimitive.int, parsed?.chapter, "ulaz: $input")
                assertEquals(e["verse"]!!.let { if (it is JsonNull) null else it.jsonPrimitive.intOrNull }, parsed?.verse, "ulaz: $input")
            }
        }
    }
}
