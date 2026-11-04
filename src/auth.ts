/**
 * Prijava: pristupni ključ (passkey) za sinkronizaciju i Login with Certilia za presude na /provjera/.
 *
 * - Pristupni ključ je glavni način: profil nastaje upisom ključa (Apple Passwords, Google Password
 *   Manager…), bez Sync koda i PIN-a. Postojeći profil sa Sync kodom dobiva ključ kad ga doda uz PIN.
 * - Sync kod + PIN ostaje kao stari način (mobilne aplikacije još nemaju native passkey).
 * - Certilia se veže uz profil jednom: OIB samo kao HMAC, ime i prezime za potpis presuda.
 *
 * Sesija je potpisani kolačić (HMAC, AUTH_SECRET). Passkey logika je prenesena iz e-satnice
 * (src/lib/passkey.ts, izvorno pay.domovina.ai), OIDC iz e-satnice src/lib/oidc + certilia.
 * Vidi docs/2026-11-04-passkey-i-certilia.md.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import * as jose from "jose";
import type { D1Database } from "./worker";

export interface AuthEnv {
  DB?: D1Database;
  AUTH_SECRET?: string;
  CERTILIA_CLIENT_ID?: string;
  CERTILIA_CLIENT_SECRET?: string;
  CERTILIA_ISSUER_BASE?: string;
}

/** Provjera starog načina (Sync kod + PIN, uz zaključavanje), iz worker.ts. */
export type VerifyPin = (
  db: D1Database,
  rawKey: string,
  pin: string
) => Promise<{ ok: true; userKey: string; displayName: string } | { ok: false; response: Response }>;

export interface SessionUser {
  userKey: string;
  displayName: string;
  pinHash: string;
  method: string;
  since: number;
  oibHash: string | null;
  certiliaName: string | null;
}

const COOKIE = "biblija_sesija";
const SESSION_MAX_AGE_S = 400 * 24 * 60 * 60; // najdulje što preglednici dopuštaju
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const FLOW_TTL_MS = 10 * 60 * 1000;
/** Drugi ključ (npr. Android uz iPhone) dodaje se samo unutar 10 min od prijave ključem. */
const FRESH_MS = 10 * 60 * 1000;
const MAX_KEYS = 10;
const RP_NAME = "Biblija";
/** pin_hash profila bez PIN-a: nikad ne odgovara SHA-256 hexu, a služi kao tajna za realtime sobu. */
const NO_PIN_PREFIX = "!";

const enc = new TextEncoder();

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const v = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of v) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const randomB64url = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ==================== Sesija ==================== */

interface SessionPayload {
  k: string; // user_key
  m: string; // način: passkey
  t: number; // epoch ms prijave
}

async function makeCookie(env: AuthEnv, p: SessionPayload): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(p)));
  const sig = await hmacHex(env.AUTH_SECRET!, `sesija:${body}`);
  return `${COOKIE}=${body}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_S}`;
}

const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

async function readSession(request: Request, env: AuthEnv): Promise<SessionPayload | null> {
  const v = readCookie(request, COOKIE);
  if (!v || !env.AUTH_SECRET) return null;
  const dot = v.lastIndexOf(".");
  if (dot < 1) return null;
  const body = v.slice(0, dot);
  if (!safeEqual(await hmacHex(env.AUTH_SECRET, `sesija:${body}`), v.slice(dot + 1))) return null;
  try {
    const bin = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as SessionPayload;
    return p && typeof p.k === "string" ? p : null;
  } catch {
    return null;
  }
}

/** Korisnik iz kolačića, ili null. Obrisan profil poništava sesiju. */
export async function sessionUser(request: Request, env: AuthEnv): Promise<SessionUser | null> {
  if (!env.DB) return null;
  const s = await readSession(request, env);
  if (!s) return null;
  const u = await env.DB.prepare(
    "SELECT user_key, display_name, pin_hash, oib_hash, certilia_ime, certilia_prezime FROM sync_users WHERE user_key = ?"
  )
    .bind(s.k)
    .first<Record<string, string | null>>();
  if (!u) return null;
  return {
    userKey: u.user_key!,
    displayName: u.display_name!,
    pinHash: u.pin_hash!,
    method: s.m,
    since: s.t,
    oibHash: u.oib_hash,
    certiliaName: u.certilia_ime && u.certilia_prezime ? `${u.certilia_ime} ${u.certilia_prezime}` : null,
  };
}

