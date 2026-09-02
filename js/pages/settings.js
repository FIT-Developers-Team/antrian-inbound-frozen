/* ==========================================================================
 * PENGATURAN
 *
 * Gudang aktif, tema, dan tabel acuan SLA. Tabel SLA di sini bersifat baca
 * saja dengan sengaja: aturannya hidup di Postgres
 * (`public.inbound_sla_target_hours`), dan menjadikannya dapat disunting dari
 * browser akan mengembalikan persoalan lama, yaitu dua sumber kebenaran.
 * ========================================================================== */

import * as api from "../api.js";
import * as store from "../store.js";
import {
  FLEET_TYPES,
  SKU_TIERED_FLEETS,
  activeSites,
  currentSite,
  setCurrentSite,
} from "../config.js";
import { esc, formatDuration, formatFull } from "../format.js";
import { badge, chip, icon, pageHeader, section, toast } from "../ui.js";
import { currentTheme, setTheme } from "../theme.js";

/**
 * Kesegaran rantai Superset → Postgres, dipisahkan dari status koneksi papan.
 * Keduanya sering disamakan, padahal papan yang "live" sama sekali tidak
 * menjamin master PO masih mengalir dari sumbernya.
 */
function sourceSection() {
  const source = store.state.source;
  const stale = store.sourceIsStale(source);

  if (!source?.last_synced_at) {
    return section({
      eyebrow: "Sumber data",
      title: "Master PO Superset",
      body: `<p class="section-note">Belum ada catatan sinkronisasi. Jalankan <code>npm run doctor</code> untuk memeriksa penjadwal dan cookie Superset.</p>`,
    });
  }

  const runFailed = String(source.last_run_status || "").toUpperCase() === "FAILED";

  return section({
    eyebrow: "Sumber data",
    title: "Master PO Superset",
    action: badge(
      stale ? "Basi" : runFailed ? "Sync gagal" : "Segar",
      stale || runFailed ? "critical" : "normal",
    ),
    body: `<div class="form-grid">
        <div class="fact"><span>Location ID</span><strong class="mono">${esc(source.location_id || "-")}</strong></div>
        <div class="fact"><span>Gudang</span><strong>${esc(source.site_code || "-")}</strong></div>
        <div class="fact"><span>Total PO</span><strong class="mono">${esc(source.total_po ?? 0)}</strong></div>
        <div class="fact"><span>Sync terakhir</span><strong class="mono">${esc(formatDuration(source.age_seconds))} lalu</strong></div>
      </div>
      ${
        source.last_run_error
          ? `<p class="field-error" style="margin-top:12px">${esc(source.last_run_error)}</p>`
          : ""
      }
      <p class="section-note">
        Penjadwal di dalam proses API menarik ulang master PO tiap lima menit.
        ${
          stale
            ? "Sumber sudah lewat lima belas menit — periksa log kontainer dan masa berlaku <code>SUPERSET_SESSION_COOKIE</code>."
            : "Papan antrean sendiri menarik ulang tiap lima belas detik."
        }
      </p>`,
  });
}

