/* ==========================================================================
 * KARTU ANTREAN
 *
 * Dipisahkan dari board.js karena keduanya menjawab pertanyaan yang berbeda:
 * board.js mengurus halaman — penyaringan, pengelompokan, aksi — sedangkan
 * berkas ini hanya menjawab "seperti apa satu tiket terlihat".
 *
 * HIERARKI ADALAH ISI UTAMANYA.
 *
 * Versi sebelumnya memberi bobot visual yang sama kepada seluruh isi kartu:
 * nomor antrean, vendor, armada, plat, gate, jam datang, lama tunggu, dan SKU
 * semuanya seukuran. Akibatnya tidak ada yang menonjol, dan operator harus
 * MEMBACA kartu alih-alih memindainya — padahal papan ini dilihat sambil
 * berjalan, dengan sarung tangan, dari jarak beberapa meter.
 *
 * Sekarang hanya dua hal yang dirancang terbaca dari jauh: nomor antrean dan
 * hitung mundur SLA. Sisanya sengaja mundur.
 * ========================================================================== */

import { fleetLabel, gateLabel, statusMeta } from "../config.js";
import { esc, formatTime } from "../format.js";
import { elapsedMarkup, slaMarkup, slaState } from "../sla.js";
import { badge, chip, fact, icon } from "../ui.js";

const STATUS_TONE = {
  WAITING: "var(--status-monitor)",
  CALLED: "var(--accent)",
  UNLOADING: "var(--teal)",
  COMPLETED: "var(--status-normal)",
  EXPIRED: "var(--status-critical)",
};

export function queueCard(row) {
  const status = String(row.status || "").toUpperCase();
  const meta = statusMeta(status);
  const phase = slaState(row).phase;

  // Keadaan mendesak diangkat ke bidang kartu, bukan hanya ke satu garis tipis
  // di tepinya. Kartu yang sudah lewat tenggat harus terlihat sebelum dibaca.
  const urgency = phase === "breached" ? " is-breached" : phase === "warning" ? " is-warning" : "";

  const poList = String(row.po_numbers || "")
    .split(/[,;]\s*/)
    .filter(Boolean);

  const calls = Number(row.call_count || 0);

  return `<article class="queue-card${urgency}" style="--queue-tone:${STATUS_TONE[status] || "var(--line-strong)"}"
    data-ticket="${esc(row.ticket_id)}">
    <div class="queue-card-head">
      <div class="queue-no">
        <strong>${esc(row.queue_no || "-")}</strong>
        <small>${esc(row.vendor_name || "Vendor tidak tercatat")}</small>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        ${
          // Server sudah menghitung panggilan sejak awal dan tidak pernah
          // menampilkannya. "Dipanggil 3x" adalah persis tanda driver yang tidak
          // merespons — informasi yang menentukan apakah tiket ini perlu
          // dibatalkan, dan selama ini hanya ada di dalam database.
          calls > 1 ? `<span class="call-count" title="Sudah dipanggil ${calls} kali">${icon("megaphone", 12)}${calls}×</span>` : ""
        }
        ${badge(meta.label, meta.tone)}
      </div>
    </div>

    ${slaMarkup(row, { hero: true })}

    <div class="queue-facts">
      ${fact("Armada", fleetLabel(row.fleet_type))}
      ${fact("Plat", row.plat_number || "-", { mono: true })}
      ${fact("Gate", gateLabel(row.gate), { mono: true })}
      ${fact("Datang", formatTime(row.arrived_at), { mono: true })}
      <div class="fact">
        <span>Tunggu</span>
        <strong>${elapsedMarkup(row.arrived_at, row.start_unloading_at)}</strong>
      </div>
      ${fact("SKU / Qty", `${row.total_sku ?? 0} / ${row.total_qty ?? 0}`, { mono: true })}
    </div>

    ${poList.length ? `<div class="queue-po-list">${poList.map((po) => chip(po, { accent: true })).join("")}</div>` : ""}

    <div class="queue-actions">${cardActions(row, status)}</div>
  </article>`;
}

/**
 * Aksi kartu mengikuti tahap tiket. "Mulai Bongkar" baru menjadi tombol utama
 * setelah driver dipanggil — sebelum itu memulai bongkar berarti melewati
 * pemanggilan, dan waktu tunggu driver jadi tidak pernah terukur.
 */
function cardActions(row, status) {
  const id = esc(row.ticket_id);
  const arrival = row.arrived_at
    ? ""
    : `<button type="button" class="btn btn-sm" data-action="arrival" data-ticket="${id}">
         ${icon("clock", 16)} Catat datang
       </button>`;

  // Membatalkan tiket hanya masuk akal selama ia belum selesai. Aksinya ada di
  // backend sejak awal, lengkap dengan aturan peran — tetapi tidak satu pun
  // halaman pernah memanggilnya, sehingga driver yang tidak muncul tidak dapat
  // dikeluarkan dari antrean sama sekali.
  const cancel = `<button type="button" class="btn btn-sm btn-ghost" data-action="cancel" data-ticket="${id}">
      ${icon("x", 16)} Batalkan
    </button>`;

  if (status === "WAITING") {
    return `${arrival}
      <button type="button" class="btn btn-primary" data-action="call" data-ticket="${id}">
        ${icon("megaphone", 16)} Panggil
      </button>
      <button type="button" class="btn" data-action="start" data-ticket="${id}">
        ${icon("play", 16)} Mulai bongkar
      </button>
      ${cancel}`;
  }

  if (status === "CALLED") {
    return `<button type="button" class="btn btn-sm" data-action="call" data-ticket="${id}">
        ${icon("megaphone", 16)} Panggil ulang
      </button>
      <button type="button" class="btn btn-primary" data-action="start" data-ticket="${id}">
        ${icon("play", 16)} Mulai bongkar
      </button>
      ${cancel}`;
  }

  if (status === "UNLOADING") {
    return `<button type="button" class="btn btn-sm" data-action="arrival" data-ticket="${id}">
        ${icon("clock", 16)} Koreksi jam
      </button>
      <button type="button" class="btn btn-teal" data-action="finish" data-ticket="${id}">
        ${icon("check", 16)} Selesai bongkar
      </button>`;
  }

  return `<span class="chip">${esc(row.expired_reason || "Tidak ada aksi")}</span>`;
}
