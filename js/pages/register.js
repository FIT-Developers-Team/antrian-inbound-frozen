/* ==========================================================================
 * PENDAFTARAN KEDATANGAN (SECURITY)
 *
 * Formulir satu layar untuk pos masuk. Urutan isiannya mengikuti urutan yang
 * benar-benar terjadi di lapangan: truk tiba (jam), apa kendaraannya (armada +
 * plat), milik siapa (vendor + PO), siapa yang bawa (driver).
 * ========================================================================== */

import * as api from "../api.js";
import * as store from "../store.js";
import { DEFAULT_FLEET, FLEET_TYPES, currentSite } from "../config.js";
import { esc, isValidPlate, normalizePlate, toLocalInputValue } from "../format.js";
import { chip, debounce, emptyState, icon, pageHeader, section, toast, withBusy } from "../ui.js";

/** Isian yang bertahan antar render, sehingga daftar PO tidak hilang saat mengetik. */
const form = {
  arrivedAt: "",
  fleet: DEFAULT_FLEET,
  plate: { prefix: "", number: "", suffix: "" },
  vendor: "",
  driverName: "",
  driverPhone: "",
  ticketType: "REG",
  pos: [],
  poQuery: "",
  manualPo: "",
};

function resetForm() {
  form.arrivedAt = toLocalInputValue();
  form.fleet = DEFAULT_FLEET;
  form.plate = { prefix: "", number: "", suffix: "" };
  form.vendor = "";
  form.driverName = "";
  form.driverPhone = "";
  form.ticketType = "REG";
  form.pos = [];
  form.poQuery = "";
  form.manualPo = "";
}

/* --------------------------------------------------------------------------
 * Bagian formulir
 * ----------------------------------------------------------------------- */
function fleetPicker() {
  return `<div class="fleet-grid" role="radiogroup" aria-label="Tipe armada">
    ${FLEET_TYPES.map(
      (fleet) => `<button type="button" role="radio"
        aria-checked="${form.fleet === fleet.value}"
        class="fleet-option${form.fleet === fleet.value ? " active" : ""}"
        data-fleet="${esc(fleet.value)}">
        <strong>${esc(fleet.label)}</strong>
        <small>SLA ${esc(fleet.slaHours)} jam</small>
      </button>`,
    ).join("")}
  </div>`;
}

/**
 * Plat dipecah tiga kotak karena itulah bentuk fisik plat Indonesia, dan
 * karena satu kotak bebas membuat operator mengetik "B1234XYZ", "b 1234 xyz",
 * atau "B-1234-XYZ" untuk kendaraan yang sama sehingga pencarian gagal.
 */
function plateInput() {
  const value = normalizePlate(form.plate.prefix, form.plate.number, form.plate.suffix);
  const invalid = value && !isValidPlate(value);
  return `<div class="plate-input">
      <input id="plate-prefix" inputmode="text" maxlength="2" placeholder="B"
             aria-label="Kode wilayah" value="${esc(form.plate.prefix)}"
             ${invalid ? 'aria-invalid="true"' : ""} />
      <input id="plate-number" inputmode="numeric" maxlength="4" placeholder="1234"
             aria-label="Nomor polisi" value="${esc(form.plate.number)}"
             ${invalid ? 'aria-invalid="true"' : ""} />
      <input id="plate-suffix" inputmode="text" maxlength="3" placeholder="XYZ"
             aria-label="Huruf seri" value="${esc(form.plate.suffix)}"
             ${invalid ? 'aria-invalid="true"' : ""} />
    </div>
    ${
      invalid
        ? `<span class="field-error">Format plat belum benar. Contoh: B 1234 XYZ.</span>`
        : `<span class="plate-preview" id="plate-preview">${esc(value || "— — —")}</span>`
    }`;
}

/**
 * Index pencarian PO yang sudah di-uppercase.
 *
 * Master PGS berisi puluhan ribu baris. Menulis
 * `po.po_number.toUpperCase().includes(query)` di dalam filter berarti membuat
 * puluhan ribu string baru pada SETIAP ketukan tombol, lalu membuangnya semua.
 * Bentuk huruf besarnya dihitung sekali per pemuatan master dan dipakai ulang.
 *
 * Index dibangun ulang ketika larik master berganti identitas — yang hanya
 * terjadi saat master dimuat atau gudang berpindah.
 */
let searchIndex = { source: null, entries: [] };

function poSearchIndex() {
  const master = store.state.poMaster;
  if (searchIndex.source === master) return searchIndex.entries;
  searchIndex = {
    source: master,
    entries: master.map((po) => ({
      po,
      haystack: `${po.po_number || ""} ${po.vendor_name || ""}`.toUpperCase(),
    })),
  };
  return searchIndex.entries;
}

