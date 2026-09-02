/* ==========================================================================
 * PAPAN ANTREAN
 *
 * Ruang kerja utama. Empat hal yang benar-benar dipakai operasional ada di
 * satu layar ini: jam kedatangan, armada + plat, tombol mulai bongkar, dan
 * hitung mundur SLA. Sebelum revamp keempatnya tersebar di empat halaman
 * berbeda (Daftar, Checker, Panggil, Waiting Monitor).
 * ========================================================================== */

import * as api from "../api.js";
import * as store from "../store.js";
import { currentSite, fleetLabel, gateLabel, statusMeta } from "../config.js";
import { esc, formatTime, toLocalInputValue } from "../format.js";
import { slaMarkup, slaState } from "../sla.js";
import { elapsedMarkup } from "../sla.js";
import {
  badge,
  chip,
  debounce,
  dialog,
  emptyState,
  fact,
  icon,
  metricStrip,
  pageHeader,
  toast,
  withBusy,
} from "../ui.js";

/** Filter hanya di memori — tidak ada permintaan tambahan ke server. */
const filters = { query: "", status: "AKTIF", gate: "" };

/* --------------------------------------------------------------------------
 * Ringkasan
 * ----------------------------------------------------------------------- */
function summarize(rows) {
  const now = new Date();
  const count = (status) => store.rowsByStatus(status, rows).length;
  const unloading = store.rowsByStatus("UNLOADING", rows);
  const phases = unloading.map((row) => slaState(row, now).phase);

  return metricStrip([
    {
      label: "Menunggu",
      value: String(count("WAITING")),
      sub: "Sudah datang, belum dipanggil",
      tone: "monitor",
    },
    {
      label: "Dipanggil",
      value: String(count("CALLED")),
      sub: "Menuju gate",
      tone: "accent",
    },
    {
      label: "Bongkar",
      value: String(unloading.length),
      sub: "SLA sedang berjalan",
      tone: "teal",
    },
    {
      label: "Mendekati SLA",
      value: String(phases.filter((phase) => phase === "warning").length),
      sub: "Sisa 30 menit terakhir",
      tone: "warning",
    },
    {
      label: "Terlambat",
      value: String(phases.filter((phase) => phase === "breached").length),
      sub: "Sudah lewat tenggat",
      tone: "critical",
    },
  ]);
}

/* --------------------------------------------------------------------------
 * Penyaringan
 * ----------------------------------------------------------------------- */
