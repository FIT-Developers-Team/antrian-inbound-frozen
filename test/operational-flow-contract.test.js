const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
// Normalisasi akhir baris: berkas dapat ter-checkout sebagai CRLF di Windows
// dan LF di CI Linux. Assertion pada teks sumber tidak boleh bergantung pada itu.
const read = (file) =>
  fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");

const app = read("js/app.js");
const api = read("js/api_v2.js");
const css = read("style.css");
const edge = read("supabase/functions/inbound-api/index.ts");
const gsheet = read("supabase/functions/sync-gsheet/index.ts");
const sla = read("supabase/migrations/20260901010000_inbound_sla_and_arrival.sql");

/**
 * Menjalankan blok V25 di sandbox agar logika SLA benar-benar dieksekusi,
 * bukan sekadar dicocokkan dengan regex.
 */
function loadV25() {
  const start = app.indexOf("(function installInboundOperationsV25()");
  assert.ok(start > 0, "blok V25 harus ada di js/app.js");
  const source = app.slice(start);

  const listeners = [];
  const context = {
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    Map,
    esc: (value) => String(value ?? ""),
    state: { dashboard: { queue: [] }, options: {} },
    parseInboundDateSafe: (value) => {
      if (!value) return null;
      const parsed = value instanceof Date ? value : new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    },
    // Aturan armada versi browser; dipakai hanya sebagai cadangan.
    getInboundSlaHours: (row) => {
      const fleet = String(row.fleet_type || "").toUpperCase();
      const sku = Number(row.ticket_total_sku || row.count_po_sku || 0);
      if (fleet.includes("FUSO") || fleet.includes("WING")) return 4;
      if (["CDD", "CDDL", "CDE", "CDEL"].some((x) => fleet.includes(x))) return sku > 40 ? 4 : 2;
      if (["VAN", "PICKUP", "MOBIL", "L300"].some((x) => fleet.includes(x))) return 2;
      if (fleet.includes("RODA 2")) return 1;
      if (fleet.includes("DROP")) return 23;
      return 0;
    },
    // Fungsi yang di-override blok V25; di browser semuanya sudah ada saat
    // blok ini dijalankan.
    renderPage: () => {},
    checkerTicketCard: () => "<article></article>",
    startLiveWaitingTimer: () => {},
    refreshLiveWaitingCells: () => {},
    getInboundSlaInfo: () => ({}),
    showToast: () => {},
    getAuthUser: () => ({ role: "SPV", display_name: "SPV", username: "spv" }),
    motherDuckApiPost: async () => ({}),
    replaceOutputRowsInRawResponse: () => {},
    liveWaitingTimer: null,
    document: {
      addEventListener: (name, fn) => listeners.push([name, fn]),
      querySelectorAll: () => [],
      getElementById: () => null,
      visibilityState: "visible",
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context;
}

const MINUTE = 60000;
const agoIso = (minutes) => new Date(Date.now() - minutes * MINUTE).toISOString();

test("hitung mundur SLA hidup kembali — sebelumnya selalu 'Belum mulai'", () => {
  const ctx = loadV25();

  // Bug lama: getInboundSlaInfoV15 memanggil `getSlaHours()` yang tidak pernah
  // didefinisikan dan membaca `row.sla_target_hours` yang tidak pernah dikirim
  // backend, sehingga target selalu 0 dan setiap tiket melaporkan "Belum mulai".
  assert.doesNotMatch(app, /getSlaHours\(row\.fleet_type, row\.count_po_sku\)/);

  const state = ctx.slaStateV25({
    status: "UNLOADING",
    fleet_type: "TRONTON/FUSO",
    ticket_total_sku: 12,
    start_unloading_at: agoIso(90),
  });
  assert.equal(state.phase, "RUNNING");
  assert.equal(state.target_hours, 4);
  // 4 jam target dikurangi 90 menit berjalan menyisakan sekitar 2j 30m.
  assert.match(state.label, /^Sisa 2j 2\dm$/);
  assert.equal(state.tone, "success");
});

test("target SLA dari server selalu mengalahkan aturan di browser", () => {
  const ctx = loadV25();
  const state = ctx.slaStateV25({
    status: "UNLOADING",
    fleet_type: "TRONTON/FUSO", // aturan browser akan bilang 4 jam
    sla_target_hours: 3, // server bilang 3 jam
    start_unloading_at: agoIso(30),
  });
  assert.equal(state.target_hours, 3);
});

test("aturan SKU CDD memakai batas 'lebih dari 40'", () => {
  const ctx = loadV25();
  const at = (sku) =>
    ctx.slaStateV25({ status: "UNLOADING", fleet_type: "CDD", ticket_total_sku: sku,
      start_unloading_at: agoIso(10) }).target_hours;
  assert.equal(at(12), 2);
  assert.equal(at(40), 2, "SKU tepat 40 masih tier 2 jam");
  assert.equal(at(41), 4);
});

test("fase SLA mencerminkan keadaan operasional sebenarnya", () => {
  const ctx = loadV25();
  const phase = (row) => ctx.slaStateV25(row).phase;

  assert.equal(phase({ status: "CALLED", fleet_type: "CDD" }), "WAITING",
    "belum bongkar berarti hitung mundur belum jalan");
  assert.equal(phase({ status: "EXPIRED", fleet_type: "CDD", expired_at: agoIso(5) }), "EXPIRED");
  assert.equal(phase({ status: "UNLOADING", fleet_type: "SEPEDA" }), "NO_SLA",
    "armada tanpa aturan tidak boleh dinilai");
  assert.equal(
    phase({ status: "COMPLETED", fleet_type: "CDD", start_unloading_at: agoIso(160),
      sla_stopped_at: agoIso(70) }),
    "DONE",
  );
});

test("peringatan muncul pada 30 menit terakhir, bukan hanya setelah terlambat", () => {
  const ctx = loadV25();
  const tone = (minutesRunning) =>
    ctx.slaStateV25({ status: "UNLOADING", fleet_type: "CDD", ticket_total_sku: 10,
      start_unloading_at: agoIso(minutesRunning) }).tone;
  assert.equal(tone(60), "success", "masih 1 jam tersisa");
  assert.equal(tone(100), "warning", "tersisa 20 menit");
  assert.equal(tone(140), "error", "sudah lewat target");
});

test("SLA berhenti dihitung saat pekerjaan selesai, bukan terus berjalan", () => {
  const ctx = loadV25();
  const done = ctx.slaStateV25({
    status: "COMPLETED", fleet_type: "CDD", ticket_total_sku: 10,
    start_unloading_at: agoIso(300), sla_stopped_at: agoIso(210),
  });
  // 300 - 210 = 90 menit kerja, di bawah target 2 jam.
  assert.equal(done.status, "SLA OK");
  assert.equal(Math.round(done.elapsed_ms / MINUTE), 90);
});

test("format durasi memakai jam-menit di atas satu jam dan menit:detik di bawahnya", () => {
  const ctx = loadV25();
  assert.equal(ctx.formatDurationV25(2 * 3600000 + 29 * MINUTE), "2j 29m");
  assert.equal(ctx.formatDurationV25(19 * MINUTE + 59000), "19:59");
  assert.equal(ctx.formatDurationV25(5000), "00:05");
});

test("elemen hitung mundur membawa datanya sendiri agar ticker tidak me-render ulang", () => {
  const ctx = loadV25();
  const html = ctx.slaCountdownHtml({
    status: "UNLOADING", fleet_type: "CDD", ticket_total_sku: 10,
    start_unloading_at: agoIso(30),
  });
  assert.match(html, /data-sla-countdown="1"/);
  assert.match(html, /data-sla-deadline="\d+"/);
  assert.match(html, /data-sla-target-hours="2"/);
  assert.match(html, /class="sla-countdown sla-tone-ok/);
  assert.match(css, /\.sla-countdown \{/);
  for (const tone of ["sla-tone-idle", "sla-tone-ok", "sla-tone-warn", "sla-tone-late"]) {
    assert.match(css, new RegExp(`\\.${tone} \\{`), `${tone} harus punya gaya`);
  }
});

test("satu ticker bersama menggantikan tiga interval satu detik dan berhenti saat tab tersembunyi", () => {
  // Sebelumnya liveWaitingTimer, __wmLiveSlaTimer, dan driverTrackTimer berjalan
  // bersamaan tanpa pernah berhenti — pemborosan daya di layar TV dan ponsel.
  assert.match(app, /window\.inboundRegisterTick = function inboundRegisterTick/);
  assert.match(app, /if \(tickTimer \|\| document\.visibilityState === "hidden"\) return;/);
  assert.match(app, /if \(document\.visibilityState === "hidden"\) stopSharedTicker\(\);/);
  assert.match(app, /window\.__wmLiveSlaTimer\)\s*\{\s*\n\s*clearInterval\(window\.__wmLiveSlaTimer\)/);
  assert.match(app, /window\.inboundRegisterTick\("sla-countdown", refreshSlaCountdownCells\)/);
});

/* ==========================================================================
 * Jam kedatangan
 * ========================================================================== */

test("form Security punya input jam kedatangan yang tidak bisa diisi masa depan", () => {
  assert.match(app, /function arrivalFieldHtmlV25/);
  assert.match(app, /name="arrived_at" id="security-arrived-at-v25"/);
  assert.match(app, /max="\$\{esc\(toLocalInputValueV25\(\)\)\}"/);
  assert.match(app, /onclick="setArrivalFieldToNowV25\(\)"/);
  assert.match(css, /\.arrival-input-row \{/);
});

test("jam kedatangan ikut terkirim saat ticket dibuat", () => {
  assert.match(api, /arrived_at: master\.arrived_at \|\| globalThis\.getSecurityArrivalValueV25\?\.\(\) \|\| ""/);
  // Backend menerima dan memvalidasinya.
  assert.match(sla, /v_arrived := coalesce\(nullif\(btrim\(v_ticket->>'arrived_at'\), ''\)::timestamptz, now\(\)\)/);
  assert.match(sla, /Jam kedatangan tidak boleh melewati waktu sekarang/);
});

test("kedatangan dapat dikoreksi untuk ticket yang sudah ada", () => {
  assert.match(app, /window\.setArrivalForTicketV25 = async function setArrivalForTicketV25/);
  assert.match(app, /motherDuckApiPost\("set_arrival"/);
  assert.match(sla, /function public\.inbound_set_arrival/);
  assert.match(edge, /action === "set_arrival"/);
  // Security di pos masuk harus bisa mencatatnya sendiri.
  assert.match(edge, /if \(action === "set_arrival"\) return \["SECURITY", "CHECKER", "SPV", "ADMIN", "DEVELOPER"\]/);
});

test("jam kedatangan dibaca dengan parser tanggal Indonesia, bukan new Date", () => {
  // Queue menyimpan tanggal sebagai teks "DD/MM/YYYY HH:MM:SS"; new Date()
  // membacanya sebagai bulan/hari dan menghasilkan tanggal yang salah.
  const card = app.slice(app.indexOf("function checkerTicketCardV25"));
  assert.doesNotMatch(card.slice(0, 2500), /new Date\(row\.arrived_at\)/);
  assert.match(app, /const arrivedMs = timeOf\(row\.arrived_at \|\| row\.waiting_started_at\)/);
});

test("waktu tunggu driver dihitung dari kedatangan, bukan jam input data", () => {
  assert.match(sla, /coalesce\(t\.arrived_at, t\.created_at\) as waiting_started_at/);
  assert.match(gsheet, /row\.waiting_started_at \|\| row\.arrived_at \|\| row\.created_at/);
});

/* ==========================================================================
 * Trigger mulai bongkar
 * ========================================================================== */

test("mulai bongkar tersedia sebagai satu aksi, bukan pilih PO satu per satu", () => {
  assert.match(sla, /function public\.inbound_start_unloading/);
  assert.match(edge, /action === "start_unloading"/);
  assert.match(app, /window\.startUnloadingTicketV25 = async function startUnloadingTicketV25/);
  // Seluruh PO yang masih PENDING dimulai sekaligus.
  assert.match(sla, /where ticket_id = v_id and upper\(coalesce\(checker_status, 'PENDING'\)\) = 'PENDING'/);
});

test("mulai bongkar bersifat idempoten dan tidak memperpanjang SLA", () => {
  // Menekan tombol dua kali tidak boleh menggeser jam mulai, karena itu akan
  // memundurkan deadline SLA secara diam-diam.
  assert.match(sla, /v_started := coalesce\(v_ticket\.start_unloading_at, v_started\)/);
  assert.match(sla, /sudah % dan tidak dapat dimulai ulang/);
});

test("mulai bongkar mengisi kedatangan dan panggilan bila belum tercatat", () => {
  assert.match(sla, /arrived_at = coalesce\(arrived_at, v_started\)/);
  assert.match(sla, /called_at = coalesce\(called_at, v_started\)/);
});

test("gate wajib ditentukan sebelum bongkar dimulai", () => {
  const fn = app.slice(
    app.indexOf("async function startUnloadingTicketV25"),
    app.indexOf("// 7. AKSI CEPAT DI KARTU CHECKER"),
  );
  assert.match(fn, /if \(!gate\) \{/);
  assert.match(fn, /if \(!gate\) return showToast\("Gate tidak dikenali\."/);
  // Konfirmasi menyebutkan target SLA supaya operator sadar hitung mundur mulai.
  assert.match(fn, /Target SLA: \$\{targetHours\} jam/);
});

test("Mulai Bongkar hanya menjadi aksi utama setelah driver dipanggil", () => {
  // Dua tombol biru sejajar pada kartu WAITING membuat operator ragu.
  assert.match(app, /const emphasis = status === "CALLED" \? " v25-action-primary" : ""/);
  assert.match(css, /\.v25-action-primary \{/);
});

/* ==========================================================================
 * Satu sumber kebenaran SLA
 * ========================================================================== */

test("aturan SLA hanya ada satu, di database", () => {
  assert.match(sla, /function public\.inbound_sla_target_hours/);
  assert.match(sla, /when f in \('TRONTON\/FUSO', 'WING BOX'\)\s*then 4/);
  assert.match(sla, /when f = 'RODA 2'\s*then 1/);
  assert.match(sla, /when f = 'DROP-OFF'\s*then 23/);

  // sync-gsheet dahulu memakai aturannya sendiri yang berbeda dari layar:
  // VAN/PICKUP/MOBIL/L300 1 jam di sheet tetapi 2 jam di UI, dan RODA 2 serta
  // DROP-OFF dianggap tanpa SLA sama sekali.
  assert.match(gsheet, /const target = Number\(row\.sla_target_hours \|\| 0\)/);
  assert.doesNotMatch(gsheet, /fleet\.includes\("FUSO"\)/);
  assert.doesNotMatch(gsheet, /"PICK UP", "L300 BOX"/);
});

test("view operasional membawa jam SLA yang sudah dihitung server", () => {
  for (const column of [
    "sla_target_hours",
    "sla_deadline_at",
    "sla_started_at",
    "sla_stopped_at",
    "waiting_started_at",
  ]) {
    assert.match(sla, new RegExp(`as ${column}\\b`), `kolom ${column} hilang dari view`);
  }
});

test("kolom baru dipetakan sampai ke layar, tidak tersaring daftar putih", () => {
  // mapOutputPoRowV15 adalah daftar putih; kolom yang tidak disebut akan hilang
  // sebelum sampai ke komponen.
  for (const field of [
    "arrived_at",
    "waiting_started_at",
    "sla_started_at",
    "sla_stopped_at",
    "sla_deadline_at",
  ]) {
    assert.match(api, new RegExp(`^\\s+${field}: dateField\\(`, "m"), `${field} tidak dipetakan`);
  }
  // Satu tiket punya satu kedatangan walaupun barisnya terpecah per PO.
  assert.match(api, /arrived_at: earliestDateTextV15\(poRows\.map\(\(row\) => row\.arrived_at\)\)/);
  assert.match(api, /sla_stopped_at: latestDateTextV15\(poRows\.map\(\(row\) => row\.sla_stopped_at\)\)/);
});

test("tab section Checker tetap satu baris di layar sempit", () => {
  // Sticky header setinggi 181px menutupi kolom pencarian di bawah 640px.
  assert.match(css, /@media \(max-width: 639px\) \{\s*\n\s*\.checker-tabs-v15 > \.grid \{/);
  assert.match(css, /overflow-x: auto;/);
});

/* ==========================================================================
 * Efisiensi: polling adaptif dan sync yang menembak gudang secara langsung
 * ========================================================================== */

test("polling melambat saat sepi dan kembali cepat saat ada kegiatan", () => {
  // ETag sudah membuat siklus sepi tidak mengirim body, tetapi setiap siklus
  // tetap membangunkan radio perangkat. Layar TV yang menyala semalaman adalah
  // kasus yang paling diuntungkan.
  assert.match(api, /const IDLE_STEP_MS = 10000;/);
  assert.match(api, /const MAX_INTERVAL_MS = 60000;/);
  assert.match(api, /const IDLE_GRACE_CYCLES = 3;/);
  assert.match(api, /const next = Math\.min\(INTERVAL_MS \+ steps \* IDLE_STEP_MS, MAX_INTERVAL_MS\)/);

  // Sinkron paksa berasal dari aksi operator; menekan Refresh berkali-kali
  // tidak boleh justru mendorong polling ke jeda paling lambat.
  assert.match(api, /idleCycles = changed \|\| forced \? 0 : idleCycles \+ 1;/);
  assert.match(api, /applyAdaptiveIntervalV11\(changed, forceUi\)/);
});

test("polling berhenti saat tab tidak terlihat", () => {
  assert.match(api, /document\.visibilityState === "hidden"/);
});

test("sync Superset meminta gudang aktif secara langsung, bukan menyaring belakangan", () => {
  const superset = read("supabase/functions/sync-superset/index.ts");
  // Filter lokasi lama menempel di saved chart (CBT/819); menyalinnya apa adanya
  // akan terus menarik gudang yang salah.
  assert.match(superset, /function withSiteFilter/);
  assert.match(superset, /existing\.filter\(\(filter\) => clean\(filter\?\.col\) !== column\)/);
  assert.match(superset, /\{ col: column, op: "IN", val: locationIds \}/);
  assert.match(superset, /\$\{baseUrl\}\/api\/v1\/chart\/data/);
  assert.match(superset, /Deno\.env\.get\("SUPERSET_LOCATION_COLUMN"\)/);

  // Cadangan tetap ada bila chart tidak menyimpan query_context.
  assert.match(superset, /async function fetchRowsFromSavedChart/);
  assert.match(superset, /mode: "saved_chart"/);
  // Jalur mana yang terpakai harus terlihat di respons.
  assert.match(superset, /fetch_mode: mode/);
});

test("hitung mundur live dipakai di monitor dan waiting list, bukan teks statis", () => {
  assert.match(app, /<td>\$\{slaCountdownHtml\(row\)\}<\/td>/);
  assert.match(app, /\$\{slaCountdownHtml\(ticket\)\}/);
  assert.match(app, /<td class="px-4 py-3 whitespace-nowrap">\$\{slaCountdownHtml\(r\)\}<\/td>/);
});
