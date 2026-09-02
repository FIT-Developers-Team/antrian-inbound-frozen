/* ============================================================================
 * TEMUAN AUDIT — PENJAGA REGRESI
 *
 * Setiap test di berkas ini menjaga satu cacat yang benar-benar ditemukan saat
 * audit menyeluruh, bukan aturan gaya. Judulnya menyebut akibatnya di lapangan,
 * bukan namanya di kode, supaya siapa pun yang membuatnya gagal langsung tahu
 * apa yang ia bawa kembali.
 * ========================================================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const { read, schema, apiServer, importModule } = require("./helpers");

const server = apiServer();
const sql = schema();
const staticServer = read("api/static.mjs");
const sync = read("api/sync-superset.mjs");

/* -- Keamanan -------------------------------------------------------------- */

test("kunci sesi yang kosong tidak pernah dapat memvalidasi token siapa pun", () => {
  // `createHmac("sha256", "")` adalah HMAC yang SAH dengan kunci kosong. Tanpa
  // penjaga ini, INBOUND_AUTH_SECRET yang tidak diset berarti siapa pun dapat
  // menyusun token berperan DEVELOPER sendiri dan memakainya pada setiap aksi
  // tulis — tanpa pernah menyentuh layar masuk. Layar login memang menolak
  // dengan 503, tetapi jalur pemeriksaan sesi tidak pernah ikut memeriksanya.
  assert.match(server, /function authSecretProblem/);
  assert.match(server, /MIN_SECRET_LENGTH = 16/);

  // Penjaganya ada di readSession, BUKAN di start(). Letak itu yang penting: ia
  // berlaku pada setiap permintaan, bukan hanya sekali saat proses menyala.
  const read = server.slice(server.indexOf("function readSession(request)"));
  const body = read.slice(0, read.indexOf("\n}"));
  assert.match(body, /if \(authSecretProblem\(\)\) return null;/);
  assert.ok(
    body.indexOf("authSecretProblem()") < body.indexOf("constantTimeEqual"),
    "kunci diperiksa sebelum tanda tangan dibandingkan",
  );
});

