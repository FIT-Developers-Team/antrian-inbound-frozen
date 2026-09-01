const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

/**
 * Akhir baris dinormalisasi: berkas dapat ter-checkout sebagai CRLF di Windows
 * dan LF di CI Linux. Assertion pada teks sumber tidak boleh bergantung pada itu.
 */
function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
}

function exists(file) {
  return fs.existsSync(path.join(root, file));
}

function listFiles(dir) {
  return fs.readdirSync(path.join(root, dir));
}

/** Menggabungkan seluruh migrasi sesuai urutan nama berkas. */
function allMigrations() {
  return listFiles("supabase/migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => read(`supabase/migrations/${file}`))
    .join("\n");
}

/** Seluruh modul frontend, untuk pemeriksaan yang berlaku menyeluruh. */
const FRONTEND_MODULES = [
  "js/app.js",
  "js/api.js",
  "js/config.js",
  "js/format.js",
  "js/sla.js",
  "js/store.js",
  "js/theme.js",
  "js/ui.js",
  "js/pages/board.js",
  "js/pages/register.js",
  "js/pages/report.js",
  "js/pages/settings.js",
];

function allFrontend() {
  return FRONTEND_MODULES.map(read).join("\n");
}

/** Memuat modul ESM frontend dari test CommonJS. */
function importModule(file) {
  const url = new URL(`file://${path.join(root, file).replace(/\\/g, "/")}`);
  return import(url.href);
}

module.exports = { root, read, exists, listFiles, allMigrations, allFrontend, FRONTEND_MODULES, importModule };