/** Delapan saran teratas; lebih dari itu tidak muat di layar tablet. */
const MAX_SUGGESTIONS = 8;

function matchingPos() {
  const query = form.poQuery.trim().toUpperCase();
  if (!query) return [];
  const chosen = new Set(form.pos.map((po) => po.po_number));
  const found = [];
  // Perulangan manual, bukan filter().slice(): pencarian berhenti begitu delapan
  // saran terkumpul, alih-alih menelusuri seluruh master lalu membuang sisanya.
  for (const entry of poSearchIndex()) {
    if (chosen.has(entry.po.po_number)) continue;
    if (!entry.haystack.includes(query)) continue;
    found.push(entry.po);
    if (found.length >= MAX_SUGGESTIONS) break;
  }
  return found;
}

/**
 * Isi kotak saran saja.
 *
 * Dipisahkan dari poPicker() supaya mengetik hanya menulis ulang bagian ini,
 * bukan membangun ulang seluruh halaman pendaftaran — yang membuang isian yang
 * sedang diketik, menutup daftar pilihan armada, dan memindahkan fokus.
 */
function suggestionMarkup() {
  const query = form.poQuery.trim();
  const suggestions = matchingPos();

  if (suggestions.length) {
    return suggestions
      .map(
        (po) => `<button type="button" class="po-suggestion" data-add-po="${esc(po.po_number)}">
          <strong>${esc(po.po_number)}</strong>
          <small>${esc(po.vendor_name || "-")} · ${esc(po.count_sku || 0)} SKU · ${esc(po.request_quantity || 0)} qty</small>
        </button>`,
      )
      .join("");
  }
  if (!query) return "";
  if (!store.state.poMaster.length) {
    return `<p class="section-note">Master PO belum selesai dimuat. Tunggu sebentar, atau pakai PO manual.</p>`;
  }
  return `<p class="section-note">Tidak ada PO cocok di master gudang aktif. Pakai PO manual bila memang belum terbit.</p>`;
}

function poPicker() {
  return `<div class="po-picker">
    ${
      form.pos.length
        ? `<div class="po-chips">${form.pos
            .map(
              (po) => `<span class="po-chip">${esc(po.po_number)}
                ${po.is_manual ? '<em style="font-style:normal;opacity:.7">manual</em>' : ""}
                <button type="button" data-remove-po="${esc(po.po_number)}" aria-label="Hapus ${esc(po.po_number)}">&times;</button>
              </span>`,
            )
            .join("")}</div>`
        : `<p class="section-note">Belum ada PO dipilih. Minimal satu PO wajib diisi.</p>`
    }

    <label>
      <span>Cari PO</span>
      <input class="input" type="search" id="po-query" placeholder="Nomor PO atau nama vendor"
             value="${esc(form.poQuery)}" autocomplete="off" />
    </label>

    <div class="po-suggestions" id="po-suggestions">${suggestionMarkup()}</div>

    <label>
      <span>PO manual</span>
      <div style="display:flex;gap:8px">
        <input class="input" id="manual-po" placeholder="PO di luar master Superset"
               value="${esc(form.manualPo)}" autocomplete="off" />
        <button type="button" class="btn" id="add-manual-po">${icon("plus", 16)} Tambah</button>
      </div>
      <small>Dipakai hanya bila PO benar-benar belum ada di master. Ditandai "manual" pada tiket.</small>
    </label>
  </div>`;
}

/* --------------------------------------------------------------------------
 * Render
 * ----------------------------------------------------------------------- */
