-- Cloudflare D1 / SQLite Multi-User & Multi-Device Sync Schema
CREATE TABLE IF NOT EXISTS sync_users (
    user_key TEXT PRIMARY KEY,
    pin_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    active_plan_id TEXT NOT NULL DEFAULT 'mb-tematski-365',
    last_url TEXT NOT NULL DEFAULT '/',
    last_label TEXT NOT NULL DEFAULT '',
    last_updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_progress (
    user_key TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    day INTEGER NOT NULL,
    completed INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_key, plan_id, day),
    FOREIGN KEY (user_key) REFERENCES sync_users(user_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_progress_user ON sync_progress(user_key);

CREATE TABLE IF NOT EXISTS sync_bookmarks (
    user_key TEXT NOT NULL,
    book_order INTEGER NOT NULL,
    book_id TEXT NOT NULL,
    book_abbr TEXT NOT NULL,
    book_title TEXT NOT NULL,
    chapter INTEGER NOT NULL,
    verse INTEGER NOT NULL,
    color TEXT NOT NULL DEFAULT 'gold',
    note TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    deleted INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_key, book_order, chapter, verse),
    FOREIGN KEY (user_key) REFERENCES sync_users(user_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_bookmarks_user ON sync_bookmarks(user_key);
