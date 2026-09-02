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
import { currentSite, gateLabel, statusMeta } from "../config.js";
import { esc, toLocalInputValue } from "../format.js";
import { slaState } from "../sla.js";
import {
  debounce,
  dialog,
  dockRail,
  emptyState,
  icon,
  metricStrip,
  pageHeader,
  toast,
  withBusy,
} from "../ui.js";
import { queueCard } from "./queue-card.js";

/** Filter hanya di memori — tidak ada permintaan tambahan ke server. */
const filters = { query: "", status: "AKTIF", gate: "" };

/* --------------------------------------------------------------------------
 * Rel dok
 *
 * Sembilan pintu inbound adalah batas fisik gudang ini: berapa pun panjang
 * antrean di luar, sembilan adalah jumlah truk yang dapat dibongkar bersamaan.
 * Memetakan gate ke penghuninya menjawab pertanyaan yang paling sering
 * ditanyakan supervisor tanpa membaca satu kartu pun.
 * ----------------------------------------------------------------------- */
function buildDocks(rows) {
  const now = new Date();
  const occupant = new Map();
  rows.forEach((row) => {
    if (String(row.status || "").toUpperCase() !== "UNLOADING" || !row.gate) return;
    // Bila dua tiket menunjuk gate yang sama — seharusnya mustahil sejak server
    // menolaknya, tetapi data lama bisa saja memuatnya — yang paling mendesak
    // yang ditampilkan.
    const current = occupant.get(row.gate);
    if (!current || slaState(row, now).seconds < slaState(current, now).seconds) {
      occupant.set(row.gate, row);
    }
  });

  return store.state.gates.map((gate) => {
    const ticket = occupant.get(gate) || null;
    return {
      name: gate,
      label: gateLabel(gate).replace(/^\S+\s/, ""),
      ticket,
      phase: ticket ? slaState(ticket, now).phase : "free",
    };
  });
}

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

    <div id="dock-rail">${dockRail(buildDocks(rows))}</div>

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
  if (!visible.length) {
    return emptyState(
      store.state.loading ? "Memuat antrean…" : "Belum ada antrean",
      store.state.loading ? "" : "Tiket baru muncul di sini begitu Security mendaftarkan kedatangan.",
    );
  }

  // Pengelompokan hanya berlaku pada tampilan "Semua aktif". Saat operator
  // memilih satu status, kelompoknya tinggal satu dan judulnya jadi kebisingan.
  if (filters.status !== "AKTIF") {
    return `<div class="board-grid">${visible.map(queueCard).join("")}</div>`;
  }

  const sections = GROUPS.map(([status, label]) => {
    const rows = visible.filter((row) => String(row.status || "").toUpperCase() === status);
    if (!rows.length) return "";
    return `<p class="queue-group">${esc(label)} <b>${rows.length}</b></p>
      <div class="board-grid">${rows.map(queueCard).join("")}</div>`;
  }).join("");

  const others = visible.filter(
    (row) => !GROUPS.some(([status]) => status === String(row.status || "").toUpperCase()),
  );
  const rest = others.length
    ? `<p class="queue-group">Lainnya <b>${others.length}</b></p>
       <div class="board-grid">${others.map(queueCard).join("")}</div>`
    : "";

  return sections + rest;
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

/**
 * Daftar dikelompokkan menurut tahap, bukan digelar sebagai satu grid panjang.
 *
 * Ketiganya milik orang yang berbeda: yang sedang bongkar dipantau Checker,
 * yang sudah dipanggil ditunggu di gate, dan yang menunggu adalah antrean yang
 * belum disentuh siapa pun. Satu grid tanpa jeda memaksa ketiganya dibaca
 * sebagai satu daftar, padahal tidak seorang pun bekerja seperti itu.
 */
const GROUPS = [
  ["UNLOADING", "Sedang bongkar"],
  ["CALLED", "Sudah dipanggil"],
  ["WAITING", "Menunggu"],
];

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
    case "cancel":
      return promptCancel(row);
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
 * Membatalkan tiket, dengan alasan yang wajib dipilih.
 *
 * Aksinya sudah ada di backend sejak awal — lengkap dengan aturan peran, jejak
 * event, dan antrean ekspor — tetapi tidak satu pun halaman pernah
 * memanggilnya. Akibatnya driver yang tidak pernah muncul tetap menggantung di
 * antrean selamanya: ia tidak dapat dipanggil, tidak dapat dibongkar, dan tidak
 * dapat dikeluarkan. Satu-satunya jalan keluar adalah menyentuh database.
 *
 * Alasannya dipilih dari daftar, bukan diketik bebas: alasan yang seragam dapat
 * dihitung nanti ("berapa banyak driver tidak muncul bulan ini"), sedangkan
 * teks bebas hanya dapat dibaca satu per satu.
 */
const CANCEL_REASONS = [
  "Driver tidak muncul saat dipanggil",
  "Truk pulang tanpa bongkar",
  "PO dibatalkan vendor",
  "Salah daftar / duplikat",
  "Kendaraan bermasalah",
];

function promptCancel(row) {
  dialog({
    title: `Batalkan ${row.queue_no}`,
    confirmLabel: "Batalkan tiket",
    confirmTone: "danger",
    body: `<label>
        <span>Alasan</span>
        <select class="input" id="cancel-reason">
          ${CANCEL_REASONS.map((reason) => `<option value="${esc(reason)}">${esc(reason)}</option>`).join("")}
        </select>
        <small>Tiket keluar dari antrean dan tidak dapat dikembalikan. Alasannya tercatat pada riwayat.</small>
      </label>`,
    onConfirm: async (dialogRoot) => {
      const reason = dialogRoot.querySelector("#cancel-reason")?.value;
      try {
        await store.mutate(() => api.cancelTicket(row.ticket_id, reason));
        toast(`${row.queue_no} dibatalkan.`);
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
