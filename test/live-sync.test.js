/* ============================================================================
 * KONTRAK SINKRONISASI LANGSUNG, DIAGNOSTIK AKUN, DAN DEPLOYMENT
 * ========================================================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const { read, schema, apiServer, importModule } = require("./helpers");

const migrations = schema();
const edge = apiServer();
const app = read("js/app.js");

/* -- 1. Kesegaran sumber PGS 160 ------------------------------------------- */

test("kesegaran sumber Superset ikut dalam setiap snapshot papan", () => {
  assert.match(migrations, /create or replace function inbound_source_freshness/);
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
  const sync = read("api/sync-superset.mjs");
  assert.match(sync, /site_master/, "site_master adalah sumber kebenaran gudang");
  assert.match(sync, /withSiteFilter/, "filter lokasi disuntikkan ke query_context");
  assert.match(migrations, /join site_master s on s\.location_id = m\.location_id and s\.active/);
});

test("halaman Pengaturan menampilkan rantai sumber secara terpisah", () => {
  const settings = read("js/pages/settings.js");
  assert.match(settings, /Master PO Superset/);
  assert.match(settings, /inbound-sync-superset-5m/);
  assert.match(settings, /SUPERSET_SESSION_COOKIE/);
});

test("tidak ada CTE yang menggabungkan alias.* dengan kolom join bernama sama", () => {
  // `select m.*, s.site_code` menghasilkan dua kolom `site_code` ketika tabel m
  // juga memilikinya, dan setiap rujukan tak berkualifikasi di bawahnya gagal
  // dengan "column reference is ambiguous". Ini menghentikan `supabase db push`
  // di tengah jalan, dan baru terlihat saat migrasi benar-benar dijalankan.
  const stars = [...migrations.matchAll(/select\s+([a-z])\.\*\s*,\s*([a-z])\./gi)];
  assert.deepEqual(
    stars.map((match) => match[0]),
    [],
    "db/schema.sql menggabungkan alias.* dengan kolom join; sebutkan kolomnya satu per satu",
  );
});

test("superset_po_master memang punya site_code sendiri", () => {
  // Alasan bug lama nyata: tabelnya punya site_code, jadi `m.*` bertabrakan
  // dengan `s.site_code` dan membuat setiap rujukan di bawahnya ambigu.
  assert.match(migrations, /create table if not exists superset_po_master[\s\S]*?site_code\s+text/);
});

/* -- 2. Diagnostik akun ---------------------------------------------------- */

