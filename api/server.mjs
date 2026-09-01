/* ============================================================================
 * ANTRIAN INBOUND FROZEN — API
 *
 * Pengganti Supabase Edge Function. Satu proses Node di depan Postgres, tanpa
 * kerangka kerja: `node:http` dan `pg` sudah cukup untuk permukaan API yang
 * hanya berisi lima belas aksi.
 *
 * Perbedaan yang paling terasa dibanding Edge Function bukan pada kodenya,
 * melainkan pada jaraknya: Postgres berada di host yang sama, jadi setiap RPC
 * adalah panggilan localhost, bukan perjalanan pulang-pergi ke Singapura. Tidak
 * ada pula cold start, dan tidak ada penangguhan proyek setelah tujuh hari
 * sepi — hal yang membuat tier gratis Supabase berbahaya untuk aplikasi gudang
 * yang harus hidup pada Senin pagi.
 * ========================================================================== */

import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import pg from "pg";

import { createStaticHandler } from "./static.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;

// Berkas statis disajikan oleh proses yang sama. Bila halaman termuat, API-nya
// pasti ikut hidup — tidak ada lagi celah antara proxy dan backend.
const serveStatic = createStaticHandler(ROOT);

/* --------------------------------------------------------------------------
 * Database
 * ----------------------------------------------------------------------- */
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // Postgres berada di jaringan Docker yang sama; kolam kecil sudah cukup dan
  // menahan aplikasi agar tidak menghabiskan slot koneksi server.
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (error) => console.error("[db] idle client error", error.message));

/** Memanggil fungsi Postgres dan mengembalikan nilai skalarnya. */
async function rpc(name, args = []) {
  const placeholders = args.map((_, index) => `$${index + 1}`).join(", ");
  const { rows } = await pool.query(`select ${name}(${placeholders}) as result`, args);
  return rows[0]?.result ?? null;
}

/**
 * Menerapkan skema pada setiap start.
 *
 * Seluruh isi db/schema.sql idempoten, jadi ini menggantikan perkakas migrasi:
 * skema selalu menyusul kode yang baru di-deploy, dan tidak ada langkah manual
 * yang dapat terlupakan di antara keduanya.
 */
async function applySchema() {
  const sql = await readFile(join(ROOT, "db", "schema.sql"), "utf8");
  await pool.query(sql);
  console.log("[db] skema diterapkan");
}

/* --------------------------------------------------------------------------
 * Sesi bertanda tangan
 * ----------------------------------------------------------------------- */
const AUTH_SECRET = process.env.INBOUND_AUTH_SECRET || "";
const SESSION_HOURS = 12;

