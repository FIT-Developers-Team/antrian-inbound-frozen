/* ============================================================================
 * KONTRAK ARSITEKTUR, AKSESIBILITAS, DAN PERFORMA
 * ========================================================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  read,
  exists,
  listFiles,
  allFrontend,
  schema,
  apiServer,
  FRONTEND_MODULES,
  importModule,
} = require("./helpers");

const html = read("index.html");
const css = read("style.css");
const frontend = allFrontend();

/* -- Arsitektur ------------------------------------------------------------ */

test("kode mati dari arsitektur lama sudah dihapus", () => {
  // Fungsi Vercel di api/ tidak pernah ter-deploy: .vercelignore mengecualikan
  // seluruh foldernya dan tidak ada vercel.json. Ia hanya menambah dua
  // dependensi npm dan implementasi backend kedua yang bisa menyimpang.
  ["api/inbound.js", "api/sync-superset.js"].forEach((file) => {
    assert.ok(!exists(file), `${file} adalah backend duplikat yang tidak pernah ter-deploy`);
  });

  // Klien realtime selalu jatuh ke polling karena realtime_config
  // mengembalikan enabled:false, tetapi tetap terunduh pada setiap muat.
  ["js/realtime_client.js", "js/realtime_client_source.js", "js/api_v2.js"].forEach((file) => {
    assert.ok(!exists(file), `${file} sudah tidak dipakai`);
  });

  const pkg = JSON.parse(read("package.json"));
  ["pg", "@vercel/functions", "@supabase/realtime-js"].forEach((dependency) => {
    assert.ok(!pkg.dependencies[dependency], `dependensi ${dependency} ikut terhapus`);
  });
});

