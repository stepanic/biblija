-- Dnevnik čitanja i linearni kursor (src/worker.ts: /api/sync polja `log`, `log_since`, `linear`)

-- Svaki posjet poglavlju: gdje (url + redak do kojeg se stiglo), kada (početak i kraj) i s kojeg uređaja.
-- LWW po (user_key, id); received_at je serversko vrijeme upisa, po njemu klijenti povlače samo novo.
CREATE TABLE IF NOT EXISTS sync_reading_log (
    user_key TEXT NOT NULL,
    id TEXT NOT NULL,
    url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    verse INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    linear INTEGER NOT NULL DEFAULT 0,
    device TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (user_key, id)
);
CREATE INDEX IF NOT EXISTS idx_sync_reading_log_received ON sync_reading_log(user_key, received_at);

-- Mjesto do kojeg je korisnik stigao čitajući redom. Skokovi na druga poglavlja ga ne mijenjaju.
CREATE TABLE IF NOT EXISTS sync_linear (
    user_key TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    verse INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);