test("masalah start diumumkan, bukan mematikan kontainer", () => {
  // Versi sebelumnya memanggil process.exit(1) pada setiap masalah start. Yang
  // terlihat operator bukan penjelasan, melainkan "no available server" dari
  // proxy: kontainer keluar, dinyalakan lagi, keluar lagi. Log memuat
  // jawabannya, tetapi kontainer yang mati sepuluh kali per menit adalah tempat
  // yang buruk untuk mencarinya.
  const start = server.slice(
    server.indexOf("async function start()"),
    server.indexOf("let backgroundJobsStarted"),
  );
  assert.doesNotMatch(start, /process\.exit/, "masalah konfigurasi tidak boleh mematikan proses");
  assert.match(start, /recordProblem\(/);
  assert.match(start, /server\.listen\(PORT/, "socket tetap dibuka");

  // Socket dibuka SEBELUM skema diterapkan: halaman yang termuat dan
  // menjelaskan masalahnya lebih berguna daripada kontainer yang tidak pernah
  // sempat dijangkau proxy.
  assert.ok(
    start.indexOf("server.listen(PORT") < start.indexOf("applySchemaWithRetry"),
    "socket dibuka sebelum skema diterapkan",
  );

  // Dan masalahnya harus dapat dibaca dari luar, bukan hanya dari log.
  assert.match(server, /export function currentProblems/);
  assert.match(server, /problems: currentProblems\(\)/);
});

test("skema yang gagal dicoba lagi, bukan menyerah selamanya", () => {
  // Kegagalan tersering bersifat sementara: Postgres masih membuka diri ketika
  // aplikasi sudah siap. Percobaan ulang membuat keadaan itu sembuh sendiri
  // tanpa siapa pun perlu menekan Deploy untuk kedua kalinya.
  assert.match(server, /async function applySchemaWithRetry/);
  assert.match(server, /clearProblems\("db"\)/);
});

test("masalah database dilaporkan apa adanya, bukan sebagai galat generik", () => {
  assert.match(server, /startupProblems\.find\(\(problem\) => problem\.area === "db"\)/);
  assert.match(server, /dbProblem\.message/);
});

test("kunci sesi yang terlalu pendek ditolak sama seperti yang kosong", () => {
  // api/server.mjs adalah titik masuk: mengimpornya akan membuka kolam koneksi
  // dan keluar karena DATABASE_URL tidak ada. Aturannya karena itu diperiksa
  // dari sumbernya, dan yang dijaga adalah keberadaan KEDUA cabang — kunci yang
  // kosong dan kunci yang terlalu pendek sama-sama tidak dapat dipercaya.
  const start = server.indexOf("export function authSecretProblem");
  const body = server.slice(start, server.indexOf("\n}", start));
  assert.ok(start > 0, "authSecretProblem harus ada");
  assert.match(body, /if \(!secret\) return/);
  assert.match(body, /secret\.length < MIN_SECRET_LENGTH/);
  assert.match(body, /return "";/, "kunci yang sah mengembalikan string kosong");
});

test("percobaan masuk dibatasi per alamat dan per akun", () => {
  // Sandi di INBOUND_AUTH_USERS adalah teks biasa dan pendek — ia diketik
  // dengan sarung tangan di layar sentuh. Tanpa pembatas, tidak ada apa pun
  // yang menghalangi skrip menebak secepat jaringan sanggup mengirim.
  assert.match(server, /loginByAddress = createRateLimiter/);
  assert.match(server, /loginByUsername = createRateLimiter/);
  assert.match(server, /send\(\s*response,\s*429/s, "batas terlampaui dijawab 429");
  assert.match(server, /"retry-after"/);
  // Banyak mesin yang menebak satu akun lolos dari batas per alamat; batas per
  // akun ada persis untuk bentuk serangan itu.
  assert.match(server, /byUsername\.allowed/);
});

test("sandi yang benar menghapus riwayat gagal", () => {
  // Operator yang salah ketik tiga kali di awal shift tidak boleh terkunci
  // selama sisa shift-nya.
  assert.match(server, /loginByAddress\.reset\(address\)/);
  assert.match(server, /loginByUsername\.reset\(username\)/);
});

test("pembatas laju membaca alamat asli di belakang proxy", async () => {
  const { clientKey } = await importModule("api/ratelimit.mjs");
  assert.equal(
    clientKey({ headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }, socket: { remoteAddress: "10.0.0.1" } }),
    "203.0.113.9",
    "tanpa ini SELURUH pengguna berbagi satu kuota, karena semuanya tampak berasal dari proxy",
  );
  assert.equal(clientKey({ headers: {}, socket: { remoteAddress: "192.0.2.5" } }), "192.0.2.5");
});

test("pembatas laju benar-benar membatasi lalu memulihkan diri", async () => {
  const { createRateLimiter } = await importModule("api/ratelimit.mjs");
  const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });

  assert.equal(limiter.check("a").allowed, true);
  assert.equal(limiter.check("a").allowed, true);
  assert.equal(limiter.check("a").allowed, true);

  const blocked = limiter.check("a");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0, "klien harus diberi tahu kapan boleh mencoba lagi");

  // Kunci lain tidak ikut terkena.
  assert.equal(limiter.check("b").allowed, true);

  limiter.reset("a");
  assert.equal(limiter.check("a").allowed, true);
});

