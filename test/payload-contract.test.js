/* ============================================================================
 * KONTRAK MUATAN — apa yang DIKIRIM server harus sama dengan apa yang DIBACA
 * halaman.
 *
 * Dua arah, dan keduanya pernah dilanggar:
 *
 *   dikirim tetapi tidak dibaca   Muatan terbuang. `inbound_history` mengirim
 *                                 ketiga puluh tiga kolom view untuk sampai
 *                                 lima ribu tiket, sementara halaman Laporan
 *                                 membaca sebelas — 4,99 MB mentah untuk
 *                                 1,85 MB isi yang benar-benar dipakai.
 *
 *   dibaca tetapi tidak dikirim   Layar yang diam-diam kosong. Ini yang lebih
 *                                 berbahaya: tidak ada galat, hanya sel
 *                                 bertuliskan "-" yang terlihat seperti data
 *                                 yang memang tidak ada.
 *
 * Daftarnya TIDAK ditulis tangan di sini. Ia dibaca dari SQL dan dari modul
 * frontend, sehingga menambah kolom di satu sisi tanpa sisi lainnya langsung
 * menggagalkan test ini alih-alih diam sampai ada yang melapor.
 * ========================================================================== */

import test from "node:test";
import assert from "node:assert/strict";

import { read, schema } from "./helpers.js";

const sql = schema();

/* -- Membaca sisi SERVER ---------------------------------------------------- */

/** Potongan SQL milik satu fungsi, dari namanya sampai penanda berikutnya. */
function fnBody(name, endMarker) {
  const start = sql.indexOf(`create or replace function ${name}`);
  assert.ok(start >= 0, `fungsi ${name} tidak ditemukan di schema.sql`);
  const end = sql.indexOf(endMarker, start);
  assert.ok(end > start, `penanda akhir untuk ${name} tidak ditemukan`);
  return sql.slice(start, end);
}

/** Kunci `'nama', kolom` di dalam satu jsonb_build_object. */
function jsonKeys(fragment) {
  return new Set([...fragment.matchAll(/'([a-z_]+)',\s/g)].map((m) => m[1]));
}

/* -- Membaca sisi KLIEN ----------------------------------------------------- */

/**
 * Nama properti yang dibaca dari sebuah baris data.
 *
 * Yang dicari adalah akses properti pada pengenal yang memang memegang baris
 * tiket. Penulisan `row.foo` di modul lain — mis. baris vendor di Analitik —
 * karena itu tidak ikut terbawa: berkas yang diperiksa disebut satu per satu.
 */
function fieldsRead(files, holders) {
  const pattern = new RegExp(`\\b(?:${holders.join("|")})\\??\\.([a-z_][a-z_0-9]*)`, "g");
  const found = new Set();
  files.forEach((file) => {
    for (const match of read(file).matchAll(pattern)) found.add(match[1]);
  });
  return found;
}

/** Properti yang milik JavaScript, bukan milik muatan server. */
const NOT_PAYLOAD = new Set([
  "length", "map", "filter", "forEach", "join", "split", "slice", "trim",
  "toUpperCase", "toLowerCase", "includes", "some", "every", "sort", "reduce",
  "find", "push", "concat", "replace", "match", "dataset", "value", "textContent",
  "querySelector", "querySelectorAll", "getTime", "toISOString", "style", "classList",
  "phase", "seconds", "label", "note", "final", "name", "ticket", "isConnected",
]);

const payloadFields = (set) => new Set([...set].filter((f) => !NOT_PAYLOAD.has(f)));

/* -- 1. Papan --------------------------------------------------------------- */

