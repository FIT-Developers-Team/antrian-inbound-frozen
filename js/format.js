/* ==========================================================================
 * ANTRIAN INBOUND FROZEN — FORMAT & PARSING
 * ========================================================================== */

/**
 * Parser tanggal yang aman untuk data operasional Indonesia.
 *
 * `new Date("31/08/2026 14:05")` menghasilkan Invalid Date di semua mesin, dan
 * `new Date("2026-08-31 14:05")` (spasi, bukan "T") dulunya dibaca berbeda
 * antara Safari dan Chrome. Karena itu bentuk hari/bulan/tahun dan bentuk
 * "YYYY-MM-DD HH:mm" ditangani eksplisit sebelum menyerah ke `new Date`.
 *
 * Nilai tanpa zona waktu diperlakukan sebagai waktu lokal perangkat, yang di
 * lapangan selalu WIB.
 */
export function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const text = String(value).trim();
  if (!text) return null;

  // ISO dengan zona waktu — jalur yang dipakai seluruh payload API.
  if (/\d{4}-\d{2}-\d{2}T/.test(text)) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  // "YYYY-MM-DD HH:mm[:ss]"
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (iso) {
    const [, y, mo, d, h, mi, s] = iso;
    return new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  }

  // "DD/MM/YYYY HH:mm[:ss]" atau "DD-MM-YYYY HH:mm[:ss]"
  const id = text.match(
    /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (id) {
    const [, d, mo, y, h, mi, s] = id;
    return new Date(+y, +mo - 1, +d, +(h || 0), +(mi || 0), +(s || 0));
  }

  const fallback = new Date(text);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

const TIME_FMT = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit" });
const DATE_FMT = new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short" });
const FULL_FMT = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** "14:05" — jam saja, untuk sel yang sudah jelas tanggalnya. */
export function formatTime(value) {
  const date = parseDate(value);
  return date ? TIME_FMT.format(date) : "-";
}

/** "31 Agu 14:05" — jam dengan tanggal ringkas. */
export function formatDateTime(value) {
  const date = parseDate(value);
  return date ? `${DATE_FMT.format(date)} ${TIME_FMT.format(date)}` : "-";
}

export function formatFull(value) {
  const date = parseDate(value);
  return date ? FULL_FMT.format(date) : "-";
}

/** Nilai untuk `<input type="datetime-local">`, selalu waktu lokal perangkat. */
export function toLocalInputValue(value = new Date()) {
  const date = parseDate(value) || new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function toDateInputValue(value = new Date()) {
  return toLocalInputValue(value).slice(0, 10);
}

/**
 * Durasi ringkas.
 *
 * Di atas satu jam operator hanya peduli jam dan menit ("2j 14m"); di bawah
 * satu jam detik justru yang menentukan, jadi ditampilkan sebagai "14:32".
 */
export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}j ${String(minutes).padStart(2, "0")}m`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Durasi panjang untuk laporan: selalu jam + menit.
 *
 * Nilai yang tidak terukur dikembalikan sebagai "-", bukan "0m". Keduanya
 * terlihat mirip di tabel tetapi artinya berlawanan: "0m" berarti selesai
 * seketika, sedangkan yang dimaksud adalah belum ada datanya sama sekali.
 */
export function formatMinutes(totalMinutes) {
  if (totalMinutes === null || totalMinutes === undefined || !Number.isFinite(Number(totalMinutes))) {
    return "-";
  }
  const minutes = Math.max(0, Math.round(Number(totalMinutes)));
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}j ${String(minutes % 60).padStart(2, "0")}m`;
  return `${minutes}m`;
}

export function minutesBetween(start, end) {
  const from = parseDate(start);
  const to = parseDate(end) || new Date();
  if (!from) return null;
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000));
}

/* --------------------------------------------------------------------------
 * Teks
 * ----------------------------------------------------------------------- */

/** Escape HTML. Setiap nilai dari server melewati fungsi ini sebelum disisipkan. */
export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString("id-ID") : "0";
}

/** Membungkus nilai untuk satu sel CSV, aman terhadap koma dan kutip. */
export function csvCell(value) {
  const text = String(value ?? "").replace(/"/g, '""');
  return /[",\n;]/.test(text) ? `"${text}"` : text;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(",")];
  rows.forEach((row) => lines.push(row.map(csvCell).join(",")));
  return lines.join("\n");
}

/* --------------------------------------------------------------------------
 * Plat nomor
 * ----------------------------------------------------------------------- */

/**
 * Plat Indonesia: 1-2 huruf wilayah, 1-4 angka, 1-3 huruf seri.
 * Contoh sah: B 1234 XYZ, DK 12 A, AB 1 CD.
 */
const PLATE_RE = /^[A-Z]{1,2}\s?\d{1,4}\s?[A-Z]{0,3}$/;

export function normalizePlate(prefix, number, suffix) {
  const clean = (value, pattern) =>
    String(value || "").toUpperCase().replace(pattern, "").trim();
  return [
    clean(prefix, /[^A-Z]/g),
    clean(number, /[^0-9]/g),
    clean(suffix, /[^A-Z]/g),
  ]
    .filter(Boolean)
    .join(" ");
}

export function isValidPlate(value) {
  return PLATE_RE.test(String(value || "").toUpperCase().trim());
}

/** Memecah "B 1234 XYZ" kembali menjadi tiga bagian untuk mengisi form. */
export function splitPlate(value = "") {
  const match = String(value)
    .toUpperCase()
    .trim()
    .match(/^([A-Z]{1,2})\s*(\d{1,4})\s*([A-Z]{0,3})$/);
  return match
    ? { prefix: match[1], number: match[2], suffix: match[3] }
    : { prefix: "", number: "", suffix: "" };
}
