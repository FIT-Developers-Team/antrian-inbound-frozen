/* ============================================================================
 * KONTRAK SINKRONISASI LANGSUNG, DIAGNOSTIK AKUN, DAN DEPLOYMENT
 * ========================================================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const { read, allMigrations, importModule } = require("./helpers");

const migrations = allMigrations();
const edge = read("supabase/functions/inbound-api/index.ts");
const app = read("js/app.js");

/* -- 1. Kesegaran sumber PGS 160 ------------------------------------------- */

test("kesegaran sumber Superset ikut dalam setiap snapshot papan", () => {
  assert.match(migrations, /create or replace function public\.inbound_source_freshness/);
  // Ikut di snapshot supaya UI tidak perlu permintaan kedua tiap 15 detik.
  assert.match(migrations, /'source', freshness\.payload/);
  assert.match(read("js/store.js"), /state\.source = payload\?\.source \|\| null/);
});

test("umur sumber dihitung server, bukan dari jam browser", () => {
  // Tablet gudang kerap meleset beberapa menit; "sync 4 menit lalu" yang
  // dihitung dari jam yang salah justru menyembunyikan sync yang macet.
  assert.match(migrations, /'age_seconds',\s*case when master\.last_synced_at is not null/);
  assert.match(migrations, /extract\(epoch from \(now\(\) - master\.last_synced_at\)\)::int/);
});

test("fingerprint ikut berubah ketika hanya sumber yang diperbarui", () => {
  // Tanpa ini, sync Superset yang baru masuk tidak mengubah ETag selama tidak
  // ada tiket yang berubah, dan indikator di layar membeku.
  const snapshot = migrations.slice(migrations.lastIndexOf("'fingerprint', md5("));
  assert.match(snapshot, /freshness\.payload->>'last_synced_at'/);
});

test("sumber yang basi mengalahkan status koneksi di pil topbar", () => {
  assert.match(app, /store\.sourceIsStale\(source\)/);
  assert.match(app, /Sumber \$\{source\.location_id \|\| "PGS"\} basi/);
});

test("ambang basi adalah tiga siklus cron yang terlewat", async () => {
  const store = await importModule("js/store.js");
  assert.equal(store.SOURCE_STALE_SECONDS, 15 * 60, "cron lima menit, ambang lima belas menit");
  assert.equal(store.sourceIsStale({ age_seconds: 300 }), false);
  assert.equal(store.sourceIsStale({ age_seconds: 1200 }), true);
  // Sumber yang belum pernah tersinkron bukan "basi" — ia belum diketahui.
  assert.equal(store.sourceIsStale({}), false);
  assert.equal(store.sourceIsStale(null), false);
});

test("sync Superset tetap menyaring ke gudang aktif saja", () => {
  const sync = read("supabase/functions/sync-superset/index.ts");
  assert.match(sync, /site_master/, "site_master adalah sumber kebenaran gudang");
  assert.match(sync, /withSiteFilter/, "filter lokasi disuntikkan ke query_context");
  assert.match(migrations, /join public\.site_master s on s\.location_id = m\.location_id and s\.active/);
});

test("halaman Pengaturan menampilkan rantai sumber secara terpisah", () => {
  const settings = read("js/pages/settings.js");
  assert.match(settings, /Master PO Superset/);
  assert.match(settings, /inbound-sync-superset-5m/);
  assert.match(settings, /SUPERSET_SESSION_COOKIE/);
});

/* -- 2. Diagnostik akun ---------------------------------------------------- */

test("salah konfigurasi akun dibedakan dari salah sandi", () => {
  // 401 dapat diperbaiki operator dengan mengetik ulang; 503 tidak bisa.
  assert.match(edge, /class AuthConfigError extends Error/);
  assert.match(edge, /if \(error instanceof AuthConfigError\)/);
  assert.match(edge, /return jsonResponse\(request, 503/);
  assert.match(edge, /INBOUND_AUTH_USERS belum diset di Supabase Secrets/);
});

test("setiap kegagalan membaca daftar akun punya pesan sendiri", () => {
  [
    /belum diset di Supabase Secrets/,
    /bukan JSON yang sah/,
    /harus berupa JSON array/,
    /array kosong/,
  ].forEach((pattern) => {
    assert.match(edge, pattern, `pesan konfigurasi hilang: ${pattern}`);
  });
});

test("role yang tidak dikenal ditolak saat login, bukan saat memakai aksi", () => {
  // Akun dengan role salah ketik dulu berhasil masuk lalu ditolak oleh setiap
  // aksi, yang di layar tampak seperti aplikasi rusak.
  assert.match(edge, /if \(!KNOWN_ROLES\.includes\(role\)\)/);
  assert.match(edge, /role "\$\{clean\(user\.role\)\}" yang tidak dikenal/);
});

test("diagnostik akun tidak membocorkan username maupun password", () => {
  const start = edge.indexOf("function authStatus()");
  const body = edge.slice(start, edge.indexOf("\n}", start));
  assert.ok(start > 0, "authStatus harus ada");
  assert.doesNotMatch(body, /user\.username/, "username tidak boleh dilaporkan");
  assert.doesNotMatch(body, /user\.password[^)]*\)[^;]*return/, "password tidak boleh dilaporkan");
  assert.match(body, /users_configured/);
  assert.match(body, /parse_ok/);
  assert.match(body, /unknown_roles/);
});

