# Mobilne aplikacije: odluka za native SwiftUI + Jetpack Compose

**Odluka (2026-10-25):** iOS u SwiftUI-ju, Android u Jetpack Composeu, dva zasebna native klijenta.
Web aplikacija (Astro SSG + Worker) služi kao funkcionalna specifikacija; zajednička jezgra su
`data/biblija.db` i HTTP ugovor `/api/auth` + `/api/sync`.

Vezani dokumenti: [Arhitektura i audit izvora](2026-10-25-arhitektura-i-audit-izvora.md)

## 1. Zašto native, a ne cross-platform

- **Nema poslovne logike za dijeljenje.** Klijentski kod je ~3.000 linija (od toga ~1.800 CSS),
  logika (plan → poglavlja, LWW merge, fold dijakritika) je nekoliko stotina linija. Vrijednost je
  u podacima, a oni su već platformski neutralni (SQLite + JSON API).
- **RN/Flutter ne nasljeđuju ništa iz Astra** (nije React), pa je i ondje potrebno prepisivanje —
  ako se prepisuje, bolje platiti za native.
- **Aplikacija za čitanje živi od platformskih detalja:** Dynamic Type / sistemska veličina fonta,
  VoiceOver/TalkBack nad dugim tekstom, glatko skrolanje, widget „današnje čitanje", lokalne
  notifikacije za plan, App Intents.
- **Nema framework churna** (RN/Expo SDK, Flutter nadogradnje).
- Cijena: UI se piše dvaput (~1,6–1,8× po značajci), dva toolchaina, rizik razilaženja značajki.

## 2. Razmotrene i odbačene alternative

| Opcija | Reuse | Zašto odbačeno |
|---|---|---|
| Capacitor (wrap Astro builda) | ~100 % | jedina opcija koja stvarno koristi postojeći kod; rizik Apple pravila 4.2 (minimum functionality), web osjećaj, slabiji widgeti/notifikacije. Ostaje kao opcija „u store za tjedan dana" ako zatreba. |
| Flutter | 0 % | prepisivanje svejedno; ne-native izgled, a11y nešto slabiji |
| React Native / Expo | ~0 % | Astro nije React; česte SDK nadogradnje |
| KMP + Compose Multiplatform | 0 % | premalo logike da opravda dijeljeni sloj |

## 3. Tehničke zamke za mobilne klijente

- **FTS5 na Androidu:** sistemski Android SQLite ne jamči FTS5 → isporučiti vlastiti SQLite
  (`androidx.sqlite:sqlite-bundled` / `BundledSQLiteDriver` uz Room). iOS sistemski SQLite ima FTS5.
- **Fold dijakritika:** `biblija.db` već ima `verses.text_folded` i FTS5 `unicode61 remove_diacritics 2`
  (`scripts/build_catalog_and_db.py`, `fold_hr`). Ali **upit** se mora foldati istim pravilima
  (`đ` → `d` ne ide kroz NFD) — `foldHr` iz `src/worker.ts` / `fold_hr` iz build skripte treba
  identično portati u Swift i Kotlin i pokriti zajedničkim testnim vektorima.
- **Bundle baze:** `biblija.db` (~20 MB) sadrži i `user_*` / `sync_*` tablice — za mobilni bundle
  izvesti read-only varijantu samo s tekstom, FTS-om i planovima. Korisničko stanje u zasebnoj
  lokalnoj bazi. Ažuriranje teksta/errata: nova verzija aplikacije ili preuzimanje verzionirane DB s Workera.
- **App Store 5.1.1(v):** ako se račun stvara u aplikaciji, mora se moći obrisati u aplikaciji →
  Worker treba endpoint za brisanje računa (trenutno ga nema).
- **Sigurnost prijave:** `user_key` + 4-znamenkasti PIN, SHA-256 bez soli po korisniku, bez
  ograničenja pokušaja → prije javnog storea barem rate limit na `/api/auth`.
- **Prava na tekst:** objava u storeovima je distribucija — provjeriti prava na Zagrebačku Bibliju
  1968. / KS tekst prije objave.

## 4. Otvoreno

1. Struktura repoa: mobilni klijenti u ovom repou (`ios/`, `android/`) ili zasebni repoi — nije odlučeno.
2. Skripta za izvoz read-only mobilne baze.
3. Worker: `DELETE` računa + rate limit na `/api/auth`.
4. Zajednički testni vektori za fold i LWW merge (JSON fixture koji koriste sva tri klijenta).
