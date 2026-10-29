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

## 4. Stanje implementacije (2026-10-25)

Klijenti su u ovom repou (`ios/`, `android/`), uz zajednički `shared/`. Ništa još nije isprobano
na uređaju; oba projekta se buildaju, a logika je pokrivena testovima koji rade na Macu bez
simulatora i emulatora.

| Dio | Gdje | Provjera |
|---|---|---|
| Read-only mobilna baza (tekst, FTS5, planovi, drugi prijevodi `alt_*`, `mobile_meta`; shema 2) | `scripts/export_mobile_db.py`, `npm run mobile-db` | odbija `user_*`/`sync_*` tablice |
| Testni vektori: fold, FTS izraz, biblijska referenca, LWW | `shared/test-vectors/`, `scripts/gen_test_vectors.py` | `npm run test:contract` (15 testova protiv pravog `src/worker.ts` nad `node:sqlite`) |
| Worker: `POST /api/account/delete`, zaključavanje nakon 5 pogrešnih PIN-ova (15 min) | `src/worker.ts`, `migrations/0002_auth_failures.sql` | isti ugovorni testovi |
| iOS logika | `ios/BiblijaKit` (Swift package) | `cd ios/BiblijaKit && swift test` (12) |
| iOS aplikacija (SwiftUI, iOS 17+) | `ios/Biblija`, `ios/project.yml` | `xcodegen generate`, build za `generic/platform=iOS` |
| Android logika | `android/core` (Kotlin/JVM, `BundledSQLiteDriver`) | `./gradlew :core:test` (12) |
| Android aplikacija (Compose, minSdk 26) | `android/app` | `./gradlew :app:assembleDebug` |

Ekrani u oba klijenta: čitač (odlomci / redak po redak, naslovi, pjesnički retci, oznake bojom,
bilješka, kopiranje i dijeljenje citata, traka „Dan N" iz plana), Biblija 365 (18 planova, napredak,
današnje čitanje, filtri), pretraga (FTS5 offline + prepoznavanje kratica), oznake, postavke
(veličina slova, tema svijetla/sepia/tamna/sustav, Sync kod + PIN, spremljeni profili, odjava,
brisanje računa, adresa poslužitelja).

### Zamke otkrivene usput

- `fold_hr` (Python, gradi indeks) koristi **NFKD**, a `foldHr` u workeru i web klijentu **NFD**.
  Razlikuju se samo za ligature i superskripte (`ﬁ`, `²`); vektori takve slučajeve označavaju
  `nfkd_only`. Mobilni klijenti slijede NFKD jer foldaju upit nad istim indeksom.
- Web `parseBibleReference` ne prepoznaje `1Kor 13` bez razmaka (kratica je `1 Kor`). Vektori to
  zaključavaju kao postojeće ponašanje; promjena ide u sva tri klijenta i vektore odjednom.
- `biblija-mobile.db` (~20 MB) je gitignoreana; Xcode prebuild faza i Gradle `exportMobileDb` je
  osvježavaju iz `data/biblija.db` (treba `python3` i izgrađen `data/biblija.db`).
- Android kopira bazu iz `assets` u `filesDir` pri instalaciji/ažuriranju (`DatabaseInstaller`);
  BundledSQLiteDriver ne čita iz APK-a.
- Sync kod + PIN: iOS Keychain (`AfterFirstUnlockThisDeviceOnly`), Android AES-GCM ključ iz
  Keystorea, datoteka isključena iz backupa.
- Lokalni merge nakon synca: `LWW.merge(server: odgovor, client: trenutno lokalno)`, pa izmjene
  napravljene dok je zahtjev bio u letu ostaju i šalju se idućim syncom.
- Adresa poslužitelja: zadano `https://biblija.domovina.ai` (iOS `BiblijaSyncBaseURL` u `project.yml`,
  Android `syncBaseUrl` u `app/build.gradle.kts`, nadjačava `-PbiblijaSyncBaseUrl=…` ili
  `biblija.syncBaseUrl` u `local.properties`); korisnik je može promijeniti u Postavkama.

## 5. Prvo pokretanje na uređajima (2026-10-26)

