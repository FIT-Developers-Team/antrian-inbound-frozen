/* ==========================================================================
 * ANTRIAN INBOUND FROZEN — STATE & POLLING
 *
 * Satu sumber state untuk seluruh halaman. Halaman berlangganan lewat
 * `subscribe()` dan menerima snapshot terbaru; tidak ada halaman yang memanggil
 * backend sendiri untuk data papan.
 *
 * Polling, bukan WebSocket. Klien realtime pernah dipasang di sini tetapi
 * konfigurasinya selalu mengembalikan `enabled: false`, sehingga yang benar-
 * benar berjalan tetap polling — sambil tetap mengunduh ~50 KB klien realtime
 * pada setiap muat halaman. Polling ber-ETag lebih murah: server menjawab 304
 * tanpa body selama tidak ada perubahan, dan sidik jari yang tidak bergeser
 * membuat papan tidak digambar ulang sama sekali.
 * ========================================================================== */

import { POLL_INTERVAL_MS } from "./config.js";
import { applyServerCatalog } from "./config.js";
import * as api from "./api.js";

const listeners = new Set();

export const state = {
  rows: [],
  gates: [],
  checkers: [],
  poMaster: [],
  operationalDate: "",
  /**
   * Kesegaran rantai Superset (PGS 160) → superset_po_master, dikirim server
   * bersama snapshot. Berbeda dari `lastSync`, yang hanya mengukur perjalanan
   * Postgres → browser.
   */
  source: null,
  loading: true,
  error: "",
  lastSync: null,
  connection: "idle", // idle | online | pending | offline
  /**
   * Sidik jari snapshot terakhir, dikirim server bersama payload.
   *
   * Dipakai untuk menjawab satu pertanyaan yang sebelumnya tidak pernah
   * ditanyakan: apakah siklus polling ini benar-benar membawa sesuatu yang
   * baru? Tanpa itu, papan dibongkar dan dibangun ulang tiap lima belas detik
   * sekalipun tidak ada satu tiket pun yang berubah — dan setiap kali itu
   * terjadi, kursor operator yang sedang mengetik di kotak pencarian terlempar
   * keluar, teks yang sedang disorot hilang, dan posisi gulir kembali ke atas.
   */
  fingerprint: "",
};

/**
 * Ambang sumber dianggap basi. Cron Superset berjalan tiap lima menit, jadi
 * lima belas menit berarti tiga siklus terlewat — itu kegagalan, bukan jitter.
 */
export const SOURCE_STALE_SECONDS = 15 * 60;

