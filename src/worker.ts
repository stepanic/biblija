/**
 * Cloudflare Worker + D1 Multi-User & Multi-Device Sync Backend for Biblija 365
 * - Poslužuje sve statičke Astro SSG stranice iz `env.ASSETS`
 * - Pruža `/api/status`, `/api/auth`, `/api/sync` i `/api/account/delete` nad Cloudflare D1 SQLite bazom (`env.DB`)
 * - `/api/live`: WebSocket preko Durable Objecta `SyncRoom` (jedan po Sync kodu) koji ostalim
 *   uređajima javi da je stanje promijenjeno, pa oni odmah povuku `/api/sync`
 * - Omogućuje da N korisnika čita Bibliju na više uređaja (mobitel, tablet, računalo)
 *   uz sinkronizaciju napretka po danima, zadnjeg pročitanog poglavlja i osobnih oznaka/bilješki.
 */

import { DurableObject } from "cloudflare:workers";

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]>;
  exec(query: string): Promise<unknown>;
}

export interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  DB?: D1Database;
  SYNC_ROOM?: DurableObjectNamespace<SyncRoom>;
}

// Najviše otvorenih veza po Sync kodu; starije se zatvaraju.
const MAX_LIVE_SOCKETS = 16;

/**
 * Jedna soba po Sync kodu. Ne čuva podatke (izvor istine je D1), samo drži WebSockete uređaja
 * i na `notify` javi svima osim pošiljatelja da povuku `/api/sync`. Hibernation API: dok nema
 * događaja objekt ne troši vrijeme izvođenja, a ping/pong odgovara runtime bez buđenja.
 */
export class SyncRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const clientId = new URL(request.url).searchParams.get("client") || "";
    const sockets = this.ctx.getWebSockets();
    for (const old of sockets.slice(0, Math.max(0, sockets.length - MAX_LIVE_SOCKETS + 1))) {
      try {
        old.close(4000, "too many connections");
      } catch (_) {}
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [clientId.slice(0, 64)]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async notify(fromClient: string, syncedAt: string): Promise<void> {
    const msg = JSON.stringify({ type: "changed", synced_at: syncedAt });
    for (const ws of this.ctx.getWebSockets()) {
      if (fromClient && this.ctx.getTags(ws)[0] === fromClient) continue;
      try {
        ws.send(msg);
      } catch (_) {}
    }
  }

  async webSocketMessage(): Promise<void> {}

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch (_) {}
  }
}

/** Ime sobe: iz hasha PIN-a, da se bez PIN-a ne može slušati tuđi Sync kod. */
async function liveRoomId(pinHash: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`biblija365-live:${pinHash}`));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const CRO_MAP: Record<string, string> = {
  č: "c", ć: "c", ž: "z", š: "s", đ: "d",
  Č: "c", Ć: "c", Ž: "z", Š: "s", Đ: "d",
};

