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
import { badge, chip, icon, pageHeader, section, toast, withBusy } from "../ui.js";
import { currentTheme, setTheme } from "../theme.js";

/**
 * Kesegaran rantai Superset → Postgres, dipisahkan dari status koneksi papan.
 * Keduanya sering disamakan, padahal papan yang "live" sama sekali tidak
 * menjamin master PO masih mengalir dari sumbernya.
 */
/**
 * Rantai Superset → Postgres, dipisahkan dari status koneksi papan.
 *
 * Keduanya sering disamakan, padahal papan yang "live" sama sekali tidak
 * menjamin master PO masih mengalir dari sumbernya.
 *
 * Bagian ini juga tempat kegagalan tersering ditangani: cookie Superset
 * berumur terbatas dan harus diganti manual. Sebelumnya kegagalan itu tercatat
 * sebagai "Superset menjawab HTTP 401" — kalimat yang benar dan tidak memberi
 * tahu siapa pun apa yang harus dilakukan.
 */
function sourceSection() {
  const source = store.state.source;
  const stale = store.sourceIsStale(source);
  const status = String(source?.last_run_status || "").toUpperCase();
  const cookieExpired = status === "COOKIE_EXPIRED";

  const action = `<button type="button" class="btn btn-sm" id="sync-now">
      ${icon("refresh", 15)} Sync sekarang
    </button>`;

  if (!source?.last_synced_at) {
    return section({
      eyebrow: "Sumber data",
      title: "Master PO Superset",
      action,
      body: `<p class="section-note">Belum ada catatan sinkronisasi. Tekan <strong>Sync sekarang</strong>
        untuk mencobanya, atau jalankan <code>npm run doctor</code> untuk memeriksa penjadwal dan cookie.</p>
        <p class="sync-result" id="sync-result" hidden></p>`,
    });
  }

  return section({
    eyebrow: "Sumber data",
    title: "Master PO Superset",
    action,
    body: `${
      cookieExpired
        ? `<div class="banner banner-warn" role="alert">
             <strong>${icon("alert", 18)} Cookie Superset kedaluwarsa</strong>
             <p>Master PO berhenti diperbarui. Cookie sesi Superset berumur terbatas dan harus diganti manual.</p>
             <ol class="steps">
               <li>Masuk ke Superset di browser.</li>
               <li>Buka DevTools → Application → Cookies, salin nilai cookie <code>session</code>.</li>
               <li>Tempel ke <code>SUPERSET_SESSION_COOKIE</code> di setelan lingkungan, lalu deploy ulang.</li>
               <li>Kembali ke sini dan tekan <strong>Sync sekarang</strong> untuk memastikan.</li>
             </ol>
           </div>`
        : ""
    }
      <div class="form-grid">
        <div class="fact"><span>Status</span><strong>${badge(
          cookieExpired ? "Cookie mati" : stale ? "Basi" : status === "FAILED" ? "Sync gagal" : "Segar",
          cookieExpired || stale || status === "FAILED" ? "critical" : "normal",
        )}</strong></div>
        <div class="fact"><span>Total PO</span><strong class="mono">${esc(source.total_po ?? 0)}</strong></div>
        <div class="fact"><span>Sync terakhir</span><strong class="mono">${esc(formatDuration(source.age_seconds))} lalu</strong></div>
        <div class="fact"><span>Location ID</span><strong class="mono">${esc(source.location_id || "-")}</strong></div>
      </div>
      ${
        source.last_run_error && !cookieExpired
          ? `<p class="field-error" style="margin-top:12px">${esc(source.last_run_error)}</p>`
          : ""
      }
      <p class="section-note">
        Penjadwal di dalam proses API menarik ulang master PO tiap lima menit.
        ${
          stale && !cookieExpired
            ? "Sumber sudah lewat lima belas menit — tekan Sync sekarang untuk melihat penyebabnya."
            : "Papan antrean sendiri menerima perubahan seketika lewat saluran langsung."
        }
      </p>
      <p class="sync-result" id="sync-result" hidden></p>`,
  });
}

/**
 * Panel pembaruan data: satu tempat untuk memaksa tarik ulang.
 *
 * Dipisahkan dari sumber data karena keduanya rantai yang berbeda — yang satu
 * Postgres ke browser, yang lain Superset ke Postgres — dan menyatukannya
 * adalah persis kekeliruan yang membuat orang mengira papan yang "live"
 * menjamin master PO ikut segar.
 */
