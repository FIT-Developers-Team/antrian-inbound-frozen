/* ============================================================================
 * PEMERIKSAAN KESEHATAN DEPLOYMENT
 *
 *   npm run doctor                       -- memeriksa http://localhost:8090
 *   INBOUND_URL=https://... npm run doctor
 *
 * Menjawab pertanyaan yang tidak dapat dijawab layar login: mengapa sebuah akun
 * tidak bisa masuk, apakah API tersambung ke database, dan apakah master PO
 * masih mengalir dari Superset.
 *
 * Skrip ini TIDAK PERNAH mengirim password. Ia hanya membaca endpoint
 * diagnostik yang melaporkan bentuk konfigurasi — jumlah akun, keabsahan JSON,
 * daftar role — tanpa membocorkan username maupun sandi.
 * ========================================================================== */

import { PRODUCTION_ORIGIN } from "../js/deployment.js";

const BASE = (process.env.INBOUND_URL || "http://localhost:8090").replace(/\/$/, "");
const TIMEOUT_MS = 15000;

const ok = (text) => `  [32mOK[0m    ${text}`;
const warn = (text) => `  [33mWARN[0m  ${text}`;
const fail = (text) => `  [31mFAIL[0m  ${text}`;
const info = (text) => `        ${text}`;

let problems = 0;

async function call(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE}${path}`, { signal: controller.signal });
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* respons tanpa body */
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
console.log(`  Target: ${BASE}`);
if (BASE.includes("localhost")) console.log(`  (produksi: ${PRODUCTION_ORIGIN} — pakai INBOUND_URL untuk memeriksanya)`);
console.log("");

/* -- 1. Web ---------------------------------------------------------------- */
console.log("  Web");
try {
  const health = await call("/healthz");
  if (health.status === 200) {
    console.log(ok("Aplikasi hidup dan menyajikan berkas statis."));
  } else if ([502, 503, 504].includes(health.status)) {
    // Inilah tampilan "no available server" dari sisi luar: proxy platform
    // menjawab, tetapi tidak ada kontainer di belakangnya untuk dirutekan.
    problems += 1;
    console.log(fail(`Proxy menjawab HTTP ${health.status} — tidak ada kontainer aplikasi yang hidup.`));
    console.log(info('Inilah yang dilaporkan Coolify sebagai "no available server".'));
    console.log(info("Kontainer kemungkinan keluar berulang kali. Buka log aplikasi di Coolify;"));
    console.log(info("baris yang diawali [db] atau [auth] menyebut penyebabnya."));
    console.log(info("Tersering: DATABASE_URL atau INBOUND_AUTH_SECRET belum diisi."));
  } else {
    problems += 1;
    console.log(fail(`/healthz mengembalikan HTTP ${health.status}.`));
  }
} catch (error) {
  problems += 1;
  console.log(fail(`Web tidak dapat dihubungi: ${error.message}`));
  console.log(info("Periksa domain dan apakah deployment sudah selesai."));
}

/* -- 2. API + database ----------------------------------------------------- */
console.log("\n  API & database");
try {
  const health = await call("/api/inbound?action=health");
  const data = health.body;

  // Masalah yang dilaporkan aplikasi tentang dirinya sendiri selalu
  // didahulukan: ia menyebut penyebab DAN tindakannya, dan itu jauh lebih
  // berguna daripada tebakan apa pun dari sisi luar.
  const reported = Array.isArray(data?.problems) ? data.problems : [];

  if (reported.length) {
    reported.forEach((problem) => {
      problems += 1;
      console.log(fail(`[${problem.area}] ${problem.message}`));
      if (problem.hint) console.log(info(problem.hint));
    });
  } else if ([502, 503, 504].includes(health.status)) {
    problems += 1;
    console.log(fail(`Proxy menjawab HTTP ${health.status}; aplikasi tidak terjangkau.`));
    console.log(info("Buka log aplikasi di Coolify untuk melihat penyebabnya."));
  } else if (data?.ok) {
    console.log(ok(`API tersambung ke Postgres — ${data.tickets ?? 0} tiket, gudang aktif ${(data.active_sites || []).join(", ")}.`));
    console.log(info(`Master PO: ${data.po_master_rows ?? 0} baris.`));
  } else {
    problems += 1;
    console.log(fail(`Health check mengembalikan HTTP ${health.status}.`));
  }
} catch (error) {
  problems += 1;
  console.log(fail(`API tidak dapat dihubungi: ${error.message}`));
}

/* -- 3. Akun --------------------------------------------------------------- */
console.log("\n  Akun");
try {
  const auth = await call("/api/inbound?action=auth_status");
  const data = auth.body?.data;

  if (!data) {
    problems += 1;
    console.log(fail("auth_status tidak menjawab; API kemungkinan belum jalan."));
  } else if (!data.secret_present) {
    problems += 1;
    console.log(fail("INBOUND_AUTH_USERS belum diset — tidak ada akun yang dapat masuk."));
    console.log(info("Penyebab paling umum akun admin tidak bisa login."));
    console.log(info("Set di environment Coolify, lalu redeploy."));
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
} catch (error) {
  problems += 1;
  console.log(fail(`Status akun tidak dapat dibaca: ${error.message}`));
}

/* -- 4. Sumber data -------------------------------------------------------- */
console.log("\n  Sumber data (Superset)");
try {
  const health = await call("/api/inbound?action=health");
  const last = health.body?.last_superset_sync;
  const rows = health.body?.po_master_rows ?? 0;

  if (!last) {
    console.log(warn("Belum pernah sync. Master PO kosong; pendaftaran harus memakai PO manual."));
    console.log(info("Set SUPERSET_SESSION_COOKIE untuk menyalakan sync."));
  } else {
    const age = (Date.now() - new Date(last).getTime()) / 1000;
    const line = `Master PO: ${rows} baris, sync ${humanAge(age)} lalu.`;
    if (age > 15 * 60) {
      problems += 1;
      console.log(fail(line));
      console.log(info("Sync seharusnya lima menit sekali. SUPERSET_SESSION_COOKIE kemungkinan kedaluwarsa."));
      console.log(info("Periksa log aplikasi di Coolify, cari baris [superset]."));
    } else {
      console.log(ok(line));
    }
  }
} catch {
  console.log(warn("Kesegaran sumber tidak dapat dibaca."));
}

/* -- Ringkasan ------------------------------------------------------------- */
console.log("");
if (problems === 0) {
  console.log("  Tidak ada masalah terdeteksi.\n");
} else {
  console.log(`  ${problems} masalah perlu ditangani.\n`);
  process.exitCode = 1;
}
