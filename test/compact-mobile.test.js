/* ============================================================================
 * KERAPATAN, PONSEL, DAN BERAT YANG TERUKUR
 *
 * Menjaga hasil satu putaran audit performa dan tata letak. Setiap angka yang
 * disebut di komentar diukur, bukan diperkirakan — dan itulah yang membuat
 * kemunduran di sini layak dianggap kemunduran.
 * ========================================================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const { read, schema, apiServer, importModule } = require("./helpers");

const html = read("index.html");
const css = read("style.css");
const sql = schema();
const server = apiServer();
const board = read("js/pages/board.js");
const store = read("js/store.js");
const settings = read("js/pages/settings.js");
const sync = read("api/sync-superset.mjs");

/**
 * Lapisan ponsel milik putaran ini.
 *
 * `css.indexOf("@media (max-width: 720px)")` menemukan blok 720px PERTAMA di
 * berkas — blok laci yang sudah ada sejak lama — dan potongannya lalu ikut
 * memuat gaya cetak di akhir berkas. Bagian ini punya judulnya sendiri, jadi
 * itulah yang dipakai sebagai batas.
 */
const mobileLayer = css.slice(css.indexOf("* 16. Ponsel"));

/** SQL tanpa komentar: asersi tentang KODE tidak boleh tertipu penjelasannya. */
const NEWLINE = String.fromCharCode(10);
const sqlCode = sql
  .split(NEWLINE)
  .filter((line) => !line.trim().startsWith("--"))
  .join(NEWLINE);

/* -- Berat muat pertama ---------------------------------------------------- */

