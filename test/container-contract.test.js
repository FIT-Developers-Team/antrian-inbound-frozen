/* ============================================================================
 * KONTRAK IMAGE PRODUKSI (COOLIFY)
 *
 * Coolify membangun dari Dockerfile. Berkas ini menjaga agar image tetap
 * ramping, tidak membawa rahasia, dan tidak mengulangi jebakan cache serta DNS
 * yang sudah pernah menggigit.
 * ========================================================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const { read, exists, importModule } = require("./helpers");

const dockerfile = read("Dockerfile");
const dockerignore = read(".dockerignore");
const nginx = read("deploy/nginx.conf.template");
const resolver = read("deploy/10-resolver.sh");

/* -- Build ----------------------------------------------------------------- */

test("Dockerfile ada — inilah yang membuat build Coolify gagal", () => {
  assert.ok(exists("Dockerfile"), "Coolify build pack Dockerfile menuntut berkas ini");
  assert.ok(exists("deploy/nginx.conf.template"));
  assert.ok(exists("deploy/10-resolver.sh"));
});

test("image hanya membawa paket statis, bukan backend atau perkakas", () => {
  // Yang tidak pernah tersalin ke image mustahil bocor darinya.
  assert.match(dockerfile, /COPY index\.html style\.css \.\//);
  assert.match(dockerfile, /COPY js\/ \.\/js\//);
  assert.match(dockerfile, /COPY assets\/ \.\/assets\//);

  [/COPY \. /, /COPY \.\/ /, /ADD \. /].forEach((pattern) => {
    assert.doesNotMatch(dockerfile, pattern, "jangan menyalin seluruh konteks ke dalam image");
  });
});

test("konteks build mengecualikan yang berat dan yang rahasia", () => {
  // Muatan statisnya ~270 KB; tanpa daftar ini konteks build ~225 MB, dan
  // seluruhnya diunggah ke daemon pada setiap deploy.
  ["node_modules/", "android/", ".git/", "supabase/", "test/", "scripts/", "data/"].forEach((entry) => {
    assert.ok(dockerignore.includes(entry), `${entry} harus dikecualikan dari konteks build`);
  });
  [".env", ".dev.vars", "*.pem"].forEach((entry) => {
    assert.ok(dockerignore.includes(entry), `${entry} harus dikecualikan`);
  });
});

test("image tidak menjalankan Node maupun memasang dependensi", () => {
  // Aplikasi ini tidak punya langkah build; menambahkan npm ke image hanya
  // memperbesar permukaan serangan tanpa memberi apa pun.
  assert.doesNotMatch(dockerfile, /npm (install|ci|run)/);
  assert.doesNotMatch(dockerfile, /FROM node/);
  assert.match(dockerfile, /FROM nginx:[\d.]+-alpine/);
});

/* -- Cache ----------------------------------------------------------------- */

test("js dan css tidak pernah di-cache lama", () => {
  // Hanya index.html yang menautkan app.js?v=N dan style.css?v=N. Sebelas modul
  // yang diimpor app.js diminta tanpa query versi, karena begitulah
  // `import "./config.js"` bekerja. Cache panjang di js/ berarti deploy
  // berikutnya tidak pernah sampai ke browser operator.
  const jsBlock = nginx.slice(nginx.indexOf("location ~* \\.(js|css)$"));
  assert.match(jsBlock, /Cache-Control "no-cache"/);
  assert.doesNotMatch(nginx.slice(0, nginx.indexOf("location /assets/")), /expires\s+\d+[dy]/);
});

test("assets boleh di-cache lama tetapi hanya lewat satu header", () => {
  const assetBlock = nginx.slice(nginx.indexOf("location /assets/"));
  assert.match(assetBlock, /max-age=2592000/);
  // `expires` dan `add_header Cache-Control` sama-sama memancarkan header itu;
  // memakai keduanya mengirimkannya dua kali.
  assert.doesNotMatch(assetBlock.slice(0, assetBlock.indexOf("location /")), /expires /);
});

/* -- Proksi API ------------------------------------------------------------ */

test("resolver diturunkan saat runtime, tidak dipatok ke DNS internal Docker", () => {
  // 127.0.0.11 hanya ada pada jaringan buatan pengguna. Di jaringan bridge
  // bawaan ia menolak koneksi, dan setiap permintaan API menjadi 502 walaupun
  // kontainernya jelas dapat menghubungi internet.
  assert.doesNotMatch(nginx, /resolver\s+127\.0\.0\.11/, "jangan patok DNS internal Docker");
  assert.match(resolver, /awk '\/\^nameserver\/ \{ print \$2 \}' \/etc\/resolv\.conf/);
  assert.match(resolver, /ipv6=off/);
  assert.match(dockerfile, /docker-entrypoint\.d\/10-resolver\.sh/);
});

test("proksi meneruskan header yang menentukan autentikasi dan cache", () => {
  const proxy = nginx.slice(nginx.indexOf("location = /api/inbound"), nginx.indexOf("---- Berkas statis"));
  assert.match(proxy, /proxy_set_header Authorization \$http_authorization/, "sesi HMAC harus lolos");
  // Tanpa If-None-Match, server tidak pernah dapat menjawab 304 dan setiap
  // polling mengunduh payload penuh.
  assert.match(proxy, /proxy_set_header If-None-Match \$http_if_none_match/);
  // SNI: tanpa ini Supabase menolak handshake TLS.
  assert.match(proxy, /proxy_ssl_server_name on/);
  assert.match(proxy, /proxy_ssl_name \$supabase_host/);
});

test("host Supabase disisipkan saat runtime, bukan dipatok di image", () => {
  assert.match(nginx, /\$\{SUPABASE_PROJECT_REF\}\.supabase\.co/);
  assert.match(dockerfile, /ENV SUPABASE_PROJECT_REF=/);
});

test("health check tidak bergantung pada Supabase", () => {
  // Backend yang bermasalah tidak boleh membuat Coolify mengira kontainernya
  // mati lalu menggulung deployment yang sebenarnya sehat.
  const health = nginx.slice(nginx.indexOf("location = /healthz"), nginx.indexOf("---- Proksi API"));
  assert.match(health, /return 200/);
  assert.doesNotMatch(health, /proxy_pass/);
  assert.match(dockerfile, /HEALTHCHECK/);
  // Health check mengikuti port yang sama dengan yang didengarkan nginx.
  assert.match(dockerfile, /localhost:\$\{NGINX_PORT\}\/healthz/);
});

test("port dapat diatur lewat lingkungan", () => {
  // Platform menyimpan setelan port per aplikasi, dan setelan itu dibuat
  // sebelum Dockerfile ini ada — sehingga proxy dapat menembak port yang tidak
  // didengarkan siapa pun, menghasilkan Bad Gateway walau kontainernya sehat.
  assert.match(nginx, /listen \$\{NGINX_PORT\}/);
  assert.match(nginx, /listen \[::\]:\$\{NGINX_PORT\}/);
  assert.match(dockerfile, /ENV NGINX_PORT=80/);
});

/* -- Frontend ------------------------------------------------------------- */

test("frontend memakai proksi same-origin sehingga CORS berhenti jadi masalah", async () => {
  const deployment = await importModule("js/deployment.js");
  assert.equal(deployment.USE_API_PROXY, true);
  assert.equal(deployment.API_PROXY_PATH, "/api/inbound");

  // Jalur di frontend harus sama persis dengan blok location nginx.
  assert.ok(
    nginx.includes(`location = ${deployment.API_PROXY_PATH}`),
    "jalur proksi frontend dan nginx harus cocok",
  );

  const config = read("js/config.js");
  assert.match(config, /isLocalhost\(\) \|\| USE_API_PROXY \? API_PROXY_PATH : SUPABASE_FUNCTION_URL/);
});

test("header keamanan dasar terpasang", () => {
  ["X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"].forEach((header) => {
    assert.match(nginx, new RegExp(header), `${header} harus diset`);
  });
});
