/* ============================================================================
 * KONTRAK DESIGN SYSTEM
 *
 * Aplikasi ini harus terlihat sebagai satu keluarga dengan
 * outbound-operations-hub. Berkas ini mengunci token dan primitif yang dipinjam
 * dari sana, sehingga penyimpangan terlihat sebagai test merah, bukan sebagai
 * "kok warnanya beda ya" beberapa bulan kemudian.
 * ========================================================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const { read, allFrontend } = require("./helpers");

const css = read("style.css");
const html = read("index.html");

/**
 * Token yang nilainya harus sama persis dengan app/globals.css milik hub.
 *
 * Bidang, garis, dan geometri dipinjam apa adanya: itulah yang membuat kedua
 * aplikasi terlihat serumpun, dan tidak satu pun darinya pernah menjadi warna
 * huruf.
 */
const SHARED_TOKENS = {
  "--bg": "#f4f7fb",
  "--surface": "#ffffff",
  "--surface-muted": "#f7f9fc",
  "--surface-accent": "#eef5ff",
  "--line": "#dfe6f0",
  "--line-strong": "#cbd6e5",
  "--text": "#10213a",
  "--text-soft": "#4c5f78",
  "--radius": "14px",
  "--sidebar": "232px",
  "--topbar-height": "72px",
};

/**
 * Token yang SENGAJA lebih gelap daripada milik hub, beserta alasannya.
 *
 * Ketujuh token ini di hub dipakai sebagai aksen dan bidang pada dasbor kantor.
 * Di sini hampir seluruh pemakaiannya adalah TEKS, dan teks yang kecil:
 * `.fact span` 9px, `.dock-state` 10px, `.badge` 10px, `.sla-note` 10px,
 * `.eyebrow` 11px, `.metric-sub` 11px. WCAG menuntut 4,5:1 untuk ukuran itu,
 * bukan 3:1 — dan pada nilai hub tidak satu pun mencapainya:
 *
 *   --text-muted     #718198  3,69:1 di atas --bg
 *   --teal           #0f9f8f  2,94:1 sebagai teks .badge-teal
 *   --status-normal  #15945f  3,87:1 sebagai teks .badge-normal
 *   --status-monitor #b58212  3,41:1
 *   --status-warning #d86a17  3,50:1  ← dipakai hitung mundur SLA menjelang tenggat
 *   --accent         #2563eb  4,06:1 sebagai teks .badge-accent
 *
 * Angka SLA yang tidak terbaca bukan cacat kosmetik: papan ini dibaca sambil
 * berjalan, bersarung tangan, di ruang beku yang layarnya berembun. Hue-nya
 * tidak bergeser — hanya satu langkah lebih pekat — sehingga kedua aplikasi
 * tetap terlihat serumpun.
 *
 * Bila hub kelak ikut memperdalam skalanya, kedua daftar ini menyatu kembali.
 */
const CONTRAST_TOKENS = {
  "--text-muted": "#616f85",
  "--accent": "#1e51c4",
  "--teal": "#0a7669",
  "--status-normal": "#0f744a",
  "--status-monitor": "#8a6009",
  "--status-warning": "#b4550c",
  "--status-critical": "#b82743",
};

const DARK_TOKENS = {
  "--bg": "#09111f",
  "--surface": "#101a2d",
  "--line": "#24334b",
  "--text": "#eef4ff",
  "--accent": "#6fa4ff",
  "--teal": "#3fd0bd",
  "--status-critical": "#ff7388",
};

function lightRoot() {
  return css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
}

test("token tema terang identik dengan design system outbound-operations-hub", () => {
  const root = lightRoot();
  Object.entries(SHARED_TOKENS).forEach(([token, value]) => {
    assert.match(root, new RegExp(`${token}:\\s*${value.replace(/[()]/g, "\\$&")};`), `${token} harus ${value}`);
  });
});

test("skala status tema terang cukup pekat untuk teks kecil", () => {
  const root = lightRoot();
  Object.entries(CONTRAST_TOKENS).forEach(([token, value]) => {
    assert.match(
      root,
      new RegExp(`${token}:\\s*${value};`),
      `${token} harus ${value} — lihat catatan CONTRAST_TOKENS sebelum menurunkannya`,
    );
  });
});

