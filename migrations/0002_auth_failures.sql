-- Ograničenje pokušaja PIN-a po Sync kodu (src/worker.ts: MAX_PIN_FAILURES, PIN_LOCK_MS)
CREATE TABLE IF NOT EXISTS sync_auth_failures (
    user_key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0,
    window_start TEXT NOT NULL,
    locked_until TEXT
);
