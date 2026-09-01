/* ==========================================================================
 * ANTRIAN INBOUND FROZEN — SHELL & ROUTER
 *
 * Merakit kerangka aplikasi, menangani masuk/keluar, dan mengarahkan ke satu
 * dari empat halaman. Tidak ada logika operasional di sini.
 * ========================================================================== */

import * as api from "./api.js";
import * as store from "./store.js";
import { BRAND_SHORT, STORAGE, brand, canAccess, currentSite, pagesForRole } from "./config.js";
import { esc, formatDuration, formatTime } from "./format.js";
import { bindVisibility, onTick, startTicker } from "./sla.js";
import { icon, toast } from "./ui.js";
import { applyTheme, cycleTheme, themeIconName } from "./theme.js";

import * as boardPage from "./pages/board.js";
import * as registerPage from "./pages/register.js";
import * as reportPage from "./pages/report.js";
import * as settingsPage from "./pages/settings.js";

const PAGES = {
  board: {
    label: "Papan Antrean",
    icon: "board",
    subtitle: "Kedatangan, bongkar, SLA",
    render: boardPage.render,
  },
  register: {
    label: "Daftar",
    icon: "register",
    subtitle: "Pos masuk",
    render: registerPage.render,
  },
  report: {
    label: "Laporan",
    icon: "report",
    subtitle: "Riwayat & ekspor",
    render: reportPage.render,
  },
  settings: {
    label: "Pengaturan",
    icon: "settings",
    subtitle: "Gudang & tampilan",
    render: settingsPage.render,
  },
};

let activePage = "board";

/* --------------------------------------------------------------------------
 * Layar masuk
 * ----------------------------------------------------------------------- */
function renderLogin() {
  document.body.innerHTML = `<main class="login-shell">
    <section class="login-art">
      <img src="assets/login-banner.webp" alt="" aria-hidden="true" />
      <span class="eyebrow">Astronauts Operations</span>
      <h2>${esc(BRAND_SHORT)}</h2>
      <p>Antrean inbound gudang beku: satu papan untuk kedatangan, bongkar, dan hitung mundur SLA.</p>
    </section>

    <section class="login-panel">
      <form class="login-form" id="login-form">
        <img src="assets/login-logo.png" alt="" aria-hidden="true" />
        <div>
          <span class="eyebrow">Masuk</span>
          <h1 style="font-size:26px;margin-top:4px">Selamat datang</h1>
        </div>
        <label>
          <span>Username</span>
          <input class="input" id="username" autocomplete="username" required autofocus />
        </label>
        <label>
          <span>Password</span>
          <input class="input" id="password" type="password" autocomplete="current-password" required />
        </label>
        <p class="field-error" id="login-error" hidden></p>
        <button type="submit" class="btn btn-primary btn-block" id="login-submit">Masuk</button>
      </form>
    </section>
  </main>
  <div class="toast-stack" id="toast-stack" role="status" aria-live="polite"></div>`;

  document.getElementById("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.getElementById("login-submit");
    const errorBox = document.getElementById("login-error");
    errorBox.hidden = true;
    button.disabled = true;
    button.textContent = "Memeriksa…";
    try {
      const user = await api.login(
        document.getElementById("username").value.trim(),
        document.getElementById("password").value,
      );
      // Layar masuk ditinggalkan sebelum data pertama selesai dimuat, sehingga
      // operator tidak menatap formulir yang seolah tidak merespons.
      activePage = pagesForRole(user.role)[0] || "board";
      renderShell();
      store.refresh();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      button.disabled = false;
      button.textContent = "Masuk";
    }
  });
}

/* --------------------------------------------------------------------------
 * Kerangka aplikasi
 * ----------------------------------------------------------------------- */
function navMarkup(role) {
  return pagesForRole(role)
    .map((key) => {
      const page = PAGES[key];
      if (!page) return "";
      // Lencana selalu dirender, tersembunyi selagi nol. Kerangka dibangun
      // sebelum data pertama tiba, jadi membuat elemennya hanya ketika sudah
      // ada antrean berarti ia tidak pernah muncul sama sekali.
      const count = key === "board" ? `<b id="nav-waiting" hidden>0</b>` : "";
      return `<button type="button" class="nav-link${key === activePage ? " active" : ""}"
        data-page="${key}"${key === activePage ? ' aria-current="page"' : ""}>
        ${icon(page.icon)}<span>${esc(page.label)}</span>${count}
      </button>`;
    })
    .join("");
}

