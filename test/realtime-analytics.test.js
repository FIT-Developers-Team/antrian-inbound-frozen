/* ============================================================================
 * PEMBARUAN LANGSUNG, REL DOK, DAN ANALITIK LEAD TIME
 *
 * Menjaga tiga penambahan yang mengubah cara aplikasi ini dipakai:
 * papan yang bergerak seketika alih-alih tiap lima belas detik, dok yang
 * terlihat sebagai bangunan alih-alih sebagai dropdown, dan lead time yang
 * dilaporkan sebagai sebaran alih-alih sebagai satu rata-rata.
 * ========================================================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const { read, schema, apiServer, importModule } = require("./helpers");

const sql = schema();
const server = apiServer();
const live = read("api/live.mjs");
const api = read("js/api.js");
const store = read("js/store.js");
const app = read("js/app.js");
const charts = read("js/charts.js");
const board = read("js/pages/board.js");
const card = read("js/pages/queue-card.js");
const analytics = read("js/pages/analytics.js");

/* -- Pembaruan langsung ---------------------------------------------------- */

test("perubahan tiket mengirim pemberitahuan dari dalam database", () => {
  // Sumbernya harus Postgres, bukan timer di API yang menanyai tabel: yang
  // terakhir itu hanya polling dengan nama lain, dan biayanya tetap bertambah
  // seiring jumlah tablet.
  assert.match(sql, /create or replace function inbound_notify_change\(\)/);
  assert.match(sql, /perform pg_notify\('inbound_changed'/);
  assert.match(sql, /create trigger tickets_notify/);
});

test("perubahan banyak baris PO tetap satu pemberitahuan", () => {
  // Menyelesaikan bongkar memperbarui seluruh baris PO milik satu tiket
  // sekaligus. Trigger per baris akan mengirim sepuluh pemberitahuan identik
  // untuk satu tindakan operator.
  const stmt = sql.slice(sql.indexOf("drop trigger if exists ticket_pos_notify"));
  assert.match(stmt, /for each statement/);
  assert.doesNotMatch(stmt.slice(0, 200), /for each row/);
});

test("API mendengarkan lewat satu koneksi dan menyebarkannya", () => {
  // Dua puluh tablet harus tetap berarti satu koneksi ke database.
  assert.match(live, /listen \$\{CHANNEL\}|listen inbound_changed/);
  assert.match(live, /function broadcast\(site\)/);
  assert.match(live, /const clients = new Set\(\)/);
  // Koneksi pendengar tidak boleh dikembalikan ke kolam dan dipakai kueri lain.
  assert.match(live, /await pool\.connect\(\)/);
  assert.match(live, /HEARTBEAT_MS/, "denyut nadi menjaga proxy tidak memutus aliran");
});

test("aliran tidak boleh dikompresi atau di-buffer", () => {
  // Proxy yang mem-buffer aliran ini menahan setiap pesan sampai buffernya
  // penuh, dan "realtime" berubah menjadi "beberapa menit sekali, sekaligus".
  assert.match(live, /"cache-control": "no-store, no-transform"/);
  assert.match(live, /"x-accel-buffering": "no"/);
  assert.match(live, /text\/event-stream/);
  // Ia juga tidak boleh melewati sendJson(), yang mengompresi dan menutup.
  const handler = server.slice(server.indexOf('action === "events"'));
  assert.match(handler.slice(0, 400), /live\.subscribe\(/);
});

test("klien memakai fetch berheader, bukan EventSource", () => {
  // EventSource tidak dapat mengirim header, jadi memakainya berarti menaruh
  // token sesi di query string — tempat ia mendarat di log akses, di header
  // Referer, dan di riwayat browser.
  assert.doesNotMatch(api, /new EventSource/);
  assert.match(api, /export function subscribeToChanges/);
  assert.match(api, /authHeaders\(\{ accept: "text\/event-stream" \}\)/);
  assert.match(api, /AbortController/);
});

test("sinyal hanya memicu penarikan, tidak membawa datanya", () => {
  // Kalau saluran ini ikut membawa isi tiket, ia menjadi sumber kebenaran kedua
  // yang dapat menyimpang dari snapshot ber-ETag.
  assert.match(store, /onSignal: \(\) => \{/);
  assert.match(store, /refresh\(\{ silent: true \}\)/);
  assert.match(live, /event: changed/);
  // Muatannya diperiksa sebagai BENTUK, bukan dengan mencari kata di seluruh
  // berkas — komentar di sini menyebut "browser" berkali-kali, dan pencarian
  // teks bebas akan menganggapnya sebagai data tiket.
  const payload = live.slice(live.indexOf("const payload = JSON.stringify("));
  assert.match(payload.slice(0, 120), /\{ site: site \|\| "ALL", at: new Date\(\)\.toISOString\(\) \}/);
});

test("polling tetap ada sebagai jaring pengaman, dengan irama yang menyesuaikan", () => {
  // Proxy memutus koneksi panjang dan tablet berpindah access point; saluran
  // yang diam tidak boleh berarti papan yang diam-diam basi.
  assert.match(store, /LIVE_POLL_INTERVAL_MS = 60_000/);
  assert.match(store, /state\.live === "live" \? LIVE_POLL_INTERVAL_MS : POLL_INTERVAL_MS/);
  assert.match(store, /unsubscribeLive/);
});

test("pil status membedakan pemeriksaan terakhir dari perubahan terakhir", () => {
  // Versi sebelumnya menampilkan jam pemeriksaan, yang berubah tiap lima belas
  // detik — sehingga papan yang membeku sejak pagi tetap terlihat seolah baru
  // saja diperbarui.
  assert.match(store, /lastChange: null/);
  assert.match(store, /if \(dataChanged\) state\.lastChange = new Date\(\)/);
  assert.match(app, /lastChange \? ` · \$\{formatTime\(lastChange\)\}`/);
  assert.match(app, /LIVE_LABEL/);
});

test("jam tablet yang meleset diumumkan sebagai cacat data", () => {
  // Jam kedatangan diketik memakai jam tablet. Selisih besar berarti setiap
  // tiket hari itu membawa jam yang salah.
  assert.match(store, /clockSkewSeconds/);
  assert.match(store, /payload\?\.server_time/);
  assert.match(app, /Math\.abs\(clockSkewSeconds\) > 120/);
  assert.match(app, /Jam tablet meleset/);
});

/* -- Rel dok --------------------------------------------------------------- */

test("dok gudang digambar sebagai rel, bukan hanya sebagai filter", () => {
  // Sembilan pintu inbound adalah batas fisik gudang. Sebelumnya kenyataan itu
  // hanya hadir sebagai satu dropdown.
  const ui = read("js/ui.js");
  assert.match(ui, /export function dockRail\(docks\)/);
  assert.match(board, /function buildDocks\(rows\)/);
  assert.match(board, /dockRail\(buildDocks\(rows\)\)/);
});

test("bar dok digerakkan ticker yang sudah ada, bukan timer baru", () => {
  // Timer kedua yang berdetak per detik adalah biaya baterai yang tidak perlu
  // di tablet gudang.
  const slaSource = read("js/sla.js");
  assert.match(slaSource, /export function refreshDockBar/);
  assert.match(slaSource, /querySelectorAll\("\[data-dock-bar\]"\)/);
  assert.equal((slaSource.match(/setInterval\(/g) || []).length, 1, "tetap satu ticker");
});

test("bar SLA menyusut, bukan bertambah", async () => {
  // Yang ditanyakan supervisor adalah "berapa sisa waktunya".
  const { refreshDockBar } = await importModule("js/sla.js");
  const element = { dataset: {}, style: new Map() };
  element.style.setProperty = (k, v) => element.style.set(k, v);
  element.style.getPropertyValue = (k) => element.style.get(k) || "";

  const started = new Date("2026-09-02T08:00:00Z");
  const deadline = new Date("2026-09-02T12:00:00Z");
  element.dataset.slaStarted = started.toISOString();
  element.dataset.slaDeadline = deadline.toISOString();

  assert.equal(refreshDockBar(element, started), 1, "penuh saat baru mulai");
  assert.equal(refreshDockBar(element, new Date("2026-09-02T10:00:00Z")), 0.5, "separuh di tengah");
  assert.equal(refreshDockBar(element, deadline), 0, "habis saat tenggat");
  assert.equal(refreshDockBar(element, new Date("2026-09-02T13:00:00Z")), 0, "tidak pernah negatif");
});

/* -- Aksi yang selama ini tidak terjangkau --------------------------------- */

test("tiket dapat dibatalkan dari papan", () => {
  // Aksinya ada di backend sejak awal — lengkap dengan aturan peran dan jejak
  // event — tetapi tidak satu pun halaman pernah memanggilnya, sehingga driver
  // yang tidak muncul menggantung di antrean selamanya.
  assert.match(card, /data-action="cancel"/);
  assert.match(board, /case "cancel":/);
  assert.match(board, /api\.cancelTicket\(/);
  // Alasan dipilih dari daftar supaya dapat dihitung, bukan diketik bebas.
  assert.match(board, /CANCEL_REASONS/);
  assert.match(board, /Driver tidak muncul saat dipanggil/);
});

test("pencacah panggilan ditampilkan", () => {
  // Server menghitungnya sejak awal dan tidak pernah menampilkannya, padahal
  // "sudah dipanggil 3x" adalah tanda driver yang perlu ditindak.
  assert.match(card, /call_count/);
  assert.match(card, /class="call-count"/);
});

test("pemilih armada berperilaku seperti radiogroup yang dijanjikannya", () => {
  // Menyandang role tanpa perilakunya lebih buruk daripada tidak menyandangnya:
  // pemakai pembaca layar diberi tahu ada dua belas pilihan yang dapat
  // dijelajahi dengan panah, lalu panahnya diam.
  const register = read("js/pages/register.js");
  assert.match(register, /role="radiogroup"/);
  assert.match(register, /tabindex="\$\{active \? "0" : "-1"\}"/, "roving tabindex");
  assert.match(register, /ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1/);
  assert.match(register, /event\.key === "Home"/);
});

/* -- Analitik lead time ---------------------------------------------------- */

test("lead time diagregasi di database, bukan di tablet", () => {
  // Rentang tiga puluh hari berarti ribuan tiket. Mengirim semuanya hanya untuk
  // dirata-rata di browser adalah pekerjaan yang pernah membuat Laporan membeku.
  assert.match(sql, /create or replace function inbound_lead_time_stats/);
  assert.match(server, /inbound_lead_time_stats/);
  assert.match(api, /export function fetchLeadTime/);
  // Yang dijaga adalah AGREGASI, bukan aritmetika apa pun. Menjumlahkan tiga
  // angka untuk menentukan lebar bar bukan menghitung ulang statistik;
  // menghitung persentil atau merata-rata ribuan tiket adalah.
  assert.doesNotMatch(analytics, /percentile|sort\(\(a, b\) => a - b\)/, "persentil dihitung server");
  assert.doesNotMatch(analytics, /rows\.reduce|tickets\.reduce/, "browser tidak mengagregasi baris tiket");
});

test("durasi dilaporkan sebagai sebaran, bukan satu rata-rata", () => {
  // Rata-rata menyembunyikan ekor: sepuluh truk lancar meredam satu truk yang
  // tertahan empat jam — padahal truk itulah yang membuat vendor menelepon.
  assert.match(sql, /create or replace function inbound_duration_summary/);
  assert.match(sql, /percentile_cont\(0\.5\)/);
  assert.match(sql, /percentile_cont\(0\.9\)/);
  assert.match(analytics, /p90 \$\{esc\(formatMinutes\(summary\.p90\)\)\}/);
});

test("tiga durasi dipisahkan, bukan digabung menjadi satu angka", () => {
  // Kalau truk berada di gudang lebih lama, yang bertambah itu menunggunya atau
  // bongkarnya? Jawabannya menentukan apakah yang kurang dok atau checker.
  ["wait_minutes", "unload_minutes", "dwell_minutes"].forEach((column) => {
    assert.match(sql, new RegExp(column), `${column} harus dihitung terpisah`);
  });
  assert.match(analytics, /Waktu tunggu/);
  assert.match(analytics, /Waktu bongkar/);
  assert.match(analytics, /Total di gudang/);
});

test("seluruh 24 jam dikembalikan, termasuk yang kosong", () => {
  // Grafik jam kedatangan yang melompati jam sepi menyesatkan mata yang
  // membacanya: puncaknya tampak lebih landai daripada kenyataannya.
  assert.match(sql, /generate_series\(0, 23\) as h\(hour\)/);
});

/* -- Grafik ---------------------------------------------------------------- */

test("warna grafik mode gelap dipilih, bukan dibalik dari token UI", () => {
  // Token gelap aplikasi (--accent #6fa4ff, --teal #3fd0bd) gagal uji pita
  // lightness di atas permukaan gelap: hasilnya bidang menyilaukan yang justru
  // sulit dibedakan. Langkah di bawah sudah lolos validator.
  assert.match(charts, /wait: \{ light: "#2563eb", dark: "#4f8ce8"/);
  assert.match(charts, /unload: \{ light: "#0f9f8f", dark: "#26ab9b"/);
  // Diperiksa pada peta SERIES saja. Hex token UI memang disebut di komentar
  // pembuka — justru untuk menerangkan mengapa ia tidak dipakai — dan mencari
  // di seluruh berkas akan menghukum penjelasan itu.
  const series = charts.slice(charts.indexOf("export const SERIES = {"), charts.indexOf("};", charts.indexOf("export const SERIES = {")));
  assert.doesNotMatch(series, /#6fa4ff|#3fd0bd/, "token UI gelap tidak boleh menjadi warna data");
});

test("tidak ada grafik bersumbu ganda", () => {
  // Dua skala pada satu grafik membuat perpotongan garis terlihat bermakna
  // padahal hanya kebetulan penskalaan. Tunggu dan bongkar sama-sama menit,
  // jadi keduanya sah berbagi SATU sumbu — dan itulah yang dipakai.
  assert.doesNotMatch(charts, /yScaleRight|y2Scale|axisRight/);
  assert.equal((charts.match(/function yScale\(/g) || []).length, 1);
});

test("sumbu selalu berhenti di angka bulat", () => {
  // Sumbu yang berakhir di 50 dengan empat garis menghasilkan 12,5 dan 37,5 —
  // yang setelah dibulatkan tampil sebagai "13" dan "38".
  assert.match(charts, /function axisTicks\(value\)/);
  assert.match(charts, /Math\.max\(1, \(\[1, 2, 5, 10\]/);
});

test("setiap grafik dapat dibaca tanpa melihat warnanya", () => {
  // Legenda untuk dua seri atau lebih, tabel angka di baliknya, dan label
  // aksesibilitas pada tiap SVG.
  assert.match(charts, /role="img"/);
  assert.match(charts, /aria-label="\$\{esc\(title\)\}/);
  assert.match(charts, /function legend\(entries\)/);
  assert.match(analytics, /function tableView\(caption, headers, rows\)/);
  assert.match(analytics, /<summary>Lihat angkanya<\/summary>/);
});

test("grafik punya lapisan hover", () => {
  // Grafik HTML memang interaktif; menghilangkan tooltip membuang separuh
  // gunanya.
  assert.match(charts, /export function bindChartTooltips/);
  assert.match(charts, /data-tip=/);
  assert.match(analytics, /bindChartTooltips\(root\)/);
});

test("analitik hanya untuk peran yang memakainya", async () => {
  // Security bekerja di pos masuk; analitik lead time bukan alat mereka.
  const { ROLE_PAGES } = await importModule("js/config.js");
  assert.ok(ROLE_PAGES.SPV.includes("analytics"));
  assert.ok(ROLE_PAGES.ADMIN.includes("analytics"));
  assert.ok(!ROLE_PAGES.SECURITY.includes("analytics"));
});

test("rentang analitik yang sudah dijawab tidak diminta ulang", () => {
  // Cacat yang sama seperti di Laporan: render yang memuat dan muat yang
  // me-render menjadi lingkaran tanpa ujung.
  assert.match(analytics, /let loadedKey = ""/);
  assert.match(analytics, /loadedKey !== rangeKey\(\) && !loading/);
  assert.match(analytics, /loadedKey = requested/);
});
