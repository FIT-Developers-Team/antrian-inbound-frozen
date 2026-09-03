/* ==========================================================================
 * ANALITIK LEAD TIME
 *
 * Halaman Laporan menjawab "apa yang terjadi pada tiket ini". Halaman ini
 * menjawab pertanyaan yang berbeda dan lebih sulit: "apakah gudang ini membaik
 * atau memburuk, dan di mana letak macetnya".
 *
 * TIGA DURASI, BUKAN SATU
 *
 * Umur satu tiket tersusun dari tiga bagian, dan masing-masing milik orang yang
 * berbeda:
 *
 *   tunggu   datang -> mulai bongkar   Milik perencanaan gate dan shift.
 *   bongkar  mulai  -> selesai         Inilah yang diukur SLA.
 *   dwell    datang -> selesai         Inilah yang dirasakan vendor.
 *
 * Menggabungkan ketiganya menjadi satu angka "lead time" menyembunyikan
 * satu-satunya hal yang berguna: kalau truk berada di gudang lebih lama, yang
 * bertambah itu menunggunya atau bongkarnya? Jawabannya menentukan apakah yang
 * kurang itu dok atau checker.
 *
 * PERSENTIL, BUKAN RATA-RATA
 *
 * Rata-rata menyembunyikan ekor. Sepuluh truk yang lancar meredam satu truk
 * yang tertahan empat jam — padahal truk itulah yang membuat vendor menelepon.
 * Setiap angka di halaman ini karena itu tampil bertiga: median, p90, dan
 * terburuk.
 * ========================================================================== */

import * as api from "../api.js";
import { currentSite } from "../config.js";
import { esc, formatMinutes, toDateInputValue } from "../format.js";
import { badge, emptyState, icon, onBreakpoint, pageHeader, section, toast, withBusy } from "../ui.js";
import {
  bindChartTooltips,
  chartEmpty,
  columnChart,
  complianceChart,
  fleetChart,
  seriesColor,
  stackedDailyChart,
} from "../charts.js";

const range = {
  from: toDateInputValue(new Date(Date.now() - 13 * 86400000)),
  to: toDateInputValue(),
};

let stats = null;
let vendors = null;
let loading = false;
let loadedKey = "";

/* --------------------------------------------------------------------------
 * Menggambar ulang ketika layar melewati ambang grafik
 *
 * Kanvas grafik dipilih pada saat render menurut lebar layar (`useGeometry()`
 * di charts.js). Tablet yang diputar dari lanskap ke potret melewati ambang
 * 720px, dan tanpa ini grafiknya tetap memakai kanvas lebar: label setinggi 10
 * unit pada kanvas 720 unit tiba di layar 390px sebagai huruf enam piksel, dan
 * bertahan begitu sampai halaman kebetulan digambar ulang.
 *
 * Satu pendengar di tingkat modul cukup — halaman ini hanya punya satu akar
 * pada satu waktu. Penjaganya menyebut elemen milik halaman ini sendiri:
 * `#page-root` dipakai bersama seluruh halaman, jadi "masih terpasang" saja
 * tidak cukup untuk memastikan Analitik-lah yang sedang ditampilkan.
 * ----------------------------------------------------------------------- */
let mounted = null;

onBreakpoint("(max-width: 720px)", () => {
  // Penjaganya menyebut elemen milik halaman ini sendiri: `#page-root` dipakai
  // bersama seluruh halaman, jadi "masih terpasang" saja tidak membuktikan
  // bahwa Analitik-lah yang sedang ditampilkan.
  if (mounted?.isConnected && mounted.querySelector("#an-apply")) render(mounted);
});

function rangeKey() {
  return `${currentSite()?.code || "ALL"}|${range.from}|${range.to}`;
}

/* --------------------------------------------------------------------------
 * Kartu angka
 * ----------------------------------------------------------------------- */

/**
 * Satu durasi, ditampilkan sebagai median besar dengan sebarannya di bawah.
 *
 * Median yang berdiri sendiri terbaca sebagai janji; median dengan p90 di
 * sebelahnya terbaca sebagai kenyataan.
 */
