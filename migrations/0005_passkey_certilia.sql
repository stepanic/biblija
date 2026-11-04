-- Pristupni ključevi (passkey) kao glavni način sinkronizacije i Login with Certilia za
-- presude na /provjera/. Sync kod + PIN ostaje kao stari način (mobilne aplikacije).
-- Vidi docs/2026-11-04-passkey-i-certilia.md.

-- Certilia potvrđuje osobu jednom, uz profil. OIB se ne sprema, samo HMAC(oib, SESSION_SECRET).
ALTER TABLE sync_users ADD COLUMN oib_hash TEXT;
ALTER TABLE sync_users ADD COLUMN certilia_ime TEXT;
ALTER TABLE sync_users ADD COLUMN certilia_prezime TEXT;
ALTER TABLE sync_users ADD COLUMN certilia_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_users_oib ON sync_users(oib_hash) WHERE oib_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY,                -- credential ID, base64url
    user_key TEXT NOT NULL REFERENCES sync_users(user_key) ON DELETE CASCADE,
    public_key TEXT NOT NULL,           -- COSE, base64url; privatni ključ ne napušta uređaj
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_key);

-- WebAuthn izazovi: jednokratni, 5 min. Kod upisa novog profila čuva i ime profila.
CREATE TABLE IF NOT EXISTS passkey_challenges (
    challenge TEXT PRIMARY KEY,
    purpose TEXT NOT NULL,              -- 'login' | 'register'
    user_key TEXT,                      -- postojeći profil kojem se dodaje ključ, ili NULL za novi
    display_name TEXT,
    expires INTEGER NOT NULL            -- epoch ms
);

-- Stanje OIDC toka prema Certiliji: ključ je sha256(state), jednokratno, 10 min.
CREATE TABLE IF NOT EXISTS oidc_flows (
    state_hash TEXT PRIMARY KEY,
    code_verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    user_key TEXT NOT NULL,
    back TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Revizija prijava: imena claimova bez vrijednosti, OIB samo kao otisak.
CREATE TABLE IF NOT EXISTS auth_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    kind TEXT NOT NULL,                 -- passkey_login | passkey_register | certilia | ...
    ok INTEGER NOT NULL,
    user_key TEXT,
    oib_hash TEXT,
    claims TEXT,
    error TEXT
);

-- Presude su od 2026-11-04 vezane uz osobu potvrđenu Certilijom, ne uz Sync kod.
-- Tablica je bila prazna (provjereno na produkciji prije migracije), pa se ponovno stvara.
DROP TABLE IF EXISTS audit_reviews;
CREATE TABLE audit_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    finding_id TEXT NOT NULL,
    reviewer TEXT NOT NULL,              -- oib_hash osobe (Certilia)
    reviewer_name TEXT NOT NULL,         -- ime i prezime iz Certilije u trenutku presude
    user_key TEXT NOT NULL,              -- profil s kojeg je presuda poslana
    verdict TEXT NOT NULL,               -- tisak_kao_online | tisak_drukcije | ne_mogu
    print_text TEXT NOT NULL DEFAULT '',
    edition TEXT NOT NULL DEFAULT '',
    page TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    photo_key TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (finding_id, reviewer),
    FOREIGN KEY (finding_id) REFERENCES audit_findings(id)
);
CREATE INDEX IF NOT EXISTS idx_audit_reviews_finding ON audit_reviews(finding_id);
