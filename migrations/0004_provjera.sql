-- Ručna provjera KS-online prema tisku (docs/2026-11-04-automatska-provjera-ks-teksta.md)
CREATE TABLE IF NOT EXISTS audit_findings (
    id TEXT PRIMARY KEY,                 -- sha1(layer|kind|ref|msg)[:12], stabilan između pokretanja
    ref TEXT NOT NULL,
    book_order INTEGER NOT NULL,
    chapter INTEGER NOT NULL,
    verse INTEGER,                       -- NULL za nalaz na razini poglavlja
    layer TEXT NOT NULL,
    kind TEXT NOT NULL,
    priority INTEGER NOT NULL,
    is_sample INTEGER NOT NULL DEFAULT 0, -- nasumični neoznačeni redak (procjena udjela grešaka)
    msg TEXT NOT NULL DEFAULT '',
    ks_text TEXT NOT NULL DEFAULT '',
    foi_text TEXT NOT NULL DEFAULT '',
    u68_text TEXT NOT NULL DEFAULT '',
    extra_json TEXT NOT NULL DEFAULT '{}',
    in_errata INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,   -- 0 kad ga novo pokretanje skripte više ne prijavljuje
    status TEXT NOT NULL DEFAULT 'otvoreno', -- otvoreno | ceka_drugog | neslaganje | rijeseno
    consensus TEXT NOT NULL DEFAULT '',  -- presuda kad je status rijeseno
    review_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_findings_queue ON audit_findings(active, priority, book_order, chapter);

CREATE TABLE IF NOT EXISTS audit_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    finding_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    verdict TEXT NOT NULL,               -- tisak_kao_online | tisak_drukcije | nije_greska | ne_mogu
    print_text TEXT NOT NULL DEFAULT '',
    edition TEXT NOT NULL DEFAULT '',
    page TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    photo_key TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (finding_id, user_key),
    FOREIGN KEY (finding_id) REFERENCES audit_findings(id)
);
CREATE INDEX IF NOT EXISTS idx_audit_reviews_finding ON audit_reviews(finding_id);
