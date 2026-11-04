# Automatska provjera KS teksta prema tisku (2026-11-04)

## Cilj

Zagrebačka Biblija (Kršćanska sadašnjost, u vlasništvu Zagrebačke nadbiskupije) jedini je
prijevod odobren za liturgiju u Hrvatskoj. Online izdanje na `biblija.ks.hr` mjestimično se
razlikuje od tiskanog. Cilj je složiti popis neusklađenosti i besplatno ga predati KS-u, kako bi
online izdanje postalo identično tiskanom.

Najjednostavnije rješenje bio bi PDF iz kojeg se tiska. S njim bi se usporedba svela na jedan diff.
Dok njega nemamo, primjenjuje se postupak opisan niže.

## Zašto glasanje izvora nije dovoljno

Trosmjerna usporedba iz listopada (`scripts/foi_vote.py`) usporedila je tekst triju
digitalizacija: `biblija.ks.hr`, FOI 74 i `hrv_usfm` (1968.). Job 24–27 nije uhvatila,
jer sva tri izvora potječu od istog sloga i jednako numeriraju premještene retke. Glasanjem se
ne može otkriti greška koju svi izvori dijele, pa je potrebna i provjera prema neovisnoj
numeraciji (Šarić, BSB).

## Slojevi (`scripts/audit_tekst.py`)

Skripta se izvrti za oko 4 sekunde. Ne koristi LLM ni mrežu. Rezultat zapisuje u
`data/audit/sumnjivi.json` (svi nalazi s tekstom i razlikom) i `data/audit/SAZETAK.md`.

| Sloj | Što hvata | Kako |
|---|---|---|
| struktura | izgubljeni redci, spojeni redci, prazni redci, duplikati | skup brojeva redaka po poglavlju uspoređuje se s U68, Šarićem i BSB-om; potrebna su bar dva od tri izvora |
| poravnanje | redak pod krivim brojem (Job 26,5 = 27,5) | rapidfuzz: ako tekst KS retka bolje odgovara drugom retku iste knjige u U68 nego retku s istim brojem |
| tekst | tipfeleri, ispali dijelovi, zalijepljeni naslovi | FOI i U68 kao dva neovisna prijepisa; najjači signal je kad se oni slažu, a KS se razlikuje |
| tipografija | `?` u riječi, ponovljena riječ, neupareni »«, razmaci | regularni izrazi |
| paralele | mala razlika između dva ista odlomka | Ps 14/53, 40/70, 57+60/108, 2 Sam 22/Ps 18, 2 Kr 18–19/Iz 36–37, Ezr 2/Neh 7 … |

Filtri protiv lažnih uzbuna:
- **Pomak numeracije:** pomak unutar istog poglavlja za stalni iznos (npr. natpisi psalama, različito izdanje) dobiva prioritet 3.
- **Tekstnokritički izostavljeni redci:** retke koje NA28 izostavlja (Mt 17,21, Mk 9,44 …) ne dobivaju prioritet 1.
- **Akrostih:** imena hebrejskih slova (Tuž, Nah, Ps 111) kojih FOI nema ne računaju se kao greška.
- **Naglasci:** FOI naglašena slova zamjenjuje s `?`, pa se `?` tretira kao zamjensko slovo. Ta su mjesta ipak zabilježena na prioritetu 3, jer tisak vjerojatno ima naglasak (npr. „Tâ”) koji KS-online nema.

## Prvi rezultat (649 nalaza)

Prioritet 1: 53 nalaza, gotovo sve stvarne greške online izdanja:

- **Job 24–27:** premješteni redci (24,18–24 iza 27,23; 26,5–14 iza 25,6; 27,5–23 iza 26,4) označeni su brojem poglavlja u kojem stoje, a ne onog iz kojeg potječu. Job 25,5–6 nedostaju.
- **Redci spojeni u prethodni (izgubljen broj retka):** Post 47,5–6 (u 47,4), Post 47,13 (u 47,12), Izl 36,38 (u 36,37), Br 6,27 (u 6,26), Zah 4,10 (pa 4,9 i 4,14).
- **Naslov zalijepljen za redak:** 2 Sam 8,18 („A. MERIBAAL”), Job 31,37 („Konac riječi Jobovih”).
- **Tipfeleri:** 1 Ljet 7,1 (zalutalo „y”), Izr 28,7 („izjelicama” prema „izbjeglicama”), Mt 27,12 („optuživali” prema „optuživale”).
- 1 Kr 15,6: redak nema ni U68. Vjerojatno se ni u tisku ne tiska (isti je kao 14,30), pa ga treba provjeriti.

