const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
// Normalisasi akhir baris: berkas dapat ter-checkout sebagai CRLF di Windows
// dan LF di CI Linux. Assertion pada teks sumber tidak boleh bergantung pada itu.
const read = (file) =>
  fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");

const InboundSites = require("../js/site_config.js");

const migration = read("supabase/migrations/20260831010000_inbound_multi_site.sql");
const appSource = read("js/app.js");
const apiSource = read("js/api_v2.js");
const supersetSync = read("supabase/functions/sync-superset/index.ts");

/** Gudang yang wajib dikenal sistem, sesuai permintaan operasional. */
const EXPECTED_SITES = [
  { code: "PGS", location_id: "160", name: "Pegangsaan", active: true },
  { code: "SRG", location_id: "796", name: "Srengseng", active: false },
  { code: "BIT", location_id: "983", name: "Bitung", active: false },
  { code: "CSI", location_id: "998", name: "Cileungsi", active: false },
];

test("registry gudang memuat PGS, SRG, BIT, dan CSI dengan location_id yang benar", () => {
  const actual = InboundSites.all().map((site) => ({
    code: site.code,
    location_id: site.location_id,
    name: site.name,
    active: site.active,
  }));
  assert.deepEqual(actual, EXPECTED_SITES);
});

test("PGS adalah satu-satunya gudang aktif sampai gudang lain dinyalakan", () => {
  const active = InboundSites.activeSites();
  assert.equal(active.length, 1);
  assert.equal(active[0].code, "PGS");
  assert.deepEqual(InboundSites.activeLocationIds(), ["160"]);
  assert.equal(InboundSites.defaultSite().code, "PGS");
});

test("seed site_master di SQL identik dengan registry frontend", () => {
  for (const site of EXPECTED_SITES) {
    const row = new RegExp(
      `\\('${site.code}',\\s*'${site.location_id}',\\s*'${site.name}'`,
    );
    assert.match(migration, row, `${site.code} harus di-seed dengan location_id ${site.location_id}`);
  }
  // PGS aktif, tiga gudang lain menunggu.
  assert.match(migration, /\('PGS', '160'[^)]*true,\s*1\)/);
  assert.match(migration, /\('SRG', '796'[^)]*false,\s*2\)/);
  assert.match(migration, /\('BIT', '983'[^)]*false,\s*3\)/);
  assert.match(migration, /\('CSI', '998'[^)]*false,\s*4\)/);
});

test("location_id dipetakan dua arah tanpa tabrakan", () => {
  for (const site of EXPECTED_SITES) {
    assert.equal(InboundSites.byLocationId(site.location_id).code, site.code);
    assert.equal(InboundSites.get(site.code).location_id, site.location_id);
  }
  assert.equal(InboundSites.byLocationId("819"), null, "CBT (819) tidak boleh dikenali lagi");
  const ids = InboundSites.all().map((site) => site.location_id);
  assert.equal(new Set(ids).size, ids.length, "location_id wajib unik");
});