function refreshSection() {
  const { live, lastChange, lastSync } = store.state;
  const mode =
    live === "live"
      ? ["Langsung", "normal", "Perubahan tiba seketika lewat saluran server; papan tidak menunggu siklus."]
      : live === "reconnecting"
        ? ["Menyambung ulang", "critical", "Saluran langsung terputus. Papan sementara ditarik tiap 15 detik."]
        : ["Berkala", "muted", "Saluran langsung tidak tersedia. Papan ditarik tiap 15 detik."];

  return section({
    eyebrow: "Pembaruan",
    title: "Sinkronisasi papan",
    action: `<button type="button" class="btn btn-sm" id="force-refresh">${icon("refresh", 15)} Tarik ulang</button>`,
    body: `<div class="form-grid">
        <div class="fact"><span>Mode</span><strong>${badge(mode[0], mode[1])}</strong></div>
        <div class="fact"><span>Perubahan terakhir</span><strong class="mono">${esc(
          lastChange ? formatFull(lastChange) : "belum ada",
        )}</strong></div>
        <div class="fact"><span>Diperiksa terakhir</span><strong class="mono">${esc(
          lastSync ? formatFull(lastSync) : "belum pernah",
        )}</strong></div>
        <div class="fact"><span>Tiket dimuat</span><strong class="mono">${esc(store.state.rows.length)}</strong></div>
      </div>
      <p class="section-note">${esc(mode[2])} <strong>Tarik ulang</strong> mengabaikan cache dan
        mengambil ulang dari server — pakai bila layar terasa tidak sesuai kenyataan di lapangan.</p>`,
  });
}

/**
 * Kolom cookie sinkronisasi.
 *
 * Hanya untuk ADMIN dan DEVELOPER: memicu penarikan ulang tidak sama dengan
 * memegang kredensial ke sistem lain.
 *
 * Nilainya TIDAK PERNAH dimuat ke dalam kotak. Kotaknya selalu kosong, dan yang
 * ditampilkan di sebelahnya adalah bentuk cookie yang tersimpan — panjang,
 * sidik jari pendek, siapa yang terakhir mengubahnya. Itu cukup untuk
 * memastikan dua orang sedang membicarakan cookie yang sama tanpa satu pun dari
 * mereka melihatnya, dan menghindarkan rahasia itu dari riwayat browser,
 * autofill, dan tangkapan layar.
 */
function cookieSection(user) {
  const role = String(user?.role || "").toUpperCase();
  if (!["ADMIN", "DEVELOPER"].includes(role)) return "";

  const status = settingsStatus?.superset_cookie;
  const present = Boolean(status?.present);

  return section({
    eyebrow: "Kredensial",
    title: "Cookie sesi Superset",
    action: present
      ? badge(`${status.length} karakter · ${status.fingerprint}`, "normal")
      : badge("Belum diisi", "critical"),
    body: `<div class="dashboard-page">
      <p class="section-note">
        Cookie Superset kedaluwarsa berkala. Mengisinya di sini berlaku pada siklus
        sinkronisasi berikutnya — tanpa deploy ulang, tanpa master PO yang membeku
        beberapa menit sambil menunggu.
      </p>

      <label>
        <span>Nilai cookie <code>session</code></span>
        <input class="input mono" id="cookie-input" type="password" autocomplete="off"
               spellcheck="false" placeholder="${present ? "Isi untuk mengganti yang tersimpan" : "Tempel nilai cookie di sini"}" />
        <small>
          Buka Superset → DevTools → Application → Cookies, salin nilai cookie <code>session</code>.
          Boleh ditempel dengan atau tanpa awalan <code>session=</code>.
        </small>
      </label>

      <div class="table-actions">
        <button type="button" class="btn btn-primary" id="cookie-save">${icon("check", 16)} Simpan cookie</button>
        ${present ? `<button type="button" class="btn btn-ghost" id="cookie-clear">Hapus</button>` : ""}
      </div>

      ${
        present
          ? `<p class="section-note">Terakhir diubah ${esc(formatFull(status.updated_at))}${
              status.updated_by ? ` oleh ${esc(status.updated_by)}` : ""
            }.</p>`
          : ""
      }

      <p class="sync-result" id="cookie-result" hidden></p>

      <div class="banner banner-warn">
        <strong>${icon("alert", 16)} Tersimpan di database</strong>
        <p>
          Berbeda dari variabel lingkungan, nilai ini ikut tersimpan di Postgres dan ikut
          ter-backup. Nilainya tidak pernah dikirim kembali ke layar mana pun, tetapi siapa
          pun yang punya akses baca ke database dapat melihatnya. Bila itu tidak dapat
          diterima, kosongkan kolom ini dan tetap pakai <code>SUPERSET_SESSION_COOKIE</code>.
        </p>
      </div>
    </div>`,
  });
}