test("doctor memeriksa akun tanpa pernah mengirim password", () => {
  const doctor = read("scripts/doctor.mjs");
  assert.match(doctor, /auth_status/);
  assert.match(doctor, /if-none-match/, "doctor mendeteksi Edge Function yang usang");

  // Yang dijaga adalah apa yang DIKIRIM, bukan kata yang muncul di keluaran:
  // doctor memang menyebut "password" saat melaporkan akun tanpa sandi.
  // Ia tidak boleh pernah mencoba login.
  assert.doesNotMatch(doctor, /action=login|"login"/, "doctor tidak boleh mencoba login");
  assert.doesNotMatch(doctor, /body:/, "doctor tidak boleh mengirim body permintaan sama sekali");
});

/* -- 3. Konfigurasi deployment --------------------------------------------- */

test("URL backend hanya didefinisikan di satu berkas", async () => {
  const deployment = await importModule("js/deployment.js");
  assert.match(deployment.SUPABASE_FUNCTION_URL, /^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/inbound-api$/);

  // Setiap pemakai membaca dari deployment.js, bukan menuliskan URL-nya sendiri.
  ["js/config.js", "scripts/dev-server.mjs", "scripts/doctor.mjs"].forEach((file) => {
    const source = read(file);
    assert.match(source, /from "\.\.?\/(js\/)?deployment\.js"/, `${file} harus mengimpor konfigurasi deployment`);
    assert.doesNotMatch(source, /https:\/\/[a-z0-9]+\.supabase\.co/, `${file} tidak boleh memuat URL Supabase sendiri`);
  });
});

test("localhost memakai proksi same-origin, produksi memanggil Supabase langsung", () => {
  const config = read("js/config.js");
  assert.match(config, /function isLocalhost\(\)/);
  assert.match(config, /BACKEND_URL = isLocalhost\(\) \? "\/api\/inbound" : SUPABASE_FUNCTION_URL/);
  // URL relatif butuh basis, jika tidak `new URL()` melempar.
  assert.match(read("js/api.js"), /new URL\(BACKEND_URL, globalThis\.location\?\.origin/);
});

test("server pengembangan tidak pernah ikut ter-deploy", () => {
  const ignored = read(".vercelignore").split(/\r?\n/).map((line) => line.trim());
  assert.ok(ignored.includes("scripts"), "scripts/ harus dikecualikan dari paket statis");
});

test("panduan deployment menyebut langkah CORS yang mudah terlewat", () => {
  const guide = read("DEPLOYMENT.md");
  assert.match(guide, /APP_ORIGINS/);
  assert.match(guide, /js\/deployment\.js/);
  assert.match(guide, /supabase functions deploy inbound-api --no-verify-jwt/);
  assert.match(guide, /capacitor\.config\.json/, "origin Android harus ikut disebut");
});

/* -- 4. Auto commit & push ------------------------------------------------- */

test("push otomatis menolak berkas yang tampak memuat rahasia", () => {
  const push = read("scripts/autopush.mjs");
  assert.match(push, /const FORBIDDEN = \[/);
  [/\\\.env/, /service\[_-\]\?role/, /\\\.pem\$/, /id_rsa/].forEach((pattern) => {
    assert.match(push, pattern, `pola rahasia hilang: ${pattern}`);
  });
  assert.match(push, /process\.exit\(1\)/);
});

test("push otomatis menjalankan gerbang mutu sebelum mendorong", () => {
  const push = read("scripts/autopush.mjs");
  assert.match(push, /runNpm\("run", "check"\)/);
  assert.match(push, /runNpm\("test"\)/);
  // Rebase dahulu supaya commit orang lain tidak tertimpa.
  assert.match(push, /"pull", "--rebase", "origin", BRANCH/);
  assert.match(push, /const BRANCH = "main"/);
});

test("git dipanggil tanpa shell agar pesan commit tidak terpecah", () => {
  // Di Windows, `shell: true` membuat shell memecah ulang argumen, sehingga
  // pesan commit berisi spasi berubah menjadi banyak pathspec dan commit gagal.
  const push = read("scripts/autopush.mjs");
  assert.match(
    push,
    /execFileSync\("git", parameters, \{ stdio: "inherit" \}\)/,
    "git dijalankan langsung, tanpa opsi shell",
  );
  assert.match(
    push,
    /execFileSync\("npm", parameters, \{ stdio: "inherit", shell: process\.platform === "win32" \}\)/,
    "npm.cmd justru memerlukan shell di Windows",
  );
});
