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
import { MIN_COMPRESS_BYTES, compress, negotiateEncoding } from "./compress.mjs";
import { clientKey, createRateLimiter } from "./ratelimit.mjs";
import { SECURITY_HEADERS, transportHeaders } from "./headers.mjs";
import { createLiveChannel } from "./live.mjs";

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
  const client = await pool.connect();
  try {
    // Kunci penasihat tingkat sesi: bila kelak ada lebih dari satu replika,
    // dua proses yang start bersamaan akan saling menimpa `drop trigger` /
    // `create trigger` dan salah satunya mati dengan galat yang membingungkan.
    // Yang kedua di sini cukup menunggu, lalu menerapkan skema yang sama.
    await client.query("select pg_advisory_lock($1)", [SCHEMA_LOCK_ID]);
    await client.query(sql);
    console.log("[db] skema diterapkan");
  } finally {
    await client.query("select pg_advisory_unlock($1)", [SCHEMA_LOCK_ID]).catch(() => {});
    client.release();
  }
}

/** Angka tetap sembarang; yang penting sama di setiap proses. */
const SCHEMA_LOCK_ID = 728_417_301;

/* --------------------------------------------------------------------------
 * Sesi bertanda tangan
 * ----------------------------------------------------------------------- */
const AUTH_SECRET = process.env.INBOUND_AUTH_SECRET || "";
const SESSION_HOURS = 12;

/**
 * Panjang minimum kunci penanda tangan.
 *
 * Ini bukan kerewelan. `createHmac("sha256", "")` adalah HMAC yang sah dengan
 * kunci kosong: bila INBOUND_AUTH_SECRET tidak diset, SIAPA PUN dapat menyusun
 * token sesi berperan DEVELOPER sendiri dan memakainya pada setiap aksi tulis,
 * tanpa pernah menyentuh layar masuk. Karena itu proses menolak start alih-alih
 * berjalan dengan lubang yang tidak terlihat dari mana pun.
 */
const MIN_SECRET_LENGTH = 16;

export function authSecretProblem(secret = AUTH_SECRET) {
  if (!secret) return "INBOUND_AUTH_SECRET belum diset; token sesi tidak dapat ditandatangani.";
  if (secret.length < MIN_SECRET_LENGTH) {
    return `INBOUND_AUTH_SECRET terlalu pendek (${secret.length} karakter, minimal ${MIN_SECRET_LENGTH}).`;
  }
  return "";
}

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
  // PENJAGA INI YANG MEMBUAT APLIKASI AMAN DINYALAKAN TANPA KUNCI.
  //
  // `createHmac("sha256", "")` adalah HMAC yang sah dengan kunci kosong, jadi
  // tanpa baris ini token yang ditandatangani kunci kosong akan lolos —
  // termasuk token berperan DEVELOPER yang disusun sendiri oleh siapa pun.
  // Dengan baris ini, kunci yang tidak sah berarti TIDAK ADA sesi yang dapat
  // diterima sama sekali: aplikasi menyala, menjelaskan masalahnya, dan tetap
  // tidak dapat dimasuki.
  if (authSecretProblem()) return null;

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
const READ_ACTIONS = ["board", "history", "sites", "source_freshness", "lead_time", "events", "po_search"];
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
  // Menarik ulang master PO atas permintaan. Cookie Superset berumur terbatas,
  // dan menunggu siklus lima menit berikutnya setelah menggantinya adalah lima
  // menit yang dihabiskan menatap layar yang belum berubah.
  sync_now: ["SPV", "ADMIN", "DEVELOPER"],
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
/**
 * Header keamanan untuk satu respons.
 *
 * HSTS bergantung pada permintaannya (hanya dipasang di atas HTTPS), jadi ia
 * disimpan pada objek respons saat permintaan masuk alih-alih diteruskan
 * melalui setiap pemanggil `send()` di berkas ini.
 */
function securityHeadersFor(response) {
  return { ...SECURITY_HEADERS, ...(response.__transportHeaders || {}) };
}

function send(response, status, body, headers = {}) {
  const payload = status === 204 || status === 304 ? null : JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...securityHeadersFor(response),
    ...headers,
  });
  response.end(payload);
}