export function render(root) {
  if (!form.arrivedAt) resetForm();
  const site = currentSite();

  // Master PO dimuat sekali dan dibagikan; permintaan yang sedang berjalan
  // tidak digandakan. Saat ia tiba, kotak saran diperbarui di tempat — tanpa
  // itu, operator yang sudah mengetik sebelum master selesai dimuat melihat
  // "tidak ada PO cocok" sampai ia menghapus dan mengetik ulang.
  store.ensurePoMaster().then(() => {
    const slot = root.querySelector("#po-suggestions");
    if (!slot || !form.poQuery.trim()) return;
    slot.innerHTML = suggestionMarkup();
    bindSuggestions(root);
  });

  root.innerHTML = `<div class="dashboard-page">
    ${pageHeader({
      scope: site?.code,
      eyebrow: "Pos masuk",
      title: "Daftar Kedatangan",
      description:
        "Catat truk yang baru tiba. Nomor antrean dan target SLA dihitung server begitu tiket tersimpan.",
    })}

    <form id="register-form" novalidate>
      <div class="dashboard-grid dashboard-grid-main">
        <div class="dashboard-page">
          ${section({
            eyebrow: "Langkah 1",
            title: "Kedatangan & kendaraan",
            body: `<div class="form-grid">
              <label class="span-2">
                <span>Jam kedatangan</span>
                <input class="input" type="datetime-local" id="arrived-at"
                       max="${toLocalInputValue()}" value="${esc(form.arrivedAt)}" required />
                <small>Jam truk tiba di pos, bukan jam formulir ini diisi. Lama tunggu driver dihitung dari sini.</small>
              </label>

              <div class="span-2">
                <label><span>Tipe armada</span></label>
                ${fleetPicker()}
              </div>

              <div class="span-2">
                <label for="plate-prefix"><span>Plat nomor</span></label>
                ${plateInput()}
              </div>

              <label>
                <span>Tipe tiket</span>
                <select class="input" id="ticket-type">
                  <option value="REG"${form.ticketType === "REG" ? " selected" : ""}>Reguler</option>
                  <option value="DROP-OFF"${form.ticketType === "DROP-OFF" ? " selected" : ""}>Drop-Off</option>
                </select>
              </label>

              <label>
                <span>Vendor</span>
                <input class="input" id="vendor" placeholder="Nama vendor"
                       value="${esc(form.vendor)}" autocomplete="off" />
              </label>
            </div>`,
          })}

          ${section({
            eyebrow: "Langkah 3",
            title: "Driver",
            body: `<div class="form-grid">
              <label>
                <span>Nama driver</span>
                <input class="input" id="driver-name" placeholder="Nama sesuai identitas"
                       value="${esc(form.driverName)}" autocomplete="off" />
              </label>
              <label>
                <span>Nomor HP</span>
                <input class="input" id="driver-phone" inputmode="tel" placeholder="08xxxxxxxxxx"
                       value="${esc(form.driverPhone)}" autocomplete="off" />
              </label>
            </div>`,
          })}
        </div>

        <div class="dashboard-page">
          ${section({
            eyebrow: "Langkah 2",
            title: "Purchase order",
            body: poPicker(),
          })}

          ${section({
            title: "Simpan tiket",
            body: `<div class="dashboard-page">
              <p class="section-note">
                Nomor antrean, target SLA, dan tenggat dihitung di server sesuai armada dan jumlah SKU.
                Tiket langsung tampil di Papan Antrean.
              </p>
              <button type="submit" class="btn btn-primary btn-block" id="submit-ticket">
                ${icon("check", 18)} Simpan &amp; masuk antrean
              </button>
              <button type="button" class="btn btn-ghost btn-block" id="reset-form">Kosongkan formulir</button>
            </div>`,
          })}
        </div>
      </div>
    </form>
  </div>`;

  bindEvents(root);
}

/* --------------------------------------------------------------------------
 * Kejadian
 * ----------------------------------------------------------------------- */
