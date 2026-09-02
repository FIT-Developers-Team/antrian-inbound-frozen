/* ==========================================================================
 * LAPORAN
 *
 * Menjawab tiga pertanyaan yang benar-benar ditanyakan supervisor tiap pagi:
 * berapa lama driver menunggu, berapa lama bongkar berjalan, dan berapa persen
 * tiket yang memenuhi SLA. Selebihnya diserahkan ke ekspor CSV.
 * ========================================================================== */

import * as api from "../api.js";
import { currentSite, fleetLabel, gateLabel, statusMeta } from "../config.js";
import {
  esc,
  formatDateTime,
  formatMinutes,
  minutesBetween,
  toCsv,
  toDateInputValue,
} from "../format.js";
import { badge, emptyState, icon, metricStrip, pageHeader, section, toast, withBusy } from "../ui.js";

const range = {
  from: toDateInputValue(new Date(Date.now() - 6 * 86400000)),
  to: toDateInputValue(),
};

let rows = [];
let loading = false;
/**
 * Rentang yang datanya sudah pernah diminta.
 *
 * Tanpa penanda ini, `render()` yang mengakhiri dirinya dengan "kalau belum ada
 * baris, muat" bertemu `load()` yang mengakhiri dirinya dengan "render" — dan
 * rentang tanggal yang memang tidak punya tiket menjadi lingkaran tanpa ujung:
 * muat, kosong, render, kosong, muat lagi, selamanya. Halaman tampak diam,
 * sementara di baliknya browser membanjiri API dengan kueri riwayat yang setiap
 * satunya memindai tabel tiket.
 *
 * "Tidak ada tiket" adalah jawaban yang sah, dan harus diingat sebagai jawaban.
 */
let loadedRange = "";
/** Server memangkas riwayat pada 5.000 baris; operator perlu tahu bila kena. */
let truncated = false;

/** Gudang ikut menjadi bagian kunci: beralih gudang wajib menarik ulang. */
function rangeKey() {
  return `${currentSite()?.code || "ALL"}|${range.from}|${range.to}`;
}

/* --------------------------------------------------------------------------
 * Perhitungan
 * ----------------------------------------------------------------------- */
function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

/**
 * Kepatuhan SLA hanya dihitung dari tiket yang benar-benar punya target dan
 * sudah selesai. Memasukkan tiket tanpa SLA atau yang masih berjalan akan
 * membuat angkanya naik-turun tanpa alasan operasional.
 */
function summarize(list) {
  // Hanya durasi yang sudah selesai yang boleh masuk rata-rata. Memasukkan
  // tiket yang masih berjalan membuat angkanya naik terus sepanjang hari
  // tanpa ada yang benar-benar berubah di lapangan.
  const waits = list
    .filter((row) => row.arrived_at && row.start_unloading_at)
    .map((row) => minutesBetween(row.arrived_at, row.start_unloading_at));
  const unloads = list
    .filter((row) => row.start_unloading_at && row.sla_stopped_at)
    .map((row) => minutesBetween(row.start_unloading_at, row.sla_stopped_at));

  const judged = list.filter(
    (row) => Number(row.sla_target_hours || 0) > 0 && row.sla_deadline_at && row.sla_stopped_at,
  );
  const met = judged.filter(
    (row) => new Date(row.sla_stopped_at).getTime() <= new Date(row.sla_deadline_at).getTime(),
  );
  const compliance = judged.length ? Math.round((met.length / judged.length) * 100) : null;

  return metricStrip([
    {
      label: "Tiket",
      value: String(list.length),
      sub: "Pada rentang terpilih",
      tone: "accent",
    },
    {
      label: "Rata-rata tunggu",
      value: formatMinutes(average(waits)),
      sub: `Datang sampai mulai bongkar · ${waits.length} tiket`,
      tone: "monitor",
    },
    {
      label: "Rata-rata bongkar",
      value: formatMinutes(average(unloads)),
      sub: `Mulai sampai selesai · ${unloads.length} tiket`,
      tone: "teal",
    },
    {
      label: "Patuh SLA",
      value: compliance === null ? "-" : `${compliance}%`,
      sub: `${met.length} dari ${judged.length} tiket selesai`,
      tone: compliance === null ? "muted" : compliance >= 90 ? "normal" : compliance >= 75 ? "warning" : "critical",
    },
  ]);
}