test("seluruh modul di-preload supaya tidak ditemukan satu tingkat pada satu waktu", () => {
  // Grafik impor aplikasi ini dalam ENAM tingkat. Tanpa preload, browser
  // mengunduh app.js, menguraikannya, baru tahu ia butuh pages/board.js;
  // mengunduh itu, menguraikannya, baru tahu ia butuh queue-card.js. Enam
  // perjalanan pulang-pergi berurutan sebelum satu piksel tergambar.
  const preloaded = [...html.matchAll(/rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(preloaded.length >= 15, `harus memuat seluruh grafik modul, baru ${preloaded.length}`);

  // Setiap modul yang benar-benar diimpor harus ada dalam daftar; yang
  // terlewat kembali menjadi perjalanan berurutan.
  ["js/config.js", "js/format.js", "js/api.js", "js/sla.js", "js/ui.js", "js/store.js", "js/charts.js"].forEach(
    (module) => assert.ok(preloaded.includes(module), `${module} belum di-preload`),
  );
});

test("papan hanya mengirim kolom yang benar-benar dibaca", () => {
  // `to_jsonb(scoped)` mengirim ketiga puluh tiga kolom view, dan sebelas di
  // antaranya tidak dibaca satu baris kode UI pun. Terukur pada papan dua hari:
  // 36% muatan baris terbuang untuk kolom yang langsung dibuang penerimanya.
  const snapshot = sqlCode.slice(
    sqlCode.indexOf("create or replace function inbound_board_snapshot"),
    sqlCode.indexOf("create or replace function inbound_history"),
  );
  // Diuji pada KODE, bukan pada komentar — komentar di sana memang menyebut
  // `to_jsonb(scoped)` justru untuk menerangkan mengapa ia tidak dipakai.
  assert.doesNotMatch(snapshot, /to_jsonb\(scoped\)/, "proyeksi baris harus disebut satu per satu");
  assert.match(snapshot, /jsonb_build_object\(\s*'ticket_id', ticket_id/);

  // Kolom yang tidak pernah dipakai tidak boleh diam-diam kembali.
  ["'registered_by'", "'row_updated_at'", "'created_at'", "'ticket_type'", "'slot'"].forEach((column) => {
    assert.ok(!snapshot.includes(column), `${column} tidak dibaca UI dan tidak boleh dikirim`);
  });

  // Tetapi yang dipakai harus tetap ada.
  ["'queue_no'", "'sla_deadline_at'", "'call_count'", "'po_numbers'", "'driver_phone'"].forEach((column) => {
    assert.ok(snapshot.includes(column), `${column} dipakai UI dan wajib dikirim`);
  });
});

test("master PO dicari di server, tidak diunduh utuh", () => {
  // Terukur pada master seukuran produksi: 3,4 MB JSON, hampir satu detik, dan
  // tiga puluh ribu objek yang menetap di memori tablet — untuk pertanyaan yang
  // jawabannya tidak pernah lebih dari delapan baris.
  assert.match(sql, /create or replace function inbound_po_search/);
  assert.match(sql, /gin_trgm_ops/, "pencarian substring lewat index trigram");
  assert.match(server, /action === "po_search"/);
  assert.doesNotMatch(read("js/pages/register.js"), /ensurePoMaster/);
});

/* -- Force refresh dan sinkronisasi ---------------------------------------- */

test("tarik ulang manual mengabaikan cache", () => {
  // `refresh()` biasa mengirim If-None-Match, dan 304 berarti layar tidak
  // berubah sama sekali. Ketika operator menekan "Muat ulang" ia justru sedang
  // menyatakan tidak percaya pada apa yang dilihatnya; menjawabnya dengan 304
  // membuat tombol itu terasa rusak.
  assert.match(store, /export async function forceRefresh\(\)/);
  assert.match(store, /api\.clearEtagCache\(\)/);
  assert.match(store, /state\.fingerprint = ""/);
  assert.match(board, /store\.forceRefresh\(\)/);
  assert.match(settings, /id="force-refresh"/);
});

test("cookie Superset yang kedaluwarsa dikenali sebagai penyebabnya sendiri", () => {
  // Selama ini ia menyamar sebagai galat HTTP biasa: pesan yang tercatat hanya
  // "Superset menjawab HTTP 401" — benar, dan tidak memberi tahu siapa pun apa
  // yang harus dilakukan. Cookie itu berumur terbatas dan HARUS diganti manual.
  assert.match(sync, /export class SupersetAuthError extends Error/);
  assert.match(sync, /response\.status === 401 \|\| response\.status === 403/);
  assert.match(sync, /kind = "COOKIE_EXPIRED"/);
  // Cookie mati tidak boleh jatuh ke jalur cadangan: cadangannya memakai cookie
  // yang sama dan pasti gagal juga, sehingga sebab aslinya hilang.
  assert.match(sync, /if \(error instanceof SupersetAuthError\) throw error/);
  // Statusnya dibedakan di sync_runs supaya layar dapat menunjukkan tindakannya.
  assert.match(sync, /error\?\.kind === "COOKIE_EXPIRED" \? "COOKIE_EXPIRED" : "FAILED"/);
});

test("layar Pengaturan menuntun perbaikan cookie, bukan sekadar melaporkannya", () => {
  assert.match(settings, /cookieExpired/);
  assert.match(settings, /Cookie Superset kedaluwarsa/);
  assert.match(settings, /<ol class="steps">/, "langkah perbaikan, bukan satu kalimat galat");
  assert.match(settings, /SUPERSET_SESSION_COOKIE/);
});

test("sinkronisasi dapat dipicu manual oleh peran yang mengurusnya", () => {
  // Setelah mengganti cookie, menunggu siklus lima menit berikutnya hanya untuk
  // tahu apakah cookie barunya benar adalah lima menit menatap layar yang belum
  // berubah.
  assert.match(server, /sync_now: \["SPV", "ADMIN", "DEVELOPER"\]/);
  assert.match(server, /action === "sync_now"/);
  assert.match(read("js/api.js"), /export function syncNow/);
  assert.match(settings, /id="sync-now"/);
});

/* -- Ponsel ---------------------------------------------------------------- */

test("navigasi pindah ke ibu jari di ponsel", () => {
  // Laci samping menuntut dua ketukan dan jangkauan ke pojok kiri ATAS — sudut
  // terjauh dari ibu jari pada perangkat yang dipegang sambil berdiri.
  const mobile = mobileLayer;
  assert.match(mobile, /\.sidebar \{[\s\S]{0,400}bottom: 0;/, "sidebar menjadi bilah bawah");
  assert.match(mobile, /flex-direction: row;/);
  assert.match(mobile, /env\(safe-area-inset-bottom\)/, "menghormati area aman perangkat");
  // Isi terakhir tidak boleh tertutup bilahnya.
  assert.match(mobile, /\.workspace \{[\s\S]{0,120}padding-bottom:/);
});

test("keadaan laci tidak bocor ke bilah bawah", () => {
  // Blok laci di 900px menetapkan lebar 280px, visibility hidden, dan transform
  // yang mendorongnya keluar layar. Tanpa penimpaan, bilah bawah menyusut
  // menjadi 280 piksel dan tabnya tidak sama lebar.
  const mobile = mobileLayer;
  assert.match(mobile, /\.sidebar\.mobile-open \{[\s\S]{0,200}transform: none;|transform: none;/);
  assert.match(mobile, /visibility: visible;/);
  assert.match(mobile, /width: 100%;/);
});

test("filter lanjutan terlipat di ponsel tetapi tetap menyatakan keadaannya", () => {
  // Bilah filter yang selalu terbuka memakan 192 piksel — hampir seperempat
  // layar — untuk dua medan yang pada sebagian besar shift tidak disentuh.
  assert.match(board, /<details class="filter-more"/);
  assert.match(board, /function filterSummary\(\)/);
  // Filter yang tersembunyi tidak boleh menyembunyikan keadaan: papan yang
  // menampilkan tiga tiket karena disaring terlihat persis seperti papan yang
  // memang hanya punya tiga tiket.
  assert.match(board, /id="board-filter-summary"/);
  assert.match(board, /syncFilterSummary\(\)/);
  // Di layar lebar ia bukan disclosure sama sekali.
  assert.match(css, /\.filter-more \{\s*display: contents;/);
});

test("anak grid tidak dapat melebarkan halaman ke samping", () => {
  // Bawaan item grid adalah `min-width: auto`. Satu anak yang memuat sesuatu
  // yang lebar — rel dok berisi sembilan ubin — karena itu MELEBARKAN seluruh
  // kolom alih-alih menggulir sendiri. Terukur di ponsel 390px: halaman menjadi
  // 820px, dan rel dok mendorong judul keluar layar.
  assert.match(css, /\.dashboard-page > \* \{\s*min-width: 0;/);
});

test("kolom eksplisit dinolkan sebelum kolom implisit dipakai", () => {
  // `.metric-strip-four` mendefinisikan empat kolom EKSPLISIT `minmax(0, 1fr)`.
  // Kolom eksplisit selalu menang atas `grid-auto-columns`, jadi tanpa
  // penolan ini kartu metrik tetap diperas dan labelnya terpotong menjadi "ME"
  // dan "DI" — dua kata yang tidak berarti apa pun.
  const strip = mobileLayer.slice(mobileLayer.indexOf(".metric-strip,"));
  const rule = strip.slice(0, strip.indexOf("}") + 1);
  assert.match(rule, /grid-template-columns: none;/);
  assert.match(rule, /grid-auto-columns: 138px;/);
});

test("nada tetap tenang: tidak ada palet atau gerak baru di lapisan ponsel", () => {
  // Kerapatan dicapai dengan menyusun ulang, bukan dengan menambah warna,
  // bayangan, atau animasi. Bila lapisan ini mulai memperkenalkan hex sendiri,
  // ia sudah berhenti menjadi penyesuaian tata letak.
  const mobile = mobileLayer;
  assert.doesNotMatch(mobile, /#[0-9a-f]{3,8}\b/i, "warna harus datang dari token, bukan hex baru");
  assert.doesNotMatch(mobile, /@keyframes|animation:/, "tidak ada animasi baru di lapisan ponsel");
});

/* -- Anggaran yang tetap dijaga -------------------------------------------- */

test("gaya tetap satu berkas tanpa framework", async () => {
  const { STATUS } = await importModule("js/config.js");
  assert.ok(Object.keys(STATUS).length >= 5, "status tiket tetap utuh");
  assert.equal((html.match(/rel="stylesheet"/g) || []).length, 2, "hanya font Google dan style.css");
  assert.doesNotMatch(html, /tailwind|bootstrap|cdn\.jsdelivr/i);
});