/** Bentuk setelan, dimuat sekali per kunjungan halaman. */
let settingsStatus = null;

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
                  <td class="cell-wrap">${esc(fleet.note)}${
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

        ${cookieSection(user)}

        ${refreshSection()}

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

  // Bentuk setelan dimuat sekali per kunjungan. Peran yang tidak berhak tidak
  // pernah meminta endpoint-nya sama sekali.
  const role = String(user?.role || "").toUpperCase();
  if (settingsStatus === null && ["ADMIN", "DEVELOPER"].includes(role)) {
    settingsStatus = {};
    api
      .fetchSettingsStatus()
      .then((status) => {
        settingsStatus = status;
        render(root);
      })
      .catch(() => {
        settingsStatus = {};
      });
  }

  const showCookieResult = (text, isError) => {
    const slot = root.querySelector("#cookie-result");
    if (!slot) return;
    slot.textContent = text;
    slot.className = isError ? "sync-result is-error" : "sync-result";
    slot.hidden = false;
  };

  const saveCookie = async (value, event) =>
    withBusy(event.currentTarget, async () => {
      try {
        const result = await api.setSyncCookie(value);
        settingsStatus = { superset_cookie: result.status };
        // Menyimpan cookie baru hampir selalu diikuti keinginan untuk tahu
        // apakah ia benar. Sinkronisasi langsung dicoba, jadi jawabannya datang
        // sekarang alih-alih pada siklus lima menit berikutnya.
        const sync = value ? await api.syncNow().catch((error) => ({ error: error.message })) : null;
        render(root);
        if (!value) return showCookieResult("Cookie dihapus; sinkronisasi kembali memakai variabel lingkungan.", false);
        if (sync?.error) return showCookieResult(`Cookie tersimpan, tetapi sinkronisasi gagal: ${sync.error}`, true);
        if (sync?.skipped) return showCookieResult(`Cookie tersimpan. ${sync.message}`, false);
        showCookieResult(`Cookie tersimpan dan diuji: ${sync?.written ?? 0} PO tersinkron.`, false);
      } catch (error) {
        showCookieResult(error.message, true);
        toast(error.message, "error");
      }
    });

  root.querySelector("#cookie-save")?.addEventListener("click", (event) => {
    const value = root.querySelector("#cookie-input")?.value?.trim() || "";
    if (!value) {
      showCookieResult("Isi nilai cookie terlebih dahulu.", true);
      return undefined;
    }
    return saveCookie(value, event);
  });

  root.querySelector("#cookie-clear")?.addEventListener("click", (event) => saveCookie("", event));

  root.querySelector("#force-refresh")?.addEventListener("click", (event) =>
    withBusy(event.currentTarget, async () => {
      await store.forceRefresh();
      toast("Papan ditarik ulang dari server.");
      render(root);
    }),
  );

  root.querySelector("#sync-now")?.addEventListener("click", (event) =>
    withBusy(event.currentTarget, async () => {
      const slot = root.querySelector("#sync-result");
      try {
        const result = await api.syncNow();
        // Sync yang dilewati bukan kegagalan; ia punya pesannya sendiri.
        const text = result?.skipped
          ? result.message
          : `${result?.written ?? 0} PO tersimpan dari ${result?.fetched ?? 0} baris.`;
        if (slot) {
          slot.textContent = text;
          slot.className = "sync-result";
          slot.hidden = false;
        }
        toast(result?.skipped ? result.message : "Master PO diperbarui.");
        await store.forceRefresh();
        render(root);
      } catch (error) {
        if (slot) {
          slot.textContent = error.message;
          slot.className = "sync-result is-error";
          slot.hidden = false;
        }
        toast(error.message, "error");
      }
    }),
  );

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
