// Ugovorni testovi: shared/test-vectors/*.json protiv pravog src/worker.ts.
// Pokretanje: npm run test:contract  (Node ≥ 22.18: type stripping za .ts, node:sqlite)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";

// `cloudflare:workers` postoji samo u workerd; za Node je dovoljna prazna klasa DurableObject.
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === "cloudflare:workers" ? { url: "data:text/javascript,export class DurableObject {}", shortCircuit: true } : next(specifier, context),
});
const { default: worker } = await import("../../src/worker.ts");

const root = new URL("../../", import.meta.url);
const vectors = (name) => JSON.parse(readFileSync(new URL(`shared/test-vectors/${name}`, root), "utf-8"));
const migrations = ["0001_sync.sql", "0002_auth_failures.sql", "0003_reading_log.sql"].map((f) =>
  readFileSync(new URL(`migrations/${f}`, root), "utf-8")
);

// Minimalni D1 nad node:sqlite (samo ono što worker koristi).
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  for (const sql of migrations) db.exec(sql);
  const stmt = (sql, params = []) => ({
    bind: (...values) => stmt(sql, values),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => db.prepare(sql).run(...params),
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
    exec: async (sql) => db.exec(sql),
  };
}

async function call(env, path, body) {
  const res = await worker.fetch(
    new Request(`https://biblija.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env
  );
  return { status: res.status, data: await res.json() };
}

const AUTH = { user_key: "test_korisnik", pin: "1234" };

async function seedServer(env, server) {
  await call(env, "/api/auth", AUTH);
  const db = env.DB.raw;
  const m = server.meta;
  db.prepare(
    "UPDATE sync_users SET active_plan_id = ?, last_url = ?, last_label = ?, last_updated_at = ? WHERE user_key = ?"
  ).run(m.active_plan_id, m.last_url, m.last_label, m.last_updated_at, AUTH.user_key);
  for (const [planId, days] of Object.entries(server.progress)) {
    for (const [day, v] of Object.entries(days)) {
      db.prepare(
        "INSERT INTO sync_progress (user_key, plan_id, day, completed, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).run(AUTH.user_key, planId, Number(day), v.completed ? 1 : 0, v.updated_at);
    }
  }
  for (const b of Object.values(server.bookmarks)) {
    db.prepare(
      `INSERT INTO sync_bookmarks (user_key, book_order, book_id, book_abbr, book_title, chapter, verse,
         color, note, text, deleted, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      AUTH.user_key, b.book_order, b.book_id, b.book_abbr, b.book_title, b.chapter, b.verse,
      b.color, b.note, b.text, b.deleted ? 1 : 0, b.updated_at
    );
  }
}

for (const c of vectors("lww_merge.json").cases) {
  test(`lww: ${c.name}`, async () => {
    const env = { DB: fakeD1() };
    await seedServer(env, c.server);
    const { status, data } = await call(env, "/api/sync", { ...AUTH, ...c.client });
    assert.equal(status, 200, JSON.stringify(data));
    assert.deepEqual(data.meta, c.expected.meta);
    assert.deepEqual(data.progress, c.expected.progress);
    assert.deepEqual(data.bookmarks, c.expected.bookmarks);

    // Drugi sync s praznim klijentom mora vratiti isto: merge je zapisan, ne samo izračunat.
    const again = await call(env, "/api/sync", {
      ...AUTH,
      meta: { last_updated_at: "1970-01-01T00:00:00.000Z" },
      progress: {},
      bookmarks: {},
    });
    assert.deepEqual(again.data.progress, c.expected.progress);
    assert.deepEqual(again.data.bookmarks, c.expected.bookmarks);
    assert.deepEqual(again.data.meta, c.expected.meta);
  });
}

// Worker folda user_key NFD varijantom; vektori označeni nfkd_only ne vrijede za nju.
test("fold_hr: worker normalizeUserKey se slaže s vektorima", async () => {
  for (const c of vectors("fold_hr.json").cases) {
    if (c.nfkd_only) continue;
    const env = { DB: fakeD1() };
    const raw = `ab_${c.input}`;
    const { data } = await call(env, "/api/auth", { user_key: raw, pin: "1234" });
    const expected = `ab_${c.expected}`.trim().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
    assert.equal(data.user_key, expected, `ulaz: ${JSON.stringify(c.input)}`);
  }
});

test("auth: 5 pogrešnih PIN-ova zaključava Sync kod, ispravan PIN tada ne prolazi", async () => {
  const env = { DB: fakeD1() };
  assert.equal((await call(env, "/api/auth", AUTH)).data.created, true);
  for (let i = 0; i < 4; i++) {
    assert.equal((await call(env, "/api/auth", { ...AUTH, pin: "0000" })).status, 401);
  }
  assert.equal((await call(env, "/api/sync", { ...AUTH, pin: "0000" })).status, 401);
  const locked = await call(env, "/api/auth", AUTH);
  assert.equal(locked.status, 429);
  assert.ok(locked.data.locked_until);
  assert.equal((await call(env, "/api/sync", AUTH)).status, 429);
});

test("auth: uspješna prijava briše brojač pogrešaka", async () => {
  const env = { DB: fakeD1() };
  await call(env, "/api/auth", AUTH);
  for (let i = 0; i < 4; i++) await call(env, "/api/auth", { ...AUTH, pin: "0000" });
  assert.equal((await call(env, "/api/auth", AUTH)).status, 200);
  for (let i = 0; i < 4; i++) await call(env, "/api/auth", { ...AUTH, pin: "0000" });
  assert.equal((await call(env, "/api/auth", AUTH)).status, 200);
});

test("account/delete: briše korisnika, napredak i oznake", async () => {
  const env = { DB: fakeD1() };
  const lww = vectors("lww_merge.json").cases[0];
  await call(env, "/api/sync", { ...AUTH, ...lww.client });

  assert.equal((await call(env, "/api/account/delete", { ...AUTH, pin: "9999" })).status, 401);
  const del = await call(env, "/api/account/delete", AUTH);
  assert.equal(del.status, 200);
  assert.equal(del.data.deleted, true);

  const db = env.DB.raw;
  for (const t of ["sync_users", "sync_progress", "sync_bookmarks", "sync_reading_log", "sync_linear"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  }
  assert.equal((await call(env, "/api/account/delete", AUTH)).status, 404);
});

const EMPTY = { meta: { last_updated_at: "1970-01-01T00:00:00.000Z" }, progress: {}, bookmarks: {} };

function logEntry(id, over = {}) {
  return {
    id,
    url: "/izaija/12/",
    label: "Izaija (Iz 12)",
    verse: 5,
    started_at: "2026-10-01T08:00:00.000Z",
    ended_at: "2026-10-01T08:10:00.000Z",
    linear: true,
    device: "Web",
    updated_at: "2026-10-01T08:10:00.000Z",
    ...over,
  };
}

test("linear: noviji kursor pobjeđuje, stariji se ignorira", async () => {
  const env = { DB: fakeD1() };
  const first = { url: "/izaija/12/", label: "Izaija (Iz 12)", verse: 5, updated_at: "2026-10-01T08:00:00.000Z" };
  let r = await call(env, "/api/sync", { ...AUTH, ...EMPTY, linear: first });
  assert.deepEqual(r.data.linear, first);

  const older = { ...first, url: "/psalmi/23/", updated_at: "2026-09-01T08:00:00.000Z" };
  r = await call(env, "/api/sync", { ...AUTH, ...EMPTY, linear: older });
  assert.deepEqual(r.data.linear, first);

  const newer = { url: "/izaija/13/", label: "Izaija (Iz 13)", verse: 0, updated_at: "2026-10-02T08:00:00.000Z" };
  r = await call(env, "/api/sync", { ...AUTH, ...EMPTY, linear: newer });
  assert.deepEqual(r.data.linear, newer);

  r = await call(env, "/api/sync", { ...AUTH, ...EMPTY, linear: { url: "javascript:alert(1)", updated_at: "2027-01-01T00:00:00.000Z" } });
  assert.deepEqual(r.data.linear, newer);
});

test("linear: bez kursora server vraća null", async () => {
  const env = { DB: fakeD1() };
  const r = await call(env, "/api/sync", { ...AUTH, ...EMPTY });
  assert.equal(r.data.linear, null);
  assert.deepEqual(r.data.log, []);
  assert.ok(r.data.log_cursor);
});

test("log: zapisi se spajaju po id-u (LWW), log_since vraća samo novo", async () => {
  const env = { DB: fakeD1() };
  const a = logEntry("aaaaaaaa-1");
  const b = logEntry("bbbbbbbb-2", { url: "/psalmi/23/", label: "Psalmi (Ps 23)", linear: false, started_at: "2026-10-01T09:00:00.000Z", ended_at: "2026-10-01T09:02:00.000Z", updated_at: "2026-10-01T09:02:00.000Z" });
  let r = await call(env, "/api/sync", { ...AUTH, ...EMPTY, log: [a, b] });
  assert.deepEqual(r.data.log, [a, b]);
  const cursor = r.data.log_cursor;

  // Stariji zapis istog id-a ne pregazi noviji.
  r = await call(env, "/api/sync", { ...AUTH, ...EMPTY, log: [{ ...a, verse: 1, updated_at: "2026-10-01T08:05:00.000Z" }], log_since: "2099-01-01T00:00:00.000Z" });
  r = await call(env, "/api/sync", { ...AUTH, ...EMPTY });
  assert.deepEqual(r.data.log, [a, b]);

  // Noviji zapis istog id-a pobjeđuje i ponovno se šalje onima koji traže od starog kursora.
  await new Promise((res) => setTimeout(res, 5));
  const a2 = { ...a, verse: 21, ended_at: "2026-10-01T08:20:00.000Z", updated_at: "2026-10-01T08:20:00.000Z" };
  const sent = await call(env, "/api/sync", { ...AUTH, ...EMPTY, log: [a2], log_since: "2099-01-01T00:00:00.000Z" });
  assert.deepEqual(sent.data.log, []);
  r = await call(env, "/api/sync", { ...AUTH, ...EMPTY, log_since: cursor });
  assert.ok(r.data.log.some((e) => e.id === a2.id && e.verse === 21));
  r = await call(env, "/api/sync", { ...AUTH, ...EMPTY, log_since: sent.data.log_cursor });
  assert.deepEqual(r.data.log, [a2]);
});

test("log: neispravni zapisi se odbacuju", async () => {
  const env = { DB: fakeD1() };
  const r = await call(env, "/api/sync", {
    ...AUTH,
    ...EMPTY,
    log: [logEntry("x"), logEntry("cccccccc-3", { url: "https://zlo.example/" }), logEntry("dddddddd-4", { started_at: "jučer" }), "smeće", logEntry("eeeeeeee-5", { verse: -3 })],
  });
  assert.deepEqual(r.data.log.map((e) => [e.id, e.verse]), [["eeeeeeee-5", 0]]);
});
