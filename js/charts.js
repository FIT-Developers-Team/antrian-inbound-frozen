/* ==========================================================================
 * GRAFIK — SVG SEBARIS
 *
 * Tanpa pustaka charting. Grafik di aplikasi ini hanya batang, garis, kolom
 * bertumpuk, dan histogram; pustaka mana pun menambah ratusan kilobyte untuk
 * menggambar bentuk yang muat dalam beberapa ratus baris — dan di jaringan
 * gudang, ratusan kilobyte itu terasa.
 *
 * ATURAN WARNA
 *
 * Warna seri TIDAK diambil dari token UI apa adanya. Token gelap aplikasi ini
 * (--accent #6fa4ff, --teal #3fd0bd) terlalu terang untuk dipakai sebagai
 * bidang data di atas permukaan gelap: keduanya gagal uji pita lightness, dan
 * hasilnya bidang yang menyilaukan sekaligus sulit dibedakan. Mode gelap karena
 * itu punya langkahnya sendiri — bukan pembalikan otomatis — dan keduanya sudah
 * lolos uji pemisahan buta warna, lantai kontras, dan chroma.
 *
 * Teks selalu memakai token teks, tidak pernah warna seri. Identitas dibawa
 * oleh penanda berwarna di sebelahnya, bukan oleh warna hurufnya.
 * ========================================================================== */

import { esc } from "./format.js";

/* --------------------------------------------------------------------------
 * Palet
 *
 * Tiga slot kategorikal, urutannya TETAP. Seri keempat tidak pernah menjadi
 * warna yang dibangkitkan; ia dilipat menjadi "Lainnya" atau dipecah menjadi
 * grafik terpisah.
 * ----------------------------------------------------------------------- */
export const SERIES = {
  wait: { light: "#2563eb", dark: "#4f8ce8", label: "Waktu tunggu" },
  unload: { light: "#0f9f8f", dark: "#26ab9b", label: "Waktu bongkar" },
  volume: { light: "#b58212", dark: "#b5892a", label: "Jumlah tiket" },
};

/** Warna seri untuk tema yang sedang berlaku. */
export function seriesColor(key) {
  const slot = SERIES[key] || SERIES.wait;
  return isDark() ? slot.dark : slot.light;
}

