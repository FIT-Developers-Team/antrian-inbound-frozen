/* ============================================================================
 * AUTO COMMIT & PUSH
 *
 *   npm run push            -- pesan commit dibangkitkan dari berkas yang berubah
 *   npm run push -- "pesan" -- pesan sendiri
 *
 * Menjalankan gerbang mutu lebih dulu, lalu commit dan push ke `main`.
 *
 * Gerbang itu bukan formalitas. Repo ini tidak punya CI, jadi push adalah
 * langkah terakhir sebelum kode tayang; sekali `main` rusak, tidak ada yang
 * menahannya. `--skip-checks` tersedia untuk keadaan darurat dan mengumumkan
 * dirinya di keluaran supaya tidak diam-diam menjadi kebiasaan.
 * ========================================================================== */

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const skipChecks = args.includes("--skip-checks");
const message = args.filter((arg) => !arg.startsWith("--")).join(" ").trim();

const BRANCH = "main";

function git(...parameters) {
  return execFileSync("git", parameters, { encoding: "utf8" }).trim();
}

function run(command, commandArgs) {
  execFileSync(command, commandArgs, { stdio: "inherit", shell: process.platform === "win32" });
}

/* -- 1. Ada yang perlu di-push? -------------------------------------------- */
const status = git("status", "--porcelain");
if (!status) {
  console.log("\n  Tidak ada perubahan untuk di-commit.\n");
  process.exit(0);
}

const changed = status.split("\n").filter(Boolean);
console.log(`\n  ${changed.length} berkas berubah.`);

/* -- 2. Jangan pernah mendorong rahasia ------------------------------------ */
/**
 * Jaring pengaman terakhir sebelum secret keluar dari mesin ini. `.gitignore`
 * sudah menutup `.env*`, tetapi berkas yang terlanjur ter-stage sebelum aturan
 * itu ada tetap lolos — dan rahasia yang sudah masuk riwayat Git tidak dapat
 * ditarik kembali hanya dengan menghapusnya di commit berikutnya.
 */
const FORBIDDEN = [
  /(^|\/)\.env($|\.)/,
  /(^|\/)\.dev\.vars$/,
  /service[_-]?role/i,
  /(^|\/)secrets?\.json$/,
  /\.pem$/,
  /\.p12$/,
  /(^|\/)id_rsa/,
];

const offenders = changed
  .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""))
  .filter((file) => FORBIDDEN.some((pattern) => pattern.test(file)));

if (offenders.length) {
  console.error("\n  Dibatalkan: berkas berikut tampak memuat rahasia.\n");
  offenders.forEach((file) => console.error(`    ${file}`));
  console.error("\n  Tambahkan ke .gitignore, lalu jalankan ulang.\n");
  process.exit(1);
}

/* -- 3. Gerbang mutu ------------------------------------------------------- */
if (skipChecks) {
  console.log("  Melewati pemeriksaan atas permintaan (--skip-checks).");
} else {
  console.log("  Memeriksa sintaks…");
  run("npm", ["run", "check"]);
  console.log("  Menjalankan test…");
  run("npm", ["test"]);
}

/* -- 4. Pesan commit ------------------------------------------------------- */
/** Menyimpulkan cakupan perubahan dari lokasi berkasnya. */
function inferScope(files) {
  const areas = new Set();
  files.forEach((file) => {
    if (file.startsWith("js/pages/")) areas.add("ui");
    else if (file.startsWith("js/")) areas.add("frontend");
    else if (file.startsWith("supabase/migrations/")) areas.add("db");
    else if (file.startsWith("supabase/functions/")) areas.add("api");
    else if (file.startsWith("test/")) areas.add("test");
    else if (file.startsWith("scripts/")) areas.add("tooling");
    else if (file.endsWith(".md")) areas.add("docs");
    else if (file === "style.css" || file === "index.html") areas.add("ui");
  });
  return [...areas].sort().join(", ") || "repo";
}

const files = changed.map((line) => line.slice(3).trim());
const commitMessage =
  message || `chore: sinkronisasi ${inferScope(files)} (${files.length} berkas)`;

/* -- 5. Commit dan push ---------------------------------------------------- */
const current = git("rev-parse", "--abbrev-ref", "HEAD");
if (current !== BRANCH) {
  console.log(`  Berpindah dari ${current} ke ${BRANCH}…`);
  run("git", ["checkout", BRANCH]);
}

run("git", ["add", "-A"]);
run("git", ["commit", "-m", commitMessage]);

// Rebase dahulu agar commit orang lain tidak tertimpa oleh push ini.
console.log("  Menarik perubahan remote…");
try {
  run("git", ["pull", "--rebase", "origin", BRANCH]);
} catch {
  console.error("\n  Rebase gagal — selesaikan konflik, lalu jalankan ulang.\n");
  process.exit(1);
}

run("git", ["push", "origin", BRANCH]);

console.log(`\n  Terdorong ke ${BRANCH}: ${commitMessage}\n`);
