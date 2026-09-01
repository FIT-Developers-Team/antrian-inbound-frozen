/* ==========================================================================
 * ANTRIAN INBOUND FROZEN — KLIEN BACKEND
 *
 * Satu-satunya jalur ke server. Semua permintaan menuju Supabase Edge Function
 * `inbound-api`, membawa session bertanda tangan HMAC pada header Authorization.
 * Browser tidak pernah memegang service-role key, cookie Superset, maupun
 * secret Apps Script.
 *
 * GET yang berulang (papan antrean) memakai ETag: server mengirim fingerprint
 * `md5(jumlah_baris | perubahan_terakhir)`, sehingga polling yang tidak
 * menemukan perubahan dijawab 304 tanpa body dan tanpa membangun payload di
 * Postgres.
 * ========================================================================== */

import { BACKEND_URL, STORAGE, currentSite } from "./config.js";

/* --------------------------------------------------------------------------
 * Session
 * ----------------------------------------------------------------------- */
export function getToken() {
  try {
    return globalThis.localStorage?.getItem(STORAGE.session) || "";
  } catch {
    return "";
  }
}

export function getUser() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(STORAGE.user) || "null");
  } catch {
    return null;
  }
}

export function setSession(token, user) {
  try {
    if (token) globalThis.localStorage?.setItem(STORAGE.session, token);
    if (user) globalThis.localStorage?.setItem(STORAGE.user, JSON.stringify(user));
    // Jam terbit dipakai untuk membedakan sesi kedaluwarsa dari backend usang;
    // lihat handleUnauthorized().
    globalThis.localStorage?.setItem(STORAGE.issuedAt, String(Date.now()));
  } catch {
    /* Penyimpanan yang ditolak tidak boleh menggagalkan login. */
  }
}

function sessionAgeMs() {
  try {
    const issued = Number(globalThis.localStorage?.getItem(STORAGE.issuedAt));
    return Number.isFinite(issued) && issued > 0 ? Date.now() - issued : Infinity;
  } catch {
    return Infinity;
  }
}

export function clearSession() {
  try {
    globalThis.localStorage?.removeItem(STORAGE.session);
    globalThis.localStorage?.removeItem(STORAGE.user);
    globalThis.localStorage?.removeItem(STORAGE.issuedAt);
  } catch {
    /* diabaikan */
  }
  etagCache.clear();
}

export function isLoggedIn() {
  return Boolean(getToken() && getUser());
}

/* --------------------------------------------------------------------------
 * Transport
 * ----------------------------------------------------------------------- */

/** ETag + salinan payload terakhir per action, supaya 304 tetap ada isinya. */
const etagCache = new Map();