export function sourceIsStale(source = state.source) {
  const age = Number(source?.age_seconds);
  return Number.isFinite(age) && age > SOURCE_STALE_SECONDS;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * @param {{ dataChanged?: boolean }} detail  `dataChanged` false berarti siklus
 *   ini hanya memperbarui indikator koneksi; isi papan tidak bergerak.
 */
function emit(detail = { dataChanged: true }) {
  listeners.forEach((listener) => {
    try {
      listener(state, detail);
    } catch (error) {
      console.error("Pelanggan state gagal", error);
    }
  });
}

function setConnection(mode) {
  if (state.connection === mode) return;
  state.connection = mode;
}

/* --------------------------------------------------------------------------
 * Memuat papan
 * ----------------------------------------------------------------------- */

/**
 * Menarik snapshot papan. `silent` dipakai oleh polling latar: kegagalan
 * sesaat hanya menurunkan indikator koneksi, tidak mengosongkan layar yang
 * sedang dipakai operator.
 */
export async function refresh({ silent = false } = {}) {
  if (!silent) state.loading = true;
  let dataChanged = true;
  try {
    const payload = await api.fetchBoard();
    const fingerprint = String(payload?.fingerprint || "");
    // Sidik jari yang sama berarti server membangun payload yang sama persis.
    // Halaman tidak perlu digambar ulang; hitung mundur SLA sudah diperbarui di
    // tempat oleh ticker dan tidak bergantung pada render.
    dataChanged = !fingerprint || fingerprint !== state.fingerprint;
    state.fingerprint = fingerprint;

    state.rows = Array.isArray(payload?.rows) ? payload.rows : [];
    state.gates = Array.isArray(payload?.gates) ? payload.gates : [];
    state.checkers = Array.isArray(payload?.checkers) ? payload.checkers : [];
    state.operationalDate = payload?.operational_date || "";
    state.source = payload?.source || null;
    applyServerCatalog({ sites: payload?.sites, gates: payload?.gates });
    state.error = "";
    state.lastSync = new Date();
    setConnection("online");
  } catch (error) {
    setConnection(silent ? "pending" : "offline");
    if (!silent) state.error = error.message || "Gagal memuat data.";
    else console.warn("Polling gagal, mencoba lagi pada siklus berikutnya", error);
  } finally {
    state.loading = false;
    // Penarikan yang tidak senyap selalu menggambar ulang: ia dipicu operator,
    // yang berhak melihat bukti bahwa permintaannya dikerjakan.
    emit({ dataChanged: dataChanged || !silent });
  }
}

/**
 * Membuang snapshot tersimpan.
 *
 * Dipanggil saat berpindah gudang: tanpa itu, sidik jari gudang lama masih
 * tersimpan dan snapshot gudang baru — bila kebetulan menghasilkan sidik jari
 * yang sama, misalnya karena keduanya sedang kosong — dianggap "tidak berubah"
 * dan papan tidak pernah digambar ulang.
 */
export function resetSnapshot() {
  state.fingerprint = "";
  state.poMaster = [];
  poMasterRequest = null;
}

/**
 * Master PO hanya dibutuhkan layar pendaftaran, jadi dimuat sesuai permintaan.
 *
 * Permintaan yang sedang berjalan disimpan dan dibagikan. Halaman pendaftaran
 * memanggil fungsi ini dari `render()`, dan `render()` berjalan pada setiap
 * ketukan tombol — tanpa penyimpanan ini, mengetik lima huruf sebelum
 * permintaan pertama selesai memicu lima unduhan master PO sekaligus, masing-
 * masing berisi puluhan ribu baris.
 */
let poMasterRequest = null;

export function ensurePoMaster() {
  if (state.poMaster.length) return Promise.resolve(state.poMaster);
  if (poMasterRequest) return poMasterRequest;

  poMasterRequest = api
    .fetchPoMaster()
    .then((payload) => {
      state.poMaster = Array.isArray(payload?.rows) ? payload.rows : [];
    })
    .catch((error) => {
      console.warn("Master PO gagal dimuat", error);
      state.poMaster = [];
    })
    .then(() => {
      poMasterRequest = null;
      emit();
      return state.poMaster;
    });

  return poMasterRequest;
}

/* --------------------------------------------------------------------------
 * Polling
 * ----------------------------------------------------------------------- */
let poller = null;

export function startPolling() {
  stopPolling();
  poller = setInterval(() => {
    // Tab yang tersembunyi tidak perlu menarik data: tidak ada yang melihatnya
    // dan browser sudah membatasi timer di latar belakang.
    if (!document.hidden) refresh({ silent: true });
  }, POLL_INTERVAL_MS);
}

export function stopPolling() {
  if (!poller) return;
  clearInterval(poller);
  poller = null;
}

export function bindVisibilityRefresh() {
  document.addEventListener("visibilitychange", () => {
    // Kembali ke tab setelah lama ditinggal: tarik sekali agar operator tidak
    // pernah melihat papan basi sambil menunggu siklus polling berikutnya.
    if (!document.hidden) refresh({ silent: true });
  });
}

/* --------------------------------------------------------------------------
 * Turunan
 * ----------------------------------------------------------------------- */

const ACTIVE = new Set(["WAITING", "CALLED", "UNLOADING"]);

export function activeRows(rows = state.rows) {
  return rows.filter((row) => ACTIVE.has(String(row.status || "").toUpperCase()));
}

export function rowsByStatus(status, rows = state.rows) {
  const wanted = String(status).toUpperCase();
  return rows.filter((row) => String(row.status || "").toUpperCase() === wanted);
}

export function findRow(ticketId) {
  return state.rows.find((row) => row.ticket_id === ticketId) || null;
}

/** Gate yang sedang ditempati tiket yang belum selesai bongkar. */
export function occupiedGates(rows = state.rows) {
  return new Set(
    rows
      .filter((row) => String(row.status || "").toUpperCase() === "UNLOADING" && row.gate)
      .map((row) => row.gate),
  );
}

export function freeGates(rows = state.rows) {
  const taken = occupiedGates(rows);
  return state.gates.filter((gate) => !taken.has(gate));
}

/**
 * Aksi menulis selalu diikuti penarikan ulang, bukan penambalan state lokal.
 * Server adalah pemilik nomor antrean, status, dan tenggat SLA; menebaknya di
 * browser adalah cara tercepat membuat dua layar menampilkan angka berbeda.
 */
export async function mutate(action) {
  const result = await action();
  await refresh({ silent: true });
  return result;
}