Prioritet 2 (370): uglavnom razlike KS-online prema FOI, gdje je U68 starije izdanje, te neupareni navodnici. Ovdje je dio razlika revizija teksta između izdanja, a ne greška.

Prioritet 3 (226): naglasci, pomaci numeracije, paralele, sitna tipografija.

Svaki nalaz ima `in_errata` (je li već u `data/errata.json`). Errata iz listopada (33) su u
`data/json/` već primijenjena, pa ih ova provjera ne vidi ponovno. U izvještaj za KS idu i one.

## Koliko smo sigurni

Bez tiskanog izdanja ne možemo tvrditi da je tekst identičan tisku. Možemo tvrditi:

1. Svaki nalaz s popisa ručno je provjeren prema tisku.
2. Na nasumičnom uzorku od N redaka koje skripta nije označila nađeno je k grešaka. Za k = 0 i
   N = 300 pravilo trojke daje gornju granicu udjela grešaka 1 % (95 % pouzdanosti), za N = 1.000
   granica je 0,3 %.

Prije uzorka treba utvrditi točno izdanje tiska (godina, ISBN). `AUDIT.md` navodi KS 2015.
(imprimatur HBK 560/2008).

## Sljedeći koraci

- **Fotografija s OCR-om:** fotografija tiskane stranice ide kroz Gemini (`agy`, bez Claude kvote) i automatski se uspoređuje s KS-online. Fotografiraju se samo poglavlja s nalazima i nasumični uzorak.
- **Web aplikacija za ručnu provjeru:** u nastavku.
- **Poravnanje sa Šarićem i BSB-om po značenju:** višejezični embedding (lokalni model) za mjesta gdje U68 nema usporedni redak.

## Web aplikacija za ručnu provjeru (prijedlog)

Ovaj problem drugdje je već riješen. Modeli od kojih vrijedi preuzeti rješenja:

- **Wikisource ProofreadPage:** sken stranice lijevo, tekst desno. Stranica je „provjerena” kad je potvrdi jedan korisnik, a „validirana” kad je potvrdi drugi, neovisni korisnik. To je točno naš slučaj.
- **Distributed Proofreaders (Project Gutenberg):** više uzastopnih krugova volontera nad istom stranicom; tako su prošle desetke tisuća knjiga.
- **Paratext (UBS/SIL) i Scripture Forge:** standard za biblijske tekstove. Provjere (chapter/verse, oznake, navodnici, ponovljene riječi, paralelni odlomci) odgovaraju našim slojevima.
- **Zooniverse, FromThePage, Transkribus:** crowdsourcing transkripcije s konsenzusom više korisnika.

Na našem stogu (Cloudflare Workers + D1 + R2, postojeća prijava Sync kod + PIN):

```
findings(id, ref, layer, kind, priority, ks_text, foi_text, u68_text, diff_json)  ← uvoz sumnjivi.json
reviews(id, finding_id, user_id, verdict, print_text, edition, page, photo_key, note, created_at)
  verdict: tisak_kao_online | tisak_drukcije | nije_greska | ne_mogu_provjeriti
sample(id, ref)   ← nasumični redci za procjenu udjela grešaka (miješaju se s nalazima)
```

Tijek rada:
1. Korisnik dobije sljedeći nalaz iz reda (najprije prioritet 1).
2. Vidi tekst KS-online, FOI i U68, s istaknutom razlikom.
3. Fotografira stranicu iz tiskanog izdanja mobitelom. Fotografija ide u R2, OCR unaprijed ispuni tekst iz tiska, a korisnik upiše presudu.
4. Provjera je naslijepa: tuđe presude ne vide se dok ne pošalješ svoju.
5. Dvije neovisne istovjetne presude znače da je nalaz potvrđen. Ako se presude razlikuju, nalaz ide trećoj osobi.
6. Nasumični redci iz uzorka izgledaju kao obični nalazi. Iz njih se računa udio grešaka koje skripta ne vidi, i to je tvrdnja o točnosti koju možemo dati KS-u.
7. Izvoz za KS: CSV i PDF, za svaki redak ref, tekst online, tekst u tisku, stranicu tiska i fotografiju.
