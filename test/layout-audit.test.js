/* ============================================================================
 * AUDIT TATA LETAK — TEMUAN YANG DIKUNCI
 *
 * Berkas ini menjaga hasil satu putaran audit tata letak end-to-end. Setiap
 * temuan di bawah pernah HIDUP di aplikasi, diukur di browser, dan diperbaiki;
 * asersinya ada supaya perbaikannya tidak diam-diam kembali.
 *
 * Yang dikunci selalu SEBABNYA, bukan nilainya. "Bilah bawah tidak boleh
 * `visibility: hidden`" tetap benar berapa pun tinggi bilahnya kelak.
 * ========================================================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const { read } = require("./helpers");

const css = read("style.css");
const app = read("js/app.js");
const board = read("js/pages/board.js");
const charts = read("js/charts.js");
const register = read("js/pages/register.js");
const report = read("js/pages/report.js");
const analytics = read("js/pages/analytics.js");

/** Blok `@media` yang menjadikan sidebar bilah navigasi bawah. */
const bottomBarLayer = css.slice(css.indexOf("* 16. Ponsel"));

/* -- Navigasi ponsel ------------------------------------------------------- */

test("bilah navigasi bawah tidak pernah disembunyikan oleh sisa aturan laci", () => {
  // Laci samping yang lama meninggalkan `visibility: hidden` dan
  // `pointer-events: none` di blok 900px, dan blok bilah bawah yang
  // menggantikannya tidak pernah menyatakan ulang keduanya. Bilahnya karena itu
  // ada di dalam tata letak — `.workspace` bahkan menyisakan 76 piksel
  // untuknya — tetapi tidak tergambar dan tidak dapat disentuh, sehingga di
  // ponsel dan tablet aplikasi ini hanya punya satu halaman yang dapat dibuka.
  const responsive = css.slice(css.indexOf("@media (max-width: 900px)"));
  const sidebarRules = responsive.match(/\.sidebar[^{]*\{[^}]*\}/g) || [];
  sidebarRules.forEach((rule) => {
    assert.doesNotMatch(rule, /visibility:\s*hidden/, `bilah bawah disembunyikan oleh: ${rule}`);
    assert.doesNotMatch(rule, /pointer-events:\s*none/, `bilah bawah tidak dapat disentuh: ${rule}`);
    assert.doesNotMatch(rule, /translateX\(-/, `bilah bawah digeser keluar layar oleh: ${rule}`);
  });
});

test("tombol navigasi tetap punya nama ketika labelnya disembunyikan", () => {
  // Di bawah 380px label teks nav `display: none`, dan simpul yang disembunyikan
  // begitu ikut hilang dari pohon aksesibilitas — sementara ikonnya sendiri
  // `aria-hidden`. Tanpa aria-label kelima tombol dibacakan tanpa nama.
  assert.match(bottomBarLayer, /\.sidebar \.nav-link span \{\s*display: none;/);
  assert.match(app, /aria-label="\$\{esc\(page\.label\)\}"/);
});

/* -- Filter papan ---------------------------------------------------------- */

test("filter status dan gate dapat dipakai di setiap lebar layar", () => {
  // `display: contents` pada `<details>` gagal dua kali sekaligus: keadaan
  // tutupnya tetap menahan isi dari penggambaran, dan browser tetap menyisipkan
  // `::details-content` sehingga kedua medan bertumpuk sebagai blok. Hasilnya
  // papan tidak punya filter status maupun gate sama sekali di atas 720px.
  assert.doesNotMatch(css, /\.filter-more \{\s*display: contents;/);
  assert.match(css, /\.filter-more-body \{\s*display: flex;/);
  // `open` adalah atribut, bukan gaya — hanya JavaScript yang dapat memasangnya.
  assert.match(board, /onBreakpoint\("\(min-width: 721px\)"/);
  assert.match(board, /wideFilters\(\)/);
});

test("bilah filter tidak menyisakan kolom kosong di halaman mana pun", () => {
  // Grid lima kolom dipakai bersama oleh bilah yang isinya berbeda: papan
  // mengisi tiga, Laporan dan Analitik dua. Kolom yang tidak terisi tetap
  // memakan lebarnya, dan Laporan menambalnya dengan <div></div> kosong.
  const rule = css.slice(css.indexOf(".filter-bar {"));
  assert.match(rule.slice(0, rule.indexOf("}")), /display: flex/);
  [report, analytics].forEach((page) => {
    assert.doesNotMatch(page, /<div><\/div>/, "medan kosong hanya menutupi grid yang salah bentuk");
  });
});

/* -- Teks yang bertabrakan ------------------------------------------------- */

test("aksi kartu antrean membungkus alih-alih saling menabrak", () => {
  // `grid-auto-flow: column` memeras keempat tombol kartu WAITING ke satu baris:
  // 78 piksel untuk label yang butuh 94, dan karena tombolnya `white-space:
  // nowrap` teksnya meluber dan bertumpuk dengan tetangganya.
  const rule = css.slice(css.indexOf(".queue-actions {"));
  const body = rule.slice(0, rule.indexOf("}"));
  assert.doesNotMatch(body, /grid-auto-flow: column/);
  assert.match(body, /repeat\(auto-fit, minmax\(\d+px, 1fr\)\)/);
});

test("kelompok tombol membungkus alih-alih meluber melewati kartunya", () => {
  // Tiga tombol tema di layar Pengaturan meluber 21 piksel melewati tepi
  // kartunya pada layar 320px, dan `.section` memakai `overflow: hidden` — jadi
  // "Ikut sistem" terpotong separuh alih-alih turun ke baris berikutnya.
  assert.match(
    css,
    /\.page-actions,\s*\n\.section-actions,\s*\n\.table-actions \{\s*\n\s*flex-wrap: wrap;/,
  );
});

test("label keadaan dok dipotong dengan ellipsis, bukan oleh tepi ubin", () => {
  // `.dock` memakai `overflow: hidden`, jadi label yang tidak muat hilang
  // separuh alih-alih menyusut. Anak fleks juga menolak menyusut di bawah lebar
  // teksnya tanpa `min-width: 0`.
  const rule = css.slice(css.indexOf(".dock-state {"));
  const body = rule.slice(0, rule.indexOf("}"));
  assert.match(body, /min-width: 0/);
  assert.match(body, /text-overflow: ellipsis/);
});

test("sel tabel tidak membungkus; wadahnya yang menggulir", () => {
  // Nama vendor sepanjang empat puluh karakter membuat satu baris tabel setinggi
  // enam baris teks — sekitar 250 piksel untuk satu tiket di layar ponsel.
  const rule = css.slice(css.indexOf(".tbl th,"));
  assert.match(rule.slice(0, rule.indexOf("}")), /white-space: nowrap/);
  assert.match(css, /\.tbl td\.cell-text \{[^}]*text-overflow: ellipsis/s);
  // Kolom teks bebas membawa nilai penuhnya di `title` supaya tidak ada yang
  // hilang karena dipotong.
  assert.match(report, /class="cell-text" title=/);
  assert.match(analytics, /class="cell-text" title=/);
});

/* -- Grafik ---------------------------------------------------------------- */

test("kanvas grafik mengecil bersama layar supaya labelnya tetap terbaca", () => {
  // SVG di dalam viewBox diskalakan seluruhnya, termasuk hurufnya. Dengan
  // viewBox tetap 720 unit, label 10 unit tiba di ponsel sebagai huruf setinggi
  // empat setengah piksel.
  assert.match(charts, /function useGeometry\(\)/);
  assert.match(charts, /matchMedia\?\.\("\(max-width: 720px\)"\)/);
  ["stackedDailyChart", "complianceChart", "columnChart", "fleetChart"].forEach((fn) => {
    const body = charts.slice(charts.indexOf(`export function ${fn}(`));
    assert.match(
      body.slice(0, body.indexOf("\n}")),
      /useGeometry\(\);/,
      `${fn} harus menyetel geometri sebelum menggambar`,
    );
  });
});

test("label terakhir sumbu-x menggantikan tetangganya, bukan menimpanya", () => {
  // Label terakhir selalu digambar; tanpa penyisihan ini ia bertumpuk dengan
  // label bertahap yang kebetulan tepat di sebelahnya.
  assert.match(charts, /if \(last - index < every\) shown\.delete\(index\)/);
});

/* -- Perpindahan halaman --------------------------------------------------- */

test("judul halaman tidak bersembunyi di balik topbar setelah berpindah menu", () => {
  // `focus()` polos menggulir elemennya ke tepi atas viewport, dan tepi itu
  // tertutup topbar setinggi 72 piksel: halaman berhenti pada scrollY 72 dengan
  // eyebrow hilang seluruhnya dan judulnya terpotong separuh.
  assert.match(app, /focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /scrollTo\(\{ top: 0/);
  assert.match(css, /\.workspace \{[^}]*scroll-margin-top: calc\(var\(--topbar-height\)/s);
});

/* -- Urutan yang dibaca ---------------------------------------------------- */

test("langkah pendaftaran mengikuti urutan baca di kedua tata letak", () => {
  // Sebelumnya Langkah 3 berada di kolom kiri dan Langkah 2 di kolom kanan, jadi
  // yang terbaca adalah 1, 3, 2 — di desktop maupun ketika kolomnya bertumpuk.
  const steps = [...register.matchAll(/eyebrow: "(Langkah \d)"/g)].map((match) => match[1]);
  assert.deepEqual(steps, ["Langkah 1", "Langkah 2", "Langkah 3"]);
});

test("judul layar masuk menurun dari tingkat satu", () => {
  const h1 = app.indexOf("<h1>${esc(BRAND_SHORT)}</h1>");
  const h2 = app.indexOf("<h2>Selamat datang</h2>");
  assert.ok(h1 > 0 && h2 > 0, "kedua judul harus ada");
  assert.ok(h1 < h2, "tingkat satu harus mendahului tingkat dua di dokumen");
});

/* -- Status yang tidak boleh hilang ---------------------------------------- */

test("pil status tetap tampil di ponsel", () => {
  // Ia satu-satunya tempat papan mengatakan bahwa ia terputus, bahwa master PO
  // membeku, atau bahwa jam tablet meleset sehingga setiap jam kedatangan hari
  // itu salah — dan ia sempat disembunyikan bersama jam dinding, di perangkat
  // yang paling sering dipakai di gudang.
  const compact = css.slice(css.indexOf("@media (max-width: 720px)"));
  const hidden = compact.match(/\.live-clock \{\s*display: none;/);
  assert.ok(hidden, "jam dinding memang boleh disembunyikan");
  assert.doesNotMatch(
    compact.slice(0, compact.indexOf("@media", 10)),
    /\.data-mode,\s*\n\s*\.live-clock \{\s*display: none;/,
    "pil status tidak boleh ikut disembunyikan",
  );
  assert.match(compact, /\.data-mode \{[^}]*max-width:/s);
});