/* --------------------------------------------------------------------------
 * Tabel
 * ----------------------------------------------------------------------- */
const COLUMNS = [
  ["Antrean", (row) => row.queue_no],
  ["Status", (row) => statusMeta(row.status).label],
  ["Vendor", (row) => row.vendor_name || "-"],
  ["Armada", (row) => fleetLabel(row.fleet_type)],
  ["Plat", (row) => row.plat_number || "-"],
  ["Gate", (row) => gateLabel(row.gate)],
  ["Datang", (row) => formatDateTime(row.arrived_at)],
  ["Mulai bongkar", (row) => formatDateTime(row.start_unloading_at)],
  ["Selesai", (row) => formatDateTime(row.sla_stopped_at)],
  // Durasi yang belum selesai ditandai "berjalan", bukan diberi angka. Angka
  // yang terus bertambah setiap kali laporan dibuka mustahil direkonsiliasi.
  ["Tunggu", (row) => (row.start_unloading_at
    ? formatMinutes(minutesBetween(row.arrived_at, row.start_unloading_at))
    : row.arrived_at ? "berjalan" : "-")],
  ["Bongkar", (row) => (row.sla_stopped_at
    ? formatMinutes(minutesBetween(row.start_unloading_at, row.sla_stopped_at))
    : row.start_unloading_at ? "berjalan" : "-")],
  ["Target SLA", (row) => (row.sla_target_hours ? `${row.sla_target_hours} jam` : "-")],
];

function slaVerdict(row) {
  if (!Number(row.sla_target_hours || 0)) return badge("Tanpa SLA", "muted");
  if (!row.sla_stopped_at || !row.sla_deadline_at) return badge("Berjalan", "accent");
  const late = new Date(row.sla_stopped_at).getTime() > new Date(row.sla_deadline_at).getTime();
  return badge(late ? "Lewat" : "Patuh", late ? "critical" : "normal");
}

function table(list) {
  if (!list.length) {
    return emptyState(
      loading ? "Memuat riwayat…" : "Tidak ada tiket pada rentang ini",
      loading ? "" : "Ubah rentang tanggal, lalu tekan Terapkan.",
    );
  }
  return `<div class="table-scroll">
    <table class="tbl">
      <thead><tr>${COLUMNS.map(([label]) => `<th>${esc(label)}</th>`).join("")}<th>SLA</th></tr></thead>
      <tbody>${list
        .map(
          (row) =>
            `<tr>${COLUMNS.map(([, get]) => `<td>${esc(get(row) ?? "-")}</td>`).join("")}<td>${slaVerdict(row)}</td></tr>`,
        )
        .join("")}</tbody>
    </table>
  </div>`;
}

/* --------------------------------------------------------------------------
 * Render
 * ----------------------------------------------------------------------- */