test("galat internal tidak pernah sampai ke browser", () => {
  // Pesan yang ditulis aturan operasional (`raise exception`, SQLSTATE P0001)
  // memang untuk dibaca di layar gudang. Sisanya — kegagalan koneksi,
  // pelanggaran constraint, galat sintaks — menyebut nama host, nama tabel, dan
  // potongan kueri kepada siapa pun yang meminta.
  assert.match(server, /function clientSafeMessage/);
  assert.match(server, /error\?\.code === "P0001"/);
  assert.match(server, /return "Kesalahan server\./);

  const handler = server.slice(server.indexOf("const server = createServer"));
  assert.doesNotMatch(
    handler.slice(0, handler.indexOf("server.requestTimeout")),
    /message: error\.message/,
    "pesan mentah tidak boleh diteruskan apa adanya",
  );
});

test("header keamanan menempel pada respons API, bukan hanya berkas statis", () => {
  // Sebelumnya header ini hanya ada di penyajian statis, sehingga justru
  // respons yang membawa data operasional dan token sesi berangkat tanpa satu
  // pun di antaranya.
  const headers = read("api/headers.mjs");
  ["x-content-type-options", "x-frame-options", "referrer-policy", "content-security-policy"].forEach((name) => {
    assert.match(headers, new RegExp(`"${name}"`), `header ${name} harus didefinisikan`);
  });
  assert.match(server, /securityHeadersFor\(response\)/);
  assert.match(staticServer, /SECURITY_HEADERS/);
});

test("CSP menutup jalur keluar data sekalipun ada skrip yang lolos", () => {
  const headers = read("api/headers.mjs");
  assert.match(headers, /"connect-src 'self'"/, "skrip asing tidak boleh dapat mengirim data keluar");
  assert.match(headers, /"object-src 'none'"/);
  assert.match(headers, /"base-uri 'self'"/);
});

test("HSTS hanya dipasang di atas HTTPS", async () => {
  // Memasangnya tanpa syarat mengunci http://localhost ke https selama setahun
  // di browser yang sama, dan itu sangat tidak menyenangkan untuk dibatalkan.
  const { transportHeaders } = await importModule("api/headers.mjs");
  assert.deepEqual(transportHeaders({ headers: {} }), {});
  assert.deepEqual(transportHeaders({ headers: { "x-forwarded-proto": "http" } }), {});
  assert.match(
    transportHeaders({ headers: { "x-forwarded-proto": "https" } })["strict-transport-security"],
    /max-age=31536000/,
  );
});

test("berkas yang boleh disajikan adalah daftar-izin, bukan daftar-larangan", () => {
  // Daftar-larangan mengharuskan setiap berkas rahasia baru diingat untuk
  // ditambahkan; yang terlupa langsung menjadi kebocoran. Daftar-izin membuat
  // berkas baru tidak terlihat sampai seseorang memutuskan sebaliknya.
  // Perilakunya diuji lewat HTTP sungguhan di test/static-serving.test.js.
  assert.match(staticServer, /const PUBLIC_FILES = new Set\(/);
  assert.match(staticServer, /const PUBLIC_DIRECTORIES = \["\/js\/", "\/assets\/"\]/);
  assert.match(staticServer, /isPublic\(requested\) \? requested : "\/index\.html"/);
  // Jalur harus dinormalisasi SEBELUM dicocokkan: `/js/../db/schema.sql` lolos
  // pemeriksaan awalan "/js/" bila urutannya terbalik.
  const handler = staticServer.slice(staticServer.indexOf("return async function serveStatic"));
  assert.ok(
    handler.indexOf("normalize(decoded)") < handler.indexOf("isPublic(requested)"),
    "normalisasi harus mendahului pencocokan daftar izin",
  );
});

test("server pengembangan menutup berkas yang sama dengan produksi", () => {
  // `npm run dev` menyajikan dari akar proyek — tempat `.env` tinggal di mesin
  // pengembang. Risikonya lokal, tetapi perilaku yang berbeda dari produksi
  // adalah perbedaan yang cepat atau lambat menjadi kejutan.
  const dev = read("scripts/dev-server.mjs");
  assert.match(dev, /const PUBLIC_FILES = new Set\(/);
  assert.match(dev, /isPublic\(requested\) \? requested : "\/index\.html"/);
  assert.match(dev, /ROOT \+ sep/);
});

test("batas folder publik diperiksa dengan pemisah jalur", async () => {
  // `startsWith("/app")` juga meloloskan `/app-rahasia/keys.env`.
  assert.match(staticServer, /ROOT_PREFIX = ROOT\.endsWith\(sep\)/);
  assert.match(staticServer, /!file\.startsWith\(ROOT_PREFIX\)/);
});

test("permintaan tidak dapat menggantung tanpa batas", () => {
  // Tablet gudang berpindah access point di tengah permintaan. Tanpa batas
  // waktu, setiap kejadian semacam itu meninggalkan socket yang tidak pernah
  // ditutup.
  assert.match(server, /server\.requestTimeout = /);
  assert.match(server, /server\.headersTimeout = /);
  assert.match(server, /server\.keepAliveTimeout = /);
});

test("pembatasan ukuran payload tidak kuadratik", () => {
  // `chunks.reduce(...)` pada setiap potongan menjumlahkan ulang seluruh
  // potongan sebelumnya, jadi unggahan besar membakar CPU tepat pada permintaan
  // yang seharusnya ditolak paling cepat.
  const start = server.indexOf("async function readBody(request)");
  const body = server.slice(start, server.indexOf("\n}", start));
  assert.doesNotMatch(body, /chunks\.reduce/, "ukuran harus dijumlahkan berjalan");
  assert.match(body, /size \+= chunk\.length/);
  assert.match(server, /class PayloadTooLarge extends Error/);
});

/* -- Performa -------------------------------------------------------------- */

test("respons teks dikompresi sebelum dikirim", async () => {
  // Paket statisnya sekitar 150 KB teks, dan snapshot papan yang berisi seratus
  // tiket sekitar 120 KB JSON — yang terakhir diminta ulang tiap lima belas
  // detik oleh setiap tablet yang menyala.
  const { isCompressible, negotiateEncoding, compress } = await importModule("api/compress.mjs");

  assert.equal(isCompressible("text/css; charset=utf-8"), true);
  assert.equal(isCompressible("application/json; charset=utf-8"), true);
  assert.equal(isCompressible("image/webp"), false, "gambar sudah terkompresi di dalamnya");

  assert.equal(negotiateEncoding({ headers: { "accept-encoding": "gzip, deflate, br" } }), "br");
  assert.equal(negotiateEncoding({ headers: { "accept-encoding": "gzip" } }), "gzip");
  assert.equal(negotiateEncoding({ headers: {} }), null, "klien yang tidak menerimanya dikirimi teks biasa");

  const sample = Buffer.from(read("style.css"), "utf8");
  const gzipped = await compress(sample, "gzip");
  assert.ok(gzipped.length < sample.length / 3, `gzip harus memangkas >2/3 (${sample.length} -> ${gzipped.length})`);
});

test("ETag menyebut encoding-nya", async () => {
  // Tanpa ini, varian gzip yang tersimpan dapat disajikan kembali kepada klien
  // yang meminta brotli: badan respons "benar" menurut ETag, tetapi tidak dapat
  // dibaca. `Vary` saja tidak cukup karena ia tidak mengubah ETag-nya.
  const { taggedEtag } = await importModule("api/compress.mjs");
  assert.equal(taggedEtag('W/"abc"', "br"), 'W/"abc+br"');
  assert.equal(taggedEtag('W/"abc"', null), 'W/"abc"');
  assert.match(staticServer, /vary: "Accept-Encoding"/);
});

test("index tersedia untuk setiap join yang berjalan tiap polling", () => {
  // superset_po_master di-join ke site_master lewat location_id, BUKAN
  // site_code. Tanpa index ini, setiap snapshot papan memindai seluruh master
  // PO hanya untuk melaporkan umur sinkronisasi di pojok layar.
  assert.match(sql, /create index if not exists superset_po_location_idx on superset_po_master\(location_id\)/);
  assert.match(sql, /create index if not exists sync_runs_recent_idx/);
  assert.match(sql, /create index if not exists tickets_gate_busy_idx/);
});

test("batas 5.000 baris riwayat benar-benar berlaku", () => {
  // `limit` di samping jsonb_agg membatasi satu baris hasil agregat, bukan
  // baris yang diagregasi ke dalamnya — jadi batasnya tidak pernah berlaku dan
  // rentang sebulan dikirim utuh sebagai satu JSON raksasa.
  const fn = sql.slice(sql.indexOf("create or replace function inbound_history"), sql.indexOf("-- 13."));
  assert.match(fn, /, capped as \(/, "batas harus berada di subquery tersendiri");
  assert.match(fn, /order by b\.created_at desc\s*\n\s*limit 5000/);
  assert.match(fn, /'truncated'/, "operator harus diberi tahu bila hasilnya terpotong");
  assert.match(read("js/pages/report.js"), /truncated/, "layar Laporan menampilkannya");
});

test("riwayat yang kosong tidak memicu permintaan tanpa akhir", () => {
  // `render()` yang berakhir dengan "kalau kosong, muat" bertemu `load()` yang
  // berakhir dengan "render": rentang tanggal tanpa tiket menjadi lingkaran
  // tanpa ujung yang membanjiri API dengan kueri riwayat.
  const report = read("js/pages/report.js");
  assert.match(report, /let loadedRange = ""/);
  assert.match(report, /loadedRange !== rangeKey\(\) && !loading/);
  assert.doesNotMatch(report, /!rows\.length && !loading/, "jumlah baris tidak boleh menjadi syarat muat ulang");
  // Kegagalan pun ditandai sudah dicoba: mencoba ulang otomatis saat API
  // bermasalah hanya memperberat API yang bermasalah.
  const load = report.slice(report.indexOf("async function load(root)"));
  assert.equal((load.match(/loadedRange = requested/g) || []).length, 2, "sukses dan gagal sama-sama ditandai");
});

test("papan tidak digambar ulang saat snapshot tidak berubah", () => {
  // Di gudang yang sepi, papan dulu dibongkar dan dibangun kembali empat kali
  // per menit tanpa satu piksel pun berubah — dan setiap kali itu terjadi,
  // kursor operator yang sedang mengetik di kotak pencarian terlempar keluar.
  assert.match(read("js/store.js"), /fingerprint !== state\.fingerprint/);
  assert.match(read("js/app.js"), /detail\.dataChanged !== false/);
  assert.match(sql, /'fingerprint', md5\(/);
});

test("mengetik tidak membangun ulang seluruh halaman", () => {
  const board = read("js/pages/board.js");
  assert.match(board, /function renderList\(root\)/);
  assert.match(board, /debounce\(\(\) => renderList\(root\)\)/);

  const register = read("js/pages/register.js");
  assert.match(register, /function suggestionMarkup\(\)/);
  assert.match(register, /debounce\(refreshSuggestions\)/);
});

test("master PO tidak diunduh berkali-kali sekaligus", () => {
  // `render()` memanggil ensurePoMaster(), dan render berjalan pada setiap
  // ketukan tombol: mengetik lima huruf sebelum permintaan pertama selesai
  // memicu lima unduhan berisi puluhan ribu baris.
  const store = read("js/store.js");
  assert.match(store, /let poMasterRequest = null/);
  assert.match(store, /if \(poMasterRequest\) return poMasterRequest/);
});

test("pencarian PO tidak membuat ulang puluhan ribu string tiap ketukan", () => {
  const register = read("js/pages/register.js");
  assert.match(register, /let searchIndex = \{ source: null, entries: \[\] \}/);
  assert.match(register, /if \(searchIndex\.source === master\) return searchIndex\.entries/);
  // Pencarian berhenti begitu delapan saran terkumpul, bukan menelusuri seluruh
  // master lalu membuang sisanya.
  assert.match(register, /if \(found\.length >= MAX_SUGGESTIONS\) break/);
});

test("sinkronisasi Superset menulis berkelompok, bukan satu baris satu perjalanan", () => {
  // Master PGS berisi puluhan ribu baris; satu INSERT per PO berarti puluhan
  // ribu perjalanan pulang-pergi tiap siklus lima menit, dengan transaksi yang
  // menahan kunci selama itu.
  assert.match(sync, /const BATCH_SIZE = 500/);
  assert.match(sync, /async function writeRows\(pool, rows, byLocation\)/);
  assert.match(sync, /offset \+= BATCH_SIZE/);
  assert.doesNotMatch(sync, /for \(const row of scoped\)/, "loop per baris sudah tidak ada");
});

test("sinkronisasi Superset punya batas waktu dan tidak pernah tumpang-tindih", () => {
  // `fetch` tanpa batas waktu menunggu selamanya: Superset yang menggantung —
  // bukan yang mati — membekukan sync tanpa satu pun baris di log.
  assert.match(sync, /AbortSignal\.timeout\(FETCH_TIMEOUT_MS\)/);
  assert.equal((sync.match(/signal: timeoutSignal\(\)/g) || []).length, 3, "setiap fetch harus berbatas waktu");
  assert.match(sync, /if \(running\)/);
  assert.match(sync, /running = false/);
});

test("setiap view dijatuhkan sebelum dibuat ulang", () => {
  // Inilah bug yang membuat deployment pertama gagal dengan "no available
  // server", dan ia lolos dari SELURUH pengujian karena setiap uji skema
  // dijalankan di database baru.
  //
  // `create or replace view` hanya boleh mengganti isi kueri; ia menolak
  // mengubah tipe atau susunan kolom. Di database kosong view dibuat baru dan
  // semuanya lancar. Di database yang sudah berisi versi lama, Postgres
  // menjawab "cannot change data type of view column" — skema berhenti,
  // kontainer keluar, dan proxy melaporkan kalimat yang tidak menyebut satu pun
  // penyebabnya.
  const views = [...sql.matchAll(/create or replace view (\w+)/g)].map((match) => match[1]);
  assert.ok(views.length > 0, "skema memang punya view");

  views.forEach((view) => {
    const dropAt = sql.indexOf(`drop view if exists ${view};`);
    const createAt = sql.indexOf(`create or replace view ${view}`);
    assert.ok(dropAt >= 0, `${view} harus dijatuhkan lebih dulu agar skema dapat naik versi`);
    assert.ok(dropAt < createAt, `drop untuk ${view} harus mendahului create`);
  });
});

test("fungsi SLA dapat disisipkan Postgres ke kueri pemanggilnya", () => {
  // Syarat inlining fungsi SQL menuntut badan berupa satu SELECT TANPA `from`.
  // Bentuk lama memakai `... from (select upper(regexp_replace(...)) as v) x`,
  // dan klausa `from` itu membuat setiap pemanggilan menjadi pemanggilan fungsi
  // sungguhan. Papan memanggilnya sekali per tiket; pada dua puluh ribu tiket
  // satu snapshot memakan 25 detik, pada kueri yang diminta tiap lima belas
  // detik.
  const canonical = sql.slice(
    sql.indexOf("create or replace function inbound_fleet_canonical"),
    sql.indexOf("create or replace function inbound_sla_target_hours"),
  );
  const target = sql.slice(
    sql.indexOf("create or replace function inbound_sla_target_hours"),
    sql.indexOf("-- 7. Gate"),
  );
  [canonical, target].forEach((body) => {
    assert.doesNotMatch(body, /from \(select/, "klausa from mematikan inlining");
  });
  // regexp_replace hanya boleh tersisa di cabang terakhir, di luar jalur panas.
  assert.equal((canonical.match(/regexp_replace/g) || []).length, 1);
});

test("cakupan gudang memakai keanggotaan array, bukan predikat is-null-or", () => {
  // Di dalam fungsi SQL, `p_site_code is null or site_code = p_site_code` tidak
  // dapat dipakai sebagai kondisi index: parameternya belum diketahui saat
  // rencana disusun, jadi cabang `is null` tidak dapat dilipat. Rencananya
  // jatuh ke pemindaian seluruh tabel tiket pada setiap polling.
  assert.match(sql, /create or replace function inbound_scoped_sites/);

  const snapshot = sql.slice(
    sql.indexOf("create or replace function inbound_board_snapshot"),
    sql.indexOf("-- 12. Riwayat"),
  );
  assert.match(snapshot, /b\.site_code = any\(inbound_scoped_sites\(p_site_code\)\)/);
  // Bentuk lama yang tidak boleh kembali, dengan spasi dirapatkan supaya
  // pemformatan SQL bebas berubah.
  assert.ok(
    !snapshot.replace(/\s+/g, " ").includes("is null or b.site_code ="),
    "predikat is-null-or mematikan index dan tidak boleh kembali",
  );

  const history = sql.slice(
    sql.indexOf("create or replace function inbound_history"),
    sql.indexOf("-- 13."),
  );
  assert.match(history, /b\.site_code = any\(inbound_scoped_sites\(p_site_code\)\)/);
});

test("hari operasional wajib terisi supaya penyaringan tanggal memakai index", () => {
  // Kolom yang boleh kosong memaksa setiap penyaringan ditulis sebagai
  // `is null or …`, dan OR di situ berarti BitmapOr alih-alih satu pemindaian
  // index — pada kueri yang berjalan tiap lima belas detik.
  assert.match(sql, /alter column operational_date set default/);
  assert.match(sql, /alter column operational_date set not null/);
  assert.match(sql, /set operational_date = \(timezone\('Asia\/Jakarta', created_at\)/, "nilai lama diisi ulang");

  const snapshot = sql.slice(
    sql.indexOf("create or replace function inbound_board_snapshot"),
    sql.indexOf("-- 12. Riwayat"),
  );
  assert.doesNotMatch(snapshot, /b\.operational_date is null or/, "toleransi null sudah tidak diperlukan");
});

test("kesegaran sumber dievaluasi sekali per snapshot", () => {
  // Tanpa `materialized`, Postgres menyisipkan pemanggilan fungsinya dan
  // mengevaluasinya ulang untuk setiap rujukan — dan payload-nya dirujuk dua
  // kali, sekali langsung dan sekali lagi di dalam md5 fingerprint.
  assert.match(sql, /freshness as materialized \(/);
  assert.match(sql, /last_run as materialized \(/);
});

test("riwayat yang tidak pernah dibaca lagi dipangkas", () => {
  // sync_runs bertambah dua belas baris tiap jam — sekitar seratus ribu per
  // tahun — dan hanya baris terakhirnya yang pernah ditanyakan.
  assert.match(sql, /create or replace function inbound_prune_history/);
  assert.match(server, /function startHistoryPruning/);
  assert.match(server, /inbound_prune_history/);
});

/* -- Aturan operasional ---------------------------------------------------- */

test("dua truk tidak dapat diarahkan ke dock yang sama", () => {
  // Papan menampilkan gate terpakai sebagai opsi yang tidak dapat dipilih,
  // tetapi itu hanya berlaku bagi layar yang datanya mutakhir. Dua supervisor
  // yang menekan tombol dalam selang beberapa detik sama-sama melihat dock yang
  // sama masih kosong.
  assert.match(sql, /create or replace function inbound_assert_gate_free/);
  assert.match(sql, /Gate % sedang dipakai tiket %/);

  const call = sql.slice(sql.indexOf("function inbound_call_ticket"), sql.indexOf("function inbound_start_unloading"));
  assert.match(call, /for update/, "baris dikunci sebelum diperiksa");
  assert.match(call, /inbound_assert_gate_free/);

  const start = sql.slice(
    sql.indexOf("function inbound_start_unloading"),
    sql.indexOf("function inbound_finish_unloading"),
  );
  assert.match(start, /for update/);
  assert.match(start, /inbound_assert_gate_free/);
  assert.match(start, /Gate wajib ditentukan sebelum bongkar dimulai/);
});

test("jam kedatangan tidak dapat dikoreksi ke setelah bongkar dimulai", () => {
  // Koreksi semacam itu membuat lama tunggu driver menjadi negatif, dan laporan
  // pagi berikutnya melaporkan angka yang mustahil tanpa petunjuk asalnya.
  const fn = sql.slice(sql.indexOf("function inbound_set_arrival"), sql.indexOf("function inbound_call_ticket"));
  assert.match(fn, /v_row\.start_unloading_at is not null and v_at > v_row\.start_unloading_at/);
  assert.match(fn, /tidak boleh setelah bongkar dimulai/);
});

test("penghapusan per tanggal tidak menyapu gudang lain", () => {
  // Admin yang membersihkan data uji coba di satu gudang ikut menghapus hari
  // kerja gudang lain, tanpa satu pun konfirmasi yang menyebutkan hal itu.
  const fn = sql.slice(sql.indexOf("function inbound_delete_tickets_by_date"), sql.indexOf("inbound_delete_single_ticket"));
  assert.match(fn, /p_site_code text default null/);
  assert.match(fn, /Kode gudang wajib diisi saat lebih dari satu gudang aktif/);
  assert.match(fn, /and \(v_site is null or site_code = v_site\)/);
  assert.match(server, /inbound_delete_tickets_by_date", \[body\.operational_date, site\]/);
});

test("skema tidak diterapkan dua proses sekaligus", () => {
  // Dua replika yang start bersamaan saling menimpa `drop trigger` /
  // `create trigger`, dan salah satunya mati dengan galat yang membingungkan.
  assert.match(server, /pg_advisory_lock/);
  assert.match(server, /pg_advisory_unlock/);
  assert.match(server, /SCHEMA_LOCK_ID/);
});

/* -- Sesi hidup ------------------------------------------------------------ */

test("papan hidup segera setelah login, bukan hanya setelah halaman dimuat ulang", () => {
  // Bug yang paling terasa di lapangan dan paling tidak terlihat dari kode:
  // boot() menyalakan pelanggan state, polling, dan ticker SLA — tetapi boot()
  // hanya melewati jalur itu ketika sesi SUDAH ada saat halaman dibuka. Login
  // pertama melewatkan semuanya, jadi operator yang baru masuk mendapat papan
  // yang diam di "Memuat antrean…" selamanya. Tombol "Muat ulang" pun tidak
  // menolong: yang hilang justru pelanggan yang seharusnya menggambar hasilnya.
  const app = read("js/app.js");
  assert.match(app, /function startLiveSession\(\)/);

  const loginHandler = app.slice(app.indexOf("const user = await api.login"), app.indexOf("} catch (error)"));
  assert.match(loginHandler, /startLiveSession\(\)/, "login harus menyalakan sesi hidup");

  const boot = app.slice(app.indexOf("function boot()"), app.indexOf("if (document.readyState"));
  assert.match(boot, /startLiveSession\(\)/, "pemuatan halaman dengan sesi juga");

  // Keduanya harus memakai jalur yang SAMA; dua salinan akan menyimpang lagi.
  assert.equal((app.match(/store\.subscribe\(/g) || []).length, 1, "hanya ada satu tempat berlangganan");
  assert.equal((app.match(/store\.startPolling\(\)/g) || []).length, 1);
});

test("masuk berulang tidak menumpuk pelanggan state", () => {
  // Keluar lalu masuk lagi tanpa memuat ulang halaman memanggil
  // startLiveSession() untuk kedua kalinya. Tanpa penjaga, setiap snapshot
  // digambar dua kali, lalu tiga kali, sampai tabletnya tersendat.
  const app = read("js/app.js");
  assert.match(app, /let liveSessionBound = false/);
  assert.match(app, /if \(liveSessionBound\) return/);
  // Polling dan ticker tetap harus dinyalakan ulang: keduanya dimatikan saat
  // keluar, dan operator berikutnya di tablet yang sama butuh papan yang hidup.
  const live = app.slice(app.indexOf("function startLiveSession()"), app.indexOf("if (liveSessionBound) return"));
  assert.match(live, /store\.startPolling\(\)/);
  assert.match(live, /startTicker\(\)/);
});

/* -- Panduan yang masih benar ---------------------------------------------- */

test("tidak ada perintah Supabase yang tersisa di pesan untuk operator", () => {
  // Aplikasi ini sudah pindah ke Postgres yang di-host sendiri. Pesan galat
  // yang menyuruh menjalankan `supabase functions deploy` mengirim operator
  // mengerjakan sesuatu yang tidak akan pernah berhasil, tepat saat papan
  // sedang mati.
  ["js/api.js", "js/pages/board.js", "js/pages/settings.js", "js/store.js", "js/app.js"].forEach((file) => {
    assert.doesNotMatch(read(file), /supabase (db push|functions deploy)/i, `${file} masih menyarankan Supabase`);
  });
  assert.match(read("js/api.js"), /Muat ulang halaman/, "sarannya harus dapat dikerjakan operator");
});