function bindEvents(root) {
  const rerender = () => render(root);

  root.querySelectorAll("[data-fleet]").forEach((button) => {
    button.addEventListener("click", () => {
      form.fleet = button.dataset.fleet;
      rerender();
    });
  });

  // Plat: pindah fokus otomatis begitu satu kotak penuh, supaya operator tidak
  // perlu menekan Tab dengan tangan yang sedang memegang berkas.
  const plateOrder = ["plate-prefix", "plate-number", "plate-suffix"];
  plateOrder.forEach((id, index) => {
    const input = root.querySelector(`#${id}`);
    input?.addEventListener("input", (event) => {
      const key = id.replace("plate-", "");
      const raw = event.target.value.toUpperCase();
      const cleaned = key === "number" ? raw.replace(/[^0-9]/g, "") : raw.replace(/[^A-Z]/g, "");
      event.target.value = cleaned;
      form.plate[key] = cleaned;
      const preview = root.querySelector("#plate-preview");
      if (preview) {
        preview.textContent =
          normalizePlate(form.plate.prefix, form.plate.number, form.plate.suffix) || "— — —";
      }
      if (cleaned.length === event.target.maxLength && index < plateOrder.length - 1) {
        root.querySelector(`#${plateOrder[index + 1]}`)?.focus();
      }
    });
  });

  const bind = (id, key, transform = (value) => value) => {
    root.querySelector(`#${id}`)?.addEventListener("input", (event) => {
      form[key] = transform(event.target.value);
    });
  };
  bind("arrived-at", "arrivedAt");
  bind("vendor", "vendor");
  bind("driver-name", "driverName");
  bind("driver-phone", "driverPhone", (value) => value.replace(/[^\d+]/g, ""));
  bind("manual-po", "manualPo", (value) => value.toUpperCase());

  root.querySelector("#ticket-type")?.addEventListener("change", (event) => {
    form.ticketType = event.target.value;
  });

  // Mengetik hanya menulis ulang kotak saran. Halaman penuh TIDAK digambar
  // ulang: itulah yang dulu memaksa fokus dikembalikan dengan tangan setiap
  // ketukan, dan yang membuat kursor selalu melompat ke ujung sehingga
  // menyunting di tengah nomor PO mustahil.
  const refreshSuggestions = () => {
    const slot = root.querySelector("#po-suggestions");
    if (slot) slot.innerHTML = suggestionMarkup();
    bindSuggestions(root);
  };
  const refreshSuggestionsSoon = debounce(refreshSuggestions);

  root.querySelector("#po-query")?.addEventListener("input", (event) => {
    form.poQuery = event.target.value;
    refreshSuggestionsSoon();
  });

  bindSuggestions(root);

  root.querySelector("#add-manual-po")?.addEventListener("click", () => {
    const poNumber = form.manualPo.trim().toUpperCase();
    if (!poNumber) {
      toast("Isi nomor PO manual terlebih dahulu.", "error");
      return;
    }
    if (form.pos.some((po) => po.po_number === poNumber)) {
      toast("PO tersebut sudah dipilih.", "error");
      return;
    }
    form.pos.push({ po_number: poNumber, is_manual: true, request_quantity: 0, count_sku: 0 });
    form.manualPo = "";
    render(root);
  });

  root.querySelectorAll("[data-remove-po]").forEach((button) => {
    button.addEventListener("click", () => {
      form.pos = form.pos.filter((po) => po.po_number !== button.dataset.removePo);
      render(root);
    });
  });

  root.querySelector("#reset-form")?.addEventListener("click", () => {
    resetForm();
    render(root);
  });

  root.querySelector("#register-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    submit(root, root.querySelector("#submit-ticket"));
  });
}

/* --------------------------------------------------------------------------
 * Kirim
 * ----------------------------------------------------------------------- */
/**
 * Tombol saran dipasang ulang setiap kali isi kotaknya berganti.
 *
 * Dipisahkan dari bindEvents() karena hanya bagian inilah yang benar-benar
 * berubah saat operator mengetik.
 */
function bindSuggestions(root) {
  root.querySelectorAll("[data-add-po]").forEach((button) => {
    button.addEventListener("click", () => {
      const poNumber = button.dataset.addPo;
      const master = store.state.poMaster.find((po) => po.po_number === poNumber);
      form.pos.push({
        po_number: poNumber,
        vendor_name: master?.vendor_name || "",
        request_quantity: master?.request_quantity || 0,
        count_sku: master?.count_sku || 0,
        is_manual: false,
      });
      if (!form.vendor && master?.vendor_name) form.vendor = master.vendor_name;
      form.poQuery = "";
      // Menambahkan PO mengubah daftar chip di atas kotak saran, jadi di sini
      // halaman memang perlu digambar ulang.
      render(root);
    });
  });
}

function validate() {
  const plate = normalizePlate(form.plate.prefix, form.plate.number, form.plate.suffix);
  if (!form.arrivedAt) return "Jam kedatangan wajib diisi.";
  if (new Date(form.arrivedAt).getTime() > Date.now() + 60000) {
    return "Jam kedatangan tidak boleh melewati waktu sekarang.";
  }
  if (!form.fleet) return "Tipe armada wajib dipilih.";
  if (!plate) return "Plat nomor wajib diisi.";
  if (!isValidPlate(plate)) return "Format plat nomor belum benar. Contoh: B 1234 XYZ.";
  if (!form.pos.length) return "Minimal satu PO wajib dipilih.";
  return "";
}

async function submit(root, button) {
  const problem = validate();
  if (problem) {
    toast(problem, "error");
    return;
  }

  await withBusy(button, async () => {
    try {
      const created = await store.mutate(() =>
        api.createTicket({
          arrived_at: new Date(form.arrivedAt).toISOString(),
          fleet_type: form.fleet,
          plat_number: normalizePlate(form.plate.prefix, form.plate.number, form.plate.suffix),
          vendor_name: form.vendor.trim(),
          driver_name: form.driverName.trim(),
          driver_phone: form.driverPhone.trim(),
          ticket_type: form.ticketType,
          pos: form.pos,
        }),
      );
      toast(`Tiket ${created?.queue_no || ""} tersimpan.`);
      resetForm();
      render(root);
    } catch (error) {
      toast(error.message, "error");
    }
  });
}
