/**
 * Ručna provjera KS-online prema tisku: red nalaza iz scripts/audit_tekst.py, slijepe presude,
 * konsenzus dviju neovisnih osoba, fotografije tiska u R2 i CSV izvoz za Kršćansku sadašnjost.
 * Vidi docs/2026-11-04-automatska-provjera-ks-teksta.md.
 */
import type { D1Database } from "./worker";

export interface R2Bucket {
  put(key: string, value: ArrayBuffer | ReadableStream, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null>;
}

export interface ProvjeraEnv {
  DB?: D1Database;
  PHOTOS?: R2Bucket;
}

/** Provjera Sync koda i PIN-a (uz zaključavanje nakon više pogrešaka), iz worker.ts. */
export type VerifyUser = (
  db: D1Database,
  rawKey: string,
  pin: string
) => Promise<{ ok: true; userKey: string; displayName: string } | { ok: false; response: Response }>;

const VERDICTS = new Set(["tisak_kao_online", "tisak_drukcije", "ne_mogu"]);
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const SAMPLE_SHARE = 0.2; // udio nasumičnih neoznačenih redaka u redu, da recenzent ne zna koji je koji

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

let schemaReady = false;
async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  const row = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_findings'")
    .first();
  if (!row) throw new Error("Tablica audit_findings ne postoji: pokreni migracije (0004_provjera.sql).");
  schemaReady = true;
}

/** Status nalaza iz presuda: dvije iste presude (bez „ne mogu”) su konsenzus, treća odlučuje neslaganje. */
function statusOf(verdicts: string[]): { status: string; consensus: string } {
  const counted = verdicts.filter((v) => v !== "ne_mogu");
  const tally = new Map<string, number>();
  for (const v of counted) tally.set(v, (tally.get(v) || 0) + 1);
  const [top, n] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] || ["", 0];
  if (n >= 2) return { status: "rijeseno", consensus: top };
  if (counted.length >= 2) return { status: "neslaganje", consensus: "" };
  if (verdicts.length >= 1) return { status: "ceka_drugog", consensus: "" };
  return { status: "otvoreno", consensus: "" };
}

function publicFinding(f: Record<string, any>) {
  return {
    id: f.id,
    ref: f.ref,
    book_order: f.book_order,
    chapter: f.chapter,
    verse: f.verse,
    // uzorak se recenzentu prikazuje kao obični redak
    layer: f.is_sample ? "redak" : f.layer,
    kind: f.is_sample ? "redak" : f.kind,
    priority: f.priority,
    msg: f.msg,
    ks_text: f.ks_text,
    foi_text: f.is_sample ? "" : f.foi_text,
    u68_text: f.is_sample ? "" : f.u68_text,
    extra: f.is_sample ? {} : JSON.parse(f.extra_json || "{}"),
    review_count: f.review_count,
  };
}

async function othersReviews(db: D1Database, findingId: string, userKey: string) {
  const { results } = await db
    .prepare(
      `SELECT verdict, print_text, edition, page, note, photo_key, created_at
         FROM audit_reviews WHERE finding_id = ? AND user_key != ? ORDER BY created_at`
    )
    .bind(findingId, userKey)
    .all<Record<string, string>>();
  return results.map((r) => ({ ...r, photo_url: r.photo_key ? `/api/provjera/photo/${r.photo_key}` : "" }));
}