test("tinta di atas bidang aksen dan teal mengikuti tema", () => {
  // Tombol primer dan tombol teal memakai warnanya sebagai LATAR, jadi tintanya
  // harus berlawanan arah dengan temanya. Sebelum token ini ada, keduanya dipaku
  // `#fff` — dan di tema gelap itu berarti putih di atas #6fa4ff, 2,5:1, pada
  // tombol yang paling sering ditekan di seluruh aplikasi.
  assert.match(css, /\.btn-primary \{[^}]*color: var\(--accent-ink\)/s);
  assert.match(css, /\.btn-teal \{[^}]*color: var\(--teal-ink\)/s);
  assert.match(lightRoot(), /--accent-ink:\s*#ffffff;/);
  assert.match(css.slice(css.indexOf(".dark {")), /--accent-ink:\s*#06152f;/);
});

test("token tema gelap identik dengan design system outbound-operations-hub", () => {
  const dark = css.slice(css.indexOf(".dark {"), css.indexOf("}", css.indexOf(".dark {")));
  Object.entries(DARK_TOKENS).forEach(([token, value]) => {
    assert.match(dark, new RegExp(`${token}:\\s*${value};`), `${token} gelap harus ${value}`);
  });
});

test("tema gelap juga berlaku lewat preferensi sistem tanpa mengalahkan pilihan eksplisit", () => {
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(
    css,
    /:root:not\(\.light\)/,
    "pilihan terang eksplisit harus menang atas setelan sistem gelap",
  );
  assert.match(read("js/theme.js"), /classList\.toggle\("light", mode === "light"\)/);
});

test("primitif inti dipinjam apa adanya dari design system", () => {
  [
    ".app-shell",
    ".sidebar",
    ".sidebar.rail",
    ".nav-link",
    ".topbar",
    ".workspace",
    ".page-header",
    ".eyebrow",
    ".card",
    ".section-head",
    ".section-body",
    ".btn",
    ".btn-primary",
    ".btn-ghost",
    ".btn-danger",
    ".input",
    ".chip",
    ".badge",
    ".metric-strip",
    ".metric-card",
    ".tbl",
    ".table-scroll",
    ".progress-track",
    ".empty-state",
    ".modal-card",
    ".form-grid",
    ".filter-bar",
  ].forEach((selector) => {
    assert.ok(
      css.includes(`${selector} {`) || css.includes(`${selector},`),
      `kelas ${selector} harus ada di design system`,
    );
  });
});

test("nada badge memakai skala status yang sama", () => {
  ["muted", "normal", "monitor", "warning", "critical", "accent", "teal"].forEach((tone) => {
    assert.match(css, new RegExp(`\\.badge-${tone}`), `badge-${tone} harus ada`);
  });
});

test("tipografi memakai Poppins dan Inconsolata seperti hub", () => {
  assert.match(css, /--font-sans: "Poppins"/);
  assert.match(css, /--font-mono: "Inconsolata"/);
  assert.match(html, /family=Poppins/);
  assert.match(html, /family=Inconsolata/);

  // Angka operasional selalu monospace supaya kolom tidak bergoyang saat
  // hitung mundur berjalan.
  assert.match(css, /\.metric-value \{[^}]*font-variant-numeric: tabular-nums/s);
  assert.match(css, /\.sla-value \{[^}]*font-variant-numeric: tabular-nums/s);
});

test("Tailwind CDN tidak lagi dimuat", () => {
  // Compiler Tailwind versi CDN menyusun ulang seluruh CSS di dalam browser
  // pada setiap muat halaman dan tidak ditujukan untuk produksi.
  assert.doesNotMatch(html, /cdn\.tailwindcss\.com/);
  assert.doesNotMatch(html, /tailwind\.config/);
  assert.doesNotMatch(html, /material-symbols|Material\+Symbols/i);
});

test("ikon adalah SVG sebaris, bukan font ikon", () => {
  assert.match(read("js/ui.js"), /export function icon\(/);
  assert.match(read("js/ui.js"), /<svg viewBox="0 0 24 24"/);
  assert.doesNotMatch(allFrontend(), /material-symbols-outlined/);
});

test("hanya ada satu berkas gaya dan ukurannya wajar", () => {
  // Batas ini dinaikkan dari 60 KB, dan alasannya dicatat supaya kenaikan
  // berikutnya harus dibela juga.
  //
  // Angka 60 KB ditetapkan ketika aplikasi ini belum punya grafik, belum punya
  // rel dok, dan belum punya lapisan tata letak ponsel. Ketiganya kini ada, dan
  // ketiganya membawa gayanya sendiri. Yang dijaga batas ini sebenarnya bukan
  // angkanya melainkan sifatnya: SATU berkas, tanpa framework, tanpa kelas yang
  // dibangkitkan — dan sifat itu masih berlaku.
  //
  // Bila angka ini perlu naik lagi, pertanyaannya bukan "berapa" melainkan
  // "gaya apa yang baru saja bertambah, dan apakah ia berhak ada".
  //
  // Naik lagi dari 72 KB ke 78 KB setelah audit tata letak menyeluruh. Yang
  // bertambah dapat disebut satu per satu: bilah filter berbasis fleks
  // (menggantikan grid lima kolom yang menyisakan dua kolom kosong), sel tabel
  // yang tidak lagi membungkus beserta dua kelas lebarnya, ubin dok yang
  // memotong labelnya dengan ellipsis, pil status ringkas untuk ponsel, ukuran
  // label grafik ponsel, dan `scroll-margin-top` supaya judul halaman tidak
  // bersembunyi di balik topbar. Sifatnya tidak berubah: satu berkas, tanpa
  // framework, tanpa kelas yang dibangkitkan.
  const bytes = Buffer.byteLength(css, "utf8");
  assert.ok(bytes < 78_000, `style.css harus tetap ramping, sekarang ${bytes} byte`);
  assert.equal((html.match(/rel="stylesheet"/g) || []).length, 2, "hanya font Google dan style.css");
});

test("kelas khusus domain tidak mengotori primitif bersama", () => {
  // Hitung mundur dan kartu antrean adalah tambahan milik aplikasi ini; ia
  // harus berdiri sebagai kelas sendiri, bukan menimpa primitif hub.
  [".sla", ".sla-hero", ".queue-card", ".plate-input", ".po-row"].forEach((selector) => {
    assert.ok(css.includes(`${selector} {`), `kelas domain ${selector} harus ada`);
  });
});