/** POST sa sesijom mora doći s istog origina (uz SameSite=Lax kao drugi sloj). */
export function sameOrigin(request: Request, url: URL): boolean {
  const o = request.headers.get("Origin");
  return !o || o === url.origin;
}

function log(env: AuthEnv, ctx: ExecutionContext, kind: string, ok: boolean, extra: { userKey?: string | null; oibHash?: string | null; claims?: string; error?: string } = {}) {
  ctx.waitUntil(
    env.DB!.prepare("INSERT INTO auth_log (kind, ok, user_key, oib_hash, claims, error) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(kind, ok ? 1 : 0, extra.userKey ?? null, extra.oibHash ?? null, extra.claims ?? null, extra.error ?? null)
      .run()
      .catch(() => {})
  );
}

/* ==================== Pristupni ključevi ==================== */

const rp = (url: URL) => ({ rpID: url.hostname, origin: url.origin });
const transports = (t: string | null) => (t ? (t.split(",") as AuthenticatorTransport[]) : undefined);

function slugify(raw: string): string {
  return raw
    .replace(/[čćČĆ]/g, "c").replace(/[žŽ]/g, "z").replace(/[šŠ]/g, "s").replace(/[đĐ]/g, "d")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "profil";
}

/** Novi user_key za profil s ključem: čitljiv, jedinstven, nije PIN-ovski račun. */
async function newUserKey(db: D1Database, displayName: string): Promise<string> {
  const base = slugify(displayName);
  for (let i = 0; i < 8; i++) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 9000 + 1000;
    const key = `${base}-${n}`;
    const taken = await db.prepare("SELECT 1 FROM sync_users WHERE user_key = ?").bind(key).first();
    const pending = await db.prepare("SELECT 1 FROM passkey_challenges WHERE user_key = ?").bind(key).first();
    if (!taken && !pending) return key;
  }
  return `${base}-${randomB64url(6).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

async function saveChallenge(db: D1Database, challenge: string, purpose: string, userKey: string | null, displayName: string | null) {
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM passkey_challenges WHERE expires < ?").bind(now),
    db
      .prepare("INSERT INTO passkey_challenges (challenge, purpose, user_key, display_name, expires) VALUES (?, ?, ?, ?, ?)")
      .bind(challenge, purpose, userKey, displayName, now + CHALLENGE_TTL_MS),
  ]);
}

/** Jednokratno: izazov se briše pri prvoj provjeri, bez obzira na ishod. */
async function consumeChallenge(db: D1Database, challenge: string, purposes: string[]) {
  const r = await db
    .prepare("DELETE FROM passkey_challenges WHERE challenge = ? RETURNING purpose, user_key, display_name, expires")
    .bind(challenge)
    .first<{ purpose: string; user_key: string | null; display_name: string | null; expires: number }>();
  if (!r || !purposes.includes(r.purpose) || r.expires < Date.now()) return null;
  return r;
}

async function userId(env: AuthEnv, userKey: string): Promise<Uint8Array> {
  // Neproziran i stabilan: isti profil uvijek ima isti userID, pa uređaj ne gomila duplikate.
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`${env.AUTH_SECRET}:biblija-user:${userKey}`)));
}

async function registerOptions(request: Request, env: AuthEnv, url: URL, verifyPin: VerifyPin): Promise<Response> {
  const db = env.DB!;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const pin = String(body.pin || "").trim();
  let userKey: string;
  let displayName: string;
  let isNew = false;

  if (pin) {
    // Postojeći profil sa Sync kodom dobiva ključ uz točan PIN (prijelaz sa starog načina).
    const a = await verifyPin(db, String(body.user_key || ""), pin);
    if (!a.ok) return a.response;
    userKey = a.userKey;
    displayName = a.displayName;
  } else {
    const s = await sessionUser(request, env);
    if (s && body.add_to_current) {
      if (s.method !== "passkey" || Date.now() - s.since > FRESH_MS) {
        return json({ ok: false, error: "Za dodavanje ključa ponovno se prijavi ključem (unutar 10 minuta)." }, 403);
      }
      userKey = s.userKey;
      displayName = s.displayName;
    } else {
      displayName = String(body.display_name || "").trim().replace(/\s+/g, " ").slice(0, 40);
      if (displayName.length < 2) return json({ ok: false, error: "Upiši ime profila (barem 2 znaka)." }, 400);
      userKey = await newUserKey(db, displayName);
      isNew = true;
    }
  }

  const existing = isNew
    ? []
    : (await db.prepare("SELECT id, transports FROM passkeys WHERE user_key = ?").bind(userKey).all<{ id: string; transports: string | null }>()).results;
  if (existing.length >= MAX_KEYS) return json({ ok: false, error: `Najviše ${MAX_KEYS} ključeva po profilu.` }, 400);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp(url).rpID,
    userName: displayName,
    userDisplayName: displayName,
    userID: await userId(env, userKey),
    attestationType: "none",
    excludeCredentials: existing.map((k) => ({ id: k.id, transports: transports(k.transports) })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  await saveChallenge(db, options.challenge, isNew ? "register_new" : "register", userKey, displayName);
  return json({ ok: true, options });
}

async function registerVerify(request: Request, env: AuthEnv, url: URL, ctx: ExecutionContext): Promise<Response> {
  const db = env.DB!;
  const body = (await request.json().catch(() => null)) as { response?: RegistrationResponseJSON; name?: string } | null;
  if (!body?.response?.id) return json({ ok: false, error: "Neispravan zahtjev." }, 400);

  let ch: Awaited<ReturnType<typeof consumeChallenge>> = null;
  const { rpID, origin } = rp(url);
  const result = await verifyRegistrationResponse({
    response: body.response,
    expectedChallenge: async (c: string) => {
      ch = await consumeChallenge(db, c, ["register_new", "register"]);
      return ch !== null;
    },
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  }).catch(() => null);
  const challenge = ch as Awaited<ReturnType<typeof consumeChallenge>>;
  if (!result?.verified || !challenge?.user_key) {
    log(env, ctx, "passkey_register", false, { error: "verify" });
    return json({ ok: false, error: "Upis ključa nije uspio." }, 400);
  }

  const userKey = challenge.user_key;
  const displayName = challenge.display_name || userKey;
  const now = new Date().toISOString();
  const { credential } = result.registrationInfo;
  const stmts = [];
  if (challenge.purpose === "register_new") {
    stmts.push(
      db
        .prepare(
          `INSERT INTO sync_users (user_key, pin_hash, display_name, active_plan_id, last_url, last_label, last_updated_at, created_at)
           VALUES (?, ?, ?, 'mb-tematski-365', '/', '', '1970-01-01T00:00:00.000Z', ?)`
        )
        .bind(userKey, NO_PIN_PREFIX + randomB64url(32), displayName, now)
    );
  }
  stmts.push(
    db
      .prepare("INSERT INTO passkeys (id, user_key, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(
        credential.id,
        userKey,
        isoBase64URL.fromBuffer(credential.publicKey),
        credential.counter,
        credential.transports?.join(",") ?? null,
        String(body.name || "").trim().slice(0, 80) || "pristupni ključ",
        now
      )
  );
  await db.batch(stmts);
  log(env, ctx, challenge.purpose === "register_new" ? "passkey_new_profile" : "passkey_register", true, { userKey });

  return json(
    { ok: true, user_key: userKey, display_name: displayName, created: challenge.purpose === "register_new" },
    200,
    { "Set-Cookie": await makeCookie(env, { k: userKey, m: "passkey", t: Date.now() }) }
  );
}

async function loginOptions(env: AuthEnv, url: URL): Promise<Response> {
  const options = await generateAuthenticationOptions({
    rpID: rp(url).rpID,
    userVerification: "required",
    allowCredentials: [], // discoverable: uređaj sam ponudi ključeve za ovu domenu
  });
  await saveChallenge(env.DB!, options.challenge, "login", null, null);
  return json({ ok: true, options });
}

async function loginVerify(request: Request, env: AuthEnv, url: URL, ctx: ExecutionContext): Promise<Response> {
  const db = env.DB!;
  const body = (await request.json().catch(() => null)) as { response?: AuthenticationResponseJSON } | null;
  if (!body?.response?.id) return json({ ok: false, error: "Neispravan zahtjev." }, 400);
  const key = await db
    .prepare("SELECT id, user_key, public_key, counter, transports FROM passkeys WHERE id = ?")
    .bind(body.response.id)
    .first<{ id: string; user_key: string; public_key: string; counter: number; transports: string | null }>();
  const fail = () => {
    log(env, ctx, "passkey_login", false, { userKey: key?.user_key });
    // Greške namjerno ne razlikuju razloge.
    return json({ ok: false, error: "Ključ nije prepoznat. Možda je profil obrisan ili je ključ uklonjen." }, 401);
  };
  if (!key) return fail();

  const { rpID, origin } = rp(url);
  const result = await verifyAuthenticationResponse({
    response: body.response,
    expectedChallenge: async (c: string) => (await consumeChallenge(db, c, ["login"])) !== null,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: { id: key.id, publicKey: isoBase64URL.toBuffer(key.public_key), counter: key.counter, transports: transports(key.transports) },
  }).catch(() => null);
  if (!result?.verified) return fail();

  await db
    .prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?")
    .bind(result.authenticationInfo.newCounter, new Date().toISOString(), key.id)
    .run();
  const u = await db.prepare("SELECT display_name FROM sync_users WHERE user_key = ?").bind(key.user_key).first<{ display_name: string }>();
  if (!u) return fail();
  log(env, ctx, "passkey_login", true, { userKey: key.user_key });
  return json(
    { ok: true, user_key: key.user_key, display_name: u.display_name },
    200,
    { "Set-Cookie": await makeCookie(env, { k: key.user_key, m: "passkey", t: Date.now() }) }
  );
}

/* ==================== Login with Certilia (OIDC + PKCE) ==================== */

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}
const discoveryCache = new Map<string, { at: number; d: Discovery; jwks: ReturnType<typeof jose.createRemoteJWKSet> }>();

/** `issuer` za provjeru dolazi iz discoveryja: kod Certilije je `…/oauth2/token`, a ne baza. */
async function discover(env: AuthEnv) {
  const u = `${env.CERTILIA_ISSUER_BASE || "https://idp.certilia.com"}/oauth2/oidcdiscovery/.well-known/openid-configuration`;
  const c = discoveryCache.get(u);
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c;
  const res = await fetch(u);
  if (!res.ok) throw new Error("discovery_failed");
  const d = (await res.json()) as Discovery;
  if (!d.issuer || !d.jwks_uri || !d.token_endpoint || !d.authorization_endpoint) throw new Error("discovery_incomplete");
  const n = { at: Date.now(), d, jwks: jose.createRemoteJWKSet(new URL(d.jwks_uri)) };
  discoveryCache.set(u, n);
  return n;
}

export const certiliaEnabled = (env: AuthEnv) => Boolean(env.CERTILIA_CLIENT_ID && env.CERTILIA_CLIENT_SECRET && env.AUTH_SECRET);

function safeBack(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/provjera/";
}

function redirect(location: string, cookie?: string): Response {
  const h: Record<string, string> = { Location: location, "Cache-Control": "no-store" };
  if (cookie) h["Set-Cookie"] = cookie;
  return new Response(null, { status: 302, headers: h });
}

async function certiliaStart(request: Request, env: AuthEnv, url: URL): Promise<Response> {
  const back = safeBack(url.searchParams.get("natrag"));
  const sep = back.includes("?") ? "&" : "?";
  if (!certiliaEnabled(env)) return redirect(`${back}${sep}certilia_greska=nije_podesena`);
  const s = await sessionUser(request, env);
  // Certilia se veže uz profil, pa profil (ključ) mora postojati prije nje.
  if (!s) return redirect(`${back}${sep}certilia_greska=prijava`);

  const state = randomB64url(32);
  const nonce = randomB64url(32);
  const verifier = randomB64url(64);
  const db = env.DB!;
  await db.batch([
    db.prepare("DELETE FROM oidc_flows WHERE created_at < ?").bind(Date.now() - FLOW_TTL_MS),
    db
      .prepare("INSERT INTO oidc_flows (state_hash, code_verifier, nonce, user_key, back, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(await sha256Hex(state), verifier, nonce, s.userKey, back, Date.now()),
  ]);
  const { d } = await discover(env);
  const params = new URLSearchParams({
    client_id: env.CERTILIA_CLIENT_ID!,
    redirect_uri: `${url.origin}/auth/certilia/callback`,
    response_type: "code",
    scope: "openid profile",
    state,
    nonce,
    code_challenge: b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier))),
    code_challenge_method: "S256",
    prompt: "login",
    // OIB (`pin`) stiže samo kroz claims parametar, ne kroz scope (izmjereno u ZEF-u i e-satnici).
    claims: JSON.stringify({ id_token: { pin: { essential: true }, given_name: null, family_name: null } }),
  });
  return redirect(`${d.authorization_endpoint}?${params.toString()}`);
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

async function certiliaCallback(request: Request, env: AuthEnv, url: URL, ctx: ExecutionContext): Promise<Response> {
  const db = env.DB!;
  const p = url.searchParams;
  let back = "/provjera/";
  const fail = (code: string, extra: { userKey?: string; oibHash?: string; claims?: string; error?: string } = {}) => {
    log(env, ctx, "certilia", false, { ...extra, error: extra.error || code });
    return redirect(`${back}${back.includes("?") ? "&" : "?"}certilia_greska=${encodeURIComponent(code)}`);
  };
  if (!certiliaEnabled(env)) return fail("nije_podesena");
  if (p.get("error")) return fail(p.get("error") === "access_denied" ? "odustao" : "idp_greska");
  const code = p.get("code");
  const state = p.get("state");
  if (!code || !state) return fail("nema_koda");

  // Jednokratno: tok se briše prije ikakvog rada, pa ponovljeni callback ne nalazi ništa.
  const flow = await db
    .prepare("DELETE FROM oidc_flows WHERE state_hash = ? RETURNING code_verifier, nonce, user_key, back, created_at")
    .bind(await sha256Hex(state))
    .first<{ code_verifier: string; nonce: string; user_key: string; back: string; created_at: number }>();
  if (!flow || Date.now() - flow.created_at > FLOW_TTL_MS) return fail("neispravan_state");
  back = flow.back;

  // Callback mora stići u istom pregledniku i profilu koji je tok pokrenuo.
  const s = await sessionUser(request, env);
  if (!s || s.userKey !== flow.user_key) return fail("druga_sesija", { userKey: flow.user_key });

  let payload: Record<string, unknown>;
  try {
    const { d, jwks } = await discover(env);
    const res = await fetch(d.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: env.CERTILIA_CLIENT_ID!,
        client_secret: env.CERTILIA_CLIENT_SECRET!,
        code,
        redirect_uri: `${url.origin}/auth/certilia/callback`,
        code_verifier: flow.code_verifier,
      }).toString(),
    });
    if (!res.ok) throw new Error(`token_exchange_${res.status}`);
    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) throw new Error("nema_id_tokena");
    const v = await jose.jwtVerify(tokens.id_token, jwks, { issuer: d.issuer, audience: env.CERTILIA_CLIENT_ID });
    if (v.payload.nonce !== flow.nonce) throw new Error("nonce_mismatch");
    payload = v.payload as Record<string, unknown>;
  } catch (e) {
    return fail("neispravan_token", { userKey: s.userKey, error: e instanceof Error ? e.message : "unknown" });
  }

  // Samo imena claimova, nikad vrijednosti.
  let claims = Object.keys(payload).sort().join(",");
  // e-Osobna šalje OIB kao `sub`; `pin` stiže kad Certilia poštuje claims zahtjev.
  const source = ["pin", "oib", "sub"].find((c) => str(payload[c])) || "none";
  const oib = source === "none" ? null : str(payload[source]);
  // Bez vrijednosti: samo odakle je identifikator i je li oblika OIB-a (11 znamenki).
  claims += `;oib_izvor=${source};11_znamenki=${/^\d{11}$/.test(oib || "") ? 1 : 0}`;
  if (!oib) return fail("nema_oiba", { userKey: s.userKey, claims });
  const ime = str(payload.given_name) || str(payload.firstname);
  const prezime = str(payload.family_name) || str(payload.lastname);
  const oibHash = await hmacHex(env.AUTH_SECRET!, `oib:${oib}`);
  if (!ime || !prezime) return fail("nema_imena", { userKey: s.userKey, oibHash, claims });

  // Jedna osoba, jedan profil: ako je OIB bio uz drugi profil, prelazi na ovaj (presude idu uz OIB).
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE sync_users SET oib_hash = NULL, certilia_ime = NULL, certilia_prezime = NULL, certilia_at = NULL WHERE oib_hash = ? AND user_key != ?").bind(oibHash, s.userKey),
    db.prepare("UPDATE sync_users SET oib_hash = ?, certilia_ime = ?, certilia_prezime = ?, certilia_at = ? WHERE user_key = ?").bind(oibHash, ime, prezime, now, s.userKey),
  ]);
  log(env, ctx, "certilia", true, { userKey: s.userKey, oibHash, claims });
  return redirect(`${back}${back.includes("?") ? "&" : "?"}certilia=ok`);
}

/* ==================== Rute ==================== */

export async function handleAuth(
  request: Request,
  env: AuthEnv,
  url: URL,
  ctx: ExecutionContext,
  verifyPin: VerifyPin
): Promise<Response | null> {
  const path = url.pathname;
  const isAuthPath = path.startsWith("/api/passkey/") || path === "/api/session" || path === "/api/logout" || path.startsWith("/auth/certilia/");
  if (!isAuthPath) return null;
  if (!env.DB || !env.AUTH_SECRET) return json({ ok: false, error: "Prijava ključem nije podešena (DB ili AUTH_SECRET)." }, 503);
  if (request.method === "POST" && !sameOrigin(request, url)) return json({ ok: false, error: "Zahtjev s drugog origina." }, 403);

  if (path === "/api/session" && request.method === "GET") {
    const s = await sessionUser(request, env);
    if (!s) return json({ ok: true, user: null, certilia_enabled: certiliaEnabled(env) });
    const keys = await env.DB.prepare("SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_key = ? ORDER BY created_at")
      .bind(s.userKey)
      .all<Record<string, string>>();
    return json({
      ok: true,
      certilia_enabled: certiliaEnabled(env),
      user: {
        user_key: s.userKey,
        display_name: s.displayName,
        method: s.method,
        fresh: Date.now() - s.since < FRESH_MS,
        has_pin: !s.pinHash.startsWith(NO_PIN_PREFIX),
        certilia_name: s.certiliaName,
        passkeys: keys.results,
      },
    });
  }
  if (path === "/api/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  }
  if (path === "/api/passkey/register/options" && request.method === "POST") return registerOptions(request, env, url, verifyPin);
  if (path === "/api/passkey/register/verify" && request.method === "POST") return registerVerify(request, env, url, ctx);
  if (path === "/api/passkey/login/options" && request.method === "POST") return loginOptions(env, url);
  if (path === "/api/passkey/login/verify" && request.method === "POST") return loginVerify(request, env, url, ctx);
  if (path === "/api/passkey/delete" && request.method === "POST") {
    const s = await sessionUser(request, env);
    if (!s) return json({ ok: false, error: "Nisi prijavljen." }, 401);
    const body = (await request.json().catch(() => ({}))) as { id?: string };
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_key = ?").bind(s.userKey).first<{ n: number }>();
    if ((n?.n || 0) <= 1 && s.pinHash.startsWith(NO_PIN_PREFIX)) {
      return json({ ok: false, error: "To je jedini ključ ovog profila. Bez njega se na profil više ne možeš prijaviti." }, 400);
    }
    await env.DB.prepare("DELETE FROM passkeys WHERE id = ? AND user_key = ?").bind(String(body.id || ""), s.userKey).run();
    return json({ ok: true });
  }
  if (path === "/auth/certilia/start" && request.method === "GET") return certiliaStart(request, env, url);
  if (path === "/auth/certilia/callback" && request.method === "GET") return certiliaCallback(request, env, url, ctx);
  if (path === "/auth/certilia/status" && request.method === "GET") {
    return json({ clientId: Boolean(env.CERTILIA_CLIENT_ID), clientSecret: Boolean(env.CERTILIA_CLIENT_SECRET), authSecret: Boolean(env.AUTH_SECRET) });
  }
  return json({ ok: false, error: "Nepoznata ruta." }, 404);
}
