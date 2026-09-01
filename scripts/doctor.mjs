/* ============================================================================
 * PEMERIKSAAN KESEHATAN DEPLOYMENT
 *
 *   npm run doctor
 *
 * Menjawab pertanyaan yang tidak dapat dijawab layar login: mengapa sebuah akun
 * tidak bisa masuk, apakah backend yang ter-deploy sudah versi terbaru, dan
 * apakah master PO masih mengalir dari Superset.
 *
 * Skrip ini TIDAK PERNAH mengirim password. Ia hanya membaca endpoint
 * diagnostik yang melaporkan bentuk konfigurasi — jumlah akun, keabsahan JSON,
 * daftar role — tanpa membocorkan username maupun sandi.
 * ========================================================================== */

import { SUPABASE_FUNCTION_URL } from "../js/deployment.js";

const BASE = process.env.INBOUND_API_URL || SUPABASE_FUNCTION_URL;
const TIMEOUT_MS = 20000;

const ok = (text) => `  [32mOK[0m    ${text}`;
const warn = (text) => `  [33mWARN[0m  ${text}`;
const fail = (text) => `  [31mFAIL[0m  ${text}`;
const info = (text) => `        ${text}`;

let problems = 0;

async function call(action, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE}?action=${action}`, {
      ...options,
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* respons tanpa body, mis. 304 */
    }
    return { status: response.status, body, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

function humanAge(seconds) {
  if (!Number.isFinite(Number(seconds))) return "tidak diketahui";
  const value = Math.round(Number(seconds));
  if (value < 90) return `${value} detik`;
  const minutes = Math.round(value / 60);
  return minutes < 90 ? `${minutes} menit` : `${Math.round(minutes / 60)} jam`;
}

console.log(`\n  Antrian Inbound Frozen — doctor`);
console.log(`  Backend: ${BASE}\n`);

/* -- 1. Backend hidup ------------------------------------------------------ */
console.log("  Backend");
try {
  const health = await call("health");
  if (health.status === 200 && health.body?.ok) {
    console.log(ok(`Backend merespons — ${health.body.tickets ?? 0} tiket tercatat.`));
  } else {
    problems += 1;
    console.log(fail(`Health check mengembalikan HTTP ${health.status}.`));
  }
} catch (error) {
  problems += 1;
  console.log(fail(`Backend tidak dapat dihubungi: ${error.message}`));
}

/* -- 2. Versi yang ter-deploy ---------------------------------------------- */
try {
  const preflight = await call("board", {
    method: "OPTIONS",
    headers: {
      Origin: "https://example.invalid",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "if-none-match",
    },
  });
  const allowHeaders = (preflight.headers.get("access-control-allow-headers") || "").toLowerCase();
  const allowOrigin = preflight.headers.get("access-control-allow-origin") || "(tidak diset)";

  if (allowHeaders.includes("if-none-match")) {
    console.log(ok("Edge Function menerima If-None-Match, jadi cache ETag aktif."));
  } else {
    problems += 1;
    console.log(fail("Edge Function yang ter-deploy sudah usang — If-None-Match tidak diizinkan."));
    console.log(info("Setiap polling mengunduh body penuh, bukan 304."));
    console.log(info("Perbaikan: supabase functions deploy inbound-api --no-verify-jwt"));
  }
  console.log(info(`CORS memantulkan origin: ${allowOrigin}`));
} catch (error) {
  console.log(warn(`Preflight CORS tidak dapat diperiksa: ${error.message}`));
}

/* -- 3. Konfigurasi akun --------------------------------------------------- */
console.log("\n  Akun");
try {
  const auth = await call("auth_status");
  const data = auth.body?.data;

  if (auth.status === 404 || !data) {
    problems += 1;
    console.log(fail("Endpoint auth_status belum ada di backend yang ter-deploy."));
    console.log(info("Deploy ulang inbound-api, lalu jalankan doctor lagi."));
  } else if (!data.secret_present) {
    problems += 1;
    console.log(fail("INBOUND_AUTH_USERS belum diset — tidak ada akun yang dapat masuk."));
    console.log(info("Inilah penyebab paling umum akun admin tidak bisa login."));
    console.log(info('supabase secrets set INBOUND_AUTH_USERS=\'[{"username":"admin",...}]\''));
  } else if (!data.parse_ok) {
    problems += 1;
    console.log(fail(`INBOUND_AUTH_USERS tidak dapat dibaca: ${data.message}`));
  } else {
    console.log(ok(`${data.users_configured} akun terdaftar dengan role: ${data.roles.join(", ")}.`));

    if (data.unknown_roles?.length) {
      problems += 1;
      console.log(fail(`Role tidak dikenal: ${data.unknown_roles.join(", ")}.`));
      console.log(info("Akun dengan role ini dapat login tetapi ditolak oleh setiap aksi."));
    }
    if (data.accounts_missing_password) {
      problems += 1;
      console.log(fail(`${data.accounts_missing_password} akun tidak memiliki password.`));
    }
    if (!data.auth_secret_present) {
      problems += 1;
      console.log(fail("INBOUND_AUTH_SECRET belum diset — token sesi tidak dapat ditandatangani."));
    }
  }

  // Hanya dilaporkan bila auth_status benar-benar menjawab. Tanpa penjagaan
  // ini, backend lama yang belum mengenal auth_status akan dilaporkan sebagai
  // "APP_ORIGINS kosong" — padahal preflight di atas jelas memantulkan sebuah
  // origin, dan nasihatnya jadi menyesatkan.
  if (data?.allowed_origins) {
    const origins = data.allowed_origins;
    if (!origins.length) {
      console.log(warn("APP_ORIGINS kosong, sehingga CORS terbuka untuk semua origin."));
    } else {
      console.log(info(`Origin yang diizinkan: ${origins.join(", ")}`));
    }
  }
} catch (error) {
  problems += 1;
  console.log(fail(`Status akun tidak dapat dibaca: ${error.message}`));
}

/* -- 4. Sumber data PGS 160 ------------------------------------------------ */
console.log("\n  Sumber data");
console.log(info("Perlu sesi login, jadi dilewati bila tidak ada INBOUND_API_TOKEN."));
const token = process.env.INBOUND_API_TOKEN;
if (token) {
  try {
    const freshness = await call("source_freshness&site=PGS", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const source = freshness.body?.data;
    if (freshness.status === 401) {
      console.log(warn("Token tidak berlaku; jalankan ulang dengan token sesi yang masih hidup."));
    } else if (source) {
      const stale = Number(source.age_seconds) > 15 * 60;
      const line = `Master PO ${source.site_code} (${source.location_id}): ${source.total_po} PO, sync ${humanAge(source.age_seconds)} lalu.`;
      if (stale) {
        problems += 1;
        console.log(fail(line));
        console.log(info("Cron seharusnya lima menit sekali. Periksa cron.job dan SUPERSET_SESSION_COOKIE."));
      } else {
        console.log(ok(line));
      }
      if (source.last_run_error) console.log(warn(`Sync terakhir: ${source.last_run_error}`));
    }
  } catch (error) {
    console.log(warn(`Kesegaran sumber tidak dapat dibaca: ${error.message}`));
  }
}

/* -- Ringkasan ------------------------------------------------------------- */
console.log("");
if (problems === 0) {
  console.log("  Tidak ada masalah terdeteksi.\n");
} else {
  console.log(`  ${problems} masalah perlu ditangani.\n`);
  process.exitCode = 1;
}