function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sign(value) {
  return base64Url(createHmac("sha256", AUTH_SECRET).update(value).digest());
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function signSession(session) {
  const encoded = base64Url(Buffer.from(JSON.stringify(session)));
  return `${encoded}.${sign(encoded)}`;
}

function readSession(request) {
  const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature || !constantTimeEqual(signature, sign(encoded))) return null;
  try {
    const session = JSON.parse(Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
    return session.exp > Date.now() ? session : null;
  } catch {
    return null;
  }
}

class AuthConfigError extends Error {}

const KNOWN_ROLES = ["SECURITY", "CHECKER", "SPV", "ADMIN", "DEVELOPER"];

/**
 * Daftar akun dibaca dari lingkungan. Setiap kegagalan di sini adalah masalah
 * konfigurasi server, bukan kesalahan operator — dan harus dapat dibedakan
 * dari sandi yang keliru, karena hanya salah satunya dapat diperbaiki dengan
 * mengetik ulang.
 */
function configuredUsers() {
  const raw = (process.env.INBOUND_AUTH_USERS || "").trim();
  if (!raw) {
    throw new AuthConfigError(
      "INBOUND_AUTH_USERS belum diset, jadi belum ada akun yang dapat masuk.",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AuthConfigError(
      'INBOUND_AUTH_USERS bukan JSON yang sah. Contoh: [{"username":"admin","password":"...","role":"ADMIN"}]',
    );
  }
  if (!Array.isArray(parsed)) throw new AuthConfigError("INBOUND_AUTH_USERS harus berupa JSON array.");
  if (parsed.length === 0) throw new AuthConfigError("INBOUND_AUTH_USERS berisi array kosong.");
  return parsed;
}

function authenticate(body) {
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");
  const user = configuredUsers().find(
    (candidate) =>
      String(candidate.username || "").trim().toLowerCase() === username &&
      // Perbandingan waktu-tetap: perbandingan biasa membocorkan panjang
      // awalan yang cocok lewat selisih waktu respons.
      constantTimeEqual(String(candidate.password || ""), password),
  );
  if (!user) return null;

  const role = String(user.role || "").trim().toUpperCase();
  if (!KNOWN_ROLES.includes(role)) {
    throw new AuthConfigError(
      `Akun "${user.username}" memakai role "${user.role}" yang tidak dikenal. ` +
        `Role yang sah: ${KNOWN_ROLES.join(", ")}.`,
    );
  }
  return {
    username: String(user.username).trim(),
    role,
    display_name: String(user.display_name || user.username).trim(),
    exp: Date.now() + SESSION_HOURS * 3600_000,
  };
}

/** Diagnostik konfigurasi. Tidak memuat username maupun password. */
function authStatus() {
  const present = Boolean((process.env.INBOUND_AUTH_USERS || "").trim());
  try {
    const users = configuredUsers();
    const roles = [...new Set(users.map((user) => String(user.role || "").toUpperCase()))];
    return {
      secret_present: present,
      parse_ok: true,
      users_configured: users.length,
      roles,
      unknown_roles: roles.filter((role) => !KNOWN_ROLES.includes(role)),
      accounts_missing_password: users.filter((user) => !String(user.password || "")).length,
      auth_secret_present: Boolean(AUTH_SECRET),
    };
  } catch (error) {
    return {
      secret_present: present,
      parse_ok: false,
      users_configured: 0,
      message: error.message,
      auth_secret_present: Boolean(AUTH_SECRET),
    };
  }
}

/* --------------------------------------------------------------------------
 * Otorisasi
 * ----------------------------------------------------------------------- */
const READ_ACTIONS = ["board", "history", "sites", "source_freshness"];
const ALL_ROLES = KNOWN_ROLES;

const WRITE_ACTIONS = {
  create_ticket: ["SECURITY", "SPV", "ADMIN", "DEVELOPER"],
  po_master: ["SECURITY", "SPV", "ADMIN", "DEVELOPER"],
  // Kedatangan dicatat Security di pos masuk; Checker dan SPV boleh mengoreksi.
  set_arrival: ALL_ROLES,
  call_ticket: ["CHECKER", "SPV", "ADMIN", "DEVELOPER"],
  start_unloading: ["CHECKER", "SPV", "ADMIN", "DEVELOPER"],
  finish_unloading: ["CHECKER", "SPV", "ADMIN", "DEVELOPER"],
  cancel_ticket: ["SPV", "ADMIN", "DEVELOPER"],
  delete_tickets_by_date: ["ADMIN", "DEVELOPER"],
  delete_single_ticket: ["ADMIN", "DEVELOPER"],
};

function canUseAction(session, action) {
  if (!session) return false;
  if (READ_ACTIONS.includes(action)) return ALL_ROLES.includes(session.role);
  return WRITE_ACTIONS[action]?.includes(session.role) ?? false;
}

/* --------------------------------------------------------------------------
 * HTTP
 * ----------------------------------------------------------------------- */
function send(response, status, body, headers = {}) {
  const payload = status === 204 || status === 304 ? null : JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(payload);
}

async function readBody(request) {
  if (request.method !== "POST") return {};
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
    // Payload API ini selalu kecil; batas ini menahan permintaan yang jelas
    // tidak masuk akal agar tidak menghabiskan memori proses.
    if (chunks.reduce((sum, part) => sum + part.length, 0) > 1_000_000) {
      throw new Error("Payload terlalu besar.");
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

function weakEtag(fingerprint) {
  return `W/"${fingerprint || "0"}"`;
}

/** Membungkus payload ber-fingerprint jadi 200 + ETag atau 304 tanpa body. */
function fingerprinted(request, response, payload, extra = {}) {
  const etag = weakEtag(payload?.fingerprint);
  const seen = String(request.headers["if-none-match"] || "");
  if (seen && seen.split(",").some((candidate) => candidate.trim() === etag)) {
    return send(response, 304, null, { etag });
  }
  return send(response, 200, { ok: true, data: payload }, { etag, ...extra });
}

const TICKET_RPC = {
  set_arrival: "inbound_set_arrival",
  call_ticket: "inbound_call_ticket",
  start_unloading: "inbound_start_unloading",
  finish_unloading: "inbound_finish_unloading",
  cancel_ticket: "inbound_cancel_ticket",
};

async function handle(request, response) {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // Health check untuk platform. Sengaja tidak menyentuh database: proses ini
  // sehat selama ia dapat menjawab, dan database yang bermasalah punya
  // penandanya sendiri di /api/inbound?action=health.
  if (path === "/healthz") {
    return send(response, 200, { ok: true });
  }

  // Apa pun di luar jalur API adalah permintaan berkas.
  if (path !== "/api/inbound") {
    return serveStatic(request, response, path);
  }

  const body = await readBody(request);
  const action = String(url.searchParams.get("action") || body.action || "").toLowerCase();

  // ---- Terbuka -------------------------------------------------------------
  if (request.method === "GET" && action === "health") {
    return send(response, 200, { ok: true, ...(await rpc("inbound_health")) });
  }

  if (request.method === "GET" && action === "auth_status") {
    return send(response, 200, { ok: true, data: authStatus() });
  }

  if (request.method === "POST" && action === "login") {
    let session;
    try {
      session = authenticate(body);
    } catch (error) {
      if (error instanceof AuthConfigError) {
        // 503, bukan 401: keduanya gagal masuk, tetapi hanya satu di antaranya
        // yang dapat diperbaiki operator dengan mengetik ulang sandinya.
        console.error("[auth] konfigurasi", error.message);
        return send(response, 503, { ok: false, message: error.message });
      }
      throw error;
    }
    if (!session) return send(response, 401, { ok: false, message: "Username atau password salah." });
    if (!AUTH_SECRET) {
      return send(response, 503, {
        ok: false,
        message: "INBOUND_AUTH_SECRET belum diset; token sesi tidak dapat ditandatangani.",
      });
    }
    return send(response, 200, {
      ok: true,
      data: {
        token: signSession(session),
        user: { username: session.username, role: session.role, display_name: session.display_name },
      },
    });
  }

  if (request.method === "POST" && action === "logout") return send(response, 200, { ok: true });

  // ---- Terautentikasi ------------------------------------------------------
  const session = readSession(request);
  if (!canUseAction(session, action)) {
    return send(response, 401, { ok: false, message: "Unauthorized" });
  }
  const site = String(url.searchParams.get("site") || body.site_code || "").toUpperCase() || null;
  const actor = { role: session.role, name: session.display_name };

  if (request.method === "GET" && action === "sites") {
    const { rows } = await pool.query(
      "select site_code, location_id, site_name, short_name, gate_prefix, gate_count, active, sort_order from site_master order by sort_order",
    );
    return send(response, 200, { ok: true, data: rows });
  }

  if (request.method === "GET" && action === "board") {
    const raw = Number(url.searchParams.get("days_back"));
    const daysBack = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 0), 30) : 2;
    const payload = await rpc("inbound_board_snapshot", [site, daysBack]);
    return fingerprinted(request, response, payload, {
      "x-inbound-rows": String(payload?.rows?.length ?? 0),
      "x-inbound-site": site || "ALL",
    });
  }

  if (request.method === "GET" && action === "history") {
    return send(response, 200, {
      ok: true,
      data: await rpc("inbound_history", [
        site,
        url.searchParams.get("from") || null,
        url.searchParams.get("to") || null,
      ]),
    });
  }

  if (request.method === "GET" && action === "source_freshness") {
    return send(response, 200, { ok: true, data: await rpc("inbound_source_freshness", [site]) });
  }

  if (request.method === "GET" && action === "po_master") {
    // Fingerprint dihitung lebih dulu supaya klien yang sudah mutakhir tidak
    // pernah memaksa Postgres membangun payload puluhan ribu baris.
    const fingerprint = await rpc("inbound_po_master_fingerprint", [site]);
    const etag = weakEtag(fingerprint);
    const seen = String(request.headers["if-none-match"] || "");
    if (seen && seen.split(",").some((candidate) => candidate.trim() === etag)) {
      return send(response, 304, null, { etag });
    }
    const payload = await rpc("inbound_po_master", [site]);
    return send(response, 200, { ok: true, data: payload }, {
      etag: weakEtag(payload?.fingerprint || fingerprint),
      "x-inbound-rows": String(payload?.total ?? 0),
    });
  }

  if (request.method === "POST" && action === "create_ticket") {
    const data = await rpc("inbound_create_tickets_bulk", [
      JSON.stringify({ tickets: [body], site_code: site ?? body.site_code }),
      JSON.stringify(actor),
    ]);
    return send(response, 201, { ok: true, data: data?.created?.[0] });
  }

  if (request.method === "POST" && TICKET_RPC[action]) {
    return send(response, 200, {
      ok: true,
      data: await rpc(TICKET_RPC[action], [JSON.stringify(body), JSON.stringify(actor)]),
    });
  }

  if (request.method === "POST" && action === "delete_tickets_by_date") {
    return send(response, 200, {
      ok: true,
      data: await rpc("inbound_delete_tickets_by_date", [body.operational_date]),
    });
  }

  if (request.method === "POST" && action === "delete_single_ticket") {
    return send(response, 200, {
      ok: true,
      data: await rpc("inbound_delete_single_ticket", [JSON.stringify(body)]),
    });
  }

  return send(response, 404, { ok: false, message: "Action tidak dikenal." });
}

/* --------------------------------------------------------------------------
 * Bootstrap
 * ----------------------------------------------------------------------- */
const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    // Pesan galat Postgres sudah ditulis untuk operator (mis. "Gate wajib
    // ditentukan"), jadi diteruskan apa adanya; jejak tumpukan tetap di log.
    console.error("[api]", request.url, error.message);
    send(response, 500, { ok: false, message: error.message || "Kesalahan server." });
  });
});

async function start() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL belum diset.");
    process.exit(1);
  }
  await applySchema();

  const { startSupersetSync } = await import("./sync-superset.mjs");
  startSupersetSync(pool);

  server.listen(PORT, () => console.log(`[api] mendengarkan di :${PORT}`));
}

/** Menutup koneksi dengan rapi supaya deploy ulang tidak memutus permintaan. */
function shutdown(signal) {
  console.log(`[api] ${signal}, menutup…`);
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((error) => {
  console.error("[api] gagal start", error);
  process.exit(1);
});
