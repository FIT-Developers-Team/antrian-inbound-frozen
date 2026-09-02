/* ============================================================================
 * KONTRAK SLA
 *
 * Hitung mundur SLA adalah alasan aplikasi ini ada. Berkas ini menjaga dua
 * hal yang dulu berulang kali rusak: aturannya hanya ada satu tempat, dan
 * jamnya mulai berdetak pada peristiwa yang benar.
 * ========================================================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const { read, schema, allFrontend, importModule } = require("./helpers");

const migrations = schema();
const frontend = allFrontend();

test("aturan SLA hanya ada satu, di dalam database", () => {
  assert.match(
    migrations,
    /create or replace function inbound_sla_target_hours/,
    "Postgres harus memiliki fungsi target SLA",
  );

  // Jika salah satu pola ini muncul kembali di frontend, aturan SLA sudah
  // bercabang lagi seperti sebelum revamp — saat browser memakai VAN = 1 jam
  // sementara database memakai 2 jam.
  const forbidden = [
    /function\s+getInboundSlaHours/,
    /fleet\.includes\(["']CDD["']\)/,
    /sku\s*>\s*40\s*\?/,
    /targetHours\s*=\s*(?:1|2|4)\b/,
  ];
  forbidden.forEach((pattern) => {
    assert.doesNotMatch(frontend, pattern, `frontend tidak boleh menghitung ulang target SLA: ${pattern}`);
  });
});

test("tabel acuan di layar Pengaturan cocok dengan aturan database", async () => {
  const { FLEET_TYPES } = await importModule("js/config.js");
  const sql = migrations;

  // Nilai yang ditampilkan ke operator harus sama dengan yang ditegakkan
  // server, walaupun ia hanya bacaan.
  const expected = {
    "RODA 2": 1,
    MOBIL: 2,
    VAN: 2,
    PICKUP: 2,
    "L300 BOX": 2,
    "WING BOX": 4,
    "TRONTON/FUSO": 4,
    "DROP-OFF": 23,
  };
  Object.entries(expected).forEach(([fleet, hours]) => {
    const entry = FLEET_TYPES.find((item) => item.value === fleet);
    assert.ok(entry, `armada ${fleet} harus ada di daftar`);
    assert.equal(entry.slaHours, hours, `target SLA ${fleet} harus ${hours} jam`);
  });

  // Bentuknya memakai pemanggilan fungsi berulang, bukan alias `f` dari sebuah
  // klausa `from`: klausa itulah yang membuat Postgres menolak menyisipkan
  // fungsi ini ke kueri pemanggilnya, dan tanpa penyisipan satu snapshot papan
  // pada dua puluh ribu tiket memakan 25 detik.
  // Spasi dirapatkan lebih dulu supaya perataan kolom di SQL boleh berubah
  // tanpa membuat test ini gagal karena alasan yang bukan soal aturan SLA.
  const flat = sql.replace(/\s+/g, " ");
  const canonical = "inbound_fleet_canonical(p_fleet)";
  [
    [`when ${canonical} = 'RODA 2' then 1`, "RODA 2 = 1 jam di database"],
    [`when ${canonical} in ('VAN', 'PICKUP', 'MOBIL', 'L300 BOX') then 2`, "kelompok 2 jam"],
    [`when ${canonical} in ('TRONTON/FUSO', 'WING BOX') then 4`, "kelompok 4 jam"],
    [`when ${canonical} = 'DROP-OFF' then 23`, "DROP-OFF = 23 jam"],
  ].forEach(([clause, message]) => {
    assert.ok(flat.includes(clause), `${message} — tidak ditemukan: ${clause}`);
  });
});

test("aturan SKU CDD memakai batas lebih dari 40", () => {
  assert.match(
    migrations,
    /coalesce\(p_sku, 0\) > 40 then 4 else 2/,
    "SKU tepat 40 masih masuk tier 2 jam",
  );
});

test("hitung mundur dianggap belum mulai sebelum bongkar dimulai", async () => {
  const { slaState } = await importModule("js/sla.js");
  const state = slaState({ sla_target_hours: 4, sla_deadline_at: null, sla_started_at: null });
  assert.equal(state.phase, "idle");
  assert.match(state.label, /4 jam/);
});

test("armada tanpa target SLA tidak pernah tampak terlambat", async () => {
  const { slaState } = await importModule("js/sla.js");
  const state = slaState({ sla_target_hours: 0, sla_started_at: "2026-09-01T01:00:00Z" });
  assert.equal(state.phase, "none");
});

test("hitung mundur berjalan dari tenggat yang dikirim server", async () => {
  const { slaState } = await importModule("js/sla.js");
  const now = new Date("2026-09-01T10:00:00Z");
  const state = slaState(
    {
      sla_target_hours: 4,
      sla_started_at: "2026-09-01T08:00:00Z",
      sla_deadline_at: "2026-09-01T12:00:00Z",
    },
    now,
  );
  assert.equal(state.phase, "running");
  assert.equal(state.seconds, 2 * 3600);
  assert.equal(state.label, "2j 00m");
});

test("peringatan muncul pada 30 menit terakhir, bukan setelah terlambat", async () => {
  const { slaState } = await importModule("js/sla.js");
  const base = {
    sla_target_hours: 2,
    sla_started_at: "2026-09-01T08:00:00Z",
    sla_deadline_at: "2026-09-01T10:00:00Z",
  };
  assert.equal(slaState(base, new Date("2026-09-01T09:29:00Z")).phase, "running");
  assert.equal(slaState(base, new Date("2026-09-01T09:31:00Z")).phase, "warning");
  assert.equal(slaState(base, new Date("2026-09-01T10:01:00Z")).phase, "breached");
});

test("keterlambatan dihitung naik, bukan berhenti di nol", async () => {
  const { slaState } = await importModule("js/sla.js");
  const state = slaState(
    {
      sla_target_hours: 2,
      sla_started_at: "2026-09-01T08:00:00Z",
      sla_deadline_at: "2026-09-01T10:00:00Z",
    },
    new Date("2026-09-01T10:45:00Z"),
  );
  assert.equal(state.phase, "breached");
  assert.equal(state.label, "+45:00");
});

test("SLA berhenti dihitung saat pekerjaan selesai, bukan terus berjalan", async () => {
  const { slaState } = await importModule("js/sla.js");
  const met = slaState(
    {
      sla_target_hours: 2,
      sla_started_at: "2026-09-01T08:00:00Z",
      sla_deadline_at: "2026-09-01T10:00:00Z",
      sla_stopped_at: "2026-09-01T09:30:00Z",
    },
    new Date("2026-09-01T23:00:00Z"),
  );
  assert.equal(met.phase, "met");
  assert.equal(met.final, true);

  const missed = slaState(
    {
      sla_target_hours: 2,
      sla_started_at: "2026-09-01T08:00:00Z",
      sla_deadline_at: "2026-09-01T10:00:00Z",
      sla_stopped_at: "2026-09-01T10:20:00Z",
    },
    new Date("2026-09-01T23:00:00Z"),
  );
  assert.equal(missed.phase, "missed");
  assert.equal(missed.label, "+20:00");
});

test("format durasi memakai jam-menit di atas satu jam dan menit-detik di bawahnya", async () => {
  const { formatDuration } = await importModule("js/format.js");
  assert.equal(formatDuration(3600 * 2 + 60 * 14), "2j 14m");
  assert.equal(formatDuration(60 * 14 + 32), "14:32");
  assert.equal(formatDuration(0), "00:00");
});

test("elemen hitung mundur membawa datanya sendiri agar ticker tidak me-render ulang", async () => {
  const { slaMarkup } = await importModule("js/sla.js");
  const html = slaMarkup({
    sla_target_hours: 4,
    sla_started_at: "2026-09-01T08:00:00Z",
    sla_deadline_at: "2026-09-01T12:00:00Z",
  });
  assert.match(html, /data-sla="1"/);
  assert.match(html, /data-sla-deadline="2026-09-01T12:00:00Z"/);
  assert.match(html, /class="sla-value"/);
});

test("satu ticker bersama menggantikan interval berlapis dan berhenti saat tab tersembunyi", () => {
  const source = read("js/sla.js");
  const intervals = source.match(/setInterval\(/g) || [];
  assert.equal(intervals.length, 1, "hanya boleh ada satu setInterval di seluruh mesin hitung mundur");
  assert.match(source, /visibilitychange/, "ticker harus berhenti saat tab tersembunyi");
  assert.match(source, /document\.hidden\)\s*stopTicker\(\)/);
});

test("jam SLA mulai pada bongkar, bukan pada pendaftaran", () => {
  assert.match(
    migrations,
    /t\.start_unloading_at as sla_started_at/,
    "sla_started_at harus berasal dari start_unloading_at",
  );
  assert.doesNotMatch(
    read("js/sla.js"),
    /created_at|register_time/,
    "browser tidak boleh memakai jam registrasi sebagai awal SLA",
  );
});