function updateWaitingBadge() {
  const badge = document.getElementById("nav-waiting");
  if (!badge) return;
  const waiting = store.rowsByStatus("WAITING").length;
  badge.textContent = String(waiting);
  badge.hidden = waiting === 0;
}

function renderShell() {
  const user = api.getUser();
  const site = currentSite();
  const railed = localStorage.getItem(STORAGE.rail) === "1";

  document.body.innerHTML = `
    <a class="skip-link" href="#page-root">Lompat ke konten utama</a>

    <div class="app-shell">
      <aside class="sidebar${railed ? " rail" : ""}" id="sidebar" aria-label="Menu utama">
        <div class="sidebar-head">
          <span class="brand-mark">
            <span class="brand-grid" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
            <span>
              <strong>${esc(BRAND_SHORT)}</strong>
              <small>${esc(site?.name || "Sistem Antrean")}</small>
            </span>
          </span>
          <button type="button" class="rail-toggle" id="rail-toggle"
                  aria-label="Ciutkan menu" aria-expanded="${!railed}">${icon("rail")}</button>
        </div>

        <nav id="side-nav" aria-label="Navigasi halaman">${navMarkup(user?.role)}</nav>

        <div class="sidebar-foot">
          <div class="sidebar-user">
            <strong>${esc(user?.display_name || "-")}</strong>
            <small class="eyebrow">${esc(user?.role || "")}</small>
          </div>
          <button type="button" class="nav-link" id="logout">${icon("logout")}<span>Keluar</span></button>
        </div>
      </aside>

      <div class="app-main">
        <header class="topbar">
          <div style="display:flex;align-items:center;gap:12px;min-width:0">
            <button type="button" class="icon-btn mobile-menu" id="mobile-menu"
                    aria-label="Buka menu" aria-controls="sidebar" aria-expanded="false">${icon("menu")}</button>
            <div class="topbar-context">
              <span class="eyebrow" id="topbar-eyebrow">${esc(PAGES[activePage]?.subtitle || "")}</span>
              <strong id="topbar-title">${esc(brand())}</strong>
            </div>
          </div>

          <div class="topbar-actions">
            <span class="data-mode" id="sync-pill"><i></i><span>Menyiapkan…</span></span>
            <span class="live-clock" id="live-clock"></span>
            <button type="button" class="icon-btn" id="theme-toggle" aria-label="Ganti tema">
              ${icon(themeIconName())}
            </button>
          </div>
        </header>

        <main class="workspace" id="page-root" tabindex="-1" aria-busy="true">
          <div class="app-boot" role="status">
            <span class="spinner" aria-hidden="true"></span>
            <p>Menyiapkan papan antrean…</p>
          </div>
        </main>
      </div>
    </div>

    <div class="toast-stack" id="toast-stack" role="status" aria-live="polite"></div>`;

  bindShell();
  renderPage();
}

function bindShell() {
  document.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.page));
  });

  document.getElementById("logout")?.addEventListener("click", () => {
    api.logout();
    signOut();
  });

  document.getElementById("theme-toggle")?.addEventListener("click", (event) => {
    cycleTheme();
    applyTheme();
    event.currentTarget.innerHTML = icon(themeIconName());
  });

  document.getElementById("rail-toggle")?.addEventListener("click", (event) => {
    const sidebar = document.getElementById("sidebar");
    const railed = sidebar.classList.toggle("rail");
    localStorage.setItem(STORAGE.rail, railed ? "1" : "0");
    event.currentTarget.setAttribute("aria-expanded", String(!railed));
  });

  document.getElementById("mobile-menu")?.addEventListener("click", (event) => {
    const sidebar = document.getElementById("sidebar");
    const open = sidebar.classList.toggle("mobile-open");
    event.currentTarget.setAttribute("aria-expanded", String(open));
    if (open) {
      const backdrop = document.createElement("button");
      backdrop.className = "nav-backdrop";
      backdrop.id = "nav-backdrop";
      backdrop.setAttribute("aria-label", "Tutup menu");
      backdrop.addEventListener("click", closeMobileNav);
      document.body.append(backdrop);
    } else {
      closeMobileNav();
    }
  });
}

function closeMobileNav() {
  document.getElementById("sidebar")?.classList.remove("mobile-open");
  document.getElementById("mobile-menu")?.setAttribute("aria-expanded", "false");
  document.getElementById("nav-backdrop")?.remove();
}

