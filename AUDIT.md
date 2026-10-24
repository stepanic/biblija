# Audit & Diff Izvještaj: Kršćanska sadašnjost (Web `biblija.ks.hr` vs. Mobilni API `com.ebiblija`)

Ovaj dokument bilježi rezultate automatske provjere integriteta svih **73 knjiga**, **1.329 poglavlja** i **35.394 retka** Svetoga pisma u izdanju Kršćanske sadašnjosti (tekst *Zagrebačke / Jeruzalemske Biblije*, KS 2015., imprimatur HBK 560/2008).

Svi niže navedeni problemi su **automatski popravljeni** u našem determinističkom JSON katalogu (`data/json/`) i SQLite bazi (`data/biblija.db`).

---

## 1. Sažetak provjere

| Metrika | Stanje u KS sustavu | Stanje u `data/biblija.db` & `data/json/` |
| :--- | :--- | :--- |
| **Ukupno knjiga** | 73 | **73** |
| **Ukupno poglavlja (`1..N`)** | 1.328 (deklarirano 1.329 zbog greške u Izlasku) | **1.328** + **1** (*Proslov Knjige Sirahove*) = **1.329** |
| **Ukupno redaka (`bible_verse`)** | 35.394 (od čega 8 „siročadi" u Sirahu 0) | **35.394** (100% očuvano i povezano) |
| **Web vs. Mobilni API razlike u prikazu** | **428 redaka** | **0** (međunaslovi i paralele čisto odvojeni) |
| **Greške u KS planovima čitanja** | **27 knjiga** s preskočenim poglavljima | Dodana 3 kompletna **Biblija 365** plana (100% pokrivenost) |

---

## 2. Otkriveni tehnički bugovi u KS sustavu

### A. Skriveni i nedostupni „Proslov prevodiočev" u Knjizi Sirahovoj (`chapter_id = 871`)
* U tablici `bible_verse` postoji 8 redaka (ID `23140`–`23147`) koji pripadaju uvodnom **Proslovu prevodiočevu** u *Knjizi Sirahovoj* (`verse_book_id: 39`, `verse_chapter_id: 871`, `chapter_number: 0`).
* Međutim, poziv na standardni WordPress REST endpoint `/wp-json/wp/v2/bible_chapter/871` puca s praznim odgovorom (fatal error / neispravna serijalizacija `chapter_number = 0`), a na web sučelju `biblija.ks.hr` u izborniku poglavlja Knjige Sirahove nude se samo poglavlja `1..51`.
* **Rješenje kod nas:** Svih 8 redaka je spašeno i strukturirano kao uvodno poglavlje `0` (*Proslov*) u [`28_knjiga-sirahova.json`](file:///Users/ms/git/stepanic/biblija/data/json/books/28_knjiga-sirahova.json) i u `data/biblija.db`.

### B. Netočan `chapter_count: 41` za Knjigu Izlaska
* U `/wp-json/wp/v2/bible_book` za **Knjigu Izlaska** (`id=13`, `knjiga-izlaska`) zapisano je `"chapter_count": 41`, iako Knjiga Izlaska ima **40 poglavlja**.
* Otvaranje `/wp-json/bible/v1/chapter/knjiga-izlaska/41` vraća `HTTP 404 Not Found`, a na webu `?book=knjiga-izlaska&chapter=41` ispisuje `<p>Nema stihova za ovo poglavlje.</p>`.
* **Rješenje kod nas:** Ispravljeno na `chapter_count: 40` u [`books.json`](file:///Users/ms/git/stepanic/biblija/data/json/books.json).

### C. 428 redaka s različitim prikazom između Weba i Mobilnog API-ja
* U sirovoj WordPress tablici `bible_verse` međunaslovi (`<h2>`, `<h3>`, `<h4>`) i sinoptičke uputnice (`<span class='Izvor'>(Mt 3, 1–17...)</span>`) spremljeni su unutar polja `content.rendered` samog retka, pri čemu se oznaka broja retka `<sup style="color:#B8860B;">¹⁹</sup>` nalazi **između** naslova `<h4>` i uputnice `<span class='Izvor'>`.
* **Web (`biblija.ks.hr`)** pomoću PHP teme izvlači `<span class="Izvor">` iznad broja retka, dok **Mobilni API (`/wp-json/bible/v1/chapter/...`)** ostavlja broj retka prije uputnice.
* Ova razlika pogađa **428 redaka** (najviše u Evanđeljima: *Matej* 128, *Luka* 116, *Marko* 93, *Ivan* 29).
* **Rješenje kod nas:** Parser u [`scripts/build_catalog_and_db.py`](file:///Users/ms/git/stepanic/biblija/scripts/build_catalog_and_db.py) čisto izdvaja `headings` i `references` u zasebna JSON polja iznad samog teksta retka (`text`).

### D. Bug paginacije u WordPress REST API-ju i 27 oštećenih KS planova čitanja
* Svi retci i poglavlja u KS WordPress bazi uvezeni su u istoj sekundi (`2025-05-23T20:28:54`). Standardni poziv na `/wp-json/wp/v2/bible_chapter?per_page=100&page=1..14` bez parametra `&orderby=id&order=asc` koristi MySQL sortiranje po `post_date DESC`, koje zbog identičnih vremenskih oznaka između stranica vraća duplikate jednih i preskače druga poglavlja.
* Upravo zbog tog buga, službeni KS planovi čitanja (`/wp-json/kk/v1/reading-plans`) nenamjerno preskaču ključna poglavlja u čak **27 knjiga** — primjerice:
  * Plan *„Djela apostolska u 15 dana"* preskače **Dj 2** (Duhove!), **Dj 7** i **Dj 10**.
  * Plan *„Novi zavjet u 90 dana"* preskače **Mt 26** (Muku Isusovu!), **Mk 14**, **Lk 1**, **Iv 6** i **Iv 21**.
  * Plan *„Novozavjetne poslanice u 90 dana"* preskače **Heb 7, 10, 11, 12 i 13**.
