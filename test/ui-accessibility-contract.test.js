const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const html = read("index.html");
const css = read("style.css");
const app = read("js/app.js");

test("halaman menyediakan jalan pintas ke konten utama", () => {
  // Tanpa ini pengguna keyboard harus menelusuri sebelas tombol menu
  // setiap kali berpindah halaman.
  assert.match(html, /<a class="skip-link" href="#page-root">/);
  assert.match(html, /id="page-root"[\s\S]{0,120}tabindex="-1"/);
  assert.match(css, /\.skip-link \{/);
  assert.match(css, /\.skip-link:focus-visible \{\s*transform: translateY\(0\);/);
});

test("landmark dan label navigasi terbaca pembaca layar", () => {
  assert.match(html, /<aside[\s\S]{0,120}aria-label="Menu utama"/);
  assert.match(html, /<nav id="side-nav" aria-label="Navigasi halaman"/);
  assert.match(html, /<nav id="mobile-nav" aria-label="Navigasi halaman \(mobile\)"/);
  // Ikon hanya dekorasi; teks tombol yang dibacakan.
  const iconCount = (html.match(/material-symbols-outlined/g) || []).length;
  const hiddenIconCount = (html.match(/material-symbols-outlined"[^>]*aria-hidden="true"/g) || []).length;
  assert.ok(
    hiddenIconCount >= iconCount - 2,
    `ikon dekoratif harus aria-hidden (${hiddenIconCount}/${iconCount})`,
  );
});

test("setiap tombol memiliki type eksplisit sehingga tidak ikut submit form", () => {
  const buttons = html.match(/<button(?![^>]*type=)[^>]*>/g) || [];
  assert.deepEqual(buttons, [], "tombol tanpa type default ke submit");
});

test("tombol tanpa teks memiliki nama yang dapat diakses", () => {
  // Sidebar toggle dan tombol tema hanya berisi ikon.
  assert.match(html, /id="sidebar-toggle"[\s\S]{0,400}aria-label="Sembunyikan atau tampilkan menu"/);
  assert.match(html, /onclick="toggleTheme\(\)"[\s\S]{0,200}aria-label="Ganti tema terang atau gelap"/);
  assert.match(html, /<span class="sr-only">Pilih gudang<\/span>/);
  assert.match(css, /\.sr-only \{/);
});

test("status sidebar diumumkan lewat aria-expanded", () => {
  assert.match(html, /aria-controls="sidebar-panel"/);
  assert.match(html, /aria-expanded="true"/);
  // Nilai harus ikut berubah ketika sidebar disembunyikan.
  assert.match(app, /toggle\.setAttribute\("aria-expanded", hidden \? "false" : "true"\)/);
});

test("toast dan indikator status diumumkan tanpa mencuri fokus", () => {
  assert.match(html, /id="toast"[\s\S]{0,200}aria-live="polite"/);
  assert.match(html, /id="toast"[\s\S]{0,200}role="status"/);
  assert.match(html, /id="api-pill"[\s\S]{0,80}role="status"/);
});

test("konten menandai status memuat dan melepasnya setelah render", () => {
  assert.match(html, /id="page-root"[\s\S]{0,160}aria-busy="true"/);
  assert.match(html, /class="app-boot" role="status"/);
  assert.match(app, /root\.setAttribute\("aria-busy", "false"\)/);
  assert.match(css, /\.app-boot \{/);
});

test("fokus keyboard selalu terlihat", () => {
  assert.match(css, /:focus-visible \{\s*outline: 2px solid rgb\(var\(--primary\)\);/);
  assert.match(css, /button:focus-visible,/);
  // Kontainer yang difokuskan secara terprogram tidak perlu cincin fokus.
  assert.match(css, /#page-root:focus,\s*\n#page-root:focus-visible \{\s*outline: none;/);
});

test("target sentuh memenuhi ukuran minimum di perangkat sentuh", () => {
  const block = css.slice(css.indexOf("@media (pointer: coarse) {\n  .nav-btn,"));
  assert.match(block, /min-height: 44px;/);
  assert.match(block, /min-width: 44px;/);
});

test("preferensi gerakan minimal dihormati secara menyeluruh", () => {
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\n  \*,\s*\n  \*::before,\s*\n  \*::after \{/,
  );
  assert.match(css, /animation-duration: 0\.01ms !important;/);
});

test("kontras teks tidak diturunkan oleh opasitas dekoratif", () => {
  assert.match(css, /#brand-site \{\s*\n  opacity: 1;/);
  // Placeholder sebelumnya 0.72 alpha, di bawah ambang WCAG AA.
  assert.match(css, /\.form-input::placeholder \{\s*\n  color: rgb\(var\(--on-surface-variant\) \/ 0\.85\)/);
});

test("kesalahan input tidak ditandai hanya dengan warna", () => {
  assert.match(css, /\.form-input\.invalid,\s*\n\.form-select\.invalid \{\s*\n  border-width: 2px;/);
  assert.match(css, /\.form-input\.invalid \+ \.form-help/);
});

test("halaman tetap informatif tanpa JavaScript", () => {
  assert.match(html, /<noscript>/);
  assert.match(html, /Aplikasi ini memerlukan JavaScript/);
  assert.match(css, /\.noscript-banner \{/);
});

test("kontrol mati dihapus dari header", () => {
  // Tombol lonceng "notifications" tidak pernah punya handler.
  assert.doesNotMatch(html, />\s*notifications\s*</);
});

test("dokumen membawa metadata dasar dan hint performa", () => {
  assert.match(html, /<html class="dark" lang="id">/);
  assert.match(html, /<title>Antrian Inbound Frozen<\/title>/);
  assert.match(html, /<meta\s+name="description"/);
  assert.match(html, /name="theme-color"[^>]*media="\(prefers-color-scheme: dark\)"/);
  assert.match(html, /rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin/);
  assert.match(html, /viewport-fit=cover/);
});

test("cetak tiket tidak membawa kerangka aplikasi", () => {
  const printBlock = css.slice(css.lastIndexOf("@media print {"));
  for (const selector of ["#sidebar-panel", "#mobile-menu-bar", "#toast", "header", ".skip-link"]) {
    assert.ok(printBlock.includes(selector), `${selector} harus disembunyikan saat cetak`);
  }
});

test("versi aset frontend naik bersamaan agar cache lama tidak tercampur", () => {
  const versions = [...html.matchAll(/\.(?:js|css)\?v=([\d.]+)/g)].map((match) => match[1]);
  assert.ok(versions.length >= 6, "seluruh aset harus punya penanda versi");
  assert.equal(new Set(versions).size, 1, `versi aset harus seragam, ditemukan ${[...new Set(versions)].join(", ")}`);
});

test("registry gudang dimuat sebelum kode aplikasi memakainya", () => {
  const siteConfig = html.indexOf("js/site_config.js");
  const appScript = html.indexOf("js/app.js");
  const apiScript = html.indexOf("js/api_v2.js");
  assert.ok(siteConfig > 0 && siteConfig < appScript && appScript < apiScript);
});

/* ==========================================================================
 * Perbaikan tata letak yang tersingkap oleh nama gate multi-site.
 * Nama gate baru ("PGS-GATE-INB-01-02") tiga kali lebih panjang dari
 * penamaan lama ("Dock 01") dan mematahkan beberapa layout padat.
 * ========================================================================== */

test("sel tabel dan kartu padat memakai chip gate ringkas", () => {
  assert.match(app, /function gateChipsHtml\(value, fallback = "-"\)/);
  // Nama penuh tetap tersedia lewat tooltip untuk mencocokkan papan gate fisik.
  assert.match(app, /<span class="gate-chip" title="\$\{esc\(gate\)\}">/);
  assert.match(css, /\.gate-chip \{/);
  assert.match(css, /white-space: nowrap;/);

  // Tidak boleh ada lagi sel tabel yang mencetak nama gate mentah.
  assert.doesNotMatch(app, /<td[^>]*>\$\{esc\(\w+\.gate \|\| "-"\)\}<\/td>/);
});

test("layar TV menampilkan gate ringkas besar dengan nama penuh sebagai subteks", () => {
  assert.match(app, /function gateDisplayHtml\(value, fallback = "-"\)/);
  assert.match(app, /<div id="display-dock" class="tv-gate mt-2">\$\{gateDisplayHtml\(last\.gate\)\}<\/div>/);
  // Pembaruan periodik harus memakai helper yang sama, bukan textContent mentah.
  assert.match(app, /if \(dock\) dock\.innerHTML = gateDisplayHtml\(latest\.gate\);/);
  assert.match(css, /\.tv-gate \.tv-gate-short \{/);
  assert.match(css, /\.tv-gate \.tv-gate-full \{/);
});

test("panel tindakan Checker adalah kolom tunggal yang tidak menciut", () => {
  // `md:col-span-2` pada field di dalam `grid-cols-1` membuat kolom implisit
  // kedua, sehingga separuh field menciut ke lebar 0 dan labelnya bertumpuk.
  assert.doesNotMatch(app, /<div class="grid grid-cols-1 gap-4">/);
  const panels = (app.match(/<div class="flex flex-col gap-4">/g) || []).length;
  assert.ok(panels >= 3, `ketiga panel Checker harus flex column, ditemukan ${panels}`);
});

test("judul halaman tidak lagi terpotong oleh subjudul", () => {
  // Sebelumnya subjudul memakai flex-shrink 0 sehingga judul menyerap seluruh
  // penyusutan dan hanya menyisakan dua karakter.
  assert.match(css, /header #page-title \{\s*\n  flex: 0 0 auto;/);
  assert.match(css, /header #page-subtitle \{\s*\n  flex: 0 1 auto;/);
});

test("filter Waiting List memberi ruang cukup untuk kontrol tanggal", () => {
  assert.match(css, /#waiting-list-filter-form-v181 > div:last-child \{[\s\S]*?repeat\(auto-fit, minmax\(180px, 1fr\)\)/);
  assert.match(css, /input\[type="date"\]\.form-input,[\s\S]*?min-width: 150px;/);
});

test("overlay tetap tidak menangkap ketukan operator", () => {
  // Indikator sinkron dan toast berada di atas form; keduanya murni informatif.
  assert.match(css, /\.global-auto-sync-indicator-v11 \{\s*\n  pointer-events: none;/);
  assert.match(css, /#toast \{\s*\n  pointer-events: none;/);
});

test("nama menu konsisten antara sidebar, judul header, dan judul kartu", () => {
  assert.match(app, /monitor: \{[\s\S]{0,200}title: "Waiting Monitor"/);
  assert.doesNotMatch(app, /title: "Waiting List Monitoring"/);
});
