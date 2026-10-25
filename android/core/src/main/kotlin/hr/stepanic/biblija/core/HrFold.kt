package hr.stepanic.biblija.core

import java.text.Normalizer
import java.util.Locale

/**
 * Port `fold_hr` iz scripts/build_catalog_and_db.py (njime su foldani `verses.text_folded` i FTS indeks).
 * Ponašanje je zaključano vektorima u shared/test-vectors/fold_hr.json.
 */
object HrFold {
    private val croatian = mapOf(
        'č' to 'c', 'ć' to 'c', 'ž' to 'z', 'š' to 's', 'đ' to 'd',
        'Č' to 'C', 'Ć' to 'C', 'Ž' to 'Z', 'Š' to 'S', 'Đ' to 'D',
    )

    private val wordRegex = Regex("""(?U)\w+""")

    fun fold(text: String): String {
        val mapped = buildString(text.length) {
            for (ch in text) append(croatian[ch] ?: ch)
        }
        val decomposed = Normalizer.normalize(mapped, Normalizer.Form.NFKD)
        val kept = buildString(decomposed.length) {
            var i = 0
            while (i < decomposed.length) {
                val cp = decomposed.codePointAt(i)
                if (Character.getType(cp) != Character.NON_SPACING_MARK.toInt()) appendCodePoint(cp)
                i += Character.charCount(cp)
            }
        }
        return kept.lowercase(Locale.ROOT)
    }

    /** Tokeni kao Pythonov `re.findall(r"[\w]+", ...)`. */
    fun tokens(folded: String): List<String> = wordRegex.findAll(folded).map { it.value }.toList()

    /** Korisnički upit → FTS5 MATCH izraz (isto kao /api/search u server.py); `null` = nema upita. */
    fun ftsExpression(query: String): String? {
        val q = query.trim()
        val toks = tokens(fold(q))
        if (toks.isEmpty()) return null
        if (q.startsWith("\"") && q.endsWith("\"") && toks.size > 1) {
            return "\"" + toks.joinToString(" ") + "\""
        }
        return toks.joinToString(" AND ") { "\"$it\"*" }
    }

    /**
     * Rasponi u izvornom tekstu gdje se pojavljuju tokeni upita (≥ 2 znaka, kao highlightMatch na webu).
     * Uspoređuje se foldani tekst, pa „bozji" označi „Božji".
     */
    fun matchRanges(text: String, query: String): List<IntRange> {
        val needles = tokens(fold(query)).filter { it.length >= 2 }.toSet()
        if (needles.isEmpty()) return emptyList()

        val folded = StringBuilder()
        val origin = ArrayList<Int>()
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            val len = Character.charCount(cp)
            for (f in fold(text.substring(i, i + len))) {
                folded.append(f)
                origin.add(i)
            }
            i += len
        }
        val foldedStr = folded.toString()

        val ranges = mutableListOf<IntRange>()
        for (needle in needles) {
            var from = 0
            while (true) {
                val at = foldedStr.indexOf(needle, from)
                if (at < 0) break
                val start = origin[at]
                val lastOrigin = origin[at + needle.length - 1]
                val end = lastOrigin + Character.charCount(text.codePointAt(lastOrigin)) - 1
                ranges.add(start..end)
                from = at + needle.length
            }
        }
        ranges.sortBy { it.first }
        val merged = mutableListOf<IntRange>()
        for (r in ranges) {
            val last = merged.lastOrNull()
            if (last != null && r.first <= last.last + 1) {
                merged[merged.size - 1] = last.first..maxOf(last.last, r.last)
            } else {
                merged.add(r)
            }
        }
        return merged
    }
}
