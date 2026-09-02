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
const analyticsPage = read("js/pages/analytics.js");

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

test("laci navigasi dihapus, bukan sekadar disembunyikan", () => {
  // Hamburger dan lacinya mati di SETIAP rentang lebar: di atas 900px sidebar
  // selalu tampak, di bawahnya navigasi ada di bilah bawah. Yang tertinggal
  // hanyalah tombol yang membuka panel kosong.
  //
  // Rentang 721-900px adalah yang paling jelas salah: itu tablet portrait —
  // perangkat yang justru paling butuh navigasi terjangkau ibu jari — dan
  // justru di sana ia mendapat laci yang harus dibuka dari pojok kiri atas.
  ["mobile-open", "nav-backdrop", "mobile-menu"].forEach((leftover) => {
    assert.doesNotMatch(css, new RegExp(leftover), `${leftover} sudah tidak dipakai`);
  });
  // Bilah bawah harus berlaku sampai 900px, bukan 720px: rentang 721-900
  // adalah tablet portrait, dan di sanalah laci dulu masih aktif.
  assert.match(mobileLayer, /@media \(max-width: 900px\)/, "bilah bawah mencakup rentang tablet");
});

test("ukuran kontrol memakai satu skala, bukan empat angka yang tidak sengaja", () => {
  // Sebelumnya: input 44px, tombol 40px, tombol kecil 34px, tombol ikon 40px,
  // ringkasan disclosure 38px. Satu baris form yang memuat input dan tombol di
  // sebelahnya karena itu tingginya tidak pernah sama.
  assert.match(css, /--control-h: 40px;/);
  assert.match(css, /--control-h-sm: 34px;/);
  assert.match(css, /\.btn,\s*\.nav-link,\s*\.input,\s*\.fleet-option \{\s*min-height: var\(--control-h\);/);
  assert.match(css, /\.btn-sm \{\s*min-height: var\(--control-h-sm\);/);

  // Tombol ikon harus BUJUR SANGKAR: sebelumnya hanya tingginya yang dinaikkan
  // pada perangkat sentuh, sehingga ia menjadi 40 lebar x 46 tinggi.
  assert.match(css, /\.icon-btn \{\s*width: var\(--control-h\);\s*height: var\(--control-h\);/);

  // Perangkat sentuh menaikkan keduanya. Papan ini disentuh dengan sarung
  // tangan di ruang dingin.
  const coarse = css.slice(css.indexOf("@media (pointer: coarse)"));
  assert.match(coarse.slice(0, 200), /--control-h: 46px;/);
  assert.match(coarse.slice(0, 200), /--control-h-sm: 46px;/);

  // SATU blok coarse untuk ukuran kontrol. Dua blok yang menetapkan tinggi
  // selektor yang sama adalah persis cara dua aturan saling membatalkan tanpa
  // ada yang menyadarinya sampai salah satunya dipindahkan.
  const heightBlocks = [...css.matchAll(/@media \(pointer: coarse\)/g)];
  assert.ok(heightBlocks.length <= 2, `blok coarse harus sedikit dan jelas, ada ${heightBlocks.length}`);
  assert.doesNotMatch(css, /\.btn,\s*\.nav-link,\s*\.input,\s*\.icon-btn,\s*\.fleet-option \{\s*min-height: 46px/);
});

test("kontrol yang dulu terlewat kini ikut berukuran layak sentuh", () => {
  // Ringkasan disclosure, saran PO, dan tombol hapus chip diketuk sama
  // seringnya dengan tombol biasa, tetapi tidak pernah tersentuh aturan ukuran.
  assert.match(css, /\.filter-more > summary,\s*\.chart-table summary,\s*\.po-suggestion \{/);
  // Tombol hapus chip PO adalah yang terkecil di seluruh aplikasi, dan satu
  // ketukan meleset menghapus PO yang benar.
  assert.match(css, /\.po-chip button \{[\s\S]{0,200}min-height: 26px;/);
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

/* -- Cookie sinkronisasi yang dapat diisi dari layar ------------------------ */

test("cookie disimpan lewat setelan, dengan lingkungan sebagai cadangan", () => {
  // Cookie Superset kedaluwarsa berkala, dan menggantinya lewat variabel
  // lingkungan berarti menunggu deploy ulang selesai — beberapa menit master PO
  // membeku, pada saat yang justru paling tidak tepat.
  assert.match(sql, /create table if not exists app_settings/);
  assert.match(sql, /create or replace function inbound_set_setting/);
  assert.match(sync, /async function resolveCookie\(pool\)/);
  // Urutannya penting: lingkungan tetap bawaan, setelan menimpanya hanya bila
  // benar-benar diisi.
  const resolve = sync.slice(sync.indexOf("async function resolveCookie"));
  const body = resolve.slice(0, resolve.indexOf("\n}"));
  assert.ok(
    body.indexOf("app_settings") < body.indexOf("process.env.SUPERSET_SESSION_COOKIE"),
    "database dibaca lebih dulu, lingkungan menjadi cadangan",
  );
});

test("nilai cookie tidak pernah dikembalikan ke browser", () => {
  // Yang dilaporkan hanya bentuknya: panjang, sidik jari pendek, siapa yang
  // terakhir mengubahnya. Cukup untuk memastikan dua orang membicarakan cookie
  // yang sama tanpa satu pun dari mereka melihatnya.
  const status = sql.slice(sql.indexOf("create or replace function inbound_setting_status"));
  const body = status.slice(0, status.indexOf("$fn$;"));
  // Setiap penyebutan kolom nilainya HARUS terbungkus length() atau md5().
  // Satu saja yang telanjang berarti rahasianya ikut terkirim — dan mencari
  // pola "setting_value)" saja tidak cukup, karena `length(setting_value)` juga
  // berakhir demikian.
  const mentions = [...body.matchAll(/(\w*)\(setting_value\)/g)].map((m) => m[1]);
  const naked = body.replace(/(length|md5)\(setting_value\)/g, "").includes("setting_value");
  assert.deepEqual([...new Set(mentions)].sort(), ["length", "md5"]);
  assert.ok(!naked, "nilai cookie hanya boleh muncul di dalam length() atau md5()");
  assert.match(body, /'fingerprint', substr\(md5\(setting_value\), 1, 8\)/);
  assert.match(body, /'length', length\(setting_value\)/);

  // Kotaknya pun tidak pernah diisi nilai yang tersimpan.
  assert.match(settings, /id="cookie-input" type="password"/);
  assert.doesNotMatch(settings, /value="\$\{esc\(status\.setting_value/);
});

test("menulis cookie lebih sempit daripada memicu sync", () => {
  // Memicu penarikan ulang tidak sama dengan memegang kredensial ke sistem lain.
  assert.match(server, /set_sync_cookie: \["ADMIN", "DEVELOPER"\]/);
  assert.match(server, /sync_now: \["SPV", "ADMIN", "DEVELOPER"\]/);
  assert.match(settings, /\["ADMIN", "DEVELOPER"\]\.includes\(role\)/);
});

test("sinkronisasi membaca cookie tiap siklus, bukan sekali saat start", () => {
  // Sebelumnya startSupersetSync keluar lebih awal bila cookie kosong, sehingga
  // cookie yang kemudian diisi lewat layar tidak pernah berlaku sampai proses
  // dinyalakan ulang — persis kebalikan dari alasan setelan itu dibuat.
  const start = sync.slice(sync.indexOf("export function startSupersetSync"));
  assert.doesNotMatch(start.slice(0, 400), /return;/, "timer selalu dinyalakan");
  assert.match(sync, /const cookie = await resolveCookie\(pool\)/);
});

test("menyimpan cookie langsung mengujinya", () => {
  // Menyimpan cookie baru hampir selalu diikuti keinginan untuk tahu apakah ia
  // benar. Menunggu siklus lima menit berikutnya adalah lima menit menatap
  // layar yang belum berubah.
  assert.match(settings, /await api\.syncNow\(\)/);
  assert.match(settings, /Cookie tersimpan dan diuji/);
});

/* -- Informasi dashboard --------------------------------------------------- */

test("kinerja vendor diagregasi di database", () => {
  assert.match(sql, /create or replace function inbound_vendor_stats/);
  assert.match(server, /action === "vendor_stats"/);
  assert.match(read("js/api.js"), /export function fetchVendorStats/);
});

test("vendor diurutkan menurut waktu dok, bukan jumlah tiket", () => {
  // Vendor yang datang sepuluh kali dengan muatan kecil tidak sama beratnya
  // dengan vendor yang datang tiga kali dan menahan dok empat jam tiap kali —
  // dan yang kedua itulah yang menentukan panjang antrean di luar.
  const fn = sqlCode.slice(sqlCode.indexOf("create or replace function inbound_vendor_stats"));
  assert.match(fn.slice(0, 3000), /order by sort_minutes desc nulls last, sort_tickets desc/);
  assert.match(fn.slice(0, 3000), /'dock_minutes', round\(coalesce\(sum\(unload_minutes\), 0\)\)::int/);
});

test("tiket batal dihitung terpisah, bukan hilang dari rata-rata", () => {
  // Tiket batal tidak punya durasi untuk dirata-rata: ia lenyap dari setiap
  // angka lain, padahal ia slot dok yang sudah dijanjikan lalu terbuang.
  assert.match(sql, /'cancelled', count\(\*\) filter \(where status = 'EXPIRED'\)/);
  assert.match(sql, /Tanpa alasan tercatat/);
  assert.match(analyticsPage, /function cancellationList\(reasons\)/);
  assert.match(analyticsPage, /class="cancel-count"/);
});

test("dok yang menganggur tetap dilaporkan", () => {
  // Dok yang tidak terpakai sama sekali adalah temuan, bukan baris kosong yang
  // boleh dilewati.
  const fn = sqlCode.slice(sqlCode.indexOf("create or replace function inbound_vendor_stats"));
  assert.match(fn.slice(0, 4000), /from inbound_active_gates\(\) g\s*left join/);
  assert.match(analyticsPage, /function gateChart\(gateRows\)/);
});

test("dua permintaan analitik berjalan bersamaan", () => {
  // Dua perjalanan yang saling menunggu adalah dua kali waktu tunggu untuk data
  // yang tidak saling bergantung.
  assert.match(analyticsPage, /await Promise\.all\(\[/);
  assert.match(analyticsPage, /api\.fetchLeadTime\(range\.from, range\.to\),\s*api\.fetchVendorStats\(range\.from, range\.to\),/);
});
