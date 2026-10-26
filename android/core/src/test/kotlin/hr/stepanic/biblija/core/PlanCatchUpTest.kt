package hr.stepanic.biblija.core

import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Treba build/mobile/biblija-mobile.db (python3 scripts/export_mobile_db.py). */
class PlanCatchUpTest {
    private lateinit var days: List<PlanDay>
    private var kings2 = 0

    @BeforeTest
    fun open() {
        val repo = Repo.openRepository()
        try {
            days = repo.planDays(PlanCatchUp.CANON_PLAN_ID)
            kings2 = repo.books().first { it.abbr == "2 Kr" }.order
        } finally {
            repo.close()
        }
    }

    @Test
    fun manualCursorOffersDaysEndingBeforeIt() {
        val offer = PlanCatchUp.daysToOffer(days, null, ChapterRef(kings2, 6)) { false }
        assertEquals((1..102).toList(), offer.map { it.day })
        assertEquals("2 Kr 3–5", offer.last().label, "dan s 2 Kr 6 ostaje neoznačen")
    }

    @Test
    fun alreadyDoneDaysAreSkipped() {
        val offer = PlanCatchUp.daysToOffer(days, null, ChapterRef(kings2, 6)) { it <= 100 }
        assertEquals(listOf(101, 102), offer.map { it.day })
    }

    @Test
    fun linearStepOffersOnlyTheDayItFinished() {
        // Dan 102 je 2 Kr 3–5: prijelaz s 2 Kr 5 na 2 Kr 6 ga završava, prijelaz s 4 na 5 ne.
        assertEquals(listOf(102), PlanCatchUp.daysToOffer(days, ChapterRef(kings2, 5), ChapterRef(kings2, 6)) { false }.map { it.day })
        assertTrue(PlanCatchUp.daysToOffer(days, ChapterRef(kings2, 4), ChapterRef(kings2, 5)) { false }.isEmpty())
    }

    @Test
    fun backwardsCursorOffersNothing() {
        assertTrue(PlanCatchUp.daysToOffer(days, ChapterRef(kings2, 6), ChapterRef(1, 3)) { false }.isEmpty())
    }
}