export function clearEtagCache() {
  etagCache.clear();
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export { ApiError };

function buildUrl(action, params = {}) {
  // BACKEND_URL relatif saat pengembangan lokal (proksi same-origin), jadi
  // basis wajib diberikan agar URL tetap dapat dibangun di kedua lingkungan.
  const url = new URL(BACKEND_URL, globalThis.location?.origin || "http://localhost");
  url.searchParams.set("action", action);
  const site = currentSite();
  if (site?.code) url.searchParams.set("site", site.code);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${getToken()}`, ...extra };
}

/**
 * Sesi yang ditolak server dibersihkan sekali di sini, sehingga setiap
 * pemanggil tidak perlu menangani 401 sendiri-sendiri.
 *
 * Kecualinya penting. Edge Function menjawab 401 untuk DUA hal yang berbeda:
 * sesi yang tidak sah, dan aksi yang tidak dikenalinya. Bila backend yang
 * ter-deploy lebih tua daripada frontend, ia tidak mengenal `board`, menjawab
 * 401, dan operator terlempar kembali ke layar login satu detik setelah
 * berhasil masuk — berulang tanpa penjelasan.
 *
 * Sesi yang baru saja terbit hampir mustahil kedaluwarsa (masa berlakunya 12
 * jam), jadi 401 pada menit pertama dibaca sebagai backend usang, bukan sebagai
 * sesi mati. Sesi tidak dihapus, dan pemanggil menerima pesan yang menyebutkan
 * penyebab sebenarnya.
 */
const FRESH_SESSION_MS = 60_000;

function handleUnauthorized() {
  if (sessionAgeMs() < FRESH_SESSION_MS) {
    throw new ApiError(
      "Backend yang ter-deploy lebih lama daripada aplikasi ini dan belum mengenal aksi yang diminta. " +
        "Jalankan: supabase db push && supabase functions deploy inbound-api",
      409,
    );
  }
  clearSession();
  globalThis.dispatchEvent?.(new CustomEvent("inbound:signed-out"));
}

async function readBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function apiGet(action, params = {}, { useEtag = false } = {}) {
  const url = buildUrl(action, params);
  const cacheKey = `${action}|${url}`;
  const cached = useEtag ? etagCache.get(cacheKey) : null;
  const headers = authHeaders(cached?.etag ? { "If-None-Match": cached.etag } : {});

  const response = await fetch(url, { method: "GET", headers, cache: "no-store" });

  if (response.status === 304 && cached) return structuredClone(cached.payload);
  if (response.status === 401) {
    handleUnauthorized();
    throw new ApiError("Sesi berakhir. Silakan masuk kembali.", 401);
  }

  const body = await readBody(response);
  if (!response.ok || body?.ok === false) {
    throw new ApiError(body?.message || `Permintaan ${action} gagal.`, response.status);
  }

  const payload = body?.data ?? body;
  if (useEtag) {
    const etag = response.headers.get("etag");
    if (etag) etagCache.set(cacheKey, { etag, payload: structuredClone(payload) });
  }
  return payload;
}

export async function apiPost(action, payload = {}) {
  const site = currentSite();
  const response = await fetch(buildUrl(action), {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ site_code: site?.code, ...payload }),
  });

  if (response.status === 401) {
    handleUnauthorized();
    throw new ApiError("Sesi berakhir. Silakan masuk kembali.", 401);
  }

  const body = await readBody(response);
  if (!response.ok || body?.ok === false) {
    throw new ApiError(body?.message || `Aksi ${action} gagal.`, response.status);
  }

  // Menulis membuat setiap snapshot yang tersimpan basi seketika; tanpa ini
  // polling berikutnya bisa dijawab 304 dan papan tampak tidak berubah.
  etagCache.clear();
  return body?.data ?? body;
}

/* --------------------------------------------------------------------------
 * Aksi
 * ----------------------------------------------------------------------- */

export async function login(username, password) {
  const response = await fetch(`${BACKEND_URL}?action=login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await readBody(response);
  if (!response.ok || body?.ok === false) {
    throw new ApiError(body?.message || "Username atau password salah.", response.status);
  }
  const data = body?.data ?? body;
  setSession(data.token, data.user);
  return data.user;
}

export function logout() {
  const token = getToken();
  clearSession();
  // Best-effort: sesi berbasis HMAC kedaluwarsa sendiri, jadi kegagalan di
  // sini tidak boleh menahan operator keluar dari aplikasi.
  if (token) {
    fetch(`${BACKEND_URL}?action=logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      keepalive: true,
    }).catch(() => {});
  }
}

/** Papan antrean: satu baris per tiket, sudah membawa tenggat SLA dari server. */
export function fetchBoard(daysBack = 2) {
  return apiGet("board", { days_back: daysBack }, { useEtag: true });
}

/** Master PO untuk layar pendaftaran. Payload besar, jadi selalu ber-ETag. */
export function fetchPoMaster() {
  return apiGet("po_master", {}, { useEtag: true });
}

/** Riwayat lengkap untuk halaman Laporan dan ekspor CSV. */
export function fetchHistory(from, to) {
  return apiGet("history", { from, to });
}

export function createTicket(ticket) {
  return apiPost("create_ticket", ticket);
}

/** Mencatat atau mengoreksi jam kedatangan driver. */
export function setArrival(ticketId, arrivedAt) {
  return apiPost("set_arrival", { ticket_id: ticketId, arrived_at: arrivedAt });
}

/** Memanggil driver ke gate tertentu. */
export function callTicket(ticketId, gate) {
  return apiPost("call_ticket", { ticket_id: ticketId, gate });
}

/**
 * Satu tombol untuk memulai bongkar: menetapkan gate, menyalakan hitung mundur
 * SLA, dan menandai seluruh PO tiket sedang dicek. Idempoten — menekan dua
 * kali tidak menggeser jam mulai dan karenanya tidak memperpanjang SLA.
 */
export function startUnloading(ticketId, gate) {
  return apiPost("start_unloading", { ticket_id: ticketId, gate });
}

export function finishUnloading(ticketId) {
  return apiPost("finish_unloading", { ticket_id: ticketId });
}

export function cancelTicket(ticketId, reason) {
  return apiPost("cancel_ticket", { ticket_id: ticketId, reason });
}