test("snapshot papan mengirim persis kolom yang dibaca papan", () => {
  const snapshot = fnBody("inbound_board_snapshot", "create or replace function inbound_history");
  const projection = snapshot.slice(
    snapshot.indexOf("select coalesce(jsonb_agg(jsonb_build_object("),
    snapshot.indexOf("  sites as ("),
  );
  const sent = jsonKeys(projection);

  // Berkas yang benar-benar memegang baris papan.
  const readFields = payloadFields(
    fieldsRead(
      ["js/pages/board.js", "js/pages/queue-card.js", "js/ui.js", "js/sla.js"],
      ["row", "ticket", "a", "b", "current", "left", "right"],
    ),
  );

  const unread = [...sent].filter((f) => !readFields.has(f));
  assert.deepEqual(unread, [], `kolom dikirim tetapi tidak pernah dibaca: ${unread.join(", ")}`);

  // Arah sebaliknya: kolom yang dibaca kartu antrean wajib ada di muatannya.
  ["queue_no", "status", "vendor_name", "gate", "arrived_at", "call_count",
   "po_numbers", "total_sku", "total_qty", "sla_deadline_at", "sla_started_at",
   "sla_stopped_at", "sla_target_hours", "driver_name", "plat_number", "fleet_type",
   "expired_reason", "ticket_id", "start_unloading_at"].forEach((field) => {
    assert.ok(sent.has(field), `${field} dibaca papan tetapi tidak dikirim`);
  });
});

/* -- 2. Laporan ------------------------------------------------------------- */

test("riwayat mengirim persis kolom yang dibaca Laporan", () => {
  const history = fnBody("inbound_history", "-- 13.");
  const rows = history.slice(history.indexOf("'rows', coalesce"));
  const sent = jsonKeys(rows);
  sent.delete("rows");

  // Halaman Laporan membaca barisnya seluruhnya lewat `row.`.
  const readFields = payloadFields(fieldsRead(["js/pages/report.js"], ["row"]));

  const unread = [...sent].filter((f) => !readFields.has(f));
  assert.deepEqual(unread, [], `kolom riwayat dikirim tetapi tidak dibaca: ${unread.join(", ")}`);

  const unsent = [...readFields].filter((f) => !sent.has(f));
  assert.deepEqual(unsent, [], `kolom riwayat dibaca tetapi tidak dikirim: ${unsent.join(", ")}`);

  // Diuji pada KODE, bukan pada komentar: komentar di sana memang menyebut
  // `to_jsonb(capped)` justru untuk menerangkan mengapa ia tidak dipakai.
  const code = history.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(code, /to_jsonb\(capped\)/, "proyeksi riwayat harus disebut satu per satu");
});

/* -- 3. Yang sudah dibuang tidak boleh kembali diam-diam -------------------- */

test("daftar checker tidak lagi ikut di setiap snapshot papan", () => {
  // Dibangun dari checker_master pada SETIAP snapshot — tiap lima belas detik,
  // per tablet — dan tidak pernah dibaca satu baris kode UI pun.
  const snapshot = fnBody("inbound_board_snapshot", "create or replace function inbound_history");
  assert.doesNotMatch(snapshot, /'checkers', checkers\.rows/);
  assert.doesNotMatch(snapshot, /from checker_master/);
  assert.doesNotMatch(read("js/store.js"), /state\.checkers/, "state papan tidak lagi menyimpannya");
});

test("master PO utuh tidak dapat dipanggil dari browser", () => {
  // 3,4 MB untuk menjawab pertanyaan yang jawabannya delapan baris. Pencariannya
  // dikerjakan Postgres lewat index trigram; pembungkus lamanya dibuang supaya
  // tidak ada yang memanggilnya karena kebetulan melihatnya.
  assert.doesNotMatch(read("js/api.js"), /export function fetchPoMaster/);
  assert.match(read("js/api.js"), /export function searchPoMaster/, "pencarian per kata tetap ada");
});

test("kesegaran sumber hanya membawa yang dibaca layar Pengaturan", () => {
  const freshness = fnBody("inbound_source_freshness", "-- 10b.");
  const sent = jsonKeys(freshness.slice(freshness.indexOf("select jsonb_build_object")));
  const readFields = payloadFields(fieldsRead(["js/pages/settings.js", "js/app.js"], ["source"]));
  const unread = [...sent].filter((f) => !readFields.has(f));
  assert.deepEqual(unread, [], `kesegaran sumber mengirim tanpa pembaca: ${unread.join(", ")}`);
});