async function stats(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT is_sample, status, consensus, priority, COUNT(*) AS n
         FROM audit_findings WHERE active = 1 GROUP BY is_sample, status, consensus, priority`
    )
    .all<{ is_sample: number; status: string; consensus: string; priority: number; n: number }>();
  const out = {
    findings: { total: 0, by_status: {} as Record<string, number>, by_priority: {} as Record<string, number>, confirmed_errors: 0 },
    sample: { total: 0, resolved: 0, errors: 0, upper_bound_95: null as number | null },
    reviews: 0,
    reviewers: 0,
  };
  for (const r of results) {
    if (r.is_sample) {
      out.sample.total += r.n;
      if (r.status === "rijeseno") {
        out.sample.resolved += r.n;
        if (r.consensus === "tisak_drukcije") out.sample.errors += r.n;
      }
    } else {
      out.findings.total += r.n;
      out.findings.by_status[r.status] = (out.findings.by_status[r.status] || 0) + r.n;
      out.findings.by_priority[`P${r.priority}`] = (out.findings.by_priority[`P${r.priority}`] || 0) + r.n;
      if (r.consensus === "tisak_drukcije") out.findings.confirmed_errors += r.n;
    }
  }
  // Gornja granica udjela grešaka (95 %): pravilo trojke za 0 grešaka, inače normalna aproksimacija
  const { resolved: N, errors: k } = out.sample;
  if (N > 0) {
    const p = k / N;
    out.sample.upper_bound_95 = k === 0 ? 3 / N : Math.min(1, p + 1.96 * Math.sqrt((p * (1 - p)) / N));
  }
  const rv = await db
    .prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT user_key) AS u FROM audit_reviews")
    .first<{ n: number; u: number }>();
  out.reviews = rv?.n || 0;
  out.reviewers = rv?.u || 0;
  return out;
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportCsv(db: D1Database, origin: string, all: boolean): Promise<Response> {
  const { results } = await db
    .prepare(
      `SELECT f.id, f.ref, f.book_order, f.chapter, f.verse, f.layer, f.kind, f.priority, f.is_sample,
              f.status, f.consensus, f.msg, f.ks_text,
              (SELECT group_concat(r.print_text, ' || ') FROM audit_reviews r
                 WHERE r.finding_id = f.id AND r.verdict = 'tisak_drukcije') AS print_texts,
              (SELECT group_concat(r.edition || ' str. ' || r.page, ' || ') FROM audit_reviews r
                 WHERE r.finding_id = f.id AND r.page != '') AS pages,
              (SELECT group_concat(r.photo_key, ' ') FROM audit_reviews r
                 WHERE r.finding_id = f.id AND r.photo_key != '') AS photos
         FROM audit_findings f
        WHERE f.active = 1 AND f.review_count > 0 ${all ? "" : "AND f.consensus = 'tisak_drukcije'"}
        ORDER BY f.book_order, f.chapter, f.verse`
    )
    .all<Record<string, any>>();
  const head = ["ref", "status", "presuda", "vrsta", "tekst_online", "tekst_u_tisku", "izdanje_i_stranica", "fotografije", "napomena_provjere"];
  const lines = [head.join(",")];
  for (const r of results) {
    const photos = String(r.photos || "")
      .split(" ")
      .filter(Boolean)
      .map((k) => `${origin}/api/provjera/photo/${k}`)
      .join(" ");
    lines.push(
      [r.ref, r.status, r.consensus, r.is_sample ? "nasumični uzorak" : `${r.layer}/${r.kind}`, r.ks_text,
        r.print_texts, r.pages, photos, r.is_sample ? "" : r.msg].map(csvCell).join(",")
    );
  }
  return new Response("﻿" + lines.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ks-online-neuskladenosti${all ? "-sve" : ""}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function handleProvjera(request: Request, env: ProvjeraEnv, url: URL, verify: VerifyUser): Promise<Response> {
  if (!env.DB) return json({ ok: false, error: "D1 nije povezan." }, 503);
  const db = env.DB;
  try {
    await ensureSchema(db);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message) }, 503);
  }
  const path = url.pathname.replace(/^\/api\/provjera/, "");

  if (path === "/stats" && request.method === "GET") return json({ ok: true, ...(await stats(db)) });

  if (path === "/export.csv" && request.method === "GET") {
    return exportCsv(db, url.origin, url.searchParams.get("sve") === "1");
  }

  if (path.startsWith("/photo/") && request.method === "GET") {
    const key = decodeURIComponent(path.slice("/photo/".length));
    if (!env.PHOTOS || !/^[0-9a-f]{12}\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(key)) return json({ ok: false }, 404);
    const obj = await env.PHOTOS.get(key);
    if (!obj) return json({ ok: false }, 404);
    return new Response(obj.body, {
      headers: { "Content-Type": obj.httpMetadata?.contentType || "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" },
    });
  }

  if (path === "/next" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as Record<string, any>;
    const auth = await verify(db, String(body.user_key || ""), String(body.pin || ""));
    if (!auth.ok) return auth.response;
    const skip: string[] = Array.isArray(body.skip) ? body.skip.filter((s: unknown) => typeof s === "string").slice(0, 200) : [];
    const wantId = typeof body.id === "string" ? body.id : "";
    const notMine = `NOT EXISTS (SELECT 1 FROM audit_reviews r WHERE r.finding_id = f.id AND r.user_key = ?)`;
    const skipSql = skip.length ? `AND f.id NOT IN (${skip.map(() => "?").join(",")})` : "";
    const pick = async (sample: boolean) =>
      db
        .prepare(
          `SELECT f.* FROM audit_findings f
            WHERE f.active = 1 AND f.status != 'rijeseno' AND f.is_sample = ? AND ${notMine} ${skipSql}
            ORDER BY (f.status = 'neslaganje') DESC, (f.status = 'ceka_drugog') DESC,
                     f.priority, ${sample ? "f.id" : "f.book_order, f.chapter, f.verse"}
            LIMIT 1`
        )
        .bind(sample ? 1 : 0, auth.userKey, ...skip)
        .first<Record<string, any>>();
    let f: Record<string, any> | null = null;
    if (wantId) {
      f = await db.prepare("SELECT * FROM audit_findings WHERE id = ?").bind(wantId).first<Record<string, any>>();
    } else {
      const sampleFirst = Math.random() < SAMPLE_SHARE;
      f = (await pick(sampleFirst)) || (await pick(!sampleFirst));
    }
    if (!f) return json({ ok: true, done: true, stats: await stats(db) });
    const mine = await db
      .prepare("SELECT verdict, print_text, edition, page, note, photo_key FROM audit_reviews WHERE finding_id = ? AND user_key = ?")
      .bind(f.id, auth.userKey)
      .first<Record<string, string>>();
    return json({
      ok: true,
      finding: publicFinding(f),
      mine: mine || null,
      // tuđe presude tek nakon vlastite (slijepa provjera)
      others: mine ? await othersReviews(db, f.id, auth.userKey) : [],
    });
  }

  if (path === "/review" && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    if (!form) return json({ ok: false, error: "Očekujem multipart/form-data." }, 400);
    const auth = await verify(db, String(form.get("user_key") || ""), String(form.get("pin") || ""));
    if (!auth.ok) return auth.response;

    const findingId = String(form.get("finding_id") || "");
    const verdict = String(form.get("verdict") || "");
    const printText = String(form.get("print_text") || "").trim().slice(0, 4000);
    const edition = String(form.get("edition") || "").trim().slice(0, 200);
    const page = String(form.get("page") || "").trim().slice(0, 40);
    const note = String(form.get("note") || "").trim().slice(0, 2000);
    if (!VERDICTS.has(verdict)) return json({ ok: false, error: "Nepoznata presuda." }, 400);
    if (verdict === "tisak_drukcije" && !printText) {
      return json({ ok: false, error: "Upiši kako redak glasi u tisku." }, 400);
    }
    const f = await db.prepare("SELECT id FROM audit_findings WHERE id = ?").bind(findingId).first();
    if (!f) return json({ ok: false, error: "Nalaz ne postoji." }, 404);

    let photoKey = "";
    const photo = form.get("photo");
    if (photo && typeof photo !== "string" && (photo as File).size > 0) {
      const file = photo as File;
      if (!env.PHOTOS) return json({ ok: false, error: "Spremište fotografija nije povezano." }, 503);
      if (file.size > MAX_PHOTO_BYTES) return json({ ok: false, error: "Fotografija je veća od 4 MB." }, 413);
      const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
      photoKey = `${findingId}/${crypto.randomUUID()}.${ext}`;
      await env.PHOTOS.put(photoKey, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || "image/jpeg" } });
    } else {
      const prev = await db
        .prepare("SELECT photo_key FROM audit_reviews WHERE finding_id = ? AND user_key = ?")
        .bind(findingId, auth.userKey)
        .first<{ photo_key: string }>();
      photoKey = prev?.photo_key || "";
    }

    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO audit_reviews (finding_id, user_key, verdict, print_text, edition, page, note, photo_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(finding_id, user_key) DO UPDATE SET
           verdict = excluded.verdict, print_text = excluded.print_text, edition = excluded.edition,
           page = excluded.page, note = excluded.note, photo_key = excluded.photo_key, created_at = excluded.created_at`
      )
      .bind(findingId, auth.userKey, verdict, printText, edition, page, note, photoKey, now)
      .run();

    const { results } = await db
      .prepare("SELECT verdict FROM audit_reviews WHERE finding_id = ?")
      .bind(findingId)
      .all<{ verdict: string }>();
    const st = statusOf(results.map((r) => r.verdict));
    await db
      .prepare("UPDATE audit_findings SET status = ?, consensus = ?, review_count = ? WHERE id = ?")
      .bind(st.status, st.consensus, results.length, findingId)
      .run();

    return json({ ok: true, status: st.status, consensus: st.consensus, others: await othersReviews(db, findingId, auth.userKey) });
  }

  return json({ ok: false, error: "Nepoznata ruta." }, 404);
}