function durationStat(label, summary, tone) {
  const count = summary?.count || 0;
  if (!count) {
    return `<article class="stat">
      <span class="stat-label">${esc(label)}</span>
      <strong class="stat-value" style="--stat-tone:var(--text-muted)">-</strong>
      <span class="stat-spread">belum ada data</span>
    </article>`;
  }
  return `<article class="stat">
    <span class="stat-label">${esc(label)}</span>
    <strong class="stat-value" style="--stat-tone:${tone}">${esc(formatMinutes(summary.p50))}</strong>
    <span class="stat-spread">p90 ${esc(formatMinutes(summary.p90))} · maks ${esc(formatMinutes(summary.max))} · ${count} tiket</span>
  </article>`;
}

function complianceStat(overall) {
  const judged = overall?.sla_judged || 0;
  const met = overall?.sla_met || 0;
  const percent = judged ? Math.round((met / judged) * 100) : null;
  const tone =
    percent === null
      ? "var(--text-muted)"
      : percent >= 90
        ? "var(--status-normal)"
        : percent >= 75
          ? "var(--status-warning)"
          : "var(--status-critical)";
  return `<article class="stat">
    <span class="stat-label">Patuh SLA</span>
    <strong class="stat-value" style="--stat-tone:${tone}">${percent === null ? "-" : `${percent}%`}</strong>
    <span class="stat-spread">${met} dari ${judged} tiket dinilai</span>
  </article>`;
}

function volumeStat(overall) {
  return `<article class="stat">
    <span class="stat-label">Tiket</span>
    <strong class="stat-value">${overall?.tickets ?? 0}</strong>
    <span class="stat-spread">${overall?.completed ?? 0} selesai · ${overall?.cancelled ?? 0} batal · ${overall?.active ?? 0} berjalan</span>
  </article>`;
}

/* --------------------------------------------------------------------------
 * Tampilan tabel
 *
 * Setiap grafik menyimpan angkanya sebagai tabel yang dapat dibuka. Itu bukan
 * sekadar syarat aksesibilitas: supervisor yang ingin menyalin angka ke laporan
 * mingguan tidak seharusnya membacanya dari batang.
 * ----------------------------------------------------------------------- */
