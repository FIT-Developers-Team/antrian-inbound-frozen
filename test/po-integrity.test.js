/* ============================================================================
 * INTEGRITAS PO — ANGKA YANG TERCATAT HARUS BERASAL DARI MASTER
 *
 * Satu tiket membawa angka yang dipakai jauh di hilir: `request_quantity` dan
 * `count_sku` mengalir ke papan, ke laporan, ke Google Sheet, dan — lewat
 * `inbound_sla_target_hours()` — ke TARGET SLA tiket itu sendiri. Selama
 * angkanya datang dari browser, seluruh rantai itu berdiri di atas nilai yang
 * dapat disunting siapa pun yang membuka DevTools.
 *
 * Berkas ini mengunci sisi sumbernya. Perilaku runtime-nya diverifikasi
 * terpisah terhadap Postgres sungguhan; yang dijaga di sini adalah agar
 * bentuknya tidak diam-diam kembali ke bentuk lama.
 * ========================================================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const { read, schema, importModule } = require("./helpers");

const sql = schema();
const register = read("js/pages/register.js");
const settings = read("js/pages/settings.js");

/** Badan fungsi pembuat tiket, tanpa komentar penjelasnya. */
const createFn = (() => {
  const start = sql.indexOf("create or replace function inbound_create_tickets_bulk");
  const body = sql.slice(start, sql.indexOf("-- 16. Aksi tiket", start));
  const NEWLINE = String.fromCharCode(10);
  return body
    .split(NEWLINE)
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("*"))
    .join(NEWLINE);
})();

/* -- Angka PO ---------------------------------------------------------------*/

test("jumlah dan SKU tiket dibaca dari master, bukan dari muatan klien", () => {
  // Bentuk lama: `coalesce((v_po->>'request_quantity')::double precision, 0)`.
  // Ia memeriksa bahwa NOMOR PO-nya ada, lalu menyimpan ANGKA apa pun yang
  // dikirim bersamanya — dua hal yang berbeda, dan selisihnya adalah seluruh
  // nilai pemeriksaan itu.
  assert.doesNotMatch(createFn, /v_po->>'request_quantity'/);
  assert.doesNotMatch(createFn, /v_po->>'count_sku'/);
  assert.doesNotMatch(createFn, /v_po->>'actual_quantity'/);

  // Yang dipakai adalah nilai yang dibaca dari superset_po_master.
  assert.match(createFn, /into v_m_found, v_m_vendor, v_m_qty, v_m_sku/);
  assert.match(createFn, /from superset_po_master m/);
});

test("pencarian master dilingkupi gudang tiket itu sendiri", () => {
  // Syarat lama hanya "ada di salah satu gudang aktif", sehingga tiket
  // Pegangsaan dapat mengangkut PO milik Srengseng — lengkap dengan vendor dan
  // jumlahnya, tanpa satu pun tanda yang terlihat sesudahnya.
  const lookup = createFn.slice(createFn.indexOf("select true, m.vendor_name"));
  assert.match(lookup.slice(0, lookup.indexOf("limit 1")), /s\.site_code = v_site/);
});

test("PO manual ditandai dan angkanya nol", () => {
  // Tanpa penanda, PO yang diketik bebas tidak dapat dibedakan dari PO yang
  // benar-benar tervalidasi begitu tiketnya tersimpan.
  assert.match(sql, /alter table ticket_pos add column if not exists is_manual boolean/);
  assert.match(createFn, /'PENDING', not v_m_found\)/);
});

test("jumlah aktual selalu mulai nol", () => {
  // Ia diisi checker saat bongkar; pendaftar di pos masuk belum melihat satu
  // koli pun, jadi nilai apa pun darinya adalah tebakan atau manipulasi.
  assert.match(createFn, /case when v_m_found then coalesce\(v_m_qty, 0\) else 0 end,\s*\n\s*0,/);
});

