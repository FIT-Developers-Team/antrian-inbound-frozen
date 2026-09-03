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
import * as analyticsPage from "./pages/analytics.js";
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
  analytics: {
    label: "Analitik",
    icon: "chart",
    subtitle: "Lead time & SLA",
    render: analyticsPage.render,
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
      <!-- Nama aplikasi adalah judul tingkat satu halaman ini, dan ia muncul
           lebih dulu di dokumen. Sebelumnya urutannya terbalik — <h2> di sini
           dan <h1> di formulir — sehingga pembaca layar menemui tingkat dua
           sebelum tingkat satu. -->
      <h1>${esc(BRAND_SHORT)}</h1>
      <p>Antrean inbound gudang beku: satu papan untuk kedatangan, bongkar, dan hitung mundur SLA.</p>
    </section>

    <section class="login-panel">
      <form class="login-form" id="login-form">
        <img src="assets/login-logo.png" alt="" aria-hidden="true" />
        <div>
          <span class="eyebrow">Masuk</span>
          <h2>Selamat datang</h2>
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
      // Sesi hidup dinyalakan DI SINI, bukan hanya di boot().
      //
      // Sebelumnya baris ini hanya `store.refresh()`, dan akibatnya cukup parah:
      // operator yang baru saja masuk mendapat papan yang tidak pernah hidup.
      // Tidak ada pelanggan state, jadi snapshot yang tiba tidak pernah
      // digambar; tidak ada polling, jadi tiket baru tidak pernah muncul; tidak
      // ada ticker, jadi hitung mundur SLA tidak pernah berdetak. Layarnya diam
      // di "Memuat antrean…" sampai halaman dimuat ulang dengan tangan — dan
      // tombol "Muat ulang" pun tidak menolong, karena yang hilang justru
      // pelanggan yang seharusnya menggambar hasilnya.
      //
      // boot() menyalakan semuanya dengan benar, tetapi boot() hanya melewati
      // jalur itu ketika sesi SUDAH ada saat halaman dibuka. Login pertama
      // melewatkan seluruhnya.
      startLiveSession();
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
      // `aria-label` bukan pengulangan yang mubazir. Di bilah bawah pada layar
      // sangat sempit, label teksnya `display: none` — dan simpul yang
      // disembunyikan begitu ikut hilang dari pohon aksesibilitas, sementara
      // ikonnya sendiri `aria-hidden`. Tanpa baris ini kelima tombol navigasi
      // dibacakan sebagai "tombol" tanpa nama sama sekali.
      return `<button type="button" class="nav-link${key === activePage ? " active" : ""}"
        data-page="${key}" aria-label="${esc(page.label)}"${key === activePage ? ' aria-current="page"' : ""}>
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
          <div class="topbar-lead">
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
  document.querySelectorAll("[data-page]").forEach((button) => {
    const active = button.dataset.page === page;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.getElementById("topbar-eyebrow").textContent = PAGES[page].subtitle;
  renderPage();

  // Fokus dipindahkan TANPA menggulir, lalu halaman digulir ke puncaknya
  // sendiri.
  //
  // `focus()` polos menggulir elemennya ke dalam pandangan, dan browser
  // menganggap "dalam pandangan" berarti tepi atas viewport — yang di aplikasi
  // ini tertutup topbar setinggi 72 piksel. Hasilnya halaman berhenti pada
  // scrollY 72: eyebrow halaman hilang seluruhnya di balik topbar dan judulnya
  // terpotong separuh, pada setiap perpindahan menu. Halaman baru juga memang
  // seharusnya dimulai dari atas, bukan dari posisi gulir halaman sebelumnya.
  document.getElementById("page-root")?.focus({ preventScroll: true });
  globalThis.scrollTo({ top: 0, behavior: "instant" });
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
/**
 * Pil status menggabungkan TIGA rantai yang berbeda, dan ketiganya pernah
 * tertukar satu sama lain:
 *
 *   1. Postgres -> browser   Saluran langsung (SSE), puluhan milidetik.
 *   2. Superset -> Postgres  Penjadwal master PO PGS 160, tiap 5 menit.
 *   3. Jam tablet vs server  Selisih jam yang menentukan benar-tidaknya jam
 *                            kedatangan yang diketik operator.
 *
 * Rantai kedua yang dulu tidak terlihat sama sekali: bila penjadwal mati atau
 * cookie Superset kedaluwarsa, papan tetap tampak "Tersambung" karena tiket
 * masih mengalir, sementara master PO membeku — dan pendaftaran mulai menolak
 * PO yang jelas-jelas ada. Sumber yang basi karena itu mengalahkan status
 * koneksi.
 *
 * Yang ditampilkan sebagai waktu adalah PERUBAHAN TERAKHIR, bukan pemeriksaan
 * terakhir. Versi sebelumnya menampilkan jam pemeriksaan, yang berubah tiap
 * lima belas detik — sehingga papan yang membeku sejak pagi tetap terlihat
 * seolah baru saja diperbarui.
 */
const LIVE_LABEL = {
  live: ["live", "Langsung"],
  reconnecting: ["paused", "Menyambung ulang"],
  polling: ["", "Berkala"],
};

function syncPillState() {
  const { connection, live, source, lastChange, clockSkewSeconds } = store.state;

  if (connection === "offline") return { tone: "offline", label: "Terputus", title: "Papan tidak dapat menghubungi server." };
  if (connection === "idle") return { tone: "", label: "Menyiapkan…", title: "" };

  // Jam tablet yang meleset jauh membuat setiap jam kedatangan hari itu salah.
  // Itu cacat data, bukan sekadar tampilan, jadi ia mengalahkan yang lain.
  if (Math.abs(clockSkewSeconds) > 120) {
    const minutes = Math.round(Math.abs(clockSkewSeconds) / 60);
    return {
      tone: "offline",
      label: `Jam tablet meleset ${minutes} menit`,
      title:
        `Jam perangkat ini ${clockSkewSeconds > 0 ? "mendahului" : "tertinggal"} jam server ` +
        `sekitar ${minutes} menit. Jam kedatangan yang diketik di sini akan ikut salah. ` +
        `Perbaiki jam perangkat, lalu muat ulang.`,
    };
  }

  if (store.sourceIsStale(source)) {
    return {
      tone: "paused",
      label: `Sumber ${source.location_id || "PGS"} basi · ${formatDuration(source.age_seconds)}`,
      title:
        `Master PO terakhir tersinkron ${formatDuration(source.age_seconds)} lalu. ` +
        `Sinkronisasi Superset seharusnya berjalan tiap 5 menit.`,
    };
  }

  const [tone, label] = LIVE_LABEL[live] || LIVE_LABEL.polling;
  const since = lastChange ? ` · ${formatTime(lastChange)}` : "";
  const sourceNote = source?.last_synced_at
    ? ` Master PO ${source.site_code || ""}: ${source.total_po ?? 0} PO, sync ${formatDuration(source.age_seconds)} lalu.`
    : "";

  return {
    tone,
    label: `${label}${since}`,
    title:
      (live === "live"
        ? "Perubahan diterima langsung dari server, tanpa menunggu siklus."
        : live === "reconnecting"
          ? "Saluran langsung terputus; papan sementara ditarik berkala."
          : "Saluran langsung tidak tersedia; papan ditarik berkala tiap 15 detik.") +
      (lastChange ? ` Perubahan terakhir ${formatTime(lastChange)}.` : "") +
      sourceNote,
  };
}

function updateSyncPill() {
  const pill = document.getElementById("sync-pill");
  if (!pill) return;
  const { tone, label, title } = syncPillState();
  pill.querySelector("i").className = tone;
  pill.querySelector("span").textContent = label;
  pill.title = title;
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
  const title = document.getElementById("topbar-title");
  if (title) title.textContent = brand();
  renderPage();
});

/* --------------------------------------------------------------------------
 * Bootstrap
 * ----------------------------------------------------------------------- */
/**
 * Menyalakan segala yang membuat papan hidup: pelanggan state, polling,
 * ticker SLA, dan jam dinding.
 *
 * Dipanggil dari DUA tempat — saat halaman dibuka dengan sesi yang sudah ada,
 * dan tepat setelah login berhasil. Keduanya wajib, dan sebelumnya hanya yang
 * pertama yang melakukannya.
 */
let liveSessionBound = false;

function startLiveSession() {
  // Polling dan ticker selalu dinyalakan ulang: keduanya dimatikan saat keluar,
  // dan operator berikutnya di tablet yang sama harus mendapat papan yang hidup
  // tanpa perlu memuat ulang halaman.
  store.refresh();
  store.startPolling();
  startTicker();

  // Sisanya memasang pendengar global, dan itu hanya boleh sekali. Memasangnya
  // ulang pada setiap login menumpuk pelanggan: dua kali masuk berarti setiap
  // snapshot menggambar papan dua kali, tiga kali masuk tiga kali, dan
  // seterusnya sampai tabletnya tersendat.
  if (liveSessionBound) return;
  liveSessionBound = true;

  store.subscribe((_state, detail = {}) => {
    // Pil status dan lencana selalu diperbarui: keduanya menyentuh dua simpul
    // teks dan tidak mengganggu apa pun yang sedang dikerjakan operator.
    updateSyncPill();
    updateWaitingBadge();

    // Papan hanya digambar ulang bila snapshotnya benar-benar berbeda.
    //
    // Sebelumnya ia dibangun ulang tiap lima belas detik tanpa syarat. Di gudang
    // yang sepi itu berarti membuang dan membangun kembali seluruh daftar kartu
    // empat kali per menit tanpa satu pun piksel yang berubah — dan setiap kali
    // itu terjadi, kursor operator yang sedang mengetik di kotak pencarian
    // terlempar keluar. Hitung mundur SLA tidak bergantung pada render ini; ia
    // diperbarui di tempat oleh ticker satu detik.
    if (activePage === "board" && detail.dataChanged !== false) renderPage();
  });

  store.bindVisibilityRefresh();
  bindVisibility();
  onTick(() => {
    const clock = document.getElementById("live-clock");
    if (clock) clock.textContent = new Date().toLocaleTimeString("id-ID");
  });
}

function boot() {
  applyTheme();

  if (!api.isLoggedIn()) {
    renderLogin();
    return;
  }

  renderShell();
  startLiveSession();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
