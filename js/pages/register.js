/* ==========================================================================
 * PENDAFTARAN KEDATANGAN (SECURITY)
 *
 * Formulir satu layar untuk pos masuk. Urutan isiannya mengikuti urutan yang
 * benar-benar terjadi di lapangan: truk tiba (jam), apa kendaraannya (armada +
 * plat), milik siapa (vendor + PO), siapa yang bawa (driver).
 * ========================================================================== */

import * as api from "../api.js";
import * as store from "../store.js";
import { DEFAULT_FLEET, FLEET_TYPES, SKU_TIERED_FLEETS, currentSite } from "../config.js";
import { esc, isValidPlate, normalizePlate, num, toLocalInputValue } from "../format.js";
import { badge, debounce, dialog, fieldError, icon, pageHeader, req, section, toast, withBusy } from "../ui.js";

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

/**
 * Galat per medan dari percobaan kirim terakhir. Validasi dulu mengembalikan
 * satu kalimat sebagai toast: operator menemukan kesalahannya satu per satu,
 * sementara medan yang dimaksud tidak pernah ditandai maupun difokuskan.
 */
let problems = {};

/** Anchor untuk memindahkan fokus ke medan pertama yang salah. */
const FIELD_ANCHOR = { arrivedAt: "#arrived-at", plate: "#plate-prefix", pos: "#po-query" };

