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
import { badge, debounce, icon, pageHeader, section, toast, withBusy } from "../ui.js";

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
/**
 * Pemilih armada — satu daftar pilihan.
 *
 * Sebelumnya dua belas tombol dalam grid. Di ponsel itu enam baris penuh, yaitu
 * bagian TERBESAR layar pendaftaran, untuk satu nilai yang pada kebanyakan
 * shift tidak pernah bergeser dari bawaannya. Grid itu juga menyandang peran
 * grup radio tanpa pernah berperilaku seperti grup radio, sampai navigasi
 * panahnya ditambahkan belakangan.
 *
 * `<select>` membawa semuanya tanpa satu baris kode: keyboard, pencarian
 * ketik-huruf, dan gulungan asli perangkat — yang di tablet gudang justru lebih
 * mudah disentuh bersarung tangan daripada dua belas target kecil.
 *
 * Keterangan di bawahnya mengikuti pilihan, sehingga catatan armada dan tier
 * SLA-nya tetap terbaca tanpa membuka layar Pengaturan.
 */
function fleetPicker() {
  const selected = FLEET_TYPES.find((fleet) => fleet.value === form.fleet);
  return `<label>
    <span>Tipe armada</span>
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
 * Hasil pencarian PO terakhir dari server.
 *
 * Sebelumnya di sini ada indeks tiga puluh ribu baris yang dibangun di tablet
 * dari master yang diunduh utuh. Yang tersisa sekarang hanya delapan baris
 * terakhir yang benar-benar ditampilkan — pencariannya sendiri dikerjakan
 * Postgres lewat index trigram.
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
 * Server memang sudah menimpanya dengan vendor milik master saat tiket dibuat,
 * jadi kotak yang dapat diketik di sini hanya menawarkan pekerjaan yang
 * hasilnya dibuang: operator mengetik satu nama, tiketnya tersimpan dengan nama
 * lain, dan tidak ada yang menjelaskan mengapa. Menampilkannya sebagai fakta
 * turunan membuat layar dan basis data mengatakan hal yang sama.
 *
 * Kotaknya kembali dapat diketik hanya ketika seluruh PO-nya manual — di situ
 * memang tidak ada master yang dapat menjawab, dan nama vendor yang diketik
 * operator adalah satu-satunya yang ada.
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
 * Sebelumnya PO yang sudah dipilih menyusut menjadi chip berisi nomornya saja.
 * Vendor, jumlah SKU, dan qty memang sempat tampil — tetapi hanya di daftar
 * saran, yaitu tepat SEBELUM operator memilih, lalu hilang begitu ia memilih.
 * Justru sesudah memilih itulah angkanya perlu dibaca: itu satu-satunya
 * kesempatan mencocokkan apa yang tertera di surat jalan dengan apa yang ada di
 * master sebelum tiketnya tersimpan.
 *
 * Totalnya dijumlahkan di baris terakhir karena satu truk kerap membawa
 * beberapa PO, dan yang dicocokkan dengan muatan adalah jumlah keseluruhannya.
 */
function poList() {
  if (!form.pos.length) {
    return `<p class="section-note">Belum ada PO dipilih. Minimal satu PO wajib diisi.</p>`;
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
             value="${esc(form.poQuery)}" autocomplete="off" />
    </label>

    <div class="po-suggestions" id="po-suggestions">${suggestionMarkup()}</div>

    <label>
      <span>PO manual</span>
      <!-- Kotak dan tombolnya membungkus ketika kolomnya sempit. Sebagai satu
           baris fleks yang dipaksa, kotaknya tergencet sampai placeholder-nya
           terpotong di tengah kata dan nomor PO yang sedang diketik tidak
           terlihat utuh. -->
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
                <span>Jam kedatangan</span>
                <input class="input" type="datetime-local" id="arrived-at"
                       max="${toLocalInputValue()}" value="${esc(form.arrivedAt)}" required />
                <small>Jam truk tiba di pos, bukan jam formulir ini diisi. Lama tunggu driver dihitung dari sini.</small>
              </label>

              <div class="span-2">${fleetPicker()}</div>

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

              ${vendorField()}
            </div>`,
          })}

          ${section({
            eyebrow: "Langkah 2",
            title: "Purchase order",
            body: poPicker(),
          })}
        </div>

        <!--
          Urutan langkah mengikuti URUTAN BACA, bukan urutan berkas.

          Di desktop mata membaca satu kolom sampai habis lalu pindah ke kolom
          berikutnya; di ponsel kedua kolom bertumpuk. Kolom kiri karena itu
          memuat langkah 1 dan 2, kolom kanan langkah 3 dan tombol simpannya —
          terbaca 1 → 2 → 3 dalam kedua tata letak.

          Pembagiannya juga mengikuti BOBOT isinya. Ketika pemilih armada masih
          berupa grid dua belas tombol, langkah 1 sendirian mengisi kolom kiri;
          setelah ia menjadi satu daftar pilihan, kolomnya tinggal separuh
          terisi sementara kolom kanan meluber. Daftar PO tumbuh seiring PO
          ditambahkan, jadi ia yang sekarang menemani langkah 1 di kolom lebar.
        -->
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

  // Armada adalah daftar pilihan biasa. Sebelumnya ia dua belas tombol yang
  // memenuhi enam baris di ponsel — bagian terbesar layar pendaftaran, untuk
  // satu nilai yang jarang berubah dari bawaannya. Daftar pilihan juga membawa
  // keyboard, pencarian ketik-huruf, dan gulungan asli perangkat tanpa satu
  // baris kode pun.
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
  const paintSuggestions = () => {
    const slot = root.querySelector("#po-suggestions");
    if (slot) slot.innerHTML = suggestionMarkup();
    bindSuggestions(root);
  };

  /**
   * Mencari ke server, dengan penjaga balapan.
   *
   * Ketikan cepat menghasilkan beberapa permintaan yang berjalan bersamaan, dan
   * jaringan tidak menjamin urutan kedatangannya. Tanpa token ini, jawaban
   * untuk "PO001" yang datang terlambat dapat menimpa jawaban untuk "PO0012"
   * yang sudah tampil — operator melihat daftar yang tidak cocok dengan apa
   * yang ada di kotak.
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
      // Baris master datang bersama hasil pencarian, jadi tidak perlu dicari
      // ulang di salinan lokal yang kini sudah tidak ada.
      //
      // Angkanya disimpan HANYA untuk ditampilkan di layar. Yang dikirim saat
      // submit tinggal nomor PO-nya: server membaca ulang vendor, jumlah, dan
      // SKU dari master gudang itu sendiri, sehingga angka yang tercatat tidak
      // pernah bergantung pada apa yang kebetulan ada di memori tablet.
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
