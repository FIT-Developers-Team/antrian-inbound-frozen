/* ==========================================================================
 * ANTRIAN INBOUND FROZEN — HITUNG MUNDUR SLA
 *
 * Aturan main:
 *
 * 1. Browser TIDAK PERNAH menghitung target SLA. Postgres yang memutuskan
 *    lewat `public.inbound_sla_target_hours(fleet_type, total_sku)` dan
 *    mengirimkan hasilnya sebagai `sla_deadline_at`. Yang dikerjakan di sini
 *    hanya selisih waktu terhadap tenggat itu. Sebelum revamp, aturan SLA ada
 *    di tiga tempat dengan angka berbeda dan tidak pernah cocok satu sama lain.
 *
 * 2. Jam SLA mulai berdetak saat BONGKAR DIMULAI (`start_unloading_at`), bukan
 *    saat tiket didaftarkan. Waktu tunggu driver dihitung terpisah, dari jam
 *    kedatangan sampai bongkar dimulai.
 *
 * 3. Satu ticker bersama untuk seluruh halaman. Sebelumnya ada tiga interval
 *    satu detik yang berjalan bersamaan; sekarang satu, dan ia berhenti saat
 *    tab tidak terlihat supaya tablet gudang tidak memboroskan baterai.
 *
 * 4. Setiap elemen hitung mundur membawa datanya sendiri lewat atribut
 *    `data-*`. Ticker hanya menulis ulang teks di dalamnya dan tidak pernah
 *    memicu render ulang kartu atau tabel — itu yang membuat papan tetap mulus
 *    walau ada puluhan tiket aktif.
 * ========================================================================== */

import { SLA_WARNING_MINUTES } from "./config.js";
import { esc, formatDuration, parseDate } from "./format.js";

/**
 * Keadaan hitung mundur sebuah tiket.
 *
 * @param {object} row  Baris papan dari server.
 * @param {Date}   now  Waktu acuan; diinjeksi agar dapat diuji.
 */
export function slaState(row = {}, now = new Date()) {
  const targetHours = Number(row.sla_target_hours || 0);
  const deadline = parseDate(row.sla_deadline_at);
  const started = parseDate(row.sla_started_at);
  const stopped = parseDate(row.sla_stopped_at);

  // Armada yang memang tidak punya SLA (mis. tipe yang belum diatur).
  if (!targetHours) {
    return { phase: "none", label: "Tanpa SLA", note: "Armada tanpa target", seconds: 0 };
  }

  // Bongkar belum dimulai: tenggat belum ada karena jam mulainya belum ada.
  if (!started || !deadline) {
    return {
      phase: "idle",
      label: `${targetHours} jam`,
      note: "Menunggu mulai bongkar",
      seconds: 0,
    };
  }

  // Pekerjaan sudah selesai: jam berhenti, hasilnya tetap, tidak ikut berdetak.
  if (stopped) {
    const overrun = Math.round((stopped.getTime() - deadline.getTime()) / 1000);
    return overrun > 0
      ? {
          phase: "missed",
          label: `+${formatDuration(overrun)}`,
          note: `Lewat SLA ${targetHours} jam`,
          seconds: overrun,
          final: true,
        }
      : {
          phase: "met",
          label: formatDuration(-overrun),
          note: `Sisa dari SLA ${targetHours} jam`,
          seconds: -overrun,
          final: true,
        };
  }

  const remaining = Math.round((deadline.getTime() - now.getTime()) / 1000);

  if (remaining < 0) {
    return {
      phase: "breached",
      label: `+${formatDuration(-remaining)}`,
      note: `Terlambat dari SLA ${targetHours} jam`,
      seconds: -remaining,
    };
  }

  // Peringatan muncul pada 30 menit terakhir, bukan setelah terlambat — pada
  // titik itu supervisor masih sempat menambah checker.
  const phase = remaining <= SLA_WARNING_MINUTES * 60 ? "warning" : "running";
  return {
    phase,
    label: formatDuration(remaining),
    note: `Sisa dari SLA ${targetHours} jam`,
    seconds: remaining,
  };
}

/**
 * Markup hitung mundur. Data tenggat ikut tertanam di elemen supaya ticker
 * dapat memperbaruinya tanpa akses ke state aplikasi.
 */
