/* ==========================================================================
 * ANTRIAN INBOUND FROZEN — KONFIGURASI
 *
 * Satu-satunya tempat nama gudang, location_id Superset, prefix gate, dan
 * daftar tipe armada didefinisikan di sisi frontend.
 *
 * CATATAN PENTING TENTANG SLA
 * ---------------------------
 * Angka jam SLA di file ini HANYA untuk ditampilkan sebagai tabel acuan di
 * halaman Pengaturan. Ia tidak pernah dipakai untuk menghitung tenggat.
 * Tenggat selalu datang dari kolom `sla_deadline_at` yang dihitung Postgres
 * lewat `public.inbound_sla_target_hours()`. Menghitung ulang di browser
 * adalah persis penyebab angka SLA di layar dan di Google Sheet tidak pernah
 * cocok sebelum revamp ini.
 * ========================================================================== */

import { API_PROXY_PATH } from "./deployment.js";

export const BRAND_FULL = "Antrian Inbound Frozen";
export const BRAND_SHORT = "Inbound Frozen";

/**
 * Selalu same-origin. Proses yang sama menyajikan halaman dan melayani jalur
 * ini, sehingga pengembangan dan produksi berperilaku sama, tidak ada URL
 * backend yang tertanam di kode browser, dan tidak ada proxy di antaranya yang
 * bisa hidup sendirian tanpa API di belakangnya.
 */
export const BACKEND_URL = API_PROXY_PATH;

export const STORAGE = {
  session: "inbound_frozen_session_v2",
  issuedAt: "inbound_frozen_issued_v2",
  user: "inbound_frozen_user_v2",
  site: "inbound_frozen_site_v2",
  theme: "inbound_frozen_theme_v2",
  rail: "inbound_frozen_rail_v2",
};

/** Interval polling papan antrean. Tab yang tersembunyi berhenti memanggil. */
export const POLL_INTERVAL_MS = 15000;

/** Ambang peringatan hitung mundur: 30 menit terakhir sebelum tenggat. */
export const SLA_WARNING_MINUTES = 30;

/* --------------------------------------------------------------------------
 * Gudang
 * ----------------------------------------------------------------------- */

/**
 * `gate_count` mengikuti jumlah dock inbound fisik per gudang. Nama gate
 * dibangkitkan sebagai `<gate_prefix>-NN`, jadi menambah dock cukup dengan
 * menaikkan angkanya di sini atau di `site_master.gate_count`.
 */
const SITE_LIST = [
  {
    code: "PGS",
    location_id: "160",
    name: "Pegangsaan",
    short_name: "Pegangsaan",
    gate_prefix: "PGS-GATE-INB-01",
    gate_count: 9,
    active: true,
  },
  {
    code: "SRG",
    location_id: "796",
    name: "Srengseng",
    short_name: "Srengseng",
    gate_prefix: "SRG-GATE-INB-01",
    gate_count: 6,
    active: false,
  },
  {
    code: "BIT",
    location_id: "983",
    name: "Bitung",
    short_name: "Bitung",
    gate_prefix: "BIT-GATE-INB-01",
    gate_count: 6,
    active: false,
  },
  {
    code: "CSI",
    location_id: "998",
    name: "Cileungsi",
    short_name: "Cileungsi",
    gate_prefix: "CSI-GATE-INB-01",
    gate_count: 6,
    active: false,
  },
];

const byCode = new Map(SITE_LIST.map((site) => [site.code, site]));

/** Daftar gate dari `site_master`; bila ada, ia menang atas daftar lokal. */
let serverGates = null;

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function gateNamesFor(site) {
  if (!site) return [];
  return Array.from(
    { length: Math.max(0, Number(site.gate_count) || 0) },
    (_, index) => `${site.gate_prefix}-${String(index + 1).padStart(2, "0")}`,
  );
}

function decorate(site) {
  return site ? { ...site, gates: gateNamesFor(site) } : null;
}

export function allSites() {
  return SITE_LIST.map(decorate);
}

export function activeSites() {
  return allSites().filter((site) => site.active);
}

export function getSite(code) {
  return decorate(byCode.get(normalizeCode(code)));
}

export function defaultSite() {
  return activeSites()[0] || allSites()[0];
}

/** Gudang yang sedang dilihat operator. Tersimpan per browser. */
export function currentSite() {
  let stored = "";
  try {
    stored = normalizeCode(globalThis.localStorage?.getItem(STORAGE.site));
  } catch {
    stored = "";
  }
  const site = stored ? getSite(stored) : null;
  return site && site.active ? site : defaultSite();
}

export function setCurrentSite(code) {
  const site = getSite(code);
  if (!site || !site.active) return currentSite();
  try {
    globalThis.localStorage?.setItem(STORAGE.site, site.code);
  } catch {
    /* Mode penyamaran tetap berjalan memakai gudang default. */
  }
  return site;
}

/**
 * Katalog dari backend menimpa daftar lokal. Dipanggil setiap kali payload
 * `state` diterima, sehingga mengaktifkan gudang baru cukup dilakukan di
 * database tanpa perlu men-deploy ulang frontend.
 */