function foldHr(str: string): string {
  return String(str || "")
    .replace(/[čćžšđČĆŽŠĐ]/g, (m) => CRO_MAP[m] || m)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeUserKey(raw: string): string {
  return foldHr(raw).trim().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
}

async function hashPin(userKey: string, pin: string): Promise<string> {
  const data = new TextEncoder().encode(`biblija365:${userKey}:${pin.trim()}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// Nakon MAX_PIN_FAILURES pogrešnih PIN-ova u PIN_WINDOW_MS Sync kod je zaključan PIN_LOCK_MS.
const MAX_PIN_FAILURES = 5;
const PIN_WINDOW_MS = 15 * 60 * 1000;
const PIN_LOCK_MS = 15 * 60 * 1000;

let schemaInitialized = false;

async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaInitialized) return;
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS sync_users (
        user_key TEXT PRIMARY KEY,
        pin_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        active_plan_id TEXT NOT NULL DEFAULT 'mb-tematski-365',
        last_url TEXT NOT NULL DEFAULT '/',
        last_label TEXT NOT NULL DEFAULT '',
        last_updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS sync_progress (
        user_key TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        day INTEGER NOT NULL,
        completed INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_key, plan_id, day)
      )
    `),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_sync_progress_user ON sync_progress(user_key)`),
    db.prepare(`
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
        PRIMARY KEY (user_key, book_order, chapter, verse)
      )
    `),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_sync_bookmarks_user ON sync_bookmarks(user_key)`),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS sync_auth_failures (
        user_key TEXT PRIMARY KEY,
        failures INTEGER NOT NULL DEFAULT 0,
        window_start TEXT NOT NULL,
        locked_until TEXT
      )
    `),
  ]);
  schemaInitialized = true;
}

async function lockedUntil(db: D1Database, userKey: string, nowMs: number): Promise<string | null> {
  const row = await db
    .prepare("SELECT locked_until FROM sync_auth_failures WHERE user_key = ?")
    .bind(userKey)
    .first<{ locked_until: string | null }>();
  if (row?.locked_until && Date.parse(row.locked_until) > nowMs) return row.locked_until;
  return null;
}

async function recordPinFailure(db: D1Database, userKey: string, nowMs: number): Promise<void> {
  const row = await db
    .prepare("SELECT failures, window_start FROM sync_auth_failures WHERE user_key = ?")
    .bind(userKey)
    .first<{ failures: number; window_start: string }>();
  const inWindow = row && nowMs - Date.parse(row.window_start) < PIN_WINDOW_MS;
  const failures = inWindow ? Number(row.failures) + 1 : 1;
  const windowStart = inWindow ? row.window_start : new Date(nowMs).toISOString();
  const locked = failures >= MAX_PIN_FAILURES ? new Date(nowMs + PIN_LOCK_MS).toISOString() : null;
  await db
    .prepare(
      `INSERT INTO sync_auth_failures (user_key, failures, window_start, locked_until)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_key) DO UPDATE SET
         failures = excluded.failures,
         window_start = excluded.window_start,
         locked_until = excluded.locked_until`
    )
    .bind(userKey, locked ? 0 : failures, windowStart, locked)
    .run();
}

async function clearPinFailures(db: D1Database, userKey: string): Promise<void> {
  await db.prepare("DELETE FROM sync_auth_failures WHERE user_key = ?").bind(userKey).run();
}

function lockedResponse(until: string): Response {
  return jsonResponse(
    { ok: false, error: "Previše pogrešnih PIN-ova. Pokušaj ponovno za 15 minuta.", locked_until: until },
    429
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/live") {
      const room = url.searchParams.get("room") || "";
      if (!env.SYNC_ROOM || !/^[0-9a-f]{64}$/.test(room)) {
        return jsonResponse({ ok: false, error: "Neispravna soba." }, 400);
      }
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return jsonResponse({ ok: false, error: "Očekujem WebSocket." }, 426);
      }
      return env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(room)).fetch(request);
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      return jsonResponse({
        mode: env.DB ? "cloudflare-d1" : "cloudflare-edge",
        sync_enabled: Boolean(env.DB),
        fts5: false,
      });
    }

    if (url.pathname === "/api/auth" && request.method === "POST") {
      if (!env.DB) {
        return jsonResponse(
          { ok: false, error: "Cloudflare D1 baza (DB binding) nije povezana u wrangler.jsonc." },
          503
        );
      }
      await ensureSchema(env.DB);

      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const rawKey = String(body.user_key || "").trim();
      const userKey = normalizeUserKey(rawKey);
      const pin = String(body.pin || "").trim();

      if (userKey.length < 3) {
        return jsonResponse({ ok: false, error: "Korisničko ime / Sync kod mora imati barem 3 znaka." }, 400);
      }
      if (pin.length < 4) {
        return jsonResponse({ ok: false, error: "PIN mora imati barem 4 znaka." }, 400);
      }

      const nowMs = Date.now();
      const until = await lockedUntil(env.DB, userKey, nowMs);
      if (until) return lockedResponse(until);

      const pinHash = await hashPin(userKey, pin);
      const now = new Date(nowMs).toISOString();

      const existing = await env.DB.prepare("SELECT * FROM sync_users WHERE user_key = ?")
        .bind(userKey)
        .first<Record<string, string>>();

      if (!existing) {
        await env.DB.prepare(
          `INSERT INTO sync_users (
             user_key, pin_hash, display_name, active_plan_id,
             last_url, last_label, last_updated_at, created_at
           ) VALUES (?, ?, ?, 'mb-tematski-365', '/', '', '1970-01-01T00:00:00.000Z', ?)`
        )
          .bind(userKey, pinHash, rawKey, now)
          .run();

        return jsonResponse({
          ok: true,
          created: true,
          user_key: userKey,
          display_name: rawKey,
        });
      }

      if (existing.pin_hash !== pinHash) {
        await recordPinFailure(env.DB, userKey, nowMs);
        return jsonResponse({ ok: false, error: "Pogrešan PIN za postojeći Sync kod." }, 401);
      }
      await clearPinFailures(env.DB, userKey);

      return jsonResponse({
        ok: true,
        created: false,
        user_key: userKey,
        display_name: existing.display_name,
      });
    }

    if (url.pathname === "/api/sync" && request.method === "POST") {
      if (!env.DB) {
        return jsonResponse(
          { ok: false, error: "Cloudflare D1 baza (DB binding) nije povezana u wrangler.jsonc." },
          503
        );
      }
      await ensureSchema(env.DB);

      const body = (await request.json().catch(() => ({}))) as Record<string, any>;
      const rawKey = String(body.user_key || "").trim();
      const userKey = normalizeUserKey(rawKey);
      const pin = String(body.pin || "").trim();

      if (userKey.length < 3 || pin.length < 4) {
        return jsonResponse({ ok: false, error: "Neispravan Sync kod ili PIN." }, 400);
      }

      const nowMs = Date.now();
      const until = await lockedUntil(env.DB, userKey, nowMs);
      if (until) return lockedResponse(until);

      const pinHash = await hashPin(userKey, pin);
      const now = new Date(nowMs).toISOString();

      let user = await env.DB.prepare("SELECT * FROM sync_users WHERE user_key = ?")
        .bind(userKey)
        .first<Record<string, string>>();

      if (!user) {
        await env.DB.prepare(
          `INSERT INTO sync_users (
             user_key, pin_hash, display_name, active_plan_id,
             last_url, last_label, last_updated_at, created_at
           ) VALUES (?, ?, ?, 'mb-tematski-365', '/', '', '1970-01-01T00:00:00.000Z', ?)`
        )
          .bind(userKey, pinHash, rawKey, now)
          .run();
        user = {
          user_key: userKey,
          pin_hash: pinHash,
          display_name: rawKey,
          active_plan_id: "mb-tematski-365",
          last_url: "/",
          last_label: "",
          last_updated_at: "1970-01-01T00:00:00.000Z",
          created_at: now,
        };
      } else if (user.pin_hash !== pinHash) {
        await recordPinFailure(env.DB, userKey, nowMs);
        return jsonResponse({ ok: false, error: "Pogrešan PIN za ovaj Sync kod." }, 401);
      }

      const batchStmts: D1PreparedStatement[] = [];

      // 1. Merge user meta (LWW)
      const cMeta = body.meta || {};
      const cMetaTs = String(cMeta.last_updated_at || "1970-01-01T00:00:00.000Z");
      const sMetaTs = String(user.last_updated_at || "1970-01-01T00:00:00.000Z");
      let mergedMeta = {
        active_plan_id: user.active_plan_id,
        last_url: user.last_url,
        last_label: user.last_label,
        last_updated_at: sMetaTs,
      };

      if (cMetaTs > sMetaTs) {
        mergedMeta = {
          active_plan_id: String(cMeta.active_plan_id || user.active_plan_id || "mb-tematski-365"),
          last_url: String(cMeta.last_url || user.last_url || "/"),
          last_label: String(cMeta.last_label || user.last_label || ""),
          last_updated_at: cMetaTs,
        };
        batchStmts.push(
          env.DB.prepare(
            `UPDATE sync_users
             SET active_plan_id = ?, last_url = ?, last_label = ?, last_updated_at = ?
             WHERE user_key = ?`
          ).bind(
            mergedMeta.active_plan_id,
            mergedMeta.last_url,
            mergedMeta.last_label,
            mergedMeta.last_updated_at,
            userKey
          )
        );
      }

      // 2. Merge progress (LWW per plan_id + day)
      const { results: sProgRows } = await env.DB.prepare(
        "SELECT plan_id, day, completed, updated_at FROM sync_progress WHERE user_key = ?"
      )
        .bind(userKey)
        .all<Record<string, any>>();

      const progMap = new Map<string, { completed: boolean; updated_at: string }>();
      for (const r of sProgRows) {
        progMap.set(`${r.plan_id}::${Number(r.day)}`, {
          completed: Boolean(r.completed),
          updated_at: String(r.updated_at),
        });
      }

      const cProgress = body.progress || {};
      for (const [planId, daysDict] of Object.entries(cProgress)) {
        if (!daysDict || typeof daysDict !== "object") continue;
        for (const [dayStr, val] of Object.entries(daysDict as Record<string, any>)) {
          const dayNum = Number(dayStr);
          if (!Number.isInteger(dayNum) || dayNum <= 0) continue;

          let cComp = true;
          let cTs = "1970-01-01T00:00:00.000Z";
          if (typeof val === "string") {
            cComp = true;
            cTs = val;
          } else if (val && typeof val === "object") {
            cComp = Boolean(val.completed ?? true);
            cTs = String(val.updated_at || "1970-01-01T00:00:00.000Z");
          } else {
            continue;
          }

          const mapKey = `${planId}::${dayNum}`;
          const existing = progMap.get(mapKey);
          if (!existing || cTs > existing.updated_at) {
            progMap.set(mapKey, { completed: cComp, updated_at: cTs });
            batchStmts.push(
              env.DB.prepare(
                `INSERT INTO sync_progress (user_key, plan_id, day, completed, updated_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(user_key, plan_id, day)
                 DO UPDATE SET completed = excluded.completed, updated_at = excluded.updated_at`
              ).bind(userKey, planId, dayNum, cComp ? 1 : 0, cTs)
            );
          }
        }
      }

      const mergedProgress: Record<string, Record<string, { completed: boolean; updated_at: string }>> = {};
      for (const [mapKey, info] of progMap.entries()) {
        const [planId, dayStr] = mapKey.split("::");
        if (!mergedProgress[planId]) mergedProgress[planId] = {};
        mergedProgress[planId][dayStr] = info;
      }

      // 3. Merge bookmarks & notes (LWW per book_order:chapter:verse)
      const { results: sBmRows } = await env.DB.prepare(
        `SELECT book_order, book_id, book_abbr, book_title, chapter, verse,
                color, note, text, deleted, updated_at
         FROM sync_bookmarks WHERE user_key = ?`
      )
        .bind(userKey)
        .all<Record<string, any>>();

      const bmMap: Record<string, any> = {};
      for (const r of sBmRows) {
        const k = `${r.book_order}:${r.chapter}:${r.verse}`;
        bmMap[k] = {
          book_order: Number(r.book_order),
          book_id: String(r.book_id),
          book_abbr: String(r.book_abbr),
          book_title: String(r.book_title),
          chapter: Number(r.chapter),
          verse: Number(r.verse),
          color: String(r.color),
          note: String(r.note),
          text: String(r.text),
          deleted: Boolean(r.deleted),
          updated_at: String(r.updated_at),
        };
      }

      const cBookmarks = body.bookmarks || {};
      for (const [k, bm] of Object.entries(cBookmarks as Record<string, any>)) {
        if (!bm || typeof bm !== "object") continue;
        const parts = String(k).split(":");
        const bo = Number(bm.book_order || parts[0] || 0);
        const ch = Number(bm.chapter ?? parts[1] ?? 0);
        const vnum = Number(bm.verse || parts[2] || 0);
        if (!bo || !vnum) continue;

        const normK = `${bo}:${ch}:${vnum}`;
        const cTs = String(bm.updated_at || bm.created_at || "1970-01-01T00:00:00.000Z");
        const cDel = Boolean(bm.deleted ?? false);
        const existing = bmMap[normK];

        if (!existing || cTs > existing.updated_at) {
          const entry = {
            book_order: bo,
            book_id: String(bm.book_id || existing?.book_id || ""),
            book_abbr: String(bm.book_abbr || existing?.book_abbr || ""),
            book_title: String(bm.book_title || existing?.book_title || ""),
            chapter: ch,
            verse: vnum,
            color: String(bm.color || "gold"),
            note: String(bm.note || ""),
            text: String(bm.text || existing?.text || ""),
            deleted: cDel,
            updated_at: cTs,
          };
          bmMap[normK] = entry;
          batchStmts.push(
            env.DB.prepare(
              `INSERT INTO sync_bookmarks (
                 user_key, book_order, book_id, book_abbr, book_title,
                 chapter, verse, color, note, text, deleted, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_key, book_order, chapter, verse)
               DO UPDATE SET
                 book_id = excluded.book_id,
                 book_abbr = excluded.book_abbr,
                 book_title = excluded.book_title,
                 color = excluded.color,
                 note = excluded.note,
                 text = excluded.text,
                 deleted = excluded.deleted,
                 updated_at = excluded.updated_at`
            ).bind(
              userKey,
              bo,
              entry.book_id,
              entry.book_abbr,
              entry.book_title,
              ch,
              vnum,
              entry.color,
              entry.note,
              entry.text,
              cDel ? 1 : 0,
              cTs
            )
          );
        }
      }

      const liveRoom = await liveRoomId(pinHash);
      if (batchStmts.length > 0) {
        await env.DB.batch(batchStmts);
        if (env.SYNC_ROOM) {
          const stub = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(liveRoom));
          const fromClient = String(body.client_id || "").slice(0, 64);
          ctx.waitUntil(stub.notify(fromClient, now).catch(() => {}));
        }
      }

      return jsonResponse({
        ok: true,
        user_key: userKey,
        display_name: user.display_name,
        live_room: liveRoom,
        synced_at: now,
        meta: mergedMeta,
        progress: mergedProgress,
        bookmarks: bmMap,
      });
    }

    // Brisanje računa iz aplikacije (App Store Review Guideline 5.1.1(v)).
    if (url.pathname === "/api/account/delete" && request.method === "POST") {
      if (!env.DB) {
        return jsonResponse(
          { ok: false, error: "Cloudflare D1 baza (DB binding) nije povezana u wrangler.jsonc." },
          503
        );
      }
      await ensureSchema(env.DB);

      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const userKey = normalizeUserKey(String(body.user_key || ""));
      const pin = String(body.pin || "").trim();

      if (userKey.length < 3 || pin.length < 4) {
        return jsonResponse({ ok: false, error: "Neispravan Sync kod ili PIN." }, 400);
      }

      const nowMs = Date.now();
      const until = await lockedUntil(env.DB, userKey, nowMs);
      if (until) return lockedResponse(until);

      const user = await env.DB.prepare("SELECT pin_hash FROM sync_users WHERE user_key = ?")
        .bind(userKey)
        .first<{ pin_hash: string }>();
      if (!user) {
        return jsonResponse({ ok: false, error: "Sync kod ne postoji." }, 404);
      }
      if (user.pin_hash !== (await hashPin(userKey, pin))) {
        await recordPinFailure(env.DB, userKey, nowMs);
        return jsonResponse({ ok: false, error: "Pogrešan PIN za ovaj Sync kod." }, 401);
      }

      await env.DB.batch([
        env.DB.prepare("DELETE FROM sync_progress WHERE user_key = ?").bind(userKey),
        env.DB.prepare("DELETE FROM sync_bookmarks WHERE user_key = ?").bind(userKey),
        env.DB.prepare("DELETE FROM sync_users WHERE user_key = ?").bind(userKey),
        env.DB.prepare("DELETE FROM sync_auth_failures WHERE user_key = ?").bind(userKey),
      ]);

      return jsonResponse({ ok: true, deleted: true, user_key: userKey });
    }

    return env.ASSETS.fetch(request);
  },
};