/**
 * Respons JSON yang dikompresi bila layak dan bila klien menerimanya.
 *
 * Snapshot papan adalah payload terbesar aplikasi ini dan ia diminta ulang tiap
 * lima belas detik oleh setiap tablet yang menyala. Seratus tiket menghasilkan
 * sekitar 120 KB JSON; gzip memampatkannya ke belasan KB. Siklus yang tidak
 * membawa perubahan tetap dijawab 304 tanpa body sama sekali — kompresi hanya
 * mengurusi siklus yang memang harus mengirim sesuatu.
 */
async function sendJson(request, response, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const encoding = payload.length >= MIN_COMPRESS_BYTES ? negotiateEncoding(request) : null;

  if (!encoding) return send(response, status, body, headers);

  let compressed;
  try {
    compressed = await compress(payload, encoding);
  } catch (error) {
    // Kompresi yang gagal tidak boleh menggagalkan permintaan; kirim apa adanya.
    console.warn("[api] kompresi gagal", error.message);
    return send(response, status, body, headers);
  }

  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-encoding": encoding,
    "content-length": compressed.length,
    vary: "Accept-Encoding",
    ...securityHeadersFor(response),
    ...headers,
  });
  response.end(compressed);
}

const MAX_BODY_BYTES = 1_000_000;

class PayloadTooLarge extends Error {}

async function readBody(request) {
  if (request.method !== "POST") return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    // Total berjalan, bukan penjumlahan ulang seluruh potongan pada setiap
    // potongan: yang terakhir itu kuadratik, sehingga unggahan besar justru
    // membakar CPU tepat pada permintaan yang seharusnya ditolak cepat.
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLarge("Payload terlalu besar.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8") || "{}");
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
  return sendJson(request, response, 200, { ok: true, data: payload }, { etag, ...extra });
}

/* --------------------------------------------------------------------------
 * Saluran perubahan langsung
 * ----------------------------------------------------------------------- */
const live = createLiveChannel(pool);

/* --------------------------------------------------------------------------
 * Pembatas laju
 *
 * Dua lapis, karena keduanya menjawab serangan yang berbeda. Batas per alamat
 * menahan satu mesin yang menebak banyak akun; batas per username menahan
 * banyak mesin yang menebak satu akun — dan yang kedua itu justru bentuk
 * serangan yang lolos dari batas per alamat.
 *
 * ANGKANYA TIMPANG DENGAN SENGAJA. Seluruh tablet gudang berada di balik satu
 * gateway, jadi bagi pembatas ini mereka adalah SATU alamat. Batas per alamat
 * yang ketat berarti pergantian shift yang ricuh — beberapa operator salah
 * ketik berturut-turut — mengunci seluruh gudang dari papan antreannya sendiri,
 * dan itu kerugian operasional yang nyata untuk melawan serangan yang tidak
 * nyata.
 *
 * Yang benar-benar menahan penebakan sandi adalah batas per akun: sepuluh
 * percobaan per lima menit berarti paling banyak seratus dua puluh tebakan per
 * jam untuk satu akun, berapa pun jumlah mesin yang mencoba. Batas per alamat
 * tinggal menjadi jaring pengaman terhadap banjir permintaan.
 * ----------------------------------------------------------------------- */
const loginByAddress = createRateLimiter({ limit: 60, windowMs: 5 * 60_000 });
const loginByUsername = createRateLimiter({ limit: 10, windowMs: 5 * 60_000 });