function tableView(caption, headers, rows) {
  if (!rows.length) return "";
  return `<details class="chart-table">
    <summary>Lihat angkanya</summary>
    <div class="table-scroll">
      <table class="tbl">
        <caption class="sr-only">${esc(caption)}</caption>
        <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
        <tbody>${rows
          .map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`)
          .join("")}</tbody>
      </table>
    </div>
  </details>`;
}

/* --------------------------------------------------------------------------
 * Vendor, dok, dan pembatalan
 * ----------------------------------------------------------------------- */

/**
 * Tabel kinerja vendor.
 *
 * Diurutkan menurut MENIT DOK, bukan jumlah tiket. Vendor yang datang sepuluh
 * kali dengan muatan kecil tidak sama beratnya dengan vendor yang datang tiga
 * kali dan menahan dok empat jam tiap kali — dan yang kedua itulah yang
 * menentukan panjang antrean di luar.
 *
 * Kolom "batal" berdiri sendiri karena tiket batal tidak punya durasi untuk
 * dirata-rata: ia hilang dari setiap angka lain, padahal ia adalah slot dok
 * yang sudah dijanjikan lalu terbuang.
 */
function vendorTable(rows) {
  if (!rows?.length) return emptyState("Belum ada tiket pada rentang ini");

  const maxMinutes = Math.max(...rows.map((row) => row.dock_minutes || 0), 1);

  return `<div class="table-scroll">
    <table class="tbl">
      <thead><tr>
        <th>Vendor</th><th class="numeric">Tiket</th><th>Waktu dok</th>
        <th class="numeric">Tunggu</th><th class="numeric">Bongkar p50</th><th class="numeric">p90</th>
        <th class="numeric">SKU</th><th class="numeric">Batal</th><th>SLA</th>
      </tr></thead>
      <tbody>${rows
        .map((row) => {
          const compliance = row.sla_judged ? Math.round((row.sla_met / row.sla_judged) * 100) : null;
          const tone =
            compliance === null ? "muted" : compliance >= 90 ? "normal" : compliance >= 75 ? "warning" : "critical";
          return `<tr>
            <td class="cell-text" title="${esc(row.vendor)}"><strong>${esc(row.vendor)}</strong></td>
            <td class="numeric mono">${esc(row.tickets)}</td>
            <td>
              <div class="bar-cell">
                <span class="bar-track"><i style="width:${((row.dock_minutes || 0) / maxMinutes) * 100}%"></i></span>
                <b class="mono">${esc(formatMinutes(row.dock_minutes))}</b>
              </div>
            </td>
            <td class="numeric mono">${esc(formatMinutes(row.wait_p50))}</td>
            <td class="numeric mono">${esc(formatMinutes(row.unload_p50))}</td>
            <td class="numeric mono">${esc(formatMinutes(row.unload_p90))}</td>
            <td class="numeric mono">${esc(row.total_sku)}</td>
            <td class="numeric mono">${row.cancelled ? `<span class="cancel-count">${esc(row.cancelled)}</span>` : "-"}</td>
            <td>${compliance === null ? badge("-", "muted") : badge(`${compliance}%`, tone)}</td>
          </tr>`;
        })
        .join("")}</tbody>
    </table>
  </div>`;
}

/**
 * Pemakaian dok.
 *
 * Sembilan pintu jarang terpakai merata. Yang selalu penuh dan yang jarang
 * tersentuh sama-sama memberi tahu sesuatu tentang cara gate dibagikan — dan
 * keduanya tidak pernah terlihat dari papan antrean, yang hanya menunjukkan
 * keadaan saat ini.
 */
function gateChart(gateRows) {
  if (!gateRows?.length) return chartEmpty("Belum ada gate aktif.");
  return columnChart(gateRows, {
    title: "Pemakaian dok",
    description: "Total menit dok terpakai per pintu inbound pada rentang terpilih.",
    series: "unload",
    // Nilainya dijadikan JAM sejak awal, bukan menit yang dibagi saat
    // menampilkan label. Menit menghasilkan garis sumbu pada 1000 dan 2000 —
    // yang setelah dibagi menjadi "17j" dan "33j", angka yang terlihat
    // sembarang. Dalam jam, garisnya jatuh pada kelipatan bulat.
    valueOf: (row) => Math.round(((row.dock_minutes || 0) / 60) * 10) / 10,
    labelOf: (row) => row.gate.slice(-2),
    tipOf: (row) =>
      `${row.gate} — ${row.tickets} tiket, ${formatMinutes(row.dock_minutes)} terpakai` +
      (row.unload_p50 ? `, median ${formatMinutes(row.unload_p50)}` : ""),
    formatValue: (v) => `${Math.round(v)}j`,
  });
}

/** Alasan pembatalan, diurutkan menurut yang paling sering. */
function cancellationList(reasons) {
  if (!reasons?.length) {
    return `<p class="section-note">Tidak ada tiket yang dibatalkan pada rentang ini.</p>`;
  }
  // Menjumlahkan segelintir alasan untuk menentukan lebar bar — bukan
  // mengagregasi baris tiket, yang seluruhnya tetap dikerjakan Postgres.
  const total = reasons.reduce((sum, reason) => sum + reason.tickets, 0);
  return `<div class="reason-list">
    ${reasons
      .map(
        (reason) => `<div class="reason">
          <span class="reason-label">${esc(reason.reason)}</span>
          <span class="bar-track"><i class="is-critical" style="width:${(reason.tickets / total) * 100}%"></i></span>
          <b class="mono">${esc(reason.tickets)}</b>
        </div>`,
      )
      .join("")}
    <p class="section-note">${total} tiket dibatalkan — setiap satu adalah slot dok
      yang sudah dijanjikan lalu terbuang.</p>
  </div>`;
}

/* --------------------------------------------------------------------------
 * Render
 * ----------------------------------------------------------------------- */
export function render(root) {
  mounted = root;
  const site = currentSite();
  const overall = stats?.overall;
  const days = stats?.by_day || [];
  const fleets = stats?.by_fleet || [];
  const hours = stats?.by_hour || [];
  const buckets = stats?.unload_buckets || [];

  root.innerHTML = `<div class="dashboard-page">
    ${pageHeader({
      scope: site?.code,
      eyebrow: "Analitik",
      title: "Lead Time Inbound",
      description:
        "Berapa lama driver menunggu, berapa lama bongkar berjalan, dan di jam berapa antrean menumpuk.",
      actions: `<button type="button" class="btn" id="analytics-refresh">${icon("refresh", 16)} Muat ulang</button>`,
    })}

    <div class="filter-bar">
      <label>
        <span>Dari</span>
        <input class="input" type="date" id="an-from" value="${esc(range.from)}" max="${toDateInputValue()}" />
      </label>
      <label>
        <span>Sampai</span>
        <input class="input" type="date" id="an-to" value="${esc(range.to)}" max="${toDateInputValue()}" />
      </label>
      <div class="table-actions">
        <button type="button" class="btn btn-primary" id="an-apply">Terapkan</button>
      </div>
    </div>

    ${
      loading && !stats
        ? emptyState("Menghitung lead time…", "Agregasi berjalan di server.")
        : !stats
          ? emptyState("Belum ada data", "Ubah rentang tanggal, lalu tekan Terapkan.")
          : `
      <div class="stat-row">
        ${volumeStat(overall)}
        ${durationStat("Waktu tunggu", overall?.wait, seriesColor("wait"))}
        ${durationStat("Waktu bongkar", overall?.unload, seriesColor("unload"))}
        ${durationStat("Total di gudang", overall?.dwell, "var(--text)")}
        ${complianceStat(overall)}
      </div>

      ${section({
        eyebrow: "Komposisi harian",
        title: "Tunggu vs bongkar",
        body:
          stackedDailyChart(days, {
            title: "Komposisi lead time harian",
            description: "Median waktu tunggu ditumpuk di atas median waktu bongkar, per hari operasional.",
          }) +
          `<p class="section-note">
            Ketika total naik, tumpukan menunjukkan bagiannya: bagian bawah yang membesar berarti
            driver menunggu lebih lama — persoalan gate dan shift. Bagian atas yang membesar berarti
            bongkarnya sendiri melambat — persoalan checker dan muatan.
          </p>` +
          tableView(
            "Lead time harian",
            ["Hari", "Tiket", "Tunggu p50", "Tunggu p90", "Bongkar p50", "Bongkar p90", "Total p50"],
            days.map((day) => [
              day.day,
              day.tickets,
              formatMinutes(day.wait_p50),
              formatMinutes(day.wait_p90),
              formatMinutes(day.unload_p50),
              formatMinutes(day.unload_p90),
              formatMinutes(day.dwell_p50),
            ]),
          ),
      })}

      ${section({
        eyebrow: "Sebaran",
        title: "Lama bongkar",
        body:
          columnChart(buckets, {
            title: "Sebaran lama bongkar",
            description: "Jumlah tiket per pita 30 menit; pita terakhir menampung semua yang lebih lama.",
            series: "unload",
            valueOf: (bucket) => bucket.tickets,
            labelOf: (bucket) =>
              bucket.to_minutes === null ? `${bucket.from_minutes}m+` : `${bucket.from_minutes}m`,
            tipOf: (bucket) =>
              bucket.to_minutes === null
                ? `Lebih dari ${bucket.from_minutes} menit — ${bucket.tickets} tiket`
                : `${bucket.from_minutes}-${bucket.to_minutes} menit — ${bucket.tickets} tiket`,
          }) +
          `<p class="section-note">Setiap batang adalah satu pita 30 menit. Ekor panjang di kanan berarti
            sebagian truk jauh melewati kebiasaannya — itulah tiket yang perlu ditelusuri satu per satu,
            bukan dirata-ratakan.</p>`,
      })}

      ${section({
        eyebrow: "Kepadatan",
        title: "Jam kedatangan",
        body:
          columnChart(hours, {
            title: "Kedatangan menurut jam",
            description: "Jumlah truk yang tiba pada tiap jam, waktu Jakarta.",
            series: "wait",
            valueOf: (hour) => hour.arrivals,
            labelOf: (hour) => String(hour.hour).padStart(2, "0"),
            tipOf: (hour) =>
              `Pukul ${String(hour.hour).padStart(2, "0")}:00 — ${hour.arrivals} truk tiba` +
              (hour.wait_p50 ? `, median tunggu ${hour.wait_p50}m` : ""),
          }) +
          `<p class="section-note">Jam dengan puncak kedatangan menentukan berapa banyak checker
            dibutuhkan — bukan rata-rata sepanjang hari, yang selalu terlihat lebih tenang daripada
            keadaan sebenarnya di pos masuk.</p>`,
      })}

      ${section({
        eyebrow: "Per armada",
        title: "Lama bongkar terhadap target",
        body:
          fleetChart(fleets, {
            title: "Lama bongkar per tipe armada",
            description: "Median dan p90 lama bongkar tiap armada, dibandingkan target SLA-nya.",
          }) +
          tableView(
            "Lama bongkar per armada",
            ["Armada", "Tiket", "Median", "p90", "Target", "Patuh"],
            fleets.map((fleet) => [
              fleet.fleet,
              fleet.tickets,
              formatMinutes(fleet.unload_p50),
              formatMinutes(fleet.unload_p90),
              `${fleet.target_hours} jam`,
              fleet.sla_judged ? `${Math.round((fleet.sla_met / fleet.sla_judged) * 100)}%` : "-",
            ]),
          ),
      })}

      ${section({
        eyebrow: "Vendor",
        title: "Siapa yang memakai waktu dok",
        body:
          vendorTable(vendors?.by_vendor) +
          `<p class="section-note">
            Diurutkan menurut total waktu dok, bukan jumlah tiket: vendor yang datang sepuluh kali
            dengan muatan kecil tidak sama beratnya dengan vendor yang datang tiga kali dan menahan
            dok empat jam tiap kali. Kolom <strong>Batal</strong> berdiri sendiri karena tiket batal
            tidak punya durasi untuk dirata-rata — ia hilang dari setiap angka lain, padahal ia slot
            dok yang sudah dijanjikan lalu terbuang.
          </p>`,
        flush: true,
      })}

      ${section({
        eyebrow: "Dok",
        title: "Pemakaian pintu inbound",
        body:
          gateChart(vendors?.by_gate) +
          `<p class="section-note">Sumbu tegak dalam jam. Pintu yang selalu penuh dan pintu yang
            jarang tersentuh sama-sama memberi tahu sesuatu tentang cara gate dibagikan — dan
            keduanya tidak terlihat dari papan antrean, yang hanya menunjukkan keadaan saat ini.</p>`,
      })}

      ${section({
        eyebrow: "Batal",
        title: "Alasan tiket keluar antrean",
        body: cancellationList(vendors?.cancellations),
      })}

      ${section({
        eyebrow: "Tren",
        title: "Kepatuhan SLA harian",
        body:
          complianceChart(days, {
            title: "Kepatuhan SLA harian",
            description: "Persentase tiket selesai yang memenuhi tenggatnya, per hari.",
          }) || chartEmpty("Belum cukup data."),
      })}
    `
    }
  </div>`;

  bindEvents(root);
  bindChartTooltips(root);
  if (loadedKey !== rangeKey() && !loading) load(root);
}

function bindEvents(root) {
  root.querySelector("#an-from")?.addEventListener("change", (event) => {
    range.from = event.target.value;
  });
  root.querySelector("#an-to")?.addEventListener("change", (event) => {
    range.to = event.target.value;
  });
  root.querySelector("#an-apply")?.addEventListener("click", (event) =>
    withBusy(event.currentTarget, () => {
      loadedKey = "";
      return load(root);
    }),
  );
  root.querySelector("#analytics-refresh")?.addEventListener("click", (event) =>
    withBusy(event.currentTarget, () => {
      loadedKey = "";
      return load(root);
    }),
  );
}

async function load(root) {
  loading = true;
  const requested = rangeKey();
  try {
    // Keduanya diminta bersamaan, bukan berurutan: dua perjalanan yang saling
    // menunggu adalah dua kali waktu tunggu untuk data yang tidak saling
    // bergantung.
    [stats, vendors] = await Promise.all([
      api.fetchLeadTime(range.from, range.to),
      api.fetchVendorStats(range.from, range.to),
    ]);
  } catch (error) {
    toast(error.message, "error");
    stats = null;
    vendors = null;
  } finally {
    loading = false;
    // Rentang yang sudah dijawab diingat sebagai sudah dijawab, termasuk ketika
    // jawabannya kosong atau gagal — mencoba ulang otomatis hanya memperberat
    // server yang sedang bermasalah.
    loadedKey = requested;
    render(root);
  }
}