function isDark() {
  const root = document.documentElement;
  if (root.classList.contains("dark")) return true;
  if (root.classList.contains("light")) return false;
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

/* --------------------------------------------------------------------------
 * Kerangka
 *
 * GEOMETRINYA MENGIKUTI LEBAR LAYAR, dan itu bukan kemewahan.
 *
 * SVG di dalam `viewBox` diskalakan seluruhnya — termasuk hurufnya. Dengan
 * viewBox tetap 720 unit dan `.chart { width: 100% }`, grafik yang sama dirender
 * selebar ~1000px di desktop dan ~320px di ponsel. Faktor skalanya 0,45, jadi
 * label sumbu setinggi 10 unit tiba di layar ponsel sebagai huruf setinggi
 * EMPAT SETENGAH PIKSEL: "08-21" dan "150m" berubah menjadi noda abu-abu yang
 * tidak dapat dibaca siapa pun, apalagi di tablet gudang yang dilihat sambil
 * berdiri.
 *
 * Memperbesar `font-size` saja tidak menyelesaikannya — huruf 24 unit menabrak
 * bidang plot dan meluber melewati padding kiri. Yang harus mengecil adalah
 * KANVASNYA: viewBox yang lebih sempit berarti faktor skala mendekati satu, dan
 * huruf 10 unit kembali tiba sebagai huruf 10 piksel.
 *
 * Nilainya dibaca pada saat render. Halaman Analitik digambar ulang setiap kali
 * dibuka dan setiap kali rentangnya berubah, jadi tidak ada pendengar resize
 * yang perlu dipelihara; grafik yang tertinggal setelah perangkat diputar akan
 * benar kembali pada muat berikutnya.
 * ----------------------------------------------------------------------- */
const COMPACT = globalThis.matchMedia?.("(max-width: 720px)");

function compact() {
  return Boolean(COMPACT?.matches);
}

let W = 720;
let H = 260;
let PAD = { top: 16, right: 16, bottom: 34, left: 46 };
let PLOT = { w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom };

/** Menyetel ulang kanvas untuk lebar layar yang sedang berlaku. */
function useGeometry() {
  if (compact()) {
    W = 340;
    H = 210;
    PAD = { top: 12, right: 8, bottom: 26, left: 34 };
  } else {
    W = 720;
    H = 260;
    PAD = { top: 16, right: 16, bottom: 34, left: 46 };
  }
  PLOT = { w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom };
}

/** Skala nilai ke koordinat y, dengan nol selalu ikut sebagai dasar. */
function yScale(max) {
  const top = max > 0 ? max : 1;
  return (value) => PAD.top + PLOT.h - (Math.max(0, value) / top) * PLOT.h;
}

/**
 * Sumbu yang berhenti di angka bulat, dengan garis pada kelipatan bulat pula.
 *
 * Sumbu yang berakhir di 137 memaksa pembacanya berhitung — dan sumbu yang
 * berakhir di 50 dengan empat garis menghasilkan 12,5 dan 37,5, yang setelah
 * dibulatkan tampil sebagai "13" dan "38": angka yang terlihat sembarang dan
 * membuat jarak antar-garis terbaca tidak sama besar.
 *
 * Karena itu yang dipilih adalah LANGKAHNYA lebih dulu — dari 1, 2, 5 kali
 * pangkat sepuluh — lalu batas atasnya mengikuti. Hasilnya setiap garis selalu
 * kelipatan langkah itu, jadi selalu bulat.
 */
function axisTicks(value) {
  if (value <= 0) return { max: 4, ticks: [0, 1, 2, 3, 4] };
  const target = value / 4;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  // Langkah tidak pernah turun di bawah satu: setiap sumbu di aplikasi ini
  // menghitung tiket atau menit, dan setengah tiket bukan besaran yang ada.
  const step = Math.max(1, ([1, 2, 5, 10].find((s) => target <= s * magnitude) ?? 10) * magnitude);
  const count = Math.max(1, Math.ceil(value / step));
  const max = step * count;
  return { max, ticks: Array.from({ length: count + 1 }, (_, index) => step * index) };
}

function gridAndAxis(max, formatValue, ticks) {
  const y = yScale(max);
  return `<g class="chart-grid" aria-hidden="true">
      ${ticks
        .map((tick) => `<line x1="${PAD.left}" y1="${y(tick)}" x2="${W - PAD.right}" y2="${y(tick)}" />`)
        .join("")}
    </g>
    <g class="chart-axis" aria-hidden="true">
      ${ticks
        .map(
          (tick) =>
            `<text x="${PAD.left - 8}" y="${y(tick) + 3}" text-anchor="end">${esc(formatValue(tick))}</text>`,
        )
        .join("")}
    </g>`;
}

/**
 * Label sumbu-x yang dijarangkan supaya tidak pernah bertabrakan.
 *
 * Label terakhir selalu tampil — pembaca perlu tahu di mana rentangnya
 * berakhir — tetapi ia MENGGANTIKAN tetangga yang terlalu dekat alih-alih
 * ditumpuk di atasnya. Bentuk sebelumnya menggambar keduanya tanpa syarat, dan
 * pada rentang empat belas hari itu menghasilkan "09-02" dan "09-03" yang
 * saling menimpa menjadi satu gumpalan di ujung kanan setiap grafik.
 */
function xLabels(items, xOf, label) {
  // Kanvas ponsel hanya selebar 340 unit; delapan label di atasnya bertumpuk.
  const every = Math.max(1, Math.ceil(items.length / (compact() ? 4 : 8)));
  const last = items.length - 1;
  const shown = new Set();
  for (let index = 0; index <= last; index += every) shown.add(index);
  for (const index of [...shown]) if (last - index < every) shown.delete(index);
  if (last >= 0) shown.add(last);

  return `<g class="chart-axis" aria-hidden="true">
    ${items
      .map((item, index) =>
        shown.has(index)
          ? `<text x="${xOf(index)}" y="${H - PAD.bottom + 16}" text-anchor="middle">${esc(label(item, index))}</text>`
          : "",
      )
      .join("")}
  </g>`;
}

function frame(inner, { title, description }) {
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
    aria-label="${esc(title)}. ${esc(description)}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`;
}

function legend(entries) {
  return `<div class="chart-legend">${entries
    .map(
      (entry) =>
        `<span><i style="background:${entry.color}"></i>${esc(entry.label)}</span>`,
    )
    .join("")}</div>`;
}

export function chartEmpty(message) {
  return `<p class="chart-empty">${esc(message)}</p>`;
}

/* --------------------------------------------------------------------------
 * Kolom bertumpuk — komposisi dwell harian
 *
 * Menjawab pertanyaan yang tidak dapat dijawab dua grafik terpisah: ketika truk
 * berada di gudang lebih lama, yang bertambah itu MENUNGGUNYA atau BONGKARNYA?
 * Keduanya menit, jadi keduanya sah berbagi satu sumbu — dan menumpuknya
 * membuat totalnya sekaligus terbaca.
 * ----------------------------------------------------------------------- */
export function stackedDailyChart(days, { title, description }) {
  if (!days.length) return chartEmpty("Belum ada tiket selesai pada rentang ini.");
  useGeometry();

  const totals = days.map((day) => (day.wait_p50 || 0) + (day.unload_p50 || 0));
  const { max, ticks } = axisTicks(Math.max(...totals, 1));
  const y = yScale(max);
  const slot = PLOT.w / days.length;
  const barWidth = Math.min(30, slot * 0.62);
  const xOf = (index) => PAD.left + slot * (index + 0.5);

  const waitColor = seriesColor("wait");
  const unloadColor = seriesColor("unload");

  const bars = days
    .map((day, index) => {
      const wait = day.wait_p50 || 0;
      const unload = day.unload_p50 || 0;
      const x = xOf(index) - barWidth / 2;
      const yWait = y(wait);
      const hWait = PAD.top + PLOT.h - yWait;
      // Celah dua piksel antar-segmen: tanpa itu dua bidang berwarna bertemu
      // langsung dan batas keduanya menjadi ilusi warna ketiga.
      const yUnload = y(wait + unload);
      const hUnload = Math.max(0, y(wait) - yUnload - 2);
      const tip = `${day.day} — tunggu ${wait}m, bongkar ${unload}m, total ${wait + unload}m (${day.tickets} tiket)`;
      return `<g class="chart-bar" data-tip="${esc(tip)}">
        <rect x="${x}" y="${yUnload}" width="${barWidth}" height="${hUnload}" rx="4" fill="${unloadColor}" />
        <rect x="${x}" y="${yWait}" width="${barWidth}" height="${Math.max(0, hWait)}" rx="4" fill="${waitColor}" />
      </g>`;
    })
    .join("");

  const svg = frame(
    `${gridAndAxis(max, (v) => `${Math.round(v)}m`, ticks)}
     ${bars}
     ${xLabels(days, xOf, (day) => day.day.slice(5))}`,
    { title, description },
  );

  return (
    svg +
    legend([
      { color: waitColor, label: "Waktu tunggu (median)" },
      { color: unloadColor, label: "Waktu bongkar (median)" },
    ])
  );
}

/* --------------------------------------------------------------------------
 * Garis — kepatuhan SLA harian
 *
 * Satu seri, jadi tidak ada kotak legenda: judulnya sudah menyebut apa yang
 * digambar. Garis acuan 90% memberi angka itu makna; tanpa acuan, "84%" hanya
 * angka yang tidak dapat dinilai baik atau buruk.
 * ----------------------------------------------------------------------- */
export function complianceChart(days, { title, description, target = 90 }) {
  useGeometry();
  const points = days
    .map((day, index) => ({
      index,
      day: day.day,
      value: day.sla_judged ? Math.round((day.sla_met / day.sla_judged) * 100) : null,
      judged: day.sla_judged,
    }))
    .filter((point) => point.value !== null);

  if (points.length < 2) return chartEmpty("Butuh minimal dua hari dengan tiket selesai.");

  const max = 100;
  const ticks = [0, 25, 50, 75, 100];
  const y = yScale(max);
  const slot = PLOT.w / days.length;
  const xOf = (index) => PAD.left + slot * (index + 0.5);
  const color = seriesColor("unload");

  const path = points.map((p, i) => `${i ? "L" : "M"}${xOf(p.index)},${y(p.value)}`).join(" ");
  const dots = points
    .map(
      (p) =>
        `<circle class="chart-dot chart-bar" cx="${xOf(p.index)}" cy="${y(p.value)}" r="4.5" fill="${color}"
           data-tip="${esc(`${p.day} — ${p.value}% patuh dari ${p.judged} tiket`)}" />`,
    )
    .join("");

  const last = points[points.length - 1];

  return frame(
    `${gridAndAxis(max, (v) => `${Math.round(v)}%`, ticks)}
     <line x1="${PAD.left}" y1="${y(target)}" x2="${W - PAD.right}" y2="${y(target)}"
       stroke="${seriesColor("volume")}" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.85" />
     <text class="chart-axis" x="${W - PAD.right}" y="${y(target) - 6}" text-anchor="end">target ${target}%</text>
     <path class="chart-line" d="${path}" stroke="${color}" />
     ${dots}
     <text class="chart-label" x="${xOf(last.index)}" y="${y(last.value) - 12}" text-anchor="end">${last.value}%</text>
     ${xLabels(days, xOf, (day) => day.day.slice(5))}`,
    { title, description },
  );
}

/* --------------------------------------------------------------------------
 * Kolom — histogram dan kepadatan jam
 *
 * Satu seri, satu warna. Ujung batang dibulatkan 4px hanya di sisi datanya dan
 * tetap menempel pada garis dasar; batang melayang membuat perbandingan tinggi
 * menjadi tidak jujur.
 * ----------------------------------------------------------------------- */
export function columnChart(items, { title, description, series = "volume", valueOf, labelOf, tipOf, formatValue }) {
  if (!items.length || items.every((item) => !valueOf(item))) {
    return chartEmpty("Belum ada data pada rentang ini.");
  }
  useGeometry();

  const { max, ticks } = axisTicks(Math.max(...items.map(valueOf), 1));
  const y = yScale(max);
  const slot = PLOT.w / items.length;
  // Dua piksel permukaan di antara batang bersebelahan.
  const barWidth = Math.max(3, slot - 2);
  const xOf = (index) => PAD.left + slot * (index + 0.5);
  const color = seriesColor(series);

  const bars = items
    .map((item, index) => {
      const value = valueOf(item) || 0;
      const top = y(value);
      const height = Math.max(0, PAD.top + PLOT.h - top);
      return `<rect class="chart-bar" x="${xOf(index) - barWidth / 2}" y="${top}"
        width="${barWidth}" height="${height}" rx="4" fill="${color}"
        data-tip="${esc(tipOf(item))}" />`;
    })
    .join("");

  return frame(
    `${gridAndAxis(max, formatValue || ((v) => String(Math.round(v))), ticks)}
     ${bars}
     ${xLabels(items, xOf, labelOf)}`,
    { title, description },
  );
}

/* --------------------------------------------------------------------------
 * Batang mendatar — perbandingan antar armada
 *
 * Mendatar karena namanya panjang ("TRONTON/FUSO"), dan memutar teks sembilan
 * puluh derajat memaksa pembacanya memiringkan kepala.
 *
 * Warnanya mengikuti STATUS kepatuhan, bukan identitas armada: yang ditanyakan
 * bukan "armada mana ini" — namanya sudah tertulis — melainkan "armada mana
 * yang bermasalah".
 * ----------------------------------------------------------------------- */
export function fleetChart(fleets, { title, description }) {
  if (!fleets.length) return chartEmpty("Belum ada tiket selesai pada rentang ini.");
  useGeometry();

  const rows = fleets.slice(0, 8);
  const rowHeight = compact() ? 34 : 30;
  const height = rows.length * rowHeight + 24;
  // Kolom nama dan kolom angka menyusut bersama kanvasnya; dipatok tetap,
  // keduanya memakan hampir seluruh lebar grafik ponsel dan menyisakan batang
  // sepanjang beberapa piksel saja.
  const labelWidth = compact() ? 86 : 108;
  const valueWidth = compact() ? 62 : 76;
  const plotWidth = W - labelWidth - valueWidth;
  const { max } = axisTicks(Math.max(...rows.map((row) => row.unload_p90 || row.unload_p50 || 0), 1));

  const bars = rows
    .map((row, index) => {
      const y = 8 + index * rowHeight;
      const p50 = row.unload_p50 || 0;
      const p90 = row.unload_p90 || p50;
      const compliance = row.sla_judged ? row.sla_met / row.sla_judged : null;
      const tone =
        compliance === null
          ? "var(--text-muted)"
          : compliance >= 0.9
            ? "var(--status-normal)"
            : compliance >= 0.75
              ? "var(--status-warning)"
              : "var(--status-critical)";
      const target = (row.target_hours || 0) * 60;

      return `<g class="chart-bar" data-tip="${esc(
        `${row.fleet} — median ${p50}m, p90 ${p90}m, target ${row.target_hours} jam, ` +
          `${row.sla_judged ? Math.round((row.sla_met / row.sla_judged) * 100) : 0}% patuh (${row.tickets} tiket)`,
      )}">
        <text class="chart-label" x="0" y="${y + 15}">${esc(row.fleet)}</text>
        <rect x="${labelWidth}" y="${y + 6}" width="${(p90 / max) * plotWidth}" height="12" rx="4"
          fill="${tone}" opacity="0.28" />
        <rect x="${labelWidth}" y="${y + 6}" width="${(p50 / max) * plotWidth}" height="12" rx="4" fill="${tone}" />
        ${
          target > 0 && target <= max
            ? `<line x1="${labelWidth + (target / max) * plotWidth}" y1="${y + 2}"
                 x2="${labelWidth + (target / max) * plotWidth}" y2="${y + 22}"
                 stroke="var(--text-muted)" stroke-width="1.5" stroke-dasharray="3 3" />`
            : ""
        }
        <text class="chart-axis" x="${W - valueWidth + 10}" y="${y + 16}">${p50}m / ${p90}m</text>
      </g>`;
    })
    .join("");

  return `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img"
      aria-label="${esc(title)}. ${esc(description)}" preserveAspectRatio="xMidYMid meet">${bars}</svg>
    <div class="chart-legend">
      <span><i style="background:var(--status-normal)"></i>Patuh SLA ≥ 90%</span>
      <span><i style="background:var(--status-warning)"></i>75–89%</span>
      <span><i style="background:var(--status-critical)"></i>Di bawah 75%</span>
      <span><i style="background:var(--text-muted)"></i>Garis putus: target SLA · batang pudar: p90</span>
    </div>`;
}

/* --------------------------------------------------------------------------
 * Lapisan hover
 *
 * Grafik HTML memang interaktif; menghilangkan tooltip berarti membuang separuh
 * gunanya. Satu tooltip dipakai bersama seluruh grafik supaya tidak ada belasan
 * simpul melayang yang harus dibersihkan.
 * ----------------------------------------------------------------------- */
let tooltip = null;

export function bindChartTooltips(root) {
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "chart-tip";
    tooltip.hidden = true;
    document.body.append(tooltip);
  }

  root.querySelectorAll("[data-tip]").forEach((mark) => {
    mark.addEventListener("pointerenter", (event) => {
      tooltip.textContent = mark.dataset.tip;
      tooltip.hidden = false;
      place(event);
    });
    mark.addEventListener("pointermove", place);
    mark.addEventListener("pointerleave", () => {
      tooltip.hidden = true;
    });
  });
}

function place(event) {
  const margin = 14;
  const box = tooltip.getBoundingClientRect();
  const left = Math.min(Math.max(margin, event.clientX - box.width / 2), innerWidth - box.width - margin);
  const top = event.clientY - box.height - margin;
  tooltip.style.left = `${left}px`;
  // Tooltip pindah ke bawah kursor ketika ruang di atas habis.
  tooltip.style.top = `${top < margin ? event.clientY + margin : top}px`;
}