/** Diagnostik terbuka; longgar, tetapi tetap berbatas. */
const diagnosticLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });

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
  response.__transportHeaders = transportHeaders(request);

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
  // Keduanya sengaja tidak memerlukan sesi: `npm run doctor` justru dipakai
  // ketika tidak ada yang bisa masuk, dan diagnostik yang butuh login tidak
  // berguna tepat pada saat ia paling dibutuhkan. Isinya tidak memuat username
  // maupun sandi — tetapi keduanya menyentuh database, jadi tetap dibatasi.
  if (request.method === "GET" && (action === "health" || action === "auth_status")) {
    const limited = diagnosticLimiter.check(clientKey(request));
    if (!limited.allowed) {
      return send(
        response,
        429,
        { ok: false, message: "Terlalu banyak permintaan diagnostik." },
        { "retry-after": String(limited.retryAfterSeconds) },
      );
    }
    if (action === "health") {
      const problems = currentProblems();
      // Database yang tidak dapat dihubungi tidak boleh membuat endpoint ini
      // ikut gagal — justru di saat itulah ia paling dibutuhkan.
      let details = null;
      try {
        details = await rpc("inbound_health");
      } catch (error) {
        problems.push({
          area: "db",
          message: `Database tidak dapat dikueri: ${error.message}`,
          hint: "Periksa DATABASE_URL dan apakah layanan Postgres hidup.",
        });
      }
      return send(response, 200, {
        ok: problems.length === 0,
        problems,
        live: { listening: live.listening, clients: live.clientCount },
        ...(details || {}),
      });
    }
    return send(response, 200, { ok: true, data: { ...authStatus(), problems: currentProblems() } });
  }

  if (request.method === "POST" && action === "login") {
    const address = clientKey(request);
    const username = String(body.username || "").trim().toLowerCase();
    const byAddress = loginByAddress.check(address);
    const byUsername = username ? loginByUsername.check(username) : { allowed: true, retryAfterSeconds: 0 };
    if (!byAddress.allowed || !byUsername.allowed) {
      const retry = Math.max(byAddress.retryAfterSeconds, byUsername.retryAfterSeconds);
      console.warn(`[auth] percobaan masuk dibatasi untuk ${address}`);
      return send(
        response,
        429,
        {
          ok: false,
          message: `Terlalu banyak percobaan masuk. Coba lagi dalam ${retry} detik.`,
        },
        { "retry-after": String(retry) },
      );
    }

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

    const secretProblem = authSecretProblem();
    if (secretProblem) return send(response, 503, { ok: false, message: secretProblem });

    // Sandi yang benar menghapus riwayat gagal, sehingga operator yang salah
    // ketik beberapa kali tidak terkunci sisa shift-nya.
    loginByAddress.reset(address);
    loginByUsername.reset(username);

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
  // Masalah database yang belum beres dilaporkan apa adanya, sekali di sini.
  // Tanpa ini setiap aksi gagal dengan "Kesalahan server" generik — benar
  // secara teknis, dan tidak berguna sama sekali bagi orang yang harus
  // memperbaikinya pada Senin pagi.
  const dbProblem = startupProblems.find((problem) => problem.area === "db");
  if (dbProblem) {
    return send(response, 503, {
      ok: false,
      message: `${dbProblem.message} ${dbProblem.hint}`.trim(),
    });
  }

  const site = String(url.searchParams.get("site") || body.site_code || "").toUpperCase() || null;
  const actor = { role: session.role, name: session.display_name };

  if (request.method === "GET" && action === "sites") {
    const { rows } = await pool.query(
      "select site_code, location_id, site_name, short_name, gate_prefix, gate_count, active, sort_order from site_master order by sort_order",
    );
    return sendJson(request, response, 200, { ok: true, data: rows });
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

  if (request.method === "GET" && action === "events") {
    // Aliran ini tidak melewati send()/sendJson(): ia tidak pernah berakhir,
    // dan tidak boleh dikompresi maupun di-buffer.
    live.subscribe(request, response, site, securityHeadersFor(response));
    return true;
  }

  if (request.method === "GET" && action === "lead_time") {
    return sendJson(request, response, 200, {
      ok: true,
      data: await rpc("inbound_lead_time_stats", [
        site,
        url.searchParams.get("from") || null,
        url.searchParams.get("to") || null,
      ]),
    });
  }

  if (request.method === "GET" && action === "history") {
    return sendJson(request, response, 200, {
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

  if (request.method === "GET" && action === "po_search") {
    // Menggantikan pengunduhan master PO utuh. Jawabannya tidak pernah lebih
    // dari beberapa baris, jadi ia tidak perlu ETag maupun kompresi.
    return send(response, 200, {
      ok: true,
      data: await rpc("inbound_po_search", [
        site,
        url.searchParams.get("q") || "",
        Number(url.searchParams.get("limit")) || 8,
      ]),
    });
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
    return sendJson(request, response, 200, { ok: true, data: payload }, {
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

  if (request.method === "POST" && action === "sync_now") {
    const { runSupersetSync } = await import("./sync-superset.mjs");
    const result = await runSupersetSync(pool);
    if (result?.error) {
      // 200 dengan ok:false, bukan 5xx: sync yang gagal bukan kegagalan
      // permintaan ini — jawabannya justru informasi yang diminta operator.
      return send(response, 200, { ok: false, message: result.error, kind: result.kind });
    }
    if (result?.skipped) {
      return send(response, 200, {
        ok: true,
        data: {
          skipped: true,
          message:
            result.reason === "overlap"
              ? "Sinkronisasi sedang berjalan; tunggu siklus ini selesai."
              : "Sinkronisasi tidak aktif karena SUPERSET_SESSION_COOKIE belum diisi.",
        },
      });
    }
    return send(response, 200, { ok: true, data: result });
  }

  if (request.method === "POST" && action === "delete_tickets_by_date") {
    // Kode gudang ikut dikirim: tanpa itu penghapusan menyapu seluruh gudang
    // pada tanggal tersebut, bukan hanya gudang yang sedang dilihat operator.
    return send(response, 200, {
      ok: true,
      data: await rpc("inbound_delete_tickets_by_date", [body.operational_date, site]),
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
/**
 * Memilah galat yang boleh dibaca operator dari galat yang tidak boleh.
 *
 * Aturan yang ditulis di db/schema.sql memakai `raise exception`, dan Postgres
 * menandainya dengan SQLSTATE P0001. Pesan-pesan itu memang ditulis untuk
 * dibaca di layar gudang ("Gate wajib ditentukan saat memanggil driver"), jadi
 * diteruskan apa adanya.
 *
 * Sisanya — kegagalan koneksi, pelanggaran constraint, galat sintaks — bukan
 * hanya tidak berguna bagi operator; ia menyebut nama host, nama tabel, dan
 * potongan kueri kepada siapa pun yang meminta. Yang itu berhenti di log.
 */
function clientSafeMessage(error) {
  if (error instanceof PayloadTooLarge) return error.message;
  if (error?.code === "P0001") return error.message;
  return "Kesalahan server. Hubungi admin bila berulang.";
}

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error("[api]", request.url, error.code || "", error.message);
    if (response.headersSent) return response.destroy();
    const status = error instanceof PayloadTooLarge ? 413 : 500;
    send(response, status, { ok: false, message: clientSafeMessage(error) });
  });
});

/**
 * Batas waktu permintaan.
 *
 * Bawaan Node membiarkan koneksi yang menggantung hidup tanpa batas. Di
 * jaringan gudang koneksi memang kerap putus di tengah jalan — tablet berpindah
 * access point, forklift lewat — dan tanpa batas ini setiap kejadian semacam
 * itu meninggalkan socket yang tidak pernah ditutup.
 */
server.requestTimeout = 30_000;
server.headersTimeout = 20_000;
// Sedikit lebih panjang dari idle timeout proxy pada umumnya, supaya proxy yang
// menutup lebih dulu dan bukan server — race itulah yang memunculkan 502 acak.
server.keepAliveTimeout = 72_000;

/**
 * Masalah yang ditemukan saat start dan belum teratasi.
 *
 * SERVER TETAP MENYALA MESKIPUN DAFTAR INI TIDAK KOSONG, dan itu keputusan yang
 * dibayar mahal untuk dipelajari.
 *
 * Versi sebelumnya memanggil `process.exit(1)` pada setiap masalah start:
 * DATABASE_URL kosong, kunci sesi kosong, skema gagal diterapkan. Niatnya baik
 * — gagal terang-terangan lebih baik daripada berjalan setengah rusak. Yang
 * sebenarnya terjadi tidak terang sama sekali: kontainer keluar, platform
 * menyalakannya lagi, ia keluar lagi, dan satu-satunya yang terlihat siapa pun
 * adalah "no available server" dari proxy — kalimat yang tidak menyebut
 * DATABASE_URL, tidak menyebut kunci sesi, dan tidak menyebut baris SQL yang
 * gagal. Log kontainer memuat jawabannya, tetapi kontainer yang mati sepuluh
 * kali per menit adalah tempat yang buruk untuk mencari.
 *
 * Menyala dengan masalah yang DIUMUMKAN lebih baik daripada tidak menyala sama
 * sekali: halaman termuat, layar masuk menjelaskan persoalannya dengan kalimat
 * yang dapat ditindaklanjuti, `npm run doctor` menyebutkannya, dan proxy punya
 * sesuatu untuk dirutekan.
 *
 * Yang membuat ini aman adalah readSession(): tanpa kunci yang sah ia menolak
 * SETIAP token, jadi aplikasi yang menyala tanpa kunci tidak dapat dimasuki
 * siapa pun — bukan hanya sulit dimasuki.
 */
const startupProblems = [];

export function currentProblems() {
  return startupProblems.map(({ area, message, hint }) => ({ area, message, hint }));
}

function recordProblem(area, message, hint = "") {
  startupProblems.push({ area, message, hint });
  console.error(`[${area}] ${message}`);
  if (hint) console.error(`[${area}] ${hint}`);
}

function clearProblems(area) {
  for (let index = startupProblems.length - 1; index >= 0; index -= 1) {
    if (startupProblems[index].area === area) startupProblems.splice(index, 1);
  }
}

/**
 * Menerapkan skema, dan bila gagal, mencoba lagi alih-alih menyerah.
 *
 * Kegagalan tersering di sini bersifat sementara: Postgres masih membuka diri
 * ketika aplikasi sudah siap. Compose menunggu healthcheck, tetapi tidak setiap
 * platform melakukannya. Percobaan ulang berkala membuat keadaan itu sembuh
 * sendiri tanpa siapa pun perlu menekan Deploy untuk kedua kalinya.
 */
async function applySchemaWithRetry() {
  try {
    await applySchema();
    clearProblems("db");
    return true;
  } catch (error) {
    recordProblem(
      "db",
      `Skema gagal diterapkan: ${error.message}`,
      "Aplikasi tetap menyala, tetapi papan antrean tidak akan memuat sampai ini beres.",
    );
    return false;
  }
}

async function start() {
  if (!process.env.DATABASE_URL) {
    recordProblem(
      "db",
      "DATABASE_URL belum diset, jadi tidak ada database yang dapat dihubungi.",
      "Isi DATABASE_URL di setelan lingkungan, lalu deploy ulang.",
    );
  }

  const secretProblem = authSecretProblem();
  if (secretProblem) {
    recordProblem(
      "auth",
      secretProblem,
      "Buat satu dengan: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }

  // Socket dibuka LEBIH DULU. Halaman yang termuat dan menjelaskan masalahnya
  // jauh lebih berguna daripada kontainer yang tidak pernah sempat dijangkau.
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`[api] mendengarkan di :${PORT}`);

  if (!process.env.DATABASE_URL) {
    console.error("[api] berjalan dalam keadaan rusak — lihat pesan di atas.");
    return;
  }

  const ready = await applySchemaWithRetry();
  if (!ready) {
    const timer = setInterval(async () => {
      if (await applySchemaWithRetry()) {
        clearInterval(timer);
        console.log("[db] skema akhirnya berhasil diterapkan.");
        startBackgroundJobs();
      }
    }, 30_000);
    timer.unref?.();
    return;
  }

  startBackgroundJobs();
}

let backgroundJobsStarted = false;

async function startBackgroundJobs() {
  if (backgroundJobsStarted) return;
  backgroundJobsStarted = true;
  const { startSupersetSync } = await import("./sync-superset.mjs");
  startSupersetSync(pool);
  startHistoryPruning();
}

/**
 * Pemangkasan riwayat harian.
 *
 * `sync_runs` bertambah dua belas baris tiap jam dan hanya baris terakhirnya
 * yang pernah dibaca. Tanpa pemangkasan ia tumbuh selamanya, dan kueri
 * "sinkronisasi terakhir" di setiap snapshot papan makin lama makin mahal.
 */
function startHistoryPruning() {
  const prune = () =>
    rpc("inbound_prune_history")
      .then((result) => {
        const runs = result?.sync_runs_deleted ?? 0;
        const events = result?.ticket_events_deleted ?? 0;
        if (runs || events) console.log(`[db] pangkas riwayat: ${runs} sync_runs, ${events} ticket_events`);
      })
      .catch((error) => console.warn("[db] pemangkasan gagal", error.message));

  // Sekali saat start, lalu sekali sehari. Bukan pekerjaan yang mendesak, jadi
  // ia tidak boleh menahan proses tetap hidup saat shutdown.
  prune();
  setInterval(prune, 24 * 3600_000).unref?.();
}

/** Menutup koneksi dengan rapi supaya deploy ulang tidak memutus permintaan. */
function shutdown(signal) {
  console.log(`[api] ${signal}, menutup…`);
  // Pendengar dan setiap aliran SSE ditutup lebih dulu; koneksi yang menggantung
  // menahan server.close() sampai batas waktu paksa di bawah.
  live.close();
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((error) => {
  // Hanya kegagalan yang benar-benar tidak terduga yang sampai ke sini —
  // masalah konfigurasi dan skema sudah ditangani sebagai startupProblems di
  // atas. Bila socket bahkan tidak dapat dibuka, tidak ada yang berguna untuk
  // disajikan dan keluar adalah jawaban yang benar.
  console.error("[api] gagal start", error);
  process.exit(1);
});
