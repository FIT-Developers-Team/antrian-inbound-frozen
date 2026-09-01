/* ============================================================================
 * KONTRAK ALUR OPERASIONAL
 *
 * Empat hal yang menjadi alasan revamp ini: input kedatangan, input tipe mobil
 * dan plat nomor, trigger mulai bongkar, dan hitung mundur SLA.
 * ========================================================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const { read, schema, apiServer, importModule } = require("./helpers");

const board = read("js/pages/board.js");
const register = read("js/pages/register.js");
const api = read("js/api.js");
const edge = apiServer();
const migrations = schema();

/* -- 1. Input kedatangan --------------------------------------------------- */

test("form pendaftaran punya input jam kedatangan yang tidak bisa diisi masa depan", () => {
  assert.match(register, /id="arrived-at"/, "input kedatangan harus ada");
  assert.match(register, /type="datetime-local"/);
  assert.match(register, /max="\$\{toLocalInputValue\(\)\}"/, "batas atas adalah waktu sekarang");
  assert.match(
    register,
    /Jam kedatangan tidak boleh melewati waktu sekarang/,
    "validasi sisi klien harus menolak kedatangan di masa depan",
  );
});

test("jam kedatangan ikut terkirim saat tiket dibuat", () => {
  assert.match(register, /arrived_at: new Date\(form\.arrivedAt\)\.toISOString\(\)/);
  assert.match(migrations, /v_arrived := coalesce\(nullif\(btrim\(v_ticket->>'arrived_at'\), ''\)/);
});

test("kedatangan dapat dikoreksi untuk tiket yang sudah ada", () => {
  assert.match(board, /data-action="arrival"/, "kartu antrean harus punya aksi koreksi kedatangan");
  assert.match(api, /export function setArrival/);
  assert.match(migrations, /create or replace function inbound_set_arrival/);
});

test("server menolak kedatangan di masa depan sebagai jaring pengaman", () => {
  const guards = migrations.match(/Jam kedatangan tidak boleh melewati waktu sekarang/g) || [];
  assert.ok(guards.length >= 2, "pembuatan tiket dan koreksi kedatangan sama-sama harus dijaga");
});

test("waktu tunggu driver dihitung dari kedatangan, bukan jam input data", () => {
  assert.match(
    board,
    /elapsedMarkup\(row\.arrived_at, row\.start_unloading_at\)/,
    "lama tunggu dihitung dari kedatangan sampai bongkar dimulai",
  );
  assert.match(read("js/pages/report.js"), /minutesBetween\(row\.arrived_at, row\.start_unloading_at\)/);
});

/* -- 2. Input tipe mobil dan plat nomor ------------------------------------ */

test("tipe armada dipilih dari daftar tertutup, bukan diketik bebas", async () => {
  const { FLEET_TYPES } = await importModule("js/config.js");
  assert.ok(FLEET_TYPES.length >= 10, "daftar armada harus lengkap");
  assert.match(register, /role="radiogroup"/, "pemilih armada harus terbaca sebagai grup radio");
  assert.match(register, /data-fleet="\$\{esc\(fleet\.value\)\}"/);
  assert.match(register, /fleet_type: form\.fleet/, "armada terkirim saat menyimpan tiket");
});

test("setiap pilihan armada menampilkan target SLA-nya sendiri", () => {
  assert.match(register, /SLA \$\{esc\(fleet\.slaHours\)\} jam/);
});

test("plat nomor dipecah tiga bagian dan dinormalisasi", async () => {
  const { normalizePlate, isValidPlate, splitPlate } = await importModule("js/format.js");

  assert.match(register, /id="plate-prefix"/);
  assert.match(register, /id="plate-number"/);
  assert.match(register, /id="plate-suffix"/);

  // Bentuk apa pun yang diketik operator menghasilkan satu bentuk kanonis,
  // sehingga pencarian plat di papan tidak pernah gagal karena spasi.
  assert.equal(normalizePlate("b", "1234", "xyz"), "B 1234 XYZ");
  assert.equal(normalizePlate(" B ", "12-34", "x y z"), "B 1234 XYZ");
  assert.equal(normalizePlate("B1", "1234", ""), "B 1234");

  assert.ok(isValidPlate("B 1234 XYZ"));
  assert.ok(isValidPlate("DK 12 A"));
  assert.ok(!isValidPlate("1234 XYZ"), "plat tanpa kode wilayah tidak sah");
  assert.ok(!isValidPlate(""), "plat kosong tidak sah");

  assert.deepEqual(splitPlate("B 1234 XYZ"), { prefix: "B", number: "1234", suffix: "XYZ" });
});

test("plat nomor wajib dan divalidasi sebelum tiket dikirim", () => {
  assert.match(register, /Plat nomor wajib diisi/);
  assert.match(register, /Format plat nomor belum benar/);
  assert.match(register, /plat_number: normalizePlate\(/);
});

test("kesalahan plat ditandai lebih dari sekadar warna", () => {
  assert.match(register, /aria-invalid="true"/);
  assert.match(register, /class="field-error"/);
  assert.match(read("style.css"), /\.field-error::before/, "ikon teks menyertai warna merah");
});

/* -- 3. Trigger mulai bongkar ---------------------------------------------- */

test("mulai bongkar tersedia sebagai satu aksi, bukan memilih PO satu per satu", () => {
  assert.match(board, /data-action="start"/);
  assert.match(api, /export function startUnloading/);
  assert.match(migrations, /create or replace function inbound_start_unloading/);
  assert.match(
    migrations,
    /where ticket_id = v_id and upper\(coalesce\(checker_status, 'PENDING'\)\) = 'PENDING'/,
    "satu aksi memulai seluruh PO yang masih menunggu",
  );
});

test("mulai bongkar bersifat idempoten dan tidak memperpanjang SLA", () => {
  assert.match(
    migrations,
    /v_started := coalesce\(v_ticket\.start_unloading_at, v_started\)/,
    "menekan dua kali tidak menggeser jam mulai",
  );
});

test("mulai bongkar mengisi kedatangan dan panggilan bila belum tercatat", () => {
  assert.match(migrations, /arrived_at = coalesce\(arrived_at, v_started\)/);
  assert.match(migrations, /called_at = coalesce\(called_at, v_started\)/);
});

test("gate wajib ditentukan sebelum bongkar dimulai", () => {
  assert.match(board, /Pilih gate terlebih dahulu/, "klien menolak submit tanpa gate");
  assert.match(board, /id="gate-input"/);
  assert.match(migrations, /Gate wajib ditentukan saat memanggil driver/);
});

test("gate yang sedang terpakai tidak dapat dipilih dua kali", () => {
  assert.match(board, /occupiedGates\(\)/);
  assert.match(board, /busy \? " disabled" : ""/);
  assert.match(read("js/store.js"), /export function occupiedGates/);
});

test("Mulai Bongkar hanya menjadi aksi utama setelah driver dipanggil", () => {
  // Pada WAITING, tombol utama adalah Panggil; Mulai Bongkar tetap tersedia
  // tetapi sebagai aksi sekunder, supaya lama tunggu driver tetap terukur.
  const waiting = board.slice(board.indexOf('if (status === "WAITING")'), board.indexOf('if (status === "CALLED")'));
  assert.match(waiting, /btn btn-primary" data-action="call"/, "Panggil adalah aksi utama saat menunggu");
  assert.match(waiting, /class="btn" data-action="start"/, "Mulai bongkar sekunder saat menunggu");

  const called = board.slice(board.indexOf('if (status === "CALLED")'), board.indexOf('if (status === "UNLOADING")'));
  assert.match(called, /btn btn-primary" data-action="start"/, "Mulai bongkar utama setelah dipanggil");
});

test("menyelesaikan bongkar menutup jam SLA dan seluruh PO sekaligus", () => {
  assert.match(board, /data-action="finish"/);
  assert.match(migrations, /create or replace function inbound_finish_unloading/);
  assert.match(migrations, /v_finished := coalesce\(v_row\.done_unloading_at, v_finished\)/);
  assert.match(migrations, /gr_status\s+= 'DONE GR'/);
});

test("setiap perubahan tiket dicatat sebagai event dan mengantre ke Google Sheet", () => {
  ["inbound_call_ticket", "inbound_finish_unloading", "inbound_cancel_ticket"].forEach((fn) => {
    const start = migrations.indexOf(`create or replace function ${fn}`);
    assert.ok(start > 0, `${fn} harus ada`);
    const body = migrations.slice(start, migrations.indexOf("$$;", start));
    assert.match(body, /insert into ticket_events/, `${fn} harus mencatat event`);
    assert.match(body, /inbound_requeue_gsheet/, `${fn} harus mengantre sinkronisasi sheet`);
  });
});

/* -- 4. Aksi terekspos di backend ------------------------------------------ */

test("Edge Function mengekspos tepat aksi yang dipakai aplikasi", () => {
  // Aksi muncul sebagai string literal (daftar baca) atau kunci objek
  // (peta peran dan peta RPC), jadi keduanya diterima.
  ["board", "history", "create_ticket", "set_arrival", "call_ticket", "start_unloading", "finish_unloading"].forEach(
    (action) => {
      assert.match(edge, new RegExp(`(["']${action}["']|\\b${action}:)`), `aksi ${action} harus tersedia`);
    },
  );
});

test("aksi halaman yang dihapus ikut hilang dari backend", () => {
  // Permukaan API yang tertinggal setelah halamannya dihapus adalah pintu yang
  // tidak dijaga siapa pun.
  ["ba_list", "ba_detail", "create_ba", "product_lookup", "export_rows", "state_delta", "realtime_config"].forEach(
    (action) => {
      assert.doesNotMatch(edge, new RegExp(`["']${action}["']`), `aksi ${action} seharusnya sudah dihapus`);
    },
  );
});

test("aksi tulis dibatasi per peran", () => {
  assert.match(edge, /cancel_ticket: \["SPV", "ADMIN", "DEVELOPER"\]/);
  assert.match(edge, /create_ticket: \["SECURITY", "SPV", "ADMIN", "DEVELOPER"\]/);
  assert.match(edge, /delete_single_ticket: \["ADMIN", "DEVELOPER"\]/);
});

test("aksi tanpa sesi selalu ditolak", () => {
  assert.match(edge, /if \(!canUseAction\(session, action\)\)/);
  assert.match(edge, /if \(!session\) return false/);
});
