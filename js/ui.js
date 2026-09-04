/* ==========================================================================
 * ANTRIAN INBOUND FROZEN — PRIMITIF UI
 *
 * Padanan JavaScript dari `components/ui/primitives.tsx` di
 * outbound-operations-hub, supaya kedua aplikasi menghasilkan markup dan kelas
 * yang sama persis.
 * ========================================================================== */

import { esc } from "./format.js";

/* --------------------------------------------------------------------------
 * Ikon
 *
 * SVG sebaris, bukan font ikon. Material Symbols menambah ~200 KB unduhan dan
 * membuat setiap ikon berkedip sebagai teks mentah sampai fontnya selesai
 * dimuat — di jaringan gudang itu terlihat setiap kali halaman dibuka.
 * ----------------------------------------------------------------------- */
const ICON_PATHS = {
  board: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  register: '<path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M9 13h6M9 17h4"/>',
  report: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  rail: '<path d="M9 3v18M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  truck: '<path d="M1 3h13v13H1zM14 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="17.5" cy="18.5" r="2"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  alert: '<path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
  // Analitik memakai kurva tren, bukan batang — supaya tidak tertukar dengan
  // Laporan, yang ikonnya memang batang.
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>',
};

export function icon(name, size = 20) {
  const path = ICON_PATHS[name] || "";
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

/* --------------------------------------------------------------------------
 * Blok halaman
 * ----------------------------------------------------------------------- */

/**
 * @param scope Kode gudang, ditampilkan sebagai chip sebelum judul. Tab dan
 *   topbar juga menyebut gudang, tetapi judullah yang bertahan saat halaman
 *   digulir dan saat layar difoto — persis saat pertanyaan "ini gudang mana?"
 *   muncul.
 */
export function pageHeader({ scope, eyebrow, title, description, actions = "" }) {
  return `<header class="page-header">
    <div>
      <span class="eyebrow">${esc(eyebrow)}</span>
      <h1>${scope ? `<span class="page-scope">${esc(scope)}</span> ` : ""}${esc(title)}</h1>
      <p>${esc(description)}</p>
    </div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ""}
  </header>`;
}

export function section({ title, eyebrow, action = "", body, className = "", flush = false }) {
  return `<section class="card section ${className}">
    <header class="section-head">
      <div>
        ${eyebrow ? `<span class="eyebrow">${esc(eyebrow)}</span>` : ""}
        <h2>${esc(title)}</h2>
      </div>
      ${action ? `<div class="section-actions">${action}</div>` : ""}
    </header>
    <div class="section-body${flush ? " flush" : ""}">${body}</div>
  </section>`;
}

const TONE_VAR = {
  accent: "var(--accent)",
  teal: "var(--teal)",
  muted: "var(--text-muted)",
  normal: "var(--status-normal)",
  monitor: "var(--status-monitor)",
  warning: "var(--status-warning)",
  critical: "var(--status-critical)",
};

export function metricCard({ label, value, sub, tone = "muted" }) {
  const color = TONE_VAR[tone] || TONE_VAR.muted;
  return `<article class="metric-card" style="--metric-tone:${color}">
    <span class="metric-label"><i></i>${esc(label)}</span>
    <strong class="metric-value">${esc(value)}</strong>
    <span class="metric-sub">${esc(sub)}</span>
  </article>`;
}

export function metricStrip(cards) {
  const size = cards.length === 3 ? " metric-strip-three" : cards.length === 4 ? " metric-strip-four" : "";
  return `<div class="metric-strip${size}">${cards.map(metricCard).join("")}</div>`;
}

export function badge(text, tone = "muted") {
  return `<span class="badge badge-${esc(tone)}">${esc(text)}</span>`;
}

export function chip(text, { accent = false } = {}) {
  return `<span class="chip${accent ? " chip-accent" : ""}">${esc(text)}</span>`;
}

export function emptyState(title, description = "", iconName = "inbox") {
  return `<div class="empty-state">
    ${icon(iconName, 28)}
    <strong>${esc(title)}</strong>
    ${description ? `<span>${esc(description)}</span>` : ""}
  </div>`;
}

export function progressBar(value, tone = "accent", label = "") {
  const width = Math.max(0, Math.min(100, Number(value) || 0));
  return `<span class="progress-track" role="img" aria-label="${esc(label)}: ${Math.round(width)}%">
    <i class="progress-${esc(tone)}" style="width:${width}%"></i>
  </span>`;
}

/**
 * Penanda medan wajib.
 *
 * Bintangnya `aria-hidden`: pembaca layar sudah mendengar "wajib" dari atribut
 * `required` pada kontrolnya, dan mendengar "bintang" di tiap label hanya
 * menambah kebisingan.
 */
export function req() {
  return `<b class="req" aria-hidden="true">*</b>`;
}

/**
 * Galat sebaris, di sebelah medan yang salah.
 *
 * Toast tidak cukup untuk kegagalan validasi: ia muncul di sudut layar, jauh
 * dari medan yang dimaksud, dan menghilang sebelum operator selesai membaca —
 * lalu tidak menyisakan satu pun tanda tentang medan mana yang harus diperbaiki.
 */
export function fieldError(message, id) {
  return message ? `<span class="field-error" id="${esc(id)}">${esc(message)}</span>` : "";
}

export function fact(label, value, { mono = false } = {}) {
  return `<div class="fact">
    <span>${esc(label)}</span>
    <strong${mono ? ' class="mono"' : ""}>${esc(value)}</strong>
  </div>`;
}

/* --------------------------------------------------------------------------
 * Rel dok
 *
 * Gudang ini punya sembilan pintu inbound. Itu batas fisiknya: berapa pun
 * panjang antrean di luar, sembilan adalah jumlah truk yang dapat dibongkar
 * bersamaan.
 *
 * Sebelumnya kenyataan itu hanya hadir sebagai satu dropdown filter, padahal
 * ia justru model mental yang dipakai supervisor sepanjang hari — "dok mana
 * yang kosong, dan mana yang sebentar lagi lewat tenggat". Menjawabnya dulu
 * berarti membaca setiap kartu antrean satu per satu.
 *
 * Setiap ubin membawa `data-dock-bar` beserta jam mulai dan tenggatnya, jadi
 * ticker satu detik yang sudah ada dapat menyusutkan barnya tanpa siapa pun
 * merender ulang rel ini.
 * ----------------------------------------------------------------------- */

/**
 * @param {{name: string, label: string, ticket: object|null, phase: string}[]} docks
 */
export function dockRail(docks) {
  // Jumlah dok diseberangkan ke CSS sebagai custom property, bukan dipaku di
  // stylesheet. Gudang ini punya sembilan pintu, gudang lain enam; relnya harus
  // membagi lebar menurut jumlah yang benar-benar ada, bukan menurut angka yang
  // kebetulan berlaku ketika CSS-nya ditulis.
  const count = Math.max(1, docks.length);
  return `<div class="dock-rail" role="list" aria-label="Status ${count} dok inbound"
    style="--dock-count:${count}">
    ${docks.map(dockTile).join("")}
  </div>`;
}

const DOCK_TONE = { breached: "dock-late", warning: "dock-warn" };

function dockTile({ label, ticket, phase }) {
  if (!ticket) {
    return `<article class="dock dock-free" role="listitem" aria-label="Dok ${esc(label)} kosong">
      <div class="dock-head">
        <span class="dock-no">${esc(label)}</span>
        <span class="dock-state">Kosong</span>
      </div>
      <div class="dock-occupant"><span class="dock-vendor">Siap menerima</span></div>
      <span class="dock-bar" aria-hidden="true"><i></i></span>
    </article>`;
  }

  const tone = DOCK_TONE[phase] || "dock-busy";
  const state = phase === "breached" ? "Lewat SLA" : phase === "warning" ? "Hampir" : "Bongkar";
  const bar = [
    `data-dock-bar="1"`,
    ticket.sla_started_at ? `data-sla-started="${esc(ticket.sla_started_at)}"` : "",
    ticket.sla_deadline_at ? `data-sla-deadline="${esc(ticket.sla_deadline_at)}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<article class="dock ${tone}" role="listitem"
    aria-label="Dok ${esc(label)}, ${esc(state)}, antrean ${esc(ticket.queue_no || "-")}">
    <div class="dock-head">
      <span class="dock-no">${esc(label)}</span>
      <span class="dock-state">${esc(state)}</span>
    </div>
    <div class="dock-occupant">
      <span class="dock-queue">${esc(ticket.queue_no || "-")}</span>
      <!-- Nama vendor kerap lebih panjang daripada ubinnya dan dipotong dengan
           ellipsis; atribut title menyimpan nilai penuhnya, sehingga
           "PT Sumber Pang…" masih dapat dipastikan tanpa membuka kartunya. -->
      <span class="dock-vendor" title="${esc(ticket.vendor_name || "Vendor tidak tercatat")}"
        >${esc(ticket.vendor_name || "Vendor tidak tercatat")}</span>
    </div>
    <span class="dock-bar" ${bar} aria-hidden="true"><i></i></span>
  </article>`;
}

/* --------------------------------------------------------------------------
 * Toast
 * ----------------------------------------------------------------------- */
const TOAST_ICON = { success: "check", error: "alert", info: "clock" };

export function toast(message, kind = "success") {
  const stack = document.getElementById("toast-stack");
  if (!stack) return;
  const node = document.createElement("div");
  node.className = `toast toast-${kind}`;
  node.innerHTML = `${icon(TOAST_ICON[kind] || "check", 18)}<span>${esc(message)}</span>`;
  stack.append(node);
  setTimeout(() => node.remove(), kind === "error" ? 6000 : 3200);
}

/* --------------------------------------------------------------------------
 * Dialog
 *
 * Fokus dipindahkan ke dalam dialog saat dibuka dan dikembalikan ke pemicunya
 * saat ditutup, sehingga operator yang memakai keyboard tidak pernah kehilangan
 * posisi. Escape selalu menutup.
 *
 * Fokus juga TERKURUNG di dalamnya, dan itu bukan kemewahan aksesibilitas.
 * `aria-modal` hanya berbicara kepada teknologi bantu; ia tidak menghentikan
 * Tab. Tanpa kurungan, satu tekanan Tab dari tombol terakhir dialog memindahkan
 * fokus ke tiga puluh sembilan kontrol di balik lapisan gelap — menu samping,
 * kartu antrean, tombol "Selesai bongkar" milik tiket lain — semuanya tetap
 * dapat ditekan meskipun tidak terlihat. Operator yang mengonfirmasi satu tiket
 * dengan keyboard dapat menyelesaikan tiket yang sama sekali lain.
 * ----------------------------------------------------------------------- */
let openDialog = null;

/** Kontrol yang benar-benar dapat menerima Tab, dalam urutan dokumen. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
}

let dialogSeq = 0;

export function dialog({ title, body, confirmLabel = "Simpan", confirmTone = "primary", onConfirm }) {
  closeDialog();
  const opener = document.activeElement;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const titleId = `modal-title-${(dialogSeq += 1)}`;
  backdrop.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
    <header class="modal-head">
      <h2 id="${titleId}">${esc(title)}</h2>
      <button type="button" class="icon-btn" data-close aria-label="Tutup">${icon("x", 18)}</button>
    </header>
    <div class="modal-body">${body}</div>
    <footer class="modal-footer">
      <button type="button" class="btn" data-close>Batal</button>
      <button type="button" class="btn btn-${esc(confirmTone)}" data-confirm>${esc(confirmLabel)}</button>
    </footer>
  </div>`;

  // Sisa halaman dilepas dari pohon aksesibilitas DAN dari urutan Tab. `inert`
  // melakukan keduanya sekaligus; kelas `modal-open` yang sudah ada hanya
  // mengunci gulir.
  const shell = document.querySelector(".app-shell");
  shell?.setAttribute("inert", "");

  document.body.append(backdrop);
  document.body.classList.add("modal-open");
  openDialog = { backdrop, opener, shell };

  backdrop.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", closeDialog);
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeDialog();
  });
  backdrop.querySelector("[data-confirm]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.classList.add("is-busy");
    try {
      const keepOpen = await onConfirm?.(backdrop);
      if (keepOpen !== false) closeDialog();
    } finally {
      button.disabled = false;
      button.classList.remove("is-busy");
    }
  });

  // Escape didengarkan hanya selama dialog terbuka. Mendaftarkannya sekali saat
  // modul dimuat akan meninggalkan listener global yang hidup selamanya, dan
  // membuat modul ini tidak dapat dimuat di luar browser.
  document.addEventListener("keydown", onDialogKeydown);

  backdrop.querySelector("input, select, textarea, button[data-confirm]")?.focus();
  return backdrop;
}

function onDialogKeydown(event) {
  if (!openDialog) return;
  if (event.key === "Escape") return closeDialog();
  if (event.key !== "Tab") return undefined;

  // `inert` sudah menutup jalan keluar pada browser yang mendukungnya; kurungan
  // ini yang membuat Tab melingkar di dalam dialog alih-alih berhenti di ujung.
  const items = focusableIn(openDialog.backdrop);
  if (!items.length) return undefined;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && (active === first || !openDialog.backdrop.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
  return undefined;
}

export function closeDialog() {
  if (!openDialog) return;
  document.removeEventListener("keydown", onDialogKeydown);
  openDialog.shell?.removeAttribute("inert");
  openDialog.backdrop.remove();
  document.body.classList.remove("modal-open");
  openDialog.opener?.focus?.();
  openDialog = null;
}

/* --------------------------------------------------------------------------
 * Bantuan aksi
 * ----------------------------------------------------------------------- */

/**
 * Menjalankan aksi tombol dengan status sibuk, sehingga ketukan ganda pada
 * layar sentuh tidak pernah mengirim dua permintaan.
 */
export async function withBusy(button, task) {
  if (!button || button.disabled) return undefined;
  const label = button.innerHTML;
  button.disabled = true;
  button.classList.add("is-busy");
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.classList.remove("is-busy");
    button.innerHTML = label;
  }
}

export function setBusy(root, busy) {
  root?.setAttribute("aria-busy", busy ? "true" : "false");
}

/**
 * Menunda pemanggilan sampai ketikan berhenti.
 *
 * Kotak pencarian di aplikasi ini menyaring daftar yang bisa berisi puluhan
 * ribu baris. Menjalankan penyaringan pada setiap ketukan berarti mengerjakan
 * pekerjaan yang sama sebanyak jumlah huruf yang diketik — dan semuanya kecuali
 * yang terakhir langsung dibuang. Di tablet gudang yang CPU-nya sederhana, itu
 * terasa sebagai huruf yang tertinggal di belakang jari.
 *
 * Seratus dua puluh milidetik cukup pendek untuk terasa seketika dan cukup
 * panjang untuk melewati seluruh ketukan di tengah kata.
 */
/**
 * Memanggil `onChange` ketika layar MELINTASI sebuah ambang, bukan setiap kali
 * ukurannya bergeser.
 *
 * Dipakai untuk hal-hal yang dipilih sekali pada saat render dan tidak dapat
 * dinyatakan dalam CSS: kanvas grafik, dan atribut `open` milik disclosure
 * filter. Tablet gudang diputar antara lanskap dan potret sepanjang hari, dan
 * tanpa ini keduanya bertahan pada pilihan yang dibuat untuk orientasi
 * sebelumnya sampai halaman kebetulan digambar ulang.
 *
 * Yang didengarkan adalah `resize`, bukan `change` milik MediaQueryList.
 * Keduanya benar di browser sungguhan, tetapi `resize` juga tiba pada viewport
 * yang diemulasikan alat uji — sehingga perilakunya dapat dibuktikan, bukan
 * sekadar diyakini. Perbandingan boolean menjaga agar penggambaran ulang hanya
 * terjadi pada lintasan ambang, bukan pada tiap piksel selama jendela diseret.
 *
 * @param {string} query  Kueri media, mis. "(max-width: 720px)".
 * @param {(matches: boolean) => void} onChange
 * @returns {() => boolean} Pembaca keadaan ambang saat ini.
 */
export function onBreakpoint(query, onChange) {
  const media = globalThis.matchMedia?.(query);
  const matches = () => Boolean(media ? media.matches : false);
  let previous = matches();

  globalThis.addEventListener?.("resize", () => {
    const current = matches();
    if (current === previous) return;
    previous = current;
    onChange(current);
  });

  return matches;
}

export function debounce(fn, waitMs = 120) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}
