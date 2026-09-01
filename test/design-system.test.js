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

/** Token yang nilainya harus sama persis dengan app/globals.css milik hub. */
const SHARED_TOKENS = {
  "--bg": "#f4f7fb",
  "--surface": "#ffffff",
  "--surface-muted": "#f7f9fc",
  "--surface-accent": "#eef5ff",
  "--line": "#dfe6f0",
  "--line-strong": "#cbd6e5",
  "--text": "#10213a",
  "--text-soft": "#4c5f78",
  "--text-muted": "#718198",
  "--accent": "#2563eb",
  "--teal": "#0f9f8f",
  "--status-normal": "#15945f",
  "--status-monitor": "#b58212",
  "--status-warning": "#d86a17",
  "--status-critical": "#cf3f58",
  "--radius": "14px",
  "--sidebar": "232px",
  "--topbar-height": "72px",
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

test("token tema terang identik dengan design system outbound-operations-hub", () => {
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  Object.entries(SHARED_TOKENS).forEach(([token, value]) => {
    assert.match(root, new RegExp(`${token}:\\s*${value.replace(/[()]/g, "\\$&")};`), `${token} harus ${value}`);
  });
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
  const bytes = Buffer.byteLength(css, "utf8");
  assert.ok(bytes < 60_000, `style.css harus tetap ramping, sekarang ${bytes} byte`);
  assert.equal((html.match(/rel="stylesheet"/g) || []).length, 2, "hanya font Google dan style.css");
});

test("kelas khusus domain tidak mengotori primitif bersama", () => {
  // Hitung mundur dan kartu antrean adalah tambahan milik aplikasi ini; ia
  // harus berdiri sebagai kelas sendiri, bukan menimpa primitif hub.
  [".sla", ".sla-hero", ".queue-card", ".plate-input", ".fleet-option"].forEach((selector) => {
    assert.ok(css.includes(`${selector} {`), `kelas domain ${selector} harus ada`);
  });
});
