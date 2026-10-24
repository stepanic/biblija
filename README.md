# 📖 Biblija 365 — Deterministički Katalog, SQLite (FTS5) Baza & Offline Web Aplikacija

[![License: MIT](https://img.shields.io/badge/License-MIT-amber.svg)](LICENSE)
[![Framework: Astro 5 SSG](https://img.shields.io/badge/Astro_5-1.334_stati%C4%8Dke_stranice-ff5d01.svg)](astro.config.mjs)
[![Deploy: Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers_Static_Assets-f38020.svg)](wrangler.jsonc)
[![Kanon: Katolički (73 knjige)](https://img.shields.io/badge/Kanon-73_knjige_(SZ_%2B_NZ)-brown.svg)](data/json/books.json)
[![SQLite: FTS5](https://img.shields.io/badge/SQLite-FTS5_Full--Text_Search-green.svg)](data/biblija.db)

Čista, brza i **100% offline** **Astro SSG** web aplikacija spremna za **Cloudflare Workers Static Assets**, deterministički JSON katalog i **SQLite (FTS5)** baza podataka cjelovitog hrvatskog katoličkog prijevoda **Svetoga pisma Staroga i Novoga zavjeta** (*Zagrebačka / Jeruzalemska Biblija*), s ugrađenim **Biblija kroz 365 dana** planovima čitanja.

---

## ✨ Ključne značajke

* **📚 Cjeloviti katolički kanon (73 knjige, 1.329 poglavlja, 35.410 redaka):**
  * Uključuje sve protokanonske i deuterokanonske knjige Staroga zavjeta (46) i Novoga zavjeta (27), s međunarodnim **USFM kodovima** (`GEN`…`REV`), engleskim nazivima, oznakama deuterokanonskih knjiga/dodataka i oznakama početka odlomka (`p: true`).
  * Strogo deterministički i očišćeni JSON katalog ([`data/json/`](data/json/)) u kojem su međunaslovi (`h2`, `h3`, `h4`), sinoptičke uputnice (`(Mt 3, 1–17...)`) i poetski prijelomi stihova (`lines` za Psalme i mudrosne knjige) čisto strukturirani i odvojeni od samog teksta retka.
* **🗓️ Program „Biblija kroz 365 dana" (6 cjelovitih godišnjih planova + 12 tematskih planova):**
  * Ugrađena su sva tri službena plana inicijative **[Muževni budite — Biblija kroz 365 dana](https://muzevnibudite.com/1163/biblija_kroz_365_dana)**:
    1. **Tematski plan (*Velika avantura s Biblijom / Bible in a Year* — Jeff Cavins & o. Mike Schmitz)** — 365 dana kroz 12 razdoblja povijesti spasenja (`mb-tematski-365`).
    2. **Usporedni plan (*Muževni budite*)** — 365 dana, svakodnevno kombinira Stari zavjet, Psalme/Mudrosne knjige i Novi zavjet (`mb-usporedni-365`).
    3. **Linearni plan (*Muževni budite*)** — čitanje od korica do korica, od *Knjige Postanka* do *Otkrivenja* (`mb-linearni-365`).
  * Dodana su i 3 algoritamski balansirana 365-dnevna plana (*Višetračni*, *Kanonski po broju redaka*, *Kronološki*) te 12 kraćih tematskih planova (15–90 dana).
* **⚡ Trenutni Offline Pretraživač (SQLite FTS5 + Statički JSON fallback):**
  * Pretraživanje svih **35.410 redaka** u `< 15 ms` — podržava upite **sa i bez hrvatskih dijakritičkih znakova** (`blazenstva` ili `blaženstva`, `pocetku` ili `početku`), točne fraze pod navodnicima (`"duh Božji"`) te filtriranje po zavjetu i knjizi.
  * **Pametni parser biblijskih kratica:** Upiši npr. `Iv 1,19`, `Ps 23`, `Post 1,1-5` ili `1 Kor 13` za trenutni skok na traženo poglavlje i redak.
* **☁️ Višekorisnička sinkronizacija na više uređaja (Cloudflare D1 / SQLite Sync):**
  * Podržava neograničen broj korisnika (**SaaS mod**) koji čitaju na više uređaja (mobitel, tablet, laptop) bez potrebe za registracijom e-mailom:
  * Klikom na **☁️ Sinkronizacija** u zaglavlju korisnik bira ili generira svoj **Sync kod (korisničko ime)** i **PIN** (SHA-256 hashiran).
  * Korištenjem *Last-Write-Wins (LWW)* algoritma s vremenskim oznakama (`updated_at`), automatski se spajaju i sinkroniziraju:
    1. Pročitani dani u bilo kojem od 18 planova čitanja (`sync_progress`),
    2. Aktivni plan i zadnje otvoreno poglavlje (*Nastavi čitanje*, `sync_users`),
    3. Osobne oznake u boji i bilješke uz retke (`sync_bookmarks`).
* **🔍 Provjera integriteta i rekonstrukcija oštećenih stihova ([`AUDIT.md`](AUDIT.md) & [`data/errata.json`](data/errata.json)):**
  * Automatskim diff checkom između web sučelja `biblija.ks.hr`, mobilnog REST API-ja i neovisnog USFM/CrossWire prijepisa otkriveno je i u ovom katalogu **ispravljeno**:
    * **Rekonstruirano 26 oštećenih ili izgubljenih stihova u bazi `biblija.ks.hr` ([`data/errata.json`](data/errata.json)):** vraćen pregaženi uvodni stih Poslanice Titu (`Tit 1,1–2`) i izdvojeni međunaslovi u `Tit 1,5` i `1,10`, vraćeno **10 odrezanih stihova na kraju 3. poglavlja Daniela (`Dn 3,91–100`)**, te vraćeni prazni i ispali stihovi u Knjizi o Jobu (`Job 25,1–4` i `Job 27,1–4`).
    * **Spašeno skriveno poglavlje *Knjige Sirahove* (`Poglavlje 0 — Proslov prevodiočev`, 8 redaka, ID `871`)** na kojem službeni `/wp/v2/bible_chapter/871` endpoint puca, a web izbornik ga ne prikazuje.
    * **428 redaka** u kojima mobilni API umeće broj retka prije sinoptičke uputnice (`<span class="Izvor">`), dok ga web prikaz stavlja nakon uputnice (npr. *Iv 1,19*).
    * Ispravljen netočan metapodatak `chapter_count: 41` za *Knjigu Izlaska* (stvarnih **40** poglavlja) i nerazriješeni HTML entiteti u naslovu *Poslanice Kološanima*.

---

## 🚀 Brzo pokretanje i Cloudflare Deploy

### Opcija 1: Astro + Cloudflare Workers Static Assets
```bash
git clone https://github.com/stepanic/biblija.git
cd biblija
npm install

# Lokalni Astro dev server
npm run dev

# Statički build svih 1.334 stranica (u ./dist za ~1.8s)
npm run build

# Lokalni Cloudflare Workers preview
npm run preview

# Deploy na Cloudflare Workers Static Assets (+ opcionalni D1 multi-device sync)
npx wrangler d1 create biblija-365-db
npx wrangler d1 migrations apply biblija-365-db --remote
npm run deploy
```
> Pri `npm run build`, Astro unaprijed generira **1.334 statičke HTML stranice** (svih 1.329 poglavlja na čistim URL-ovima poput `/evandelje-po-ivanu/1/`, `/psalmi/23/`, `/knjiga-sirahova/0/` s OpenGraph opisima + `/plan/`, `/pretraga/`, `/oznake/`), dok [`src/worker.ts`](src/worker.ts) obrađuje `/api/auth` i `/api/sync` nad Cloudflare D1 bazom ([`migrations/0001_sync.sql`](migrations/0001_sync.sql)).

### Opcija 2: Lokalni Python + SQLite FTS5 server (bez Node.js-a)
```bash
python3 server.py --port 8088
```
Otvori **`http://127.0.0.1:8088`** u pregledniku.
> Poslužuje izgrađeni `dist/` direktorij (ili korijenski SPA fallback) uz izravni **SQLite FTS5** API (`/api/search`) nad [`data/biblija.db`](data/biblija.db).

---

## 🗂️ Struktura podataka (`data/`)

### 1. SQLite baza podataka (`data/biblija.db`)
Spremna za izravno korištenje iz bilo kojeg programskog jezika ili alata:
* `books` — 73 knjige (`book_order`, `id`, `abbr`, `title`, `testament`, `category`, `chapter_count`, `verse_count`)
* `chapters` — 1.329 poglavlja (`book_order`, `chapter`, `verse_count`)
* `verses` — 35.394 retka (`book_order`, `book_abbr`, `chapter`, `verse`, `text`, `text_folded`, `headings_json`, `references_json`, `lines_json`)
* `verses_fts` — **FTS5 virtualna tablica** (`unicode61 remove_diacritics 2`)
* `reading_plans` & `reading_plan_days` — 18 planova čitanja
* `user_progress` & `user_bookmarks` — tablice za lokalno praćenje napretka i bilješki

Primjer izravnog SQLite FTS5 upita iz terminala:
```bash
sqlite3 data/biblija.db "SELECT book_abbr || ' ' || chapter || ',' || verse, text FROM verses_fts JOIN verses ON verses.id = verses_fts.rowid WHERE verses_fts MATCH 'blazenstva' LIMIT 5;"
```

### 2. Deterministički JSON katalog (`data/json/`)
* [`data/json/books.json`](data/json/books.json) — popis svih 73 knjiga katoličkog kanona.
* [`data/json/books/`](data/json/books/) — 73 pojedinačne JSON datoteke (`01_knjiga-postanka.json` … `73_otkrivenje.json`).
* [`data/json/plans/`](data/json/plans/) — JSON definicije svih 365-dnevnih i tematskih planova čitanja.
* [`data/json/verses_compact.json`](data/json/verses_compact.json) — kompaktni indeks svih 35.394 redaka za trenutnu klijentsku pretragu u statičkom načinu rada.

---

## 📜 Izvor teksta i licenca

* **Softver, skripte i arhitektura baze:** Objavljeno pod **[MIT licencom](LICENSE)**.
* **Biblijski tekst:** *Sveto pismo Staroga i Novoga zavjeta*, Kršćanska sadašnjost, Zagreb, 2015. (Glavni urednici: Jure Kaštelan, Bonaventura Duda; Urednici: Josip Tabak, Jerko Fućak; Imprimatur HBK br. 560/2008). Autorska prava na prijevod pripadaju nakladničkoj kući *Kršćanska sadašnjost d.o.o.*
* **Planovi čitanja „Biblija kroz 365 dana":** Preuzeti i prilagođeni prema planovima portala [Muževni budite](https://muzevnibudite.com/1163/biblija_kroz_365_dana) (*Linearni*, *Usporedni* i *Tematski / Ascension — Velika avantura s Biblijom*).