export function applyServerCatalog(catalog = {}) {
  const sites = Array.isArray(catalog.sites) ? catalog.sites : [];
  sites.forEach((row) => {
    const site = byCode.get(normalizeCode(row.site_code || row.code));
    if (!site) return;
    site.active = true;
    if (row.location_id) site.location_id = String(row.location_id).trim();
    if (row.site_name) site.name = String(row.site_name).trim();
    if (row.short_name) site.short_name = String(row.short_name).trim();
    if (row.gate_prefix) site.gate_prefix = String(row.gate_prefix).trim();
    if (Number.isFinite(Number(row.gate_count))) site.gate_count = Number(row.gate_count);
  });
  if (sites.length) {
    const activeCodes = new Set(sites.map((row) => normalizeCode(row.site_code || row.code)));
    SITE_LIST.forEach((site) => {
      site.active = activeCodes.has(site.code);
    });
  }
  const gates = Array.isArray(catalog.gates) ? catalog.gates.filter(Boolean) : [];
  serverGates = gates.length ? gates.map((gate) => String(gate).trim()) : null;
  return activeSites();
}

/** Nama gate untuk gudang yang sedang dilihat. */
export function gateOptions(code) {
  const site = code ? getSite(code) : currentSite();
  if (serverGates?.length) {
    const scoped = serverGates.filter((gate) =>
      site ? gate.toUpperCase().startsWith(`${site.code}-`) : true,
    );
    if (scoped.length) return scoped;
  }
  return gateNamesFor(site);
}

/** Mengubah "PGS-GATE-INB-01-03" menjadi "PGS 03" untuk sel tabel dan kartu. */
export function gateLabel(gate) {
  const text = String(gate || "").trim();
  if (!text) return "-";
  const site = allSites().find((item) => text.toUpperCase().startsWith(`${item.code}-`));
  const number = text.match(/(\d{2})\s*$/)?.[1] || text.match(/\d+/)?.[0] || "-";
  return site ? `${site.code} ${number}` : text;
}

/** "Inbound Frozen · Pegangsaan" — dipakai di sidebar dan judul halaman. */
export function brand(withSite = true) {
  const site = currentSite();
  return withSite && site ? `${BRAND_SHORT} · ${site.short_name || site.name}` : BRAND_SHORT;
}

/* --------------------------------------------------------------------------
 * Tipe armada
 *
 * `slaHours` hanya untuk tabel acuan di layar Pengaturan; nilainya harus sama
 * dengan `public.inbound_sla_target_hours()` dan diverifikasi oleh
 * test/sla-contract.test.js supaya tidak pernah menyimpang lagi.
 * ----------------------------------------------------------------------- */
export const FLEET_TYPES = [
  { value: "RODA 2", label: "Roda 2", note: "Motor / kurir", slaHours: 1 },
  { value: "MOBIL", label: "Mobil", note: "Grandmax, city car", slaHours: 2 },
  { value: "VAN", label: "Van", note: "Blind van", slaHours: 2 },
  { value: "PICKUP", label: "Pickup", note: "Pickup bak / box", slaHours: 2 },
  { value: "L300 BOX", label: "L300 Box", note: "Mitsubishi L300", slaHours: 2 },
  { value: "CDE", label: "CDE", note: "Colt diesel engkel", slaHours: "2 / 4" },
  { value: "CDEL", label: "CDE Long", note: "Engkel long", slaHours: "2 / 4" },
  { value: "CDD", label: "CDD", note: "Colt diesel double", slaHours: "2 / 4" },
  { value: "CDDL", label: "CDD Long", note: "Double long", slaHours: "2 / 4" },
  { value: "WING BOX", label: "Wing Box", note: "Wingbox besar", slaHours: 4 },
  { value: "TRONTON/FUSO", label: "Tronton / Fuso", note: "Muatan besar", slaHours: 4 },
  { value: "DROP-OFF", label: "Drop-Off", note: "Titip barang, tanpa driver tunggu", slaHours: 23 },
];

export const DEFAULT_FLEET = "CDD";

/** Tipe armada yang memakai tier SKU: >40 SKU naik dari 2 jam ke 4 jam. */
export const SKU_TIERED_FLEETS = ["CDE", "CDEL", "CDD", "CDDL"];

export function fleetLabel(value) {
  const found = FLEET_TYPES.find((fleet) => fleet.value === String(value || "").toUpperCase());
  return found ? found.label : String(value || "-");
}

/* --------------------------------------------------------------------------
 * Status tiket
 *
 * Empat keadaan saja, mengikuti alur nyata di pos masuk:
 *   WAITING   driver sudah datang dan tercatat, belum dipanggil
 *   CALLED    dipanggil ke gate tertentu
 *   UNLOADING bongkar berjalan — di sinilah hitung mundur SLA hidup
 *   COMPLETED selesai
 * EXPIRED dipakai untuk tiket yang dibatalkan atau driver tidak muncul.
 * ----------------------------------------------------------------------- */
export const STATUS = {
  WAITING: { label: "Menunggu", tone: "monitor" },
  CALLED: { label: "Dipanggil", tone: "accent" },
  UNLOADING: { label: "Bongkar", tone: "teal" },
  COMPLETED: { label: "Selesai", tone: "normal" },
  EXPIRED: { label: "Batal", tone: "critical" },
};

export function statusMeta(status) {
  return STATUS[String(status || "").toUpperCase()] || { label: status || "-", tone: "muted" };
}

/** Peran dan halaman yang boleh dibukanya. */
export const ROLE_PAGES = {
  // Security bekerja di pos masuk; analitik lead time bukan alat mereka.
  SECURITY: ["board", "register", "settings"],
  CHECKER: ["board", "report", "settings"],
  SPV: ["board", "register", "report", "analytics", "settings"],
  ADMIN: ["board", "register", "report", "analytics", "settings"],
  DEVELOPER: ["board", "register", "report", "analytics", "settings"],
};

export function pagesForRole(role) {
  return ROLE_PAGES[String(role || "").toUpperCase()] || ["board"];
}

export function canAccess(page, role) {
  return pagesForRole(role).includes(page);
}
