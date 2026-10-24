# Audit & Diff Izvještaj: Kršćanska sadašnjost (`biblija.ks.hr` / `com.ebiblija`) + Unakrsna provjera s `eBible` / `CrossWire`

Ovaj dokument bilježi rezultate automatske provjere integriteta svih **73 knjiga**, **1.329 poglavlja** i **35.410 redaka** Svetoga pisma u izdanju Kršćanske sadašnjosti (tekst *Zagrebačke / Jeruzalemske Biblije*, KS 2015., imprimatur HBK 560/2008), uključujući unakrsnu stih-po-stih usporedbu s neovisnim USFM/CrossWire prijepisom.

Svi niže navedeni problemi su **automatski popravljeni i rekonstruirani** u našem determinističkom JSON katalogu ([`data/json/`](data/json/), [`data/errata.json`](data/errata.json)) i SQLite bazi ([`data/biblija.db`](data/biblija.db)).

---

## 1. Sažetak provjere

| Metrika | Stanje u sirovom KS sustavu (`biblija.ks.hr`) | Stanje u `data/biblija.db` & `data/json/` |
| :--- | :--- | :--- |
| **Ukupno knjiga** | 73 | **73** (s USFM kodovima `GEN`…`REV` i `deuterocanonical` oznakama) |
| **Ukupno poglavlja (`0..N`)** | 1.328 (deklarirano 1.329 zbog greške u Izlasku; Sirah 0 skriven) | **1.328** + **1** (*Proslov Knjige Sirahove*) = **1.329** |
| **Ukupno redaka (`bible_verse`)** | 35.394 (nedostaje `Dn 3,91–100`, `Job 25,2–4`, `Job 27,2–4`; `Tit 1,1` pregažen) | **35.410** (svi izgubljeni i oštećeni stihovi rekonstruirani u [`data/errata.json`](data/errata.json)) |
| **Web vs. Mobilni API razlike u prikazu** | **428 redaka** | **0** (međunaslovi i paralele čisto odvojeni) |
| **Rekonstruirani oštećeni stihovi (`errata.json`)** | **26 stihova** s oštećenim/izgubljenim tekstom u KS bazi | **26 popravljenih stihova** |
| **Greške u KS planovima čitanja** | **27 knjiga** s preskočenim poglavljima | Dodana 3 službena **Muževni budite — Biblija 365** plana + 3 algoritamska 365 plana |

---

## 2. Otkriveni i rekonstruirani oštećeni stihovi u službenoj bazi `biblija.ks.hr` ([`data/errata.json`](data/errata.json))

Unakrsnom usporedbom sirove WordPress baze `biblija.ks.hr` s neovisnim prijepisom *Zagrebačke Biblije* otkriveno je i popravljeno **26 oštećenih ili izgubljenih stihova**:

### A. Izgubljen uvodni stih Poslanice Titu (`Tit 1,1–2`) i zalijepljeni međunaslovi (`Tit 1,5` i `Tit 1,10`)
* Na `biblija.ks.hr` (WordPress `chapter_id = 1416`, `post_id = 37149`) pod **`Tit 1,1`** stoji samo:
  > `¹ On koji ne laže,`