test("vendor tiket mengikuti vendor PO master", () => {
  // Nama vendor yang diketik bebas di samping PO tervalidasi membuat satu
  // vendor muncul sebagai beberapa ejaan di laporan yang sama.
  assert.match(createFn, /update tickets t\s*\n\s*set vendor_name = coalesce\(/);
  assert.match(createFn, /where p\.ticket_id = v_ticket_id and not p\.is_manual/);
});

/* -- Muatan klien -----------------------------------------------------------*/

test("layar pendaftaran hanya mengirim nomor PO dan penandanya", () => {
  // Mengirim angkanya berarti menawarkan nilai yang dapat disunting pada
  // sesuatu yang ikut menentukan target SLA.
  assert.match(register, /pos: form\.pos\.map\(\(po\) => \(\{ po_number: po\.po_number, is_manual: Boolean\(po\.is_manual\) \}\)\)/);
});

test("vendor tidak diketik ulang ketika PO master sudah menjawabnya", () => {
  assert.match(register, /function vendorField\(\)/);
  assert.match(register, /readonly/);
  assert.match(register, /Mengikuti master PO/);
});

/* -- Kesetiaan sinkronisasi -------------------------------------------------*/

test("baris ganda per PO terdeteksi, bukan ditimpa diam-diam", async () => {
  const { auditRowKeys } = await importModule("api/sync-superset.mjs");

  // source_row_key = location_id|po_number, jadi baris kedua untuk PO yang sama
  // menimpa yang pertama lewat `on conflict do update`. Selama angkanya sama,
  // nilai tersimpan tetap benar; ketika berbeda, yang tersimpan pasti bukan
  // total PO itu.
  const identical = auditRowKeys([
    ["160|PO1", "PO1", 100, 0, 5],
    ["160|PO1", "PO1", 100, 0, 5],
  ]);
  assert.equal(identical.duplicates, 1);
  assert.equal(identical.conflicts, 0);

  const conflicting = auditRowKeys([
    ["160|PO2", "PO2", 40, 0, 2],
    ["160|PO2", "PO2", 60, 0, 3],
  ]);
  assert.equal(conflicting.conflicts, 1);
  assert.deepEqual(conflicting.conflicting, ["PO2"]);

  const clean = auditRowKeys([
    ["160|PO3", "PO3", 10, 0, 1],
    ["160|PO4", "PO4", 20, 0, 2],
  ]);
  assert.equal(clean.duplicates, 0);
  assert.equal(clean.unique, 2);
});

test("kolom sumber yang belum disimpan dilaporkan, bukan dibuang diam-diam", async () => {
  const { unmappedColumns } = await importModule("api/sync-superset.mjs");

  // Chart di Superset dapat disunting siapa pun yang punya aksesnya, dan kolom
  // yang ditambahkan di sana tidak akan pernah muncul di sini maupun memberi
  // kabar bahwa ia ada. Inilah yang menjawab "apakah sumbernya sudah membawa
  // sku_number / product_name / l1_category_name / company_name".
  assert.deepEqual(
    unmappedColumns([
      {
        po_number: "PO1",
        vendor_name: "V",
        location_id: "160",
        request_quantity: 10,
        count_sku: 1,
        company_name: "PT A",
        sku_number: "SKU1",
        product_name: "Produk",
        l1_category_name: "Frozen",
      },
    ]),
    ["company_name", "l1_category_name", "product_name", "sku_number"],
  );

  // Chart yang persis sepadan dengan tabelnya tidak menghasilkan catatan.
  assert.deepEqual(unmappedColumns([{ po_number: "PO1", location_id: "160", count_sku: 1 }]), []);
  assert.deepEqual(unmappedColumns([]), []);
});

test("catatan sync yang tidak menggagalkan apa pun tetap sampai ke layar", () => {
  // Kegagalan sudah punya tempatnya sendiri; justru catatan yang tidak
  // menggagalkan apa pun yang paling mudah terlewat.
  assert.match(sql, /'last_run_notes', \(select notes from last_run\)/);
  assert.match(sql, /alter table sync_runs add column if not exists notes text/);
  assert.match(settings, /source\.last_run_notes/);
});
