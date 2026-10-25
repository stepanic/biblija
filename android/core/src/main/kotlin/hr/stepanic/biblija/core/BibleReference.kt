package hr.stepanic.biblija.core

data class BibleReference(val book: Book, val chapter: Int, val verse: Int?) {
    val label: String get() = "${book.abbr} $chapter" + (verse?.let { ",$it" } ?: "")

    companion object {
        // Isti regex kao parseBibleReference u public/astro-client.js
        private val pattern = Regex("""^([1-3]?\s*[a-zA-ZčćžšđČĆŽŠĐ.]+)\s+([0-9]+)(?:\s*[,:]\s*([0-9]+)(?:\s*[-–]\s*([0-9]+))?)?$""")

        /** Prepoznaje „Iv 3,16", „1 Kor 13", „Ps 23". Vidi shared/test-vectors/bible_reference.json. */
        fun parse(raw: String, books: List<Book>): BibleReference? {
            val m = pattern.matchEntire(raw.trim()) ?: return null
            val token = HrFold.fold(m.groupValues[1].replace(".", "").trim())
            val ch = m.groupValues[2].toIntOrNull() ?: return null
            val verse = m.groupValues[3].takeIf { it.isNotEmpty() }?.toIntOrNull()
            val book = books.firstOrNull {
                val title = HrFold.fold(it.title)
                HrFold.fold(it.abbr) == token || title == token || title.startsWith(token)
            } ?: return null
            if (ch < 0 || ch > book.chapterCount) return null
            return BibleReference(book, ch, verse)
        }
    }
}