* Pri unosu u WordPress, cijeli uvodni apostolski pozdrav 1. stiha slučajno je pregažen završnim riječima 2. stiha (`"On koji ne laže,"`).
* Dodatno, u **`Tit 1,5`** i **`Tit 1,10`** zaboravljene su HTML oznake `<h4>`, pa su međunaslovi zalijepljeni izravno na početak biblijskog stiha (`"Postavljanje starješina Poradi toga ostavih te..."` i `"Borba protiv krivih učitelja Jer mnogi su..."`).
* **Rješenje kod nas:** U [`63_poslanica-titu.json`](data/json/books/63_poslanica-titu.json) vraćen je puni tekst `Tit 1,1` (*„Pavao, sluga Božji i apostol Isusa Krista poradi vjere izabranika Božjih i spoznanja istine usmjerene k pobožnosti"*), dopunjen `Tit 1,2`, te izdvojeni `<h4>` međunaslovi u `Tit 1,5` i `Tit 1,10`.

### B. Odrezan završetak 3. poglavlja Knjige o Danielu (`Dn 3,91–100`)
* Na `biblija.ks.hr` 3. poglavlje Knjige o Danielu završava na **90. stihu** (`Dn 3,90`, svršetak hvalospjeva trojice mladića u užarenoj peći).
* Cijeli završetak 3. poglavlja — **10 stihova (`Dn 3,91–100`)** u kojima kralj Nabukodonozor vidi četvrtog čovjeka u vatri, poziva Šadraka, Mešaka i Abed Nega da izađu iz peći i blagoslivlja Boga Svevišnjega — ispao je pri KS-ovom uvozu u bazu!
* **Rješenje kod nas:** Svih 10 stihova (`Dn 3,91–100`) zajedno s pripadajućim međunaslovima rekonstruirano je u [`34_daniel.json`](data/json/books/34_daniel.json).

### C. Prazni i ispali stihovi u Knjizi o Jobu (`Job 25,1–4` i `Job 27,1–4`)
* U *Jeruzalemskoj Bibliji* treći krug govora u Knjizi o Jobu (poglavlja 24–27) tiskan je s kritičkim premještanjem redaka (`26,5–14` unutar 25. poglavlja, `27,5–23` unutar 26. poglavlja, te `24,18–24` unutar 27. poglavlja).
* Pri uvozu u WordPress po broju poglavlja na `biblija.ks.hr`:
  * Stihovi **`Job 25,1`** (`id = 18442`) i **`Job 27,1`** (`id = 18476`) ostali su **potpuno prazni** (`<sup ...>¹</sup>&nbsp; ` bez ikakvog teksta!).
  * Stihovi **`Job 25,2–4`** (početak Bildadova govora) i **`Job 27,2–4`** (početak Jobove besjede) potpuno su ispali iz baze.
* **Rješenje kod nas:** U [`22_knjiga-o-jobu.json`](data/json/books/22_knjiga-o-jobu.json) rekonstruirani su tekstovi `Job 25,1–4` i `Job 27,1–4`.

### D. Zaostali OCR znakovi (`?`) i tipfeleri u `biblija.ks.hr`
* U `Job 19,1` (`"?Job progovori i reče:"`), `Job 29,1` (`"?Job nastavi svoju besjedu i reče:"`) i `Iz 10,1` (`"?Jao onima koji izdaju odredbe nepravedne..."`) na početku retka stajao je zaostali znak `?`, a u grčkom dodatku `Est 1,1` spojena riječ `"spremi sena propast"`. Sve je očišćeno.

---

## 3. Ostali tehnički bugovi u KS sustavu (Web vs. Mobilni API)

### A. Skriveni i nedostupni „Proslov prevodiočev" u Knjizi Sirahovoj (`chapter_id = 871`)
* U tablici `bible_verse` postoji 8 redaka (ID `23140`–`23147`) koji pripadaju uvodnom **Proslovu prevodiočevu** u *Knjizi Sirahovoj* (`verse_book_id: 39`, `verse_chapter_id: 871`, `chapter_number: 0`).
* Poziv na `/wp-json/wp/v2/bible_chapter/871` puca s praznim odgovorom, a na web sučelju `biblija.ks.hr` u izborniku poglavlja Knjige Sirahove nude se samo poglavlja `1..51`.
* **Rješenje kod nas:** Svih 8 redaka spašeno je kao uvodno poglavlje `0` (*Proslov*) u [`28_knjiga-sirahova.json`](data/json/books/28_knjiga-sirahova.json).

### B. Netočan `chapter_count: 41` za Knjigu Izlaska
* U `/wp-json/wp/v2/bible_book` za **Knjigu Izlaska** (`id=13`, `knjiga-izlaska`) zapisano je `"chapter_count": 41`, iako Knjiga Izlaska ima **40 poglavlja** (otvaranje 41. poglavlja vraća 404). Ispravljeno na `40`.

### C. 428 redaka s različitim prikazom između Weba i Mobilnog API-ja
* U sirovoj WordPress tablici `bible_verse` međunaslovi (`<h2>`, `<h3>`, `<h4>`) i sinoptičke uputnice (`<span class='Izvor'>(Mt 3, 1–17...)</span>`) spremljeni su unutar polja `content.rendered`, pri čemu se oznaka broja retka `<sup>` nalazi **između** naslova i uputnice.
* **Web (`biblija.ks.hr`)** izvlači `<span class="Izvor">` iznad broja retka, dok **Mobilni API (`/wp-json/bible/v1/chapter/...`)** ostavlja broj retka prije uputnice u **428 redaka**.
* **Rješenje kod nas:** Parser u [`scripts/build_catalog_and_db.py`](scripts/build_catalog_and_db.py) čisto izdvaja `headings` i `references` u zasebna JSON polja.

### D. Bug paginacije u WordPress REST API-ju i 27 oštećenih KS planova čitanja
* Svi retci i poglavlja u KS WordPress bazi uvezeni su s identičnim timestampom (`2025-05-23T20:28:54`). Zbog paginacije bez `orderby=id`, službeni KS planovi čitanja (`/wp-json/kk/v1/reading-plans`) preskaču ključna poglavlja u **27 knjiga** (npr. *Dj 2*, *Mt 26*, *Mk 14*, *Lk 1*, *Iv 6*).

---

## 4. Nalaz o podrijetlu `eBible.org (hrv_usfm)` i `CrossWire SWORD (CroSaric)` izvora

Tijekom unakrsne provjere s otvoreno dostupnim repozitorijima `eBible.org (hrv_usfm.zip)` i `CrossWire / scrollmapper (CroSaric.json)` — koji su u međunarodnim biblijskim bazama desetljećima označeni kao **„prijevod Ivana Ev. Šarića (1941./42.)"** — dokazano je da **ti izvori uopće ne sadrže Šarićev prijevod, nego stariju digitalizaciju *Zagrebačke Biblije (Kršćanska sadašnjost, 1968.)***:

1. **Božje ime `Jahve`:** U tim se datotekama tisućama puta koristi Božje ime **`Jahve`** (npr. *Ps 23,1*: *„Jahve je pastir moj"*), dok Ivan Ev. Šarić u svim izdanjima svog prijevoda dosljedno koristi *Gospod* ili *Gospodin*.
2. **Doslovno poklapanje s prijevodom Dude i Fućka / Kaštelana i Dude:** U 57 od 73 knjige uvodni stihovi se od riječi do riječi (100%) poklapaju s tekstom *Zagrebačke Biblije* (npr. *Iv 1,1*: *„U početku bijaše Riječ i Riječ bijaše u Boga i Riječ bijaše Bog"*).
3. **Tragovi starog scrapea iz *The Unbound Bible* i oštećenja u `eBible` izvoru:**
   * Na kraju *Druge knjige o Makabejcima* (`2 Mak 15,39`) u `eBible` i `CrossWire` datotekama ostao je čak i zalijepljen zaglavni komentar susjedne datoteke iz *The Unbound Bible* projekta:
     `#THE UNBOUND BIBLE (www.unboundbible.org) #name Ukrainian: NT (P.Kulish, 1871) #filetype Unmapped-BCVS...`
   * U `eBible / CroSaric` verziji niz je stihova odrezan napola (`Post 47,4`, `Post 47,12`, `Izl 36,37`, `1 Sam 2,22`, a u `Jr 25,2` stoji samo jedna riječ: `"Prorok"`) ili sadrži oštećene znakove kodiranja (`ÓodbÄaci` u `Ps 60,2`, `Ę` u `1 Mak 2,70; 9,22; 12,53`, `#` umjesto teksta u `Sir 1,5` i `1,7`).
   * Naša baza u `data/biblija.db` i `data/json/` čuva potpuni, neoštećeni tekst iz primarne baze KS-a, uz dopunu 26 stihova iz [`data/errata.json`](data/errata.json) gdje je primarna KS baza imala propust pri unosu.