export function render(root) {
  const site = currentSite();

  root.innerHTML = `<div class="dashboard-page">
    ${pageHeader({
      scope: site?.code,
      eyebrow: "Riwayat",
      title: "Laporan Operasional",
      description: "Waktu tunggu, waktu bongkar, dan kepatuhan SLA per rentang tanggal.",
      actions: `<button type="button" class="btn" id="export-csv">${icon("download", 16)} Ekspor CSV</button>`,
    })}

    <div class="filter-bar">
      <label>
        <span>Dari</span>
        <input class="input" type="date" id="from" value="${esc(range.from)}" max="${toDateInputValue()}" />
      </label>
      <label>
        <span>Sampai</span>
        <input class="input" type="date" id="to" value="${esc(range.to)}" max="${toDateInputValue()}" />
      </label>
      <div></div>
      <div></div>
      <div class="table-actions">
        <button type="button" class="btn btn-primary" id="apply-range">Terapkan</button>
      </div>
    </div>

    ${summarize(rows)}

    ${
      truncated
        ? `<div class="banner" role="status">
             <strong>${icon("alert", 18)} Rentang terlalu lebar</strong>
             <p>Hanya 5.000 tiket terbaru yang ditampilkan. Persempit rentang tanggal untuk melihat sisanya.</p>
           </div>`
        : ""
    }

    ${section({
      eyebrow: `${rows.length} tiket`,
      title: "Rincian tiket",
      body: table(rows),
      flush: true,
    })}
  </div>`;

  bindEvents(root);
  // Rentang yang sudah pernah dijawab tidak diminta ulang, sekalipun jawabannya
  // nol baris. Muat ulang dilakukan lewat tombol Terapkan.
  if (loadedRange !== rangeKey() && !loading) load(root);
}

function bindEvents(root) {
  root.querySelector("#from")?.addEventListener("change", (event) => {
    range.from = event.target.value;
  });
  root.querySelector("#to")?.addEventListener("change", (event) => {
    range.to = event.target.value;
  });
  root.querySelector("#apply-range")?.addEventListener("click", (event) =>
    withBusy(event.currentTarget, () => {
      // Terapkan selalu memaksa penarikan ulang, termasuk untuk rentang yang
      // sama: itulah satu-satunya cara operator menyegarkan laporan.
      loadedRange = "";
      return load(root);
    }),
  );
  root.querySelector("#export-csv")?.addEventListener("click", exportCsv);
}

async function load(root) {
  loading = true;
  const requested = rangeKey();
  try {
    const payload = await api.fetchHistory(range.from, range.to);
    rows = Array.isArray(payload?.rows) ? payload.rows : [];
    truncated = Boolean(payload?.truncated);
    loadedRange = requested;
  } catch (error) {
    toast(error.message, "error");
    rows = [];
    truncated = false;
    // Kegagalan juga ditandai sebagai "sudah dicoba". Mencoba ulang otomatis
    // saat API sedang bermasalah hanya memperberat API yang sedang bermasalah;
    // tombol Terapkan tetap tersedia bagi operator yang ingin mengulang.
    loadedRange = requested;
  } finally {
    loading = false;
    render(root);
  }
}

function exportCsv() {
  if (!rows.length) {
    toast("Tidak ada data untuk diekspor.", "error");
    return;
  }
  const headers = COLUMNS.map(([label]) => label).concat("SLA");
  const body = rows.map((row) =>
    COLUMNS.map(([, get]) => get(row) ?? "").concat(
      !Number(row.sla_target_hours || 0)
        ? "TANPA SLA"
        : !row.sla_stopped_at
          ? "BERJALAN"
          : new Date(row.sla_stopped_at) > new Date(row.sla_deadline_at)
            ? "LEWAT"
            : "PATUH",
    ),
  );

  // BOM di depan supaya Excel versi Indonesia membaca UTF-8 dengan benar.
  const blob = new Blob(["﻿", toCsv(headers, body)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `inbound-${currentSite()?.code || "ALL"}-${range.from}-${range.to}.csv`;
  // Tautan harus berada di dokumen sebelum diklik: sebagian browser mengabaikan
  // klik pada elemen yang tidak pernah terpasang.
  link.style.display = "none";
  document.body.append(link);
  link.click();
  // Objek URL dilepas setelah unduhan sempat dimulai. Melepasnya seketika
  // membatalkan unduhan yang belum sempat berjalan di sebagian browser.
  setTimeout(() => {
    URL.revokeObjectURL(url);
    link.remove();
  }, 1000);
  toast(`${rows.length} baris diekspor.`);
}