test("salah konfigurasi akun dibedakan dari salah sandi", () => {
  // 401 dapat diperbaiki operator dengan mengetik ulang; 503 tidak bisa.
  assert.match(edge, /class AuthConfigError extends Error/);
  assert.match(edge, /if \(error instanceof AuthConfigError\)/);
  assert.match(edge, /send\(response, 503/);
  assert.match(edge, /INBOUND_AUTH_USERS belum diset/);
});

test("setiap kegagalan membaca daftar akun punya pesan sendiri", () => {
  [
    /belum diset/,
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
  assert.match(edge, /yang tidak dikenal/);
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

  // Yang dijaga adalah apa yang DIKIRIM, bukan kata yang muncul di keluaran:
  // doctor memang menyebut "password" saat melaporkan akun tanpa sandi.
  // Ia tidak boleh pernah mencoba login.
  assert.doesNotMatch(doctor, /action=login|"login"/, "doctor tidak boleh mencoba login");
  assert.doesNotMatch(doctor, /body:/, "doctor tidak boleh mengirim body permintaan sama sekali");
});

/* -- 3. Konfigurasi deployment --------------------------------------------- */

test("tidak ada URL backend yang tertanam di kode browser", async () => {
  const deployment = await importModule("js/deployment.js");
  assert.equal(deployment.API_PROXY_PATH, "/api/inbound");

  // Alamat backend hidup di docker-compose.yml (API_UPSTREAM), bukan di sini.
  // PRODUCTION_ORIGIN dikecualikan: ia hanya dokumentasi untuk doctor, tidak
  // pernah dipakai browser untuk memanggil apa pun.
  // localhost dikecualikan: js/api.js memakainya sebagai basis `new URL()`
  // untuk jalur relatif, bukan sebagai alamat backend.
  ["js/config.js", "js/api.js"].forEach((file) => {
    const remote = [...read(file).matchAll(/https?:\/\/[a-z0-9.-]+/gi)]
      .map((match) => match[0])
      .filter((url) => !url.includes("localhost"));
    assert.deepEqual(remote, [], `${file} tidak boleh memuat URL backend`);
  });
  assert.doesNotMatch(read("js/deployment.js"), /supabase/i, "tidak ada sisa Supabase");
});

test("pengembangan dan produksi memakai jalur API yang sama", async () => {
  // Keduanya memproksikan /api/inbound di origin yang sama, sehingga tidak ada
  // perilaku CORS yang hanya muncul di salah satunya.
  const { API_PROXY_PATH } = await importModule("js/deployment.js");
  assert.match(API_PROXY_PATH, /^\//, "jalur proksi harus relatif terhadap origin");
  assert.match(read("js/config.js"), /export const BACKEND_URL = API_PROXY_PATH/);
  // Proses Node yang sama melayani statis dan API, jadi jalur ini ditangani
  // di satu tempat — tidak ada proxy terpisah yang bisa menyimpang darinya.
  assert.ok(read("api/server.mjs").includes(`path !== "${API_PROXY_PATH}"`));
  assert.ok(read("scripts/dev-server.mjs").includes(`requestUrl.pathname === "${API_PROXY_PATH}"`));

  // URL relatif butuh basis, jika tidak `new URL()` melempar.
  assert.match(read("js/api.js"), /new URL\(BACKEND_URL, globalThis\.location\?\.origin/);
});

test("server pengembangan tidak pernah ikut ter-deploy", () => {
  const ignored = read(".vercelignore").split(/\r?\n/).map((line) => line.trim());
  assert.ok(ignored.includes("scripts"), "scripts/ harus dikecualikan dari paket statis");
});

test("panduan deployment menyebut setiap variabel yang wajib", () => {
  const guide = read("DEPLOYMENT.md");
  ["POSTGRES_PASSWORD", "INBOUND_AUTH_SECRET", "INBOUND_AUTH_USERS"].forEach((name) => {
    assert.ok(guide.includes(name), `${name} harus disebut di panduan`);
  });
  assert.match(guide, /Docker Compose/, "build pack Coolify harus disebut");
  assert.match(guide, /\/healthz/, "health check path harus disebut");
});

test("panduan memuat langkah verifikasi yang dapat dijalankan", () => {
  const guide = read("DEPLOYMENT.md");
  assert.match(guide, /npm run doctor/);
  assert.match(guide, /pg_dump/, "cadangan wajib disebut — data kini milik sendiri");
  assert.match(guide, /## Rollback/, "rollback wajib ada di runbook");
  assert.doesNotMatch(guide, /supabase/i, "tidak ada sisa instruksi Supabase");
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
  assert.match(push, /runNpm\("run check"\)/);
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
  // npm dijalankan sebagai satu string perintah. Bentuk ini memakai shell
  // tanpa memicu DEP0190, yang hanya berlaku ketika argumen dikirim terpisah
  // lalu digabung tanpa di-escape.
  assert.match(
    push,
    /execSync\(`npm \$\{script\}`, \{ stdio: "inherit" \}\)/,
    "npm dijalankan sebagai satu string perintah",
  );
});

test("kegagalan login menunjuk penyebab sebenarnya, bukan selalu sandi", () => {
  // Ketika proksi menjawab 502 karena layanan API belum berjalan, badannya
  // berisi HTML, JSON.parse gagal, dan pesan lama jatuh ke "Username atau
  // password salah" — menyalahkan sandi operator atas server yang bahkan tidak
  // menyala. Berjam-jam dapat terbuang mengganti sandi yang sudah benar.
  const api = read("js/api.js");
  assert.match(api, /function loginFailure\(status, body\)/);
  assert.match(api, /status === 502 \|\| status === 503 \|\| status === 504/);
  assert.match(api, /Layanan API tidak dapat dihubungi/);
  assert.match(api, /Server belum terkonfigurasi/);
  assert.match(api, /Tidak dapat menghubungi server/, "kegagalan jaringan juga dibedakan");

  // 401 tetap berbunyi seperti kredensial salah, karena memang itu artinya.
  assert.match(api, /if \(status === 401\) return new ApiError\("Username atau password salah\."/);

  // Pesan dari server selalu menang bila ada.
  assert.match(api, /if \(body\?\.message\) return new ApiError\(body\.message, status\)/);
});

test("token yang hilang tidak diperlakukan sebagai login berhasil", () => {
  // Respons 200 tanpa token pernah menyimpan sesi kosong dan melempar operator
  // ke papan yang setiap permintaannya langsung ditolak.
  assert.match(read("js/api.js"), /if \(!data\?\.token\) throw loginFailure/);
});