/* --------------------------------------------------------------------------
 * Router
 * ----------------------------------------------------------------------- */
function navigate(page) {
  const user = api.getUser();
  if (!PAGES[page] || !canAccess(page, user?.role)) {
    toast("Halaman tersebut tidak tersedia untuk peran Anda.", "error");
    return;
  }
  activePage = page;
  closeMobileNav();
  document.querySelectorAll("[data-page]").forEach((button) => {
    const active = button.dataset.page === page;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.getElementById("topbar-eyebrow").textContent = PAGES[page].subtitle;
  renderPage();
  document.getElementById("page-root")?.focus();
}

function renderPage() {
  const root = document.getElementById("page-root");
  if (!root) return;
  PAGES[activePage].render(root);
  // Konten sudah tergambar; pembaca layar tidak perlu lagi diberi tahu bahwa
  // halaman sedang memuat.
  root.setAttribute("aria-busy", "false");
}

/* --------------------------------------------------------------------------
 * Indikator sinkronisasi
 * ----------------------------------------------------------------------- */
const SYNC_LABEL = {
  idle: ["", "Menyiapkan…"],
  online: ["", "Tersambung"],
  pending: ["paused", "Mencoba ulang"],
  offline: ["offline", "Terputus"],
};

/**
 * Pil status menggabungkan DUA rantai yang berbeda:
 *
 *   1. Supabase → browser   (polling papan, tiap 15 detik)
 *   2. Superset → Supabase  (cron master PO PGS 160, tiap 5 menit)
 *
 * Rantai kedua yang dulu tidak terlihat sama sekali. Bila cron mati atau cookie
 * Superset kedaluwarsa, papan tetap tampak "Tersambung" karena tiket masih
 * mengalir, sementara master PO membeku — dan pendaftaran mulai menolak PO yang
 * jelas-jelas ada. Sumber yang basi karena itu mengalahkan status koneksi.
 */
function updateSyncPill() {
  const pill = document.getElementById("sync-pill");
  if (!pill) return;

  const [tone, label] = SYNC_LABEL[store.state.connection] || SYNC_LABEL.idle;
  const synced = store.state.lastSync ? ` · ${formatTime(store.state.lastSync)}` : "";
  const source = store.state.source;

  if (store.state.connection === "online" && store.sourceIsStale(source)) {
    pill.querySelector("i").className = "paused";
    pill.querySelector("span").textContent =
      `Sumber ${source.location_id || "PGS"} basi · ${formatDuration(source.age_seconds)}`;
    pill.title =
      `Master PO terakhir tersinkron ${formatDuration(source.age_seconds)} lalu. ` +
      `Cron Superset seharusnya berjalan tiap 5 menit.`;
    return;
  }

  pill.querySelector("i").className = tone;
  pill.querySelector("span").textContent = `${label}${synced}`;
  pill.title = source?.last_synced_at
    ? `Master PO ${source.site_code || ""} ${source.location_id || ""}: ${source.total_po ?? 0} PO, ` +
      `sync ${formatDuration(source.age_seconds)} lalu.`
    : "";
}

/* --------------------------------------------------------------------------
 * Sesi
 * ----------------------------------------------------------------------- */
function signOut() {
  store.stopPolling();
  renderLogin();
}

globalThis.addEventListener("inbound:signed-out", signOut);
globalThis.addEventListener("inbound:site-changed", () => {
  document.getElementById("topbar-title").textContent = brand();
  renderPage();
});

/* --------------------------------------------------------------------------
 * Bootstrap
 * ----------------------------------------------------------------------- */
function boot() {
  applyTheme();

  if (!api.isLoggedIn()) {
    renderLogin();
    return;
  }

  renderShell();

  store.subscribe(() => {
    updateSyncPill();
    updateWaitingBadge();
    // Halaman yang menampilkan data papan digambar ulang saat snapshot baru
    // tiba. Halaman formulir tidak, supaya isian operator tidak hilang.
    if (activePage === "board") renderPage();
  });

  store.refresh();
  store.startPolling();
  store.bindVisibilityRefresh();

  startTicker();
  bindVisibility();
  onTick(() => {
    const clock = document.getElementById("live-clock");
    if (clock) clock.textContent = new Date().toLocaleTimeString("id-ID");
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