export function render(root) {
  const site = currentSite();
  const user = api.getUser();
  const sites = activeSites();

  root.innerHTML = `<div class="dashboard-page">
    ${pageHeader({
      scope: site?.code,
      eyebrow: "Preferensi",
      title: "Pengaturan",
      description: "Gudang yang sedang dipantau, tampilan, dan acuan target SLA.",
    })}

    <div class="dashboard-grid dashboard-grid-main">
      <div class="dashboard-page">
        ${section({
          eyebrow: "Acuan",
          title: "Target SLA bongkar",
          body: `<div class="table-scroll">
            <table class="tbl">
              <thead><tr><th>Armada</th><th>Target</th><th>Catatan</th></tr></thead>
              <tbody>${FLEET_TYPES.map(
                (fleet) => `<tr>
                  <td><strong>${esc(fleet.label)}</strong></td>
                  <td class="numeric">${esc(fleet.slaHours)} jam</td>
                  <td>${esc(fleet.note)}${
                    SKU_TIERED_FLEETS.includes(fleet.value)
                      ? ' <span class="chip">2 jam sampai 40 SKU, 4 jam di atas 40</span>'
                      : ""
                  }</td>
                </tr>`,
              ).join("")}</tbody>
            </table>
          </div>
          <p class="section-note">
            Angka ini dihitung dan ditegakkan oleh Postgres. Browser hanya menghitung selisih waktu
            terhadap tenggat yang dikirim server, sehingga angka di layar, di Google Sheet, dan di
            laporan selalu sama.
          </p>`,
          flush: false,
        })}
      </div>

      <div class="dashboard-page">
        ${section({
          eyebrow: "Lokasi",
          title: "Gudang aktif",
          body:
            sites.length > 1
              ? `<label>
                   <span>Gudang dipantau</span>
                   <select class="input" id="site-select">
                     ${sites
                       .map(
                         (item) =>
                           `<option value="${esc(item.code)}"${item.code === site?.code ? " selected" : ""}>
                              ${esc(item.name)} (${esc(item.code)})
                            </option>`,
                       )
                       .join("")}
                   </select>
                 </label>`
              : `<p>Gudang aktif: <strong>${esc(site?.name || "-")}</strong> ${chip(site?.code || "-")}</p>
                 <p class="section-note">
                   Gudang lain diaktifkan dari database (<code>site_master.active</code>), tanpa deploy ulang.
                 </p>`,
        })}

        ${sourceSection()}

        ${section({
          eyebrow: "Tampilan",
          title: "Tema",
          body: `<div class="table-actions">
            ${["light", "dark", "system"]
              .map(
                (mode) =>
                  `<button type="button" class="btn${currentTheme() === mode ? " btn-primary" : ""}" data-theme="${mode}">
                     ${mode === "light" ? icon("sun", 16) : mode === "dark" ? icon("moon", 16) : ""}
                     ${mode === "light" ? "Terang" : mode === "dark" ? "Gelap" : "Ikut sistem"}
                   </button>`,
              )
              .join("")}
          </div>`,
        })}

        ${section({
          eyebrow: "Sesi",
          title: "Akun",
          body: `<div class="dashboard-page">
            <div class="form-grid">
              <div class="fact"><span>Pengguna</span><strong>${esc(user?.display_name || "-")}</strong></div>
              <div class="fact"><span>Peran</span><strong>${badge(user?.role || "-", "accent")}</strong></div>
            </div>
            <p class="section-note">
              Sinkronisasi terakhir: ${esc(store.state.lastSync ? formatFull(store.state.lastSync) : "belum pernah")}
              · ${esc(store.state.rows.length)} tiket dimuat.
            </p>
            <button type="button" class="btn btn-danger btn-block" id="logout">${icon("logout", 16)} Keluar</button>
          </div>`,
        })}
      </div>
    </div>
  </div>`;

  root.querySelector("#site-select")?.addEventListener("change", async (event) => {
    setCurrentSite(event.target.value);
    api.clearEtagCache();
    // Snapshot dan master PO gudang lama dibuang, bukan sekadar ditimpa:
    // keduanya dikunci pada gudang dan menyisakannya membuat layar pendaftaran
    // menyarankan PO milik gudang yang tidak lagi dipantau.
    store.resetSnapshot();
    await store.refresh();
    toast(`Beralih ke gudang ${event.target.value}.`);
    globalThis.dispatchEvent(new CustomEvent("inbound:site-changed"));
  });

  root.querySelectorAll("[data-theme]").forEach((button) => {
    button.addEventListener("click", () => {
      setTheme(button.dataset.theme);
      render(root);
    });
  });

  root.querySelector("#logout")?.addEventListener("click", () => {
    api.logout();
    globalThis.dispatchEvent(new CustomEvent("inbound:signed-out"));
  });
}