export function slaMarkup(row = {}, { hero = false } = {}) {
  const state = slaState(row);
  const attrs = [
    `data-sla="1"`,
    `data-sla-target="${esc(row.sla_target_hours || 0)}"`,
    row.sla_deadline_at ? `data-sla-deadline="${esc(row.sla_deadline_at)}"` : "",
    row.sla_started_at ? `data-sla-started="${esc(row.sla_started_at)}"` : "",
    row.sla_stopped_at ? `data-sla-stopped="${esc(row.sla_stopped_at)}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<div class="sla ${hero ? "sla-hero " : ""}sla-${state.phase}" ${attrs}>
    <span class="sla-value">${esc(state.label)}</span>
    <span class="sla-note">${esc(state.note)}</span>
  </div>`;
}

/** Membaca kembali baris tiruan dari atribut elemen untuk dihitung ulang. */
function rowFromElement(element) {
  return {
    sla_target_hours: element.dataset.slaTarget,
    sla_deadline_at: element.dataset.slaDeadline,
    sla_started_at: element.dataset.slaStarted,
    sla_stopped_at: element.dataset.slaStopped,
  };
}

const PHASES = ["idle", "none", "running", "warning", "breached", "met", "missed"];

/** Memperbarui satu elemen hitung mundur di tempat. */
export function refreshSlaElement(element, now = new Date()) {
  const state = slaState(rowFromElement(element), now);
  const value = element.querySelector(".sla-value");
  const note = element.querySelector(".sla-note");
  if (value && value.textContent !== state.label) value.textContent = state.label;
  if (note && note.textContent !== state.note) note.textContent = state.note;
  PHASES.forEach((phase) => element.classList.toggle(`sla-${phase}`, phase === state.phase));
  return state;
}

/* --------------------------------------------------------------------------
 * Ticker bersama
 * ----------------------------------------------------------------------- */
let timer = null;
const extraTicks = new Set();

function tick() {
  const now = new Date();
  document.querySelectorAll("[data-sla]").forEach((element) => refreshSlaElement(element, now));
  document.querySelectorAll("[data-elapsed-from]").forEach((element) => {
    refreshElapsedElement(element, now);
  });
  document.querySelectorAll("[data-dock-bar]").forEach((element) => refreshDockBar(element, now));
  extraTicks.forEach((fn) => {
    try {
      fn(now);
    } catch (error) {
      console.error("Ticker tambahan gagal", error);
    }
  });
}

/**
 * Durasi berjalan yang bukan SLA — mis. lama driver menunggu sejak datang.
 * Elemen berhenti berdetak begitu `data-elapsed-to` terisi.
 */
export function elapsedMarkup(from, to, { className = "mono" } = {}) {
  const attrs = [
    `data-elapsed-from="${esc(from || "")}"`,
    to ? `data-elapsed-to="${esc(to)}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<span class="${className}" ${attrs}>${esc(elapsedText(from, to))}</span>`;
}

function elapsedText(from, to, now = new Date()) {
  const start = parseDate(from);
  if (!start) return "-";
  const end = parseDate(to) || now;
  return formatDuration(Math.round((end.getTime() - start.getTime()) / 1000));
}

export function refreshElapsedElement(element, now = new Date()) {
  const text = elapsedText(element.dataset.elapsedFrom, element.dataset.elapsedTo, now);
  if (element.textContent !== text) element.textContent = text;
}

/**
 * Bar SLA di rel dok.
 *
 * Ia MENYUSUT, bukan bertambah: yang ditanyakan supervisor adalah "berapa sisa
 * waktunya", bukan "berapa yang sudah terpakai". Bar penuh berarti bongkar baru
 * dimulai; bar habis berarti tenggat tiba.
 *
 * Lebarnya ditulis sebagai custom property, bukan gaya `width` langsung, supaya
 * transisinya tetap dipegang CSS dan ticker hanya menyetor satu angka.
 */
export function refreshDockBar(element, now = new Date()) {
  const started = parseDate(element.dataset.slaStarted);
  const deadline = parseDate(element.dataset.slaDeadline);
  if (!started || !deadline) {
    element.style.setProperty("--dock-progress", "0%");
    return 0;
  }
  const total = deadline.getTime() - started.getTime();
  const remaining = deadline.getTime() - now.getTime();
  const ratio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  const percent = `${(ratio * 100).toFixed(1)}%`;
  if (element.style.getPropertyValue("--dock-progress") !== percent) {
    element.style.setProperty("--dock-progress", percent);
  }
  return ratio;
}

/** Mendaftarkan pekerjaan lain yang perlu berdetak per detik (mis. jam dinding). */
export function onTick(fn) {
  extraTicks.add(fn);
  return () => extraTicks.delete(fn);
}

export function startTicker() {
  if (timer) return;
  tick();
  timer = setInterval(tick, 1000);
}

export function stopTicker() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Tab yang tersembunyi tidak perlu berdetak: hasilnya tidak terlihat dan
 * browser sudah membatasi interval di latar belakang. Saat kembali terlihat,
 * satu tick langsung dijalankan supaya angka tidak sempat terlihat basi.
 */
export function bindVisibility() {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopTicker();
    else startTicker();
  });
}
