import Foundation

/// Veza linearnog kursora i plana „Biblija 365 — Kanonski redom", kao `offerPlanCatchUp` u
/// public/astro-client.js. Samo taj plan ide redom kao kursor, pa se dani prije kursora mogu označiti
/// pročitanima; aplikacija ih uvijek nudi uz potvrdu i nikad ne poništava već označene.
public enum PlanCatchUp {
    public static let canonPlanId = "biblija-365-kanonski"

    /// (knjiga, poglavlje) kao jedan broj za usporedbu; Proslov je poglavlje 0.
    public static func position(_ ref: ChapterRef) -> Int { ref.bookOrder * 1000 + ref.chapter }

    /// Kraj dana: zadnje poglavlje zadnjeg čitanja.
    public static func endPosition(_ day: PlanDay) -> Int {
        day.readings.map { $0.bookOrder * 1000 + $0.chapterEnd }.max() ?? -1
    }

    /// Dani koji završavaju prije kursora `to`, a nisu označeni. Uz `from` (stari kursor pri linearnom
    /// čitanju) samo dani koje je ovaj pomak završio, da odbijeni dani ne iskaču ponovno.
    /// Dan koji sadrži kursorovo poglavlje ostaje neoznačen.
    public static func daysToOffer(
        days: [PlanDay], from: ChapterRef?, to: ChapterRef, isDone: (Int) -> Bool
    ) -> [PlanDay] {
        let upper = position(to)
        let lower = from.map(position) ?? -1
        guard lower < upper else { return [] }
        return days.filter { day in
            let end = endPosition(day)
            return end < upper && end >= lower && !isDone(day.day)
        }
    }
}
