package hr.stepanic.biblija.core

/**
 * Veza linearnog kursora i plana „Biblija 365 — Kanonski redom", kao `offerPlanCatchUp` u
 * public/astro-client.js. Samo taj plan ide redom kao kursor, pa se dani prije kursora mogu označiti
 * pročitanima; aplikacija ih uvijek nudi uz potvrdu i nikad ne poništava već označene.
 */
object PlanCatchUp {
    const val CANON_PLAN_ID = "biblija-365-kanonski"

    /** (knjiga, poglavlje) kao jedan broj za usporedbu; Proslov je poglavlje 0. */
    fun position(ref: ChapterRef) = ref.bookOrder * 1000 + ref.chapter

    /** Kraj dana: zadnje poglavlje zadnjeg čitanja. */
    fun endPosition(day: PlanDay) = day.readings.maxOfOrNull { it.bookOrder * 1000 + it.chapterEnd } ?: -1

    /**
     * Dani koji završavaju prije kursora [to], a nisu označeni. Uz [from] (stari kursor pri linearnom
     * čitanju) samo dani koje je ovaj pomak završio, da odbijeni dani ne iskaču ponovno.
     * Dan koji sadrži kursorovo poglavlje ostaje neoznačen.
     */
    fun daysToOffer(days: List<PlanDay>, from: ChapterRef?, to: ChapterRef, isDone: (Int) -> Boolean): List<PlanDay> {
        val upper = position(to)
        val lower = from?.let(::position) ?: -1
        if (lower >= upper) return emptyList()
        return days.filter { day ->
            val end = endPosition(day)
            end < upper && end >= lower && !isDone(day.day)
        }
    }
}