test("tidak ada definisi fungsi ganda yang saling menimpa", () => {
  // js/app.js versi lama memuat tiga belas fungsi yang didefinisikan dua kali;
  // definisi terakhir menang dan ribuan baris sisanya tetap dikirim ke browser.
  FRONTEND_MODULES.forEach((file) => {
    const names = [...read(file).matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map((m) => m[1]);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    assert.deepEqual(duplicates, [], `${file} memuat definisi ganda: ${duplicates.join(", ")}`);
  });
});

test("frontend dipecah menjadi modul ES, bukan satu berkas raksasa", () => {
  assert.match(html, /<script type="module"/);
  FRONTEND_MODULES.forEach((file) => {
    const lines = read(file).split("\n").length;
    assert.ok(lines < 600, `${file} harus tetap terbaca dalam satu duduk (${lines} baris)`);
  });
  assert.equal(JSON.parse(read("js/package.json")).type, "module");
});

test("hanya ada satu jalur ke backend", () => {
  assert.match(read("js/api.js"), /BACKEND_URL/);
  // Modul selain api.js tidak boleh memanggil fetch sendiri.
  FRONTEND_MODULES.filter((file) => file !== "js/api.js").forEach((file) => {
    assert.doesNotMatch(read(file), /\bfetch\(/, `${file} harus lewat js/api.js`);
  });
});

test("browser tidak pernah memegang rahasia sisi server", () => {
  [/service_role/i, /SUPABASE_SERVICE_ROLE/, /SYNC_SECRET/, /INBOUND_AUTH_SECRET/].forEach((pattern) => {
    assert.doesNotMatch(frontend, pattern, `rahasia ${pattern} tidak boleh ada di frontend`);
    assert.doesNotMatch(html, pattern);
  });
});

test("sesi kedaluwarsa membersihkan dirinya sendiri sekali di lapisan API", () => {
  const api = read("js/api.js");
  assert.match(api, /if \(response\.status === 401\)/);
  assert.match(api, /handleUnauthorized/);
  assert.match(api, /inbound:signed-out/);
});

/* -- Performa -------------------------------------------------------------- */

test("polling papan memakai ETag sehingga siklus tanpa perubahan dijawab 304", () => {
  const api = read("js/api.js");
  assert.match(api, /If-None-Match/);
  assert.match(api, /response\.status === 304/);
  // API membandingkan If-None-Match sendiri, tanpa helper terpisah.
  assert.match(apiServer(), /if-none-match/);
  assert.match(apiServer(), /send\(response, 304/);
  assert.match(schema(), /'fingerprint', md5\(/);
});

test("menulis membatalkan cache ETag agar papan tidak tampak tidak berubah", () => {
  assert.match(read("js/api.js"), /etagCache\.clear\(\);\n  return body\?\.data \?\? body;/);
});

test("papan mengirim satu baris per tiket, bukan satu baris per PO", () => {
  const sql = schema();
  assert.match(sql, /create or replace view inbound_board/);
  assert.match(sql, /with po_rollup as \(/, "PO harus diagregasi di server");
  assert.match(sql, /string_agg\(po_number/);
  assert.match(apiServer(), /inbound_board_snapshot/);
});

test("riwayat laporan dibatasi rentang tanggal di server", () => {
  assert.match(schema(), /create or replace function inbound_history/);
  assert.match(schema(), /b\.operational_date::date between x\.from_date and x\.to_date/);
  assert.match(read("js/api.js"), /export function fetchHistory\(from, to\)/);
});

test("polling tidak lebih cepat dari sepuluh detik dan berhenti saat tab tersembunyi", async () => {
  const { POLL_INTERVAL_MS } = await importModule("js/config.js");
  assert.ok(POLL_INTERVAL_MS >= 10000, "polling minimal sepuluh detik");
  assert.match(read("js/store.js"), /if \(!document\.hidden\) refresh\(\{ silent: true \}\)/);
});

test("index tersedia untuk jalur kueri papan", () => {
  assert.match(schema(), /create index if not exists tickets_board_idx/);
  assert.match(schema(), /create index if not exists ticket_pos_ticket_idx/);
});

/* -- Aksesibilitas --------------------------------------------------------- */

test("halaman menyediakan jalan pintas ke konten utama", () => {
  assert.match(read("js/app.js"), /class="skip-link" href="#page-root"/);
  assert.match(css, /\.skip-link \{/);
  assert.match(css, /\.skip-link:focus-visible/);
});

test("landmark dan label navigasi terbaca pembaca layar", () => {
  const app = read("js/app.js");
  assert.match(app, /<aside class="sidebar.*id="sidebar" aria-label="Menu utama"/);
  assert.match(app, /<nav id="side-nav" aria-label="Navigasi halaman"/);
  assert.match(app, /<main class="workspace" id="page-root"/);
  assert.match(app, /aria-current="page"/);
});

test("setiap tombol memiliki type eksplisit sehingga tidak ikut submit form", () => {
  const buttons = [...frontend.matchAll(/<button(?![^>]*type=)[^>]*>/g)];
  assert.deepEqual(buttons.map((match) => match[0]), [], "semua <button> harus punya atribut type");
});

test("tombol tanpa teks memiliki nama yang dapat diakses", () => {
  const iconOnly = [...frontend.matchAll(/<button[^>]*class="[^"]*icon-btn[^"]*"[^>]*>/g)];
  assert.ok(iconOnly.length > 0, "aplikasi memang memakai tombol ikon");
  iconOnly.forEach((match) => {
    assert.match(match[0], /aria-label=/, `tombol ikon tanpa nama: ${match[0]}`);
  });
});

test("keadaan buka-tutup diumumkan lewat aria-expanded", () => {
  const app = read("js/app.js");
  assert.match(app, /id="rail-toggle"[\s\S]*?aria-expanded=/);
  assert.match(app, /id="mobile-menu"[\s\S]*?aria-expanded="false"/);
  assert.match(app, /setAttribute\("aria-expanded", String\(open\)\)/);
});

test("toast diumumkan tanpa mencuri fokus", () => {
  assert.match(read("js/app.js"), /class="toast-stack" id="toast-stack" role="status" aria-live="polite"/);
  assert.match(css, /\.toast-stack \{[^}]*pointer-events: none/s);
});

test("konten menandai status memuat dan melepasnya setelah render", () => {
  const app = read("js/app.js");
  assert.match(app, /aria-busy="true"/);
  assert.match(app, /root\.setAttribute\("aria-busy", "false"\)/);
});

test("fokus keyboard selalu terlihat", () => {
  assert.match(css, /:focus-visible \{\s*outline: 3px solid/);
});

test("target sentuh memenuhi ukuran minimum di perangkat sentuh", () => {
  const coarse = css.slice(css.indexOf("@media (pointer: coarse)"));
  assert.match(coarse, /min-height: 46px/);
  assert.match(css, /\.btn \{[^}]*min-height: 40px/s);
});

test("preferensi gerakan minimal dihormati secara menyeluruh", () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(block, /animation-duration: 0\.001ms !important/);
  assert.match(block, /transition-duration: 0\.001ms !important/);
});

test("dialog mengembalikan fokus ke pemicunya dan menutup dengan Escape", () => {
  const ui = read("js/ui.js");
  assert.match(ui, /aria-modal="true"/);
  assert.match(ui, /openDialog\.opener\?\.focus\?\.\(\)/);
  assert.match(ui, /event\.key === "Escape"/);
});

test("halaman tetap informatif tanpa JavaScript", () => {
  assert.match(html, /<noscript>/);
  assert.match(html, /memerlukan JavaScript/);
});

test("dokumen membawa metadata dasar dan hint performa", () => {
  assert.match(html, /<html lang="id">/);
  assert.match(html, /name="description"/);
  assert.match(html, /name="theme-color"[^>]*prefers-color-scheme: dark/);
  assert.match(html, /rel="preconnect" href="https:\/\/fonts\.gstatic\.com"/);
  assert.match(html, /rel="preconnect" href="https:\/\/qiafoaoslnbmtsbnmqou\.supabase\.co"/);
});

test("tema dipasang sebelum paint pertama agar tidak ada kedipan putih", () => {
  const headScript = html.slice(html.indexOf("<script>"), html.indexOf("</script>"));
  assert.match(headScript, /localStorage\.getItem\("inbound_frozen_theme_v2"\)/);
  assert.match(headScript, /documentElement\.classList\.add\("dark"\)/);
});

test("versi aset frontend naik bersamaan agar cache lama tidak tercampur", () => {
  const versions = [...html.matchAll(/\?v=([\d.]+)/g)].map((match) => match[1]);
  assert.ok(versions.length >= 2, "CSS dan modul utama sama-sama berversi");
  assert.equal(new Set(versions).size, 1, `versi aset harus seragam, ditemukan ${versions.join(", ")}`);
});

/* -- Nilai yang dirender --------------------------------------------------- */

const XSS = '<img src=x onerror="alert(1)">';

test("escape membersihkan seluruh karakter yang berbahaya di HTML", async () => {
  const { esc } = await importModule("js/format.js");
  assert.equal(esc(XSS), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(esc("'\"&<>"), "&#39;&quot;&amp;&lt;&gt;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
});

test("primitif UI tidak pernah meloloskan markup dari nilai server", async () => {
  const ui = await importModule("js/ui.js");
  const { slaMarkup } = await importModule("js/sla.js");

  // Nama vendor bermuatan skrip adalah jalur termudah membawa XSS ke papan,
  // karena ia berasal dari master PO yang disinkronkan dari sistem lain.
  const outputs = [
    ui.badge(XSS, "muted"),
    ui.chip(XSS),
    ui.fact("Vendor", XSS),
    ui.emptyState(XSS, XSS),
    ui.metricCard({ label: XSS, value: XSS, sub: XSS }),
    ui.pageHeader({ eyebrow: XSS, title: XSS, description: XSS, scope: XSS }),
    ui.section({ title: XSS, eyebrow: XSS, body: "" }),
    slaMarkup({ sla_target_hours: 4, sla_deadline_at: XSS, sla_started_at: XSS }),
  ];

  outputs.forEach((html) => {
    assert.ok(!html.includes("<img"), `markup lolos: ${html}`);
    assert.ok(!html.includes('onerror="'), `atribut kejadian lolos: ${html}`);
    assert.ok(html.includes("&lt;img"), `nilai harus muncul sebagai teks: ${html}`);
  });
});

test("halaman tidak menyisipkan nilai server langsung ke posisi HTML", () => {
  // Setiap nilai baris harus lewat esc() atau primitif yang meng-escape.
  // Pola di bawah menangkap interpolasi yang mendarat langsung sebagai teks
  // elemen atau nilai atribut.
  ["js/pages/board.js", "js/pages/register.js", "js/pages/report.js", "js/pages/settings.js"].forEach((file) => {
    const source = read(file);
    const direct = [...source.matchAll(/(?:>|=")\$\{\s*(row|po|user|site|item)\./g)];
    assert.deepEqual(direct.map((m) => m[0]), [], `${file} menyisipkan nilai server tanpa escape`);
  });
});

/* -- Multi gudang ---------------------------------------------------------- */

test("registry gudang tetap sinkron dengan seed site_master", async () => {
  const { allSites, activeSites } = await importModule("js/config.js");
  const sites = allSites();
  assert.deepEqual(
    sites.map((site) => [site.code, site.location_id]),
    [["PGS", "160"], ["SRG", "796"], ["BIT", "983"], ["CSI", "998"]],
  );
  assert.deepEqual(activeSites().map((site) => site.code), ["PGS"], "hanya PGS yang aktif");

  const sql = schema();
  sites.forEach((site) => {
    assert.match(sql, new RegExp(`'${site.code}'\\s*,\\s*'${site.location_id}'`), `${site.code} harus ada di seed`);
  });
});

test("gate dibangkitkan dari prefix gudang, bukan daftar hardcoded", async () => {
  const { gateOptions, gateLabel, applyServerCatalog } = await importModule("js/config.js");
  const gates = gateOptions("PGS");
  assert.equal(gates.length, 9);
  assert.equal(gates[0], "PGS-GATE-INB-01-01");
  assert.equal(gateLabel("PGS-GATE-INB-01-03"), "PGS 03");

  // Katalog dari backend menang, sehingga menambah dock cukup di database.
  applyServerCatalog({ sites: [{ site_code: "PGS" }], gates: ["PGS-GATE-INB-01-01", "PGS-GATE-INB-01-02"] });
  assert.equal(gateOptions("PGS").length, 2);
});

test("tidak ada sisa identitas gudang lain di kode aplikasi", () => {
  assert.doesNotMatch(frontend, /getCibitungGateOptions/);
  assert.doesNotMatch(frontend, /\bCBT\b/);
  assert.doesNotMatch(frontend, /\b819\b/);
});

test("permintaan API selalu membawa kode gudang aktif", () => {
  assert.match(read("js/api.js"), /url\.searchParams\.set\("site", site\.code\)/);
  assert.match(read("js/api.js"), /site_code: site\?\.code/);
});

/* -- Paket deployment ------------------------------------------------------ */

test("paket deployment statis tidak membawa berkas backend atau rahasia", () => {
  const ignored = read(".vercelignore").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  ["supabase", "test", "android", "apps-script", "data", "scripts", ".env*"].forEach((entry) => {
    assert.ok(ignored.includes(entry), `${entry} harus dikecualikan dari paket statis`);
  });
});

test("skema aman diterapkan berulang kali", () => {
  // API menerapkan db/schema.sql pada SETIAP start, jadi setiap pernyataan
  // wajib idempoten — kalau tidak, kontainer gagal start pada deploy kedua.
  const sql = schema();
  const creates = [...sql.matchAll(/^create (?:or replace )?(?:table|index|view|function|extension)[^;(]*/gim)];
  assert.ok(creates.length > 20, "skema harus punya banyak objek");
  creates.forEach((match) => {
    const statement = match[0];
    assert.ok(
      /if not exists/i.test(statement) || /or replace/i.test(statement),
      `tidak idempoten: ${statement.slice(0, 70)}`,
    );
  });
});