test("gate dibangkitkan dari prefix gudang, bukan daftar CBT/STL hardcoded", () => {
  const pgs = InboundSites.gateNamesFor(InboundSites.get("PGS"));
  assert.equal(pgs.length, 9);
  assert.equal(pgs[0], "PGS-GATE-INB-01-01");
  assert.equal(pgs[8], "PGS-GATE-INB-01-09");
  assert.equal(InboundSites.gateLabel("PGS-GATE-INB-01-03"), "PGS 03");
  assert.equal(InboundSites.siteOfGate("PGS-GATE-INB-01-03").code, "PGS");

  assert.doesNotMatch(appSource, /"CBT-GATE-INB-01-01"/);
  assert.doesNotMatch(appSource, /"STL-GATE-INB-01-01"/);
  assert.doesNotMatch(appSource, /const GATES_V16 = \[/);
  assert.match(appSource, /window\.InboundSites\?\.gateOptions\?\.\(\)/);
});

test("katalog site_master dari backend menimpa registry frontend", () => {
  const applied = InboundSites.applyServerCatalog({
    sites: [
      { site_code: "PGS", location_id: "160", site_name: "Pegangsaan", gate_count: 9, gate_prefix: "PGS-GATE-INB-01" },
      { site_code: "SRG", location_id: "796", site_name: "Srengseng", gate_count: 6, gate_prefix: "SRG-GATE-INB-01" },
    ],
    gates: ["PGS-GATE-INB-01-01", "SRG-GATE-INB-01-01"],
  });
  assert.deepEqual(applied.map((site) => site.code), ["PGS", "SRG"]);
  assert.deepEqual(InboundSites.gateOptions("SRG"), ["SRG-GATE-INB-01-01"]);

  // Kembalikan ke kondisi awal supaya urutan pengujian tidak berpengaruh.
  InboundSites.applyServerCatalog({
    sites: [{ site_code: "PGS", location_id: "160", site_name: "Pegangsaan", gate_count: 9, gate_prefix: "PGS-GATE-INB-01" }],
    gates: [],
  });
  assert.deepEqual(InboundSites.activeSites().map((site) => site.code), ["PGS"]);
});

test("nomor antrian dan nomor BA di-scope per gudang", () => {
  // Urutan antrian harian tidak boleh tercampur antar gudang.
  assert.match(
    migration,
    /where operational_date = v_operational_date\s*\n\s*and site_code = v_site and ticket_type = v_ticket_type and slot = v_slot/,
  );
  assert.match(migration, /pg_advisory_xact_lock\(hashtext\(v_site \|\| '\|' \|\| v_operational_date::text/);

  // Nomor BA memakai kode gudang, bukan literal CBT.
  assert.match(migration, /v_ba_number:=lpad\(v_number::text,6,'0'\)\|\|'\/'\|\|v_site\|\|'\/'\|\|to_char\(v_date,'MM\/YYYY'\)/);
  assert.match(migration, /v_key:=v_site\|\|'-'\|\|to_char\(v_date,'YYYY-MM'\)/);
  assert.doesNotMatch(migration, /'\/CBT\/'/);
});

test("sync Superset hanya menyimpan PO milik gudang aktif", () => {
  // Filter dilakukan di Edge Function...
  assert.match(supersetSync, /siteByLocation\.has\(clean\(row\.location_id\)\)/);
  assert.match(supersetSync, /from\("site_master"\)[\s\S]*\.eq\("active", true\)/);
  // ...dan diverifikasi ulang di database sebagai sabuk pengaman.
  assert.match(migration, /Stage berisi location_id di luar gudang aktif/);
  assert.match(migration, /inbound_active_location_ids\(\)/);
  // Snapshot gudang non-aktif tidak boleh terhapus oleh sync gudang lain.
  assert.match(migration, /where m\.location_id = any\(v_active\)/);
  // View publik menyaring gudang non-aktif.
  assert.match(migration, /join public\.site_master s on s\.location_id = m\.location_id\s*\n\s*where s\.active/);
});

test("chart Superset dapat dipindahkan tanpa menyunting kode", () => {
  assert.match(supersetSync, /Deno\.env\.get\("SUPERSET_CHART_ID"\)/);
  assert.match(supersetSync, /tidak memuat satu pun location_id gudang aktif/);
});

test("tidak ada sisa identitas CBT / 819 di kode aplikasi", () => {
  const files = {
    "js/app.js": appSource,
    "js/api_v2.js": apiSource,
    "js/site_config.js": read("js/site_config.js"),
    "index.html": read("index.html"),
    "js/supabase_backend.js": read("js/supabase_backend.js"),
    "supabase/functions/inbound-api/index.ts": read("supabase/functions/inbound-api/index.ts"),
  };
  for (const [name, source] of Object.entries(files)) {
    assert.doesNotMatch(source, /inbound[_-]?cbt/i, `${name} masih memakai identitas CBT`);
    assert.doesNotMatch(source, /Inbound CBT/, `${name} masih menampilkan merek lama`);
  }
});

test("permintaan API selalu membawa kode gudang aktif", () => {
  assert.match(apiSource, /function currentSiteCode\(\)/);
  assert.match(apiSource, /url\.searchParams\.set\("site", site\)/);
  assert.match(apiSource, /body: JSON\.stringify\(\{ site_code: currentSiteCode\(\), \.\.\.payload \}\)/);
});

test("UI menyediakan pemilih gudang dan hanya muncul saat ada lebih dari satu", () => {
  const html = read("index.html");
  assert.match(html, /id="site-switcher"/);
  assert.match(html, /onchange="switchInboundSite\(this\.value\)"/);
  assert.match(appSource, /function renderSiteSwitcher\(\)/);
  assert.match(appSource, /if \(active\.length < 2\) \{/);
  // Berpindah gudang harus membuang snapshot dan cache gudang sebelumnya.
  assert.match(appSource, /window\.clearInboundEtagCache\?\.\(\)/);
});