Uređaji: iPhone SE 2nd, iPhone 12 mini (u devicectl „iPhone od: Anita", hardver `iPhone13,1`),
iPhone 15 Pro (Release build), motorola edge 30 ultra i moto g86 (Android 15/16, adb).

### Komande (bez simulatora/emulatora)

```bash
# iOS: build + potpis + instalacija; id za -destination daje `xcodebuild -showdestinations`,
# a za devicectl `xcrun devicectl list devices` (to su različiti identifikatori)
cd ios && xcodegen generate
xcodebuild -project Biblija.xcodeproj -scheme Biblija [-configuration Release] \
  -destination 'id=<xcodebuild id>' -allowProvisioningUpdates DEVELOPMENT_TEAM=6SCK58757K \
  -derivedDataPath build/dd build
xcrun devicectl device install app --device <devicectl id> build/dd/Build/Products/Debug-iphoneos/Biblija.app
xcrun devicectl device process launch --device <devicectl id> hr.stepanic.biblija365
# snimka zaslona (iOS 17+; idevicescreenshot ne radi bez DDI-ja, tunneld traži sudo)
pymobiledevice3 developer dvt screenshot --userspace --udid <xcodebuild id> out.png

# Android: oba uređaja, dodir i snimka preko adb
cd android && ./gradlew :app:assembleDebug
adb -s <serial> install -r app/build/outputs/apk/debug/app-debug.apk
adb -s <serial> shell svc power stayon usb      # inače zaključan ekran daje crne snimke
adb -s <serial> exec-out screencap -p > out.png
adb -s <serial> shell input tap X Y             # koordinate u pikselima uređaja
```

iPhone se s Maca može samo snimati, ne i dodirivati; iOS ekrane prolazi korisnik.

### Pronađeno i popravljeno (Android, b3c98b1)

| Simptom | Uzrok |
|---|---|
| Pad pri otvaranju Biblije 365 i pretrage (`ExceptionInInitializerError` u `HrFold`) | `Regex("(?U)\w+")`: JVM zna `(?U)`, Androidov ICU regex baca `PatternSyntaxException`. JVM testovi to ne mogu uhvatiti. Sad `[\p{L}\p{N}_]+`. |
| Svi retci podcrtani i obojeni kao linkovi | `LinkAnnotation.Clickable` bez `TextLinkStyles` dobije Material link stil |
| Tekst u sans-serifu | Motorola s font overlayem (`com.android.theme.font.RookeryRegular`) vraća sans za `FontFamily.Serif`; ugrađen Source Serif 4 (OFL, varijabilni `res/font`) |
| Ljubičasti sheetovi i dijalozi | M3 `surfaceContainerLow/High` nisu bili mapirani na paletu |

Na Androidu isprobano: čitač, oznaka bojom, Biblija 365 („Pročitano"), pretraga fraze, kratica
`Iv 3,16` → skok na redak, popis oznaka, postavke, sepia, tamna, „redak po redak".
iOS se pokreće na sva tri iPhonea i čitač izgleda ispravno (iOS 26 staklasti tab bar), ali ekrani
osim čitača i pretrage na iOS-u nisu prođeni. Sync nije isproban ni na jednoj platformi (nema
produkcijskog Workera).

Horizontalne trake (16ebd5a): bile su unutar paddinga roditelja i rezale se 16–20 dp od ruba.
Pravilo za oba klijenta: traka ide od ruba do ruba, margina je njezin `contentPadding` (Android
`Modifier.bleed` u `ui/Common.kt`); u karticama do ruba kartice, koja reže sadržaj svojim oblikom.
iOS: isto pravilo s `railBleed` (`App/Theme.swift`, `contentMargins` + negativni padding); filteri oznaka su u `safeAreaInset` iznad liste jer u insetGrouped retku ne mogu do ruba ekrana. Viđeno samo u čitaču (iPhone 15 Pro).

Sitnice uočene, nepopravljene: ispod gumba „Otvori Iv 3,16" piše „Pronađeno 0 pogodaka";
skok na redak ne ističe ciljni redak.

## 6. Otvoreno

1. Proći iOS ekrane (plan, pretraga, oznake, postavke) na uređaju.
2. Produkcijski Worker je na `https://biblija.domovina.ai` (2026-10-26). Android sync i brisanje
   računa isprobani na moto g86; iOS sync i sync s webom (isti kod na webu i uređaju) još nisu.
   Realtime (WebSocket `/api/live`, Durable Object `SyncRoom`) dodan na web, Android i iOS; na webu
   isproban u produkciji, na mobitelima samo buildan. Test: isti Sync kod na oba Androida, oznaka na
   jednom mora se pojaviti na drugom unutar sekunde bez povratka u aplikaciju.
3. Widget „današnje čitanje", lokalne notifikacije za plan, App Intents — još nisu rađeni.
4. Prava na tekst prije objave u storeovima; TestFlight / interno testiranje na Playu.
5. Prava ikona (trenutna je generirana: `scripts/gen_app_icon.py`, Android vektor u `res/drawable`).
