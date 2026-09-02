/* ============================================================================
 * KONTRAK IMAGE PRODUKSI
 *
 * Satu kontainer menyajikan berkas statis sekaligus melayani API. Berkas ini
 * menjaga agar image tetap ramping, tidak membawa rahasia, dan tidak
 * mengulangi jebakan cache yang sudah pernah menggigit.
 * ========================================================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const { read, exists, importModule } = require("./helpers");

const dockerfile = read("Dockerfile");
const dockerignore = read(".dockerignore");
const compose = read("docker-compose.yml");
const staticServer = read("api/static.mjs");
const server = read("api/server.mjs");

/* -- Build ----------------------------------------------------------------- */

test("Dockerfile dan compose ada di akar repo", () => {
  // Coolify membaca keduanya dari akar; bila hilang, build pack apa pun gagal
  // sebelum sempat menjalankan apa-apa.
  assert.ok(exists("Dockerfile"));
  assert.ok(exists("docker-compose.yml"));
  assert.ok(exists("docker-compose.local.yml"));
  assert.ok(exists("db/schema.sql"));
});

test("satu kontainer menyajikan statis dan API sekaligus", () => {
  // Susunan dua kontainer (nginx + API) membuat setiap kegagalan deployment
  // bermuara pada sambungan di antara keduanya: proxy hidup, API tidak, lalu
  // operator melihat 502. Menyatukannya menghapus kelas kegagalan itu.
  assert.match(dockerfile, /CMD \["node", "api\/server\.mjs"\]/);
  assert.match(server, /createStaticHandler/);
  assert.ok(!exists("deploy/nginx.conf.template"), "nginx tidak lagi dipakai");
});

test("image membawa kode, skema, dan paket statis — tidak lebih", () => {
  assert.match(dockerfile, /COPY api\/ \.\/api\//);
  assert.match(dockerfile, /COPY db\/ \.\/db\//);
  assert.match(dockerfile, /COPY index\.html style\.css \.\//);
  assert.match(dockerfile, /COPY js\/ \.\/js\//);
  assert.match(dockerfile, /COPY assets\/ \.\/assets\//);

  [/COPY \. /, /COPY \.\/ /, /ADD \. /].forEach((pattern) => {
    assert.doesNotMatch(dockerfile, pattern, "jangan menyalin seluruh konteks ke dalam image");
  });
});

test("konteks build mengecualikan yang berat dan yang rahasia", () => {
  ["node_modules/", "android/", ".git/", "test/", "scripts/", "data/"].forEach((entry) => {
    assert.ok(dockerignore.includes(entry), `${entry} harus dikecualikan dari konteks build`);
  });
  [".env", ".dev.vars", "*.pem"].forEach((entry) => {
    assert.ok(dockerignore.includes(entry), `${entry} harus dikecualikan`);
  });
});

test("berjalan sebagai pengguna tak berhak", () => {
  assert.match(dockerfile, /^USER node$/m);
});

/* -- Cache ----------------------------------------------------------------- */

test("js dan css tidak pernah di-cache lama", () => {
  // Hanya index.html yang menautkan app.js?v=N dan style.css?v=N. Sebelas modul
  // yang diimpor app.js diminta tanpa query versi, karena begitulah
  // `import "./config.js"` bekerja. Cache panjang berarti deploy berikutnya
  // mengirim app.js baru di atas sebelas modul lama.
  assert.match(staticServer, /function cacheControl\(pathname\)/);
  assert.match(staticServer, /return "no-cache"/);
  assert.match(staticServer, /pathname\.startsWith\("\/assets\/"\)/, "hanya assets/ yang di-cache lama");
});

test("penyajian statis tidak dapat keluar dari folder publik", () => {
  assert.match(staticServer, /normalize\(decoded\)/);
  assert.match(staticServer, /decodeURIComponent\(pathname\)/);
  assert.match(staticServer, /403/);

  // Batasnya diperiksa dengan pemisah jalur, bukan sekadar awalan string:
  // `startsWith("/app")` juga meloloskan `/app-rahasia/keys.env`.
  assert.match(staticServer, /ROOT_PREFIX = ROOT\.endsWith\(sep\)/);
  assert.match(staticServer, /!file\.startsWith\(ROOT_PREFIX\)/);
});

test("tipe konten modul ES benar", () => {
  // Browser menolak menjalankan modul yang dikirim dengan tipe salah.
  assert.match(staticServer, /"\.js": "text\/javascript; charset=utf-8"/);
});

/* -- Port & health --------------------------------------------------------- */

test("port dapat diatur dan EXPOSE menyebutkannya", () => {
  // Coolify membaca EXPOSE untuk menentukan port yang dirutekan proxy-nya.
  assert.match(dockerfile, /ENV PORT=3000/);
  assert.match(dockerfile, /EXPOSE 3000/);
  assert.match(server, /Number\(process\.env\.PORT\)/);
});

test("health check tidak bergantung pada database", () => {
  // Database yang bermasalah tidak boleh membuat platform mengira kontainernya
  // mati lalu menggulung deployment yang sebenarnya sehat.
  const health = server.slice(
    server.indexOf('if (path === "/healthz")'),
    server.indexOf('if (path !== "/api/inbound")'),
  );
  assert.match(health, /send\(response, 200, \{ ok: true \}\)/);
  assert.doesNotMatch(health, /rpc\(/, "healthz tidak boleh menyentuh Postgres");
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /healthz/);
});

/* -- Compose --------------------------------------------------------------- */

test("compose tidak menerbitkan port ke host di produksi", () => {
  // Proxy Coolify sudah memegang port 80/443 host dan menjangkau layanan lewat
  // jaringan internal; menerbitkan port justru berebut dengannya.
  assert.match(compose, /expose:/);
  assert.doesNotMatch(compose, /^\s+ports:/m, "pemetaan port hanya ada di override lokal");
  assert.match(read("docker-compose.local.yml"), /ports:/);
});

test("compose menolak start tanpa rahasia yang wajib", () => {
  // Lebih baik gagal terang-terangan saat deploy daripada menyalakan aplikasi
  // yang setiap login-nya pasti ditolak.
  ["POSTGRES_PASSWORD", "INBOUND_AUTH_USERS", "INBOUND_AUTH_SECRET"].forEach((name) => {
    assert.match(compose, new RegExp(`\\$\\{${name}:\\?`), `${name} harus wajib`);
  });
});

test("aplikasi menunggu database siap sebelum start", () => {
  // Penerapan skema tidak boleh berlomba dengan Postgres yang belum menerima
  // koneksi.
  assert.match(compose, /condition: service_healthy/);
  assert.match(compose, /pg_isready/);
});

test("data operasional ada di volume bernama", () => {
  assert.match(compose, /inbound-db:\/var\/lib\/postgresql\/data/);
  assert.match(compose, /^volumes:/m);
});

/* -- Frontend -------------------------------------------------------------- */

test("frontend memanggil API di origin yang sama", async () => {
  const deployment = await importModule("js/deployment.js");
  assert.equal(deployment.API_PROXY_PATH, "/api/inbound");
  assert.match(read("js/config.js"), /export const BACKEND_URL = API_PROXY_PATH/);
  // Proses yang sama melayani keduanya, jadi tidak ada proxy yang bisa putus.
  assert.match(server, /path !== "\/api\/inbound"/);
});