function applyFilters(rows) {
  const query = filters.query.trim().toLowerCase();
  return rows.filter((row) => {
    const status = String(row.status || "").toUpperCase();
    if (filters.status === "AKTIF") {
      if (!["WAITING", "CALLED", "UNLOADING"].includes(status)) return false;
    } else if (filters.status && status !== filters.status) {
      return false;
    }
    if (filters.gate && row.gate !== filters.gate) return false;
    if (!query) return true;
    return [row.queue_no, row.vendor_name, row.plat_number, row.driver_name, row.po_numbers]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
}

/** Kartu diurutkan berdasarkan urgensi, bukan waktu daftar. */
function sortByUrgency(rows) {
  const rank = { UNLOADING: 0, CALLED: 1, WAITING: 2 };
  const now = new Date();
  return [...rows].sort((a, b) => {
    const statusDiff =
      (rank[String(a.status).toUpperCase()] ?? 9) - (rank[String(b.status).toUpperCase()] ?? 9);
    if (statusDiff !== 0) return statusDiff;
    // Di dalam kelompok yang sama, yang paling dekat melanggar SLA naik dulu.
    const left = slaState(a, now);
    const right = slaState(b, now);
    const weight = (s) => (s.phase === "breached" ? -1e9 - s.seconds : s.seconds || 1e9);
    return weight(left) - weight(right);
  });
}

/* --------------------------------------------------------------------------
 * Kartu antrean
 * ----------------------------------------------------------------------- */
function queueCard(row) {
  const status = String(row.status || "").toUpperCase();
  const meta = statusMeta(status);
  const tone = {
    WAITING: "var(--status-monitor)",
    CALLED: "var(--accent)",
    UNLOADING: "var(--teal)",
    COMPLETED: "var(--status-normal)",
    EXPIRED: "var(--status-critical)",
  }[status] || "var(--line-strong)";

  const poList = String(row.po_numbers || "")
    .split(/[,;]\s*/)
    .filter(Boolean);

  return `<article class="queue-card" style="--queue-tone:${tone}" data-ticket="${esc(row.ticket_id)}">
    <div class="queue-card-head">
      <div class="queue-no">
        <strong>${esc(row.queue_no || "-")}</strong>
        <small>${esc(row.vendor_name || "Vendor tidak tercatat")}</small>
      </div>
      ${badge(meta.label, meta.tone)}
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

  if (status === "WAITING") {
    return `${arrival}
      <button type="button" class="btn btn-primary" data-action="call" data-ticket="${id}">
        ${icon("megaphone", 16)} Panggil
      </button>
      <button type="button" class="btn" data-action="start" data-ticket="${id}">
        ${icon("play", 16)} Mulai bongkar
      </button>`;
  }

  if (status === "CALLED") {
    return `<button type="button" class="btn btn-sm" data-action="call" data-ticket="${id}">
        ${icon("megaphone", 16)} Panggil ulang
      </button>
      <button type="button" class="btn btn-primary" data-action="start" data-ticket="${id}">
        ${icon("play", 16)} Mulai bongkar
      </button>`;
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

/**
 * Kegagalan memuat harus terlihat di tempat operator bekerja.
 *
 * Sebelumnya pesannya hanya disimpan di state dan tidak pernah dirender, jadi
 * backend yang bermasalah tampak persis seperti hari yang sepi: papan kosong,
 * tanpa satu pun petunjuk tentang apa yang salah atau apa yang harus dilakukan.
 */
function errorBanner() {
  const message = store.state.error;
  if (!message) return "";

  // Bila pesannya menyebut perintah yang harus dijalankan, perintah itu
  // dipisahkan ke barisnya sendiri sebagai kode agar dapat langsung disalin.
  const command = message.match(/(?:Jalankan|Perintah):\s*(.+?)\s*$/)?.[1];
  const prose = command ? message.slice(0, message.indexOf(command)).replace(/(?:Jalankan|Perintah):\s*$/, "").trim() : message;

  return `<div class="banner" role="alert">
    <strong>${icon("alert", 18)} Data tidak dapat dimuat</strong>
    <p>${esc(prose)}</p>
    ${command ? `<p><code>${esc(command)}</code></p>` : ""}
  </div>`;
}

/* --------------------------------------------------------------------------
 * Render
 * ----------------------------------------------------------------------- */
export function render(root) {
  const site = currentSite();
  const rows = store.state.rows;
  const visible = sortByUrgency(applyFilters(rows));

  const statusOptions = ["AKTIF", "WAITING", "CALLED", "UNLOADING", "COMPLETED", "EXPIRED"]
    .map(
      (value) =>
        `<option value="${value}"${filters.status === value ? " selected" : ""}>${
          value === "AKTIF" ? "Semua aktif" : esc(statusMeta(value).label)
        }</option>`,
    )
    .join("");

  const gateOptionsHtml = [`<option value="">Semua gate</option>`]
    .concat(
      store.state.gates.map(
        (gate) =>
          `<option value="${esc(gate)}"${filters.gate === gate ? " selected" : ""}>${esc(gateLabel(gate))}</option>`,
      ),
    )
    .join("");

  root.innerHTML = `<div class="dashboard-page">
    ${pageHeader({
      scope: site?.code,
      eyebrow: "Operasional",
      title: "Papan Antrean",
      description:
        "Catat kedatangan, panggil driver ke gate, mulai bongkar, dan pantau hitung mundur SLA dalam satu layar.",
      actions: `<button type="button" class="btn" data-action="refresh">${icon("refresh", 16)} Muat ulang</button>`,
    })}

    ${errorBanner()}

    ${summarize(rows)}

    <div class="filter-bar">
      <label>
        <span>Cari</span>
        <input class="input" type="search" id="board-query" placeholder="Nomor antrean, vendor, plat, PO"
               value="${esc(filters.query)}" />
      </label>
      <label>
        <span>Status</span>
        <select class="input" id="board-status">${statusOptions}</select>
      </label>
      <label>
        <span>Gate</span>
        <select class="input" id="board-gate">${gateOptionsHtml}</select>
      </label>
      <div class="table-actions">
        <span class="chip" id="board-count">${visible.length} tiket</span>
      </div>
    </div>

    <div id="board-list">${listMarkup(visible)}</div>
  </div>`;

  bindEvents(root);
}

function listMarkup(visible) {
  if (visible.length) return `<div class="board-grid">${visible.map(queueCard).join("")}</div>`;
  return emptyState(
    store.state.loading ? "Memuat antrean…" : "Belum ada antrean",
    store.state.loading ? "" : "Tiket baru muncul di sini begitu Security mendaftarkan kedatangan.",
  );
}

/**
 * Menggambar ulang HANYA daftar kartu.
 *
 * Penyaringan seluruhnya terjadi di memori, jadi mengetik di kotak pencarian
 * tidak pernah menyentuh jaringan — tetapi sebelumnya ia tetap membangun ulang
 * seluruh halaman, termasuk kotak pencarian itu sendiri. Akibatnya fokus dan
 * posisi kursor harus dipulihkan dengan tangan setiap ketukan, dan kedua daftar
 * pilihan di sampingnya ikut tertutup bila sedang terbuka.
 */
function renderList(root) {
  const visible = sortByUrgency(applyFilters(store.state.rows));
  const list = root.querySelector("#board-list");
  if (list) list.innerHTML = listMarkup(visible);
  const count = root.querySelector("#board-count");
  if (count) count.textContent = `${visible.length} tiket`;
  bindTicketActions(root);
}

function bindEvents(root) {
  const filterList = debounce(() => renderList(root));

  root.querySelector("#board-query")?.addEventListener("input", (event) => {
    filters.query = event.target.value;
    filterList();
  });

  root.querySelector("#board-status")?.addEventListener("change", (event) => {
    filters.status = event.target.value;
    renderList(root);
  });

  root.querySelector("#board-gate")?.addEventListener("change", (event) => {
    filters.gate = event.target.value;
    renderList(root);
  });

  root.querySelector('[data-action="refresh"]')?.addEventListener("click", (event) =>
    // Penarikan manual selalu menggambar ulang papan, bahkan bila sidik jarinya
    // tidak berubah: operator yang menekan tombol berhak melihat buktinya.
    withBusy(event.currentTarget, () => store.refresh()),
  );

  bindTicketActions(root);
}

function bindTicketActions(root) {
  root.querySelectorAll("[data-action][data-ticket]").forEach((button) => {
    button.addEventListener("click", () => handleAction(button));
  });
}

/* --------------------------------------------------------------------------
 * Aksi
 * ----------------------------------------------------------------------- */
async function handleAction(button) {
  const ticketId = button.dataset.ticket;
  const row = store.findRow(ticketId);
  if (!row) return;

  switch (button.dataset.action) {
    case "arrival":
      return promptArrival(row);
    case "call":
      return promptGate(row, "call");
    case "start":
      return promptGate(row, "start");
    case "finish":
      return withBusy(button, async () => {
        try {
          await store.mutate(() => api.finishUnloading(ticketId));
          toast(`${row.queue_no} selesai bongkar.`);
        } catch (error) {
          toast(error.message, "error");
        }
      });
    default:
      return undefined;
  }
}

/**
 * Jam kedatangan dibatasi tidak boleh melewati sekarang. Kedatangan di masa
 * depan hampir selalu salah ketik, dan bila lolos ia membuat waktu tunggu
 * driver menjadi negatif. Server menolak hal yang sama sebagai jaring pengaman.
 */
function promptArrival(row) {
  dialog({
    title: `Jam kedatangan ${row.queue_no}`,
    confirmLabel: "Simpan",
    body: `<label>
        <span>Driver tiba di pos</span>
        <input class="input" type="datetime-local" id="arrival-input"
               max="${toLocalInputValue()}"
               value="${toLocalInputValue(row.arrived_at || new Date())}" />
        <small>Dipakai untuk menghitung lama driver menunggu sampai bongkar dimulai.</small>
      </label>`,
    onConfirm: async (dialogRoot) => {
      const input = dialogRoot.querySelector("#arrival-input");
      const value = input?.value;
      if (!value) {
        toast("Jam kedatangan wajib diisi.", "error");
        return false;
      }
      if (new Date(value).getTime() > Date.now() + 60000) {
        toast("Jam kedatangan tidak boleh melewati waktu sekarang.", "error");
        return false;
      }
      try {
        await store.mutate(() => api.setArrival(row.ticket_id, new Date(value).toISOString()));
        toast(`Kedatangan ${row.queue_no} tercatat.`);
        return true;
      } catch (error) {
        toast(error.message, "error");
        return false;
      }
    },
  });
}

/**
 * Gate wajib ditentukan sebelum bongkar dimulai: tanpa gate, papan tidak dapat
 * menunjukkan dock mana yang sedang terpakai dan dua truk bisa diarahkan ke
 * tempat yang sama.
 */
function promptGate(row, mode) {
  const taken = store.occupiedGates();
  const options = store.state.gates
    .map((gate) => {
      const busy = taken.has(gate) && gate !== row.gate;
      return `<option value="${esc(gate)}"${row.gate === gate ? " selected" : ""}${busy ? " disabled" : ""}>
        ${esc(gateLabel(gate))}${busy ? " — terpakai" : ""}
      </option>`;
    })
    .join("");

  dialog({
    title: mode === "call" ? `Panggil ${row.queue_no}` : `Mulai bongkar ${row.queue_no}`,
    confirmLabel: mode === "call" ? "Panggil" : "Mulai bongkar",
    confirmTone: mode === "call" ? "primary" : "teal",
    body: `<label>
        <span>Gate</span>
        <select class="input" id="gate-input">
          <option value="">Pilih gate</option>
          ${options}
        </select>
        <small>${
          mode === "call"
            ? "Driver diarahkan ke gate ini."
            : "Hitung mundur SLA mulai berdetak begitu tombol ini ditekan."
        }</small>
      </label>`,
    onConfirm: async (dialogRoot) => {
      const gate = dialogRoot.querySelector("#gate-input")?.value;
      if (!gate) {
        toast("Pilih gate terlebih dahulu.", "error");
        return false;
      }
      try {
        if (mode === "call") {
          await store.mutate(() => api.callTicket(row.ticket_id, gate));
          toast(`${row.queue_no} dipanggil ke ${gateLabel(gate)}.`);
        } else {
          await store.mutate(() => api.startUnloading(row.ticket_id, gate));
          toast(`Bongkar ${row.queue_no} dimulai. SLA berjalan.`);
        }
        return true;
      } catch (error) {
        toast(error.message, "error");
        return false;
      }
    },
  });
}
