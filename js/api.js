/* ==========================================================================
 * ANTRIAN INBOUND FROZEN — KLIEN BACKEND
 *
 * Satu-satunya jalur ke server. Semua permintaan menuju `/api/inbound` pada
 * origin yang sama, membawa session bertanda tangan HMAC pada header
 * Authorization. Browser tidak pernah memegang kredensial database, cookie
 * Superset, maupun kunci penanda tangan sesi.
 *
 * GET yang berulang (papan antrean) memakai ETag: server mengirim fingerprint
 * `md5(jumlah_baris | perubahan_terakhir)`, sehingga polling yang tidak
 * menemukan perubahan dijawab 304 tanpa body dan tanpa membangun payload di
 * Postgres. Respons yang memang membawa isi dikompresi gzip atau brotli.
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
 * Kecualinya penting. API menjawab 401 untuk DUA hal yang berbeda: sesi yang
 * tidak sah, dan aksi yang tidak dikenalinya. Bila kontainer yang berjalan
 * lebih tua daripada halaman yang termuat di browser — hal yang terjadi ketika
 * tab lama dibiarkan terbuka melewati sebuah deploy — ia tidak mengenal aksi
 * `board`, menjawab 401, dan operator terlempar kembali ke layar login satu
 * detik setelah berhasil masuk, berulang tanpa penjelasan.
 *
 * Sesi yang baru saja terbit hampir mustahil kedaluwarsa (masa berlakunya 12
 * jam), jadi 401 pada menit pertama dibaca sebagai versi yang tidak sepadan,
 * bukan sebagai sesi mati. Sesi tidak dihapus, dan pemanggil menerima pesan
 * yang menyebutkan penyebab sebenarnya — beserta tindakan yang benar-benar
 * menyelesaikannya.
 */
const FRESH_SESSION_MS = 60_000;

function handleUnauthorized() {
  if (sessionAgeMs() < FRESH_SESSION_MS) {
    throw new ApiError(
      "Versi aplikasi di browser tidak sepadan dengan server. " +
        "Muat ulang halaman (Ctrl+Shift+R); bila masih terjadi, deploy ulang kontainer aplikasi.",
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

/**
 * Menerjemahkan kegagalan login menjadi pesan yang menunjuk penyebab sebenarnya.
 *
 * Ini bukan kosmetik. Sebelumnya SETIAP kegagalan berakhir sebagai "Username
 * atau password salah": ketika proksi menjawab 502 karena layanan API belum
 * berjalan, badannya berisi HTML, `JSON.parse` gagal, pesannya menjadi
 * undefined, dan layar menyalahkan sandi operator atas server yang bahkan
 * tidak menyala. Berjam-jam dapat terbuang mengganti sandi yang sejak awal
 * sudah benar.
 */
function loginFailure(status, body) {
  // Pesan dari server selalu menang bila ada — ia paling spesifik.
  if (body?.message) return new ApiError(body.message, status);

  if (status === 401) return new ApiError("Username atau password salah.", status);
  if (status === 503) {
    return new ApiError(
      "Server belum terkonfigurasi: daftar akun atau kunci sesi belum diisi. Hubungi admin.",
      status,
    );
  }
  if (status === 502 || status === 503 || status === 504) {
    return new ApiError(
      `Layanan API tidak dapat dihubungi (HTTP ${status}). Aplikasi tampil, tetapi backend-nya belum berjalan.`,
      status,
    );
  }
  if (status >= 500) {
    return new ApiError(`Server bermasalah (HTTP ${status}). Coba lagi sebentar.`, status);
  }
  // Respons tanpa JSON pada status apa pun berarti yang menjawab bukan API —
  // biasanya halaman galat milik proxy di depannya.
  return new ApiError(
    `Jawaban tidak dikenali dari server (HTTP ${status}). Backend kemungkinan belum siap.`,
    status,
  );
}

export async function login(username, password) {
  let response;
  try {
    response = await fetch(`${BACKEND_URL}?action=login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch (error) {
    // Jaringan putus sebelum permintaan sampai; tidak ada status untuk dibaca.
    throw new ApiError(`Tidak dapat menghubungi server: ${error.message}`, 0);
  }

  const body = await readBody(response);
  if (!response.ok || body?.ok === false) throw loginFailure(response.status, body);

  const data = body?.data ?? body;
  if (!data?.token) throw loginFailure(response.status, body);

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