function resetForm() {
  problems = {};
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
/**
 * Pemilih armada — satu daftar pilihan, bukan dua belas tombol.
 *
 * Grid dua belas tombol memenuhi enam baris di ponsel — bagian terbesar layar
 * pendaftaran — untuk satu nilai yang jarang bergeser dari bawaannya, dan ia
 * menyandang peran grup radio tanpa berperilaku seperti grup radio. `<select>`
 * membawa keyboard, pencarian ketik-huruf, dan gulungan asli perangkat tanpa
 * satu baris kode; keterangan di bawahnya mengikuti pilihan sehingga tier SLA
 * terbaca tanpa membuka Pengaturan.
 */
function fleetPicker() {
  const selected = FLEET_TYPES.find((fleet) => fleet.value === form.fleet);
  return `<label>
    <span>Tipe armada ${req()}</span>
    <select class="input" id="fleet-select">
      ${FLEET_TYPES.map(
        (fleet) =>
          `<option value="${esc(fleet.value)}"${fleet.value === form.fleet ? " selected" : ""}>
             ${esc(fleet.label)} — SLA ${esc(fleet.slaHours)} jam
           </option>`,
      ).join("")}
    </select>
    <small>${selected ? esc(selected.note) : ""}${
      selected && SKU_TIERED_FLEETS.includes(selected.value)
        ? " · target naik ke 4 jam di atas 40 SKU"
        : ""
    }</small>
  </label>`;
}

/**
 * Plat dipecah tiga kotak karena itulah bentuk fisik plat Indonesia, dan
 * karena satu kotak bebas membuat operator mengetik "B1234XYZ", "b 1234 xyz",
 * atau "B-1234-XYZ" untuk kendaraan yang sama sehingga pencarian gagal.
 */
function plateInput() {
  const value = normalizePlate(form.plate.prefix, form.plate.number, form.plate.suffix);
  const invalid = (value && !isValidPlate(value)) || Boolean(problems.plate);
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
        ? fieldError(problems.plate || "Format plat nomor belum benar. Contoh: B 1234 XYZ.", "err-plate")
        : `<span class="plate-preview" id="plate-preview" aria-hidden="true">${esc(value || "— — —")}</span>`
    }`;
}

/**
 * Hasil pencarian PO terakhir dari server — delapan baris, bukan indeks tiga
 * puluh ribu baris yang dulu dibangun di tablet dari master yang diunduh utuh.
 * Pencariannya dikerjakan Postgres lewat index trigram.
 */
let suggestions = [];
let searchToken = 0;
let searching = false;

/**
 * Isi kotak saran saja.
 *
 * Dipisahkan dari poPicker() supaya mengetik hanya menulis ulang bagian ini,
 * bukan membangun ulang seluruh halaman pendaftaran — yang membuang isian yang
 * sedang diketik, menutup daftar pilihan armada, dan memindahkan fokus.
 */
function suggestionMarkup() {
  const query = form.poQuery.trim();
  const chosen = new Set(form.pos.map((po) => po.po_number));
  const visible = suggestions.filter((po) => !chosen.has(po.po_number));

  if (visible.length) {
    return visible
      .map(
        (po) => `<button type="button" class="po-suggestion" data-add-po="${esc(po.po_number)}">
          <strong>${esc(po.po_number)}</strong>
          <small>${esc(po.vendor_name || "-")} · ${esc(po.count_sku || 0)} SKU · ${esc(po.request_quantity || 0)} qty</small>
        </button>`,
      )
      .join("");
  }
  if (!query) return "";
  if (searching) return `<p class="section-note">Mencari…</p>`;
  return `<p class="section-note">Tidak ada PO cocok di master gudang aktif. Pakai PO manual bila memang belum terbit.</p>`;
}

/**
 * Vendor: DIBACA dari PO, bukan diketik — selama ada satu PO master terpilih.
 *
 * Server menimpanya dengan vendor milik master saat tiket dibuat, jadi kotak
 * yang dapat diketik hanya menawarkan pekerjaan yang hasilnya dibuang: operator
 * mengetik satu nama, tiketnya tersimpan dengan nama lain, tanpa penjelasan.
 * Kotaknya kembali dapat diketik hanya ketika seluruh PO-nya manual — di situ
 * tidak ada master yang dapat menjawab.
 */
function vendorField() {
  const fromMaster = form.pos.find((po) => !po.is_manual && po.vendor_name);

  if (fromMaster) {
    return `<label>
      <span>Vendor</span>
      <input class="input" id="vendor" value="${esc(fromMaster.vendor_name)}" readonly
             aria-describedby="vendor-note" />
      <small id="vendor-note">Mengikuti master PO ${esc(fromMaster.po_number)}. Tidak diketik manual.</small>
    </label>`;
  }

  return `<label>
    <span>Vendor</span>
    <input class="input" id="vendor" placeholder="Nama vendor"
           value="${esc(form.vendor)}" autocomplete="off" />
    <small>${
      form.pos.length
        ? "Seluruh PO dipilih manual, jadi nama vendor tidak dapat diambil dari master."
        : "Terisi sendiri begitu PO dipilih."
    }</small>
  </label>`;
}

/**
 * PO terpilih, dengan angkanya ikut terlihat.
 *
 * Vendor, SKU, dan qty dulu hanya tampil di daftar saran — tepat SEBELUM
 * operator memilih — lalu hilang begitu ia memilih. Justru sesudah memilih
 * itulah angkanya perlu dibaca: satu-satunya kesempatan mencocokkan surat jalan
 * dengan master sebelum tiketnya tersimpan. Totalnya dijumlahkan karena satu
 * truk kerap membawa beberapa PO.
 */
function poList() {
  if (!form.pos.length) {
    return problems.pos
      ? fieldError(problems.pos, "err-pos")
      : `<p class="section-note">Belum ada PO dipilih. Minimal satu PO wajib diisi.</p>`;
  }

  const totalSku = form.pos.reduce((sum, po) => sum + (Number(po.count_sku) || 0), 0);
  const totalQty = form.pos.reduce((sum, po) => sum + (Number(po.request_quantity) || 0), 0);

  const rows = form.pos
    .map(
      (po) => `<li class="po-row${po.is_manual ? " is-manual" : ""}">
        <div class="po-row-head">
          <strong class="mono">${esc(po.po_number)}</strong>
          ${po.is_manual ? badge("Manual", "warning") : ""}
          <button type="button" class="po-row-remove" data-remove-po="${esc(po.po_number)}"
                  aria-label="Hapus ${esc(po.po_number)}">${icon("x", 15)}</button>
        </div>
        <p class="po-row-vendor">${esc(
          po.is_manual ? "PO manual — belum ada data master" : po.vendor_name || "Vendor tidak tercatat",
        )}</p>
        <div class="po-row-facts">
          <span><i>SKU</i><b class="mono">${esc(po.is_manual ? "-" : num(po.count_sku))}</b></span>
          <span><i>Qty</i><b class="mono">${esc(po.is_manual ? "-" : num(po.request_quantity))}</b></span>
        </div>
      </li>`,
    )
    .join("");

  return `<ul class="po-list">${rows}</ul>
    <p class="po-total">
      <span>${form.pos.length} PO</span>
      <span><i>SKU</i> <b class="mono">${esc(num(totalSku))}</b></span>
      <span><i>Qty</i> <b class="mono">${esc(num(totalQty))}</b></span>
    </p>`;
}

function poPicker() {
  return `<div class="po-picker">
    ${poList()}

    <label>
      <span>Cari PO</span>
      <input class="input" type="search" id="po-query" placeholder="Nomor PO atau nama vendor"
             value="${esc(form.poQuery)}" autocomplete="off"
             ${problems.pos ? 'aria-invalid="true" aria-describedby="err-pos"' : ""} />
    </label>

    <div class="po-suggestions" id="po-suggestions">${suggestionMarkup()}</div>

    <label>
      <span>PO manual</span>
      <!-- Membungkus ketika kolomnya sempit: sebagai satu baris fleks yang
           dipaksa, kotaknya tergencet sampai placeholder-nya terpotong. -->
      <div class="inline-field">
        <input class="input" id="manual-po" placeholder="Nomor PO di luar master"
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
                <span>Jam kedatangan ${req()}</span>
                <input class="input" type="datetime-local" id="arrived-at"
                       max="${toLocalInputValue()}" value="${esc(form.arrivedAt)}" required
                       ${problems.arrivedAt ? 'aria-invalid="true" aria-describedby="err-arrivedAt"' : ""} />
                ${fieldError(problems.arrivedAt, "err-arrivedAt")}
                <small>Jam truk tiba di pos, bukan jam formulir ini diisi. Lama tunggu driver dihitung dari sini.</small>
              </label>

              <div class="span-2">${fleetPicker()}</div>

              <div class="span-2">
                <label for="plate-prefix"><span>Plat nomor ${req()}</span></label>
                ${plateInput()}
              </div>

              <label>
                <span>Tipe tiket</span>
                <select class="input" id="ticket-type">
                  <option value="REG"${form.ticketType === "REG" ? " selected" : ""}>Reguler</option>
                  <option value="DROP-OFF"${form.ticketType === "DROP-OFF" ? " selected" : ""}>Drop-Off</option>
                </select>
              </label>

              ${vendorField()}
            </div>`,
          })}

          ${section({
            eyebrow: "Langkah 2",
            // section() meng-escape judulnya, jadi penanda wajib tidak dapat
            // dititipkan di sini; untuk bagian ini catatan di dalam badannya
            // ("Minimal satu PO wajib diisi") yang membawanya.
            title: "Purchase order",
            body: poPicker(),
          })}
        </div>

        <!-- Urutan langkah mengikuti URUTAN BACA: kolom kiri memuat langkah 1
             dan 2, kolom kanan langkah 3 dan tombol simpannya, sehingga
             terbaca 1 → 2 → 3 baik berdampingan maupun bertumpuk. Daftar PO
             menemani langkah 1 di kolom lebar karena ia yang tumbuh. -->
        <div class="dashboard-page">
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

          ${section({
            title: "Simpan tiket",
            body: `<div class="dashboard-page">
              <p class="section-note">
                <span class="req-legend">${req()} wajib diisi.</span>
                Nomor antrean, target SLA, dan tenggat dihitung di server sesuai armada dan jumlah SKU.
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

  // Alasan bentuknya ada di docblock fleetPicker().
  root.querySelector("#fleet-select")?.addEventListener("change", (event) => {
    form.fleet = event.target.value;
    // Digambar ulang supaya keterangan di bawahnya mengikuti armada terpilih.
    rerender();
    root.querySelector("#fleet-select")?.focus();
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
      delete problems.plate;
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

  // Galat sebuah medan hilang begitu medannya disunting: menahannya sampai kirim
  // berikutnya membuat tanda merah bertahan pada isian yang sudah diperbaiki.
  const bind = (id, key, transform = (value) => value) => {
    root.querySelector(`#${id}`)?.addEventListener("input", (event) => {
      form[key] = transform(event.target.value);
      if (problems[key]) delete problems[key];
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

  // Mengetik hanya menulis ulang kotak saran; menggambar ulang halaman penuh
  // dulu memaksa fokus dan posisi kursor dipulihkan dengan tangan.
  const paintSuggestions = () => {
    const slot = root.querySelector("#po-suggestions");
    if (slot) slot.innerHTML = suggestionMarkup();
    bindSuggestions(root);
  };

  /**
   * Mencari ke server, dengan penjaga balapan: ketikan cepat menghasilkan
   * beberapa permintaan bersamaan dan jaringan tidak menjamin urutannya, jadi
   * jawaban untuk "PO001" yang terlambat dapat menimpa jawaban "PO0012".
   */
  const runSearch = async () => {
    const query = form.poQuery.trim();
    if (!query) {
      suggestions = [];
      searching = false;
      paintSuggestions();
      return;
    }

    const token = ++searchToken;
    searching = true;
    paintSuggestions();
    try {
      const found = await api.searchPoMaster(query);
      if (token !== searchToken) return;
      suggestions = Array.isArray(found) ? found : [];
    } catch (error) {
      if (token !== searchToken) return;
      suggestions = [];
      console.warn("Pencarian PO gagal", error);
    } finally {
      if (token === searchToken) {
        searching = false;
        paintSuggestions();
      }
    }
  };

  const searchSoon = debounce(runSearch, 180);

  root.querySelector("#po-query")?.addEventListener("input", (event) => {
    form.poQuery = event.target.value;
    searchSoon();
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

  // Konfirmasi hanya muncul bila memang ada yang akan hilang — termasuk daftar
  // PO yang mungkin butuh beberapa pencarian untuk disusun.
  root.querySelector("#reset-form")?.addEventListener("click", () => {
    const wipe = () => {
      resetForm();
      render(root);
      return true;
    };
    const filled =
      form.pos.length || form.driverName.trim() || form.driverPhone.trim() ||
      normalizePlate(form.plate.prefix, form.plate.number, form.plate.suffix);
    if (!filled) return wipe();
    return dialog({
      title: "Kosongkan formulir?",
      confirmLabel: "Kosongkan",
      confirmTone: "danger",
      body: `<p>Seluruh isian dibuang, termasuk ${form.pos.length} PO yang sudah dipilih.</p>`,
      onConfirm: wipe,
    });
  });

  root.querySelector("#register-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    submit(root, root.querySelector("#submit-ticket"));
  });
}

/* --------------------------------------------------------------------------
 * Kirim
 * ----------------------------------------------------------------------- */
/** Dipasang ulang tiap kali isi kotak saran berganti — hanya bagian inilah
 *  yang berubah saat operator mengetik. */
function bindSuggestions(root) {
  root.querySelectorAll("[data-add-po]").forEach((button) => {
    button.addEventListener("click", () => {
      const poNumber = button.dataset.addPo;
      // Angkanya disimpan HANYA untuk ditampilkan. Yang dikirim saat submit
      // tinggal nomor PO-nya: server membaca ulang vendor, jumlah, dan SKU dari
      // master gudangnya sendiri.
      const master = suggestions.find((po) => po.po_number === poNumber);
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

/** SELURUH masalah sekaligus: berhenti pada yang pertama memaksa operator
 *  menemukan sisanya lewat percobaan berulang, satu kirim per medan. */
function validate() {
  const plate = normalizePlate(form.plate.prefix, form.plate.number, form.plate.suffix);
  const found = {};
  if (!form.arrivedAt) found.arrivedAt = "Jam kedatangan wajib diisi.";
  else if (new Date(form.arrivedAt).getTime() > Date.now() + 60000) {
    found.arrivedAt = "Jam kedatangan tidak boleh melewati waktu sekarang.";
  }
  if (!plate) found.plate = "Plat nomor wajib diisi.";
  else if (!isValidPlate(plate)) found.plate = "Format plat nomor belum benar. Contoh: B 1234 XYZ.";
  if (!form.pos.length) found.pos = "Minimal satu PO wajib dipilih.";
  return found;
}

async function submit(root, button) {
  problems = validate();
  const keys = Object.keys(problems);
  if (keys.length) {
    // Medannya ditandai, lalu fokus dan pandangan dibawa ke yang pertama.
    // Toast tetap ada sebagai ringkasan, bukan sebagai satu-satunya pemberitahu.
    render(root);
    const first = root.querySelector(FIELD_ANCHOR[keys[0]]);
    first?.focus({ preventScroll: true });
    first?.scrollIntoView({ block: "center", behavior: "smooth" });
    toast(keys.length === 1 ? problems[keys[0]] : `${keys.length} isian belum benar.`, "error");
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
          // Hanya nomor PO dan penandanya yang diseberangkan. Vendor, jumlah,
          // dan SKU dibaca server dari master gudangnya sendiri — mengirimnya
          // dari sini berarti menawarkan angka yang dapat disunting siapa pun
          // yang membuka DevTools, pada nilai yang ikut menentukan target SLA.
          pos: form.pos.map((po) => ({ po_number: po.po_number, is_manual: Boolean(po.is_manual) })),
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
