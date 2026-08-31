const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const api = read("supabase/functions/inbound-api/index.ts");
const http = read("supabase/functions/_shared/http.ts");
const gsheet = read("supabase/functions/sync-gsheet/index.ts");
const superset = read("supabase/functions/sync-superset/index.ts");
const perf = read("supabase/migrations/20260831011000_inbound_performance.sql");
const multiSite = read("supabase/migrations/20260831010000_inbound_multi_site.sql");
const cron = read("supabase/migrations/20260831012000_inbound_cron_hardening.sql");
const frontend = read("js/api_v2.js");

test("polling operasional tidak lagi menyeret seluruh master PO", () => {
  // `state` memakai snapshot operasional; master PO punya action tersendiri.
  assert.match(api, /action === "state"[\s\S]{0,200}inbound_operational_snapshot/);
  assert.match(api, /action === "po_master"/);

  const snapshot = perf.slice(
    perf.indexOf("function public.inbound_operational_snapshot"),
    perf.indexOf("function public.inbound_operational_delta"),
  );
  assert.ok(snapshot.length > 0, "RPC snapshot operasional harus ada");
  assert.doesNotMatch(
    snapshot,
    /superset_po_public|superset_po_master/,
    "snapshot operasional tidak boleh menyertakan master PO",
  );
  assert.match(snapshot, /'outputForm', payload\.rows/);

  // Frontend memisahkan kedua permintaan dan hanya mengambil master saat perlu.
  assert.match(frontend, /async function fetchPoMasterData\(\)/);
  assert.match(frontend, /inboundApiGet\("state", \{\}, \{ useEtag: true \}\)/);
  assert.match(frontend, /inboundApiGet\("po_master", \{\}, \{ useEtag: true \}\)/);
  assert.match(frontend, /const \[operational, poMaster\] = await Promise\.all\(/);
});

test("snapshot dibatasi jendela hari operasional yang dapat dikonfigurasi", () => {
  assert.match(perf, /greatest\(least\(coalesce\(p_days_back, 7\), 90\), 0\) as days_back/);
  assert.match(perf, /r\.operational_date::date >= b\.today - b\.days_back/);
  // Baris tanpa tanggal operasional (data lama) tetap ikut, bukan hilang diam-diam.
  assert.match(perf, /r\.operational_date is null/);
  assert.match(api, /INBOUND_SNAPSHOT_DAYS_BACK/);
  assert.match(api, /Math\.min\(Math\.max\(Math\.trunc\(raw\), 0\), 90\)/);
});

test("respons ber-fingerprint memakai ETag sehingga polling tanpa perubahan dijawab 304", () => {
  assert.match(http, /export function weakEtag/);
  assert.match(http, /export function matchesEtag/);
  assert.match(http, /status === 204 \|\| status === 304 \? null : JSON\.stringify\(body\)/);
  // Tanpa expose-headers, browser tidak dapat membaca ETag lintas asal.
  assert.match(http, /"access-control-expose-headers": "etag/);
  assert.match(http, /"access-control-allow-headers": "[^"]*if-none-match/);

  assert.match(api, /function fingerprinted\(/);
  assert.match(api, /if \(matchesEtag\(request, etag\)\) return notModifiedResponse\(request, etag\)/);
  // Master PO menghitung fingerprint dulu supaya payload berat tidak dibangun sia-sia.
  assert.match(api, /inbound_po_master_fingerprint/);
  assert.match(perf, /function public\.inbound_po_master_fingerprint/);

  assert.match(frontend, /headers\["If-None-Match"\] = cached\.etag/);
  assert.match(frontend, /if \(response\.status === 304 && cached\) return cloneCachedPayload\(cached\.data\)/);
  // Entri cache dikembalikan sebagai salinan; pemanggil yang memodifikasi
  // hasil tidak boleh ikut mencemari isi cache.
  assert.match(frontend, /function cloneCachedPayload\(value\)/);
  assert.match(frontend, /inboundEtagCache\.set\(cacheKey, \{ etag, data: cloneCachedPayload\(data\) \}\)/);
  // Setiap mutasi wajib membuang cache agar tidak menampilkan data basi.
  assert.match(frontend, /clearInboundEtagCache\(\);\s*\n\s*return json\.data \|\| json;/);
});

test("outbox GSheet diselesaikan per batch, bukan satu UPDATE per baris", () => {
  assert.match(perf, /function public\.inbound_claim_gsheet_batch/);
  assert.match(perf, /function public\.inbound_settle_gsheet_batch/);
  // SKIP LOCKED mencegah dua worker mengirim baris yang sama ke Google.
  assert.match(perf, /for update skip locked/);
  assert.match(perf, /where ticket_po_id = any\(p_ticket_po_ids\)/);

  assert.match(gsheet, /inbound_claim_gsheet_batch/);
  assert.match(gsheet, /inbound_settle_gsheet_batch/);
  assert.doesNotMatch(gsheet, /for \(const id of ids\)/, "loop update per baris harus hilang");
});

test("baris outbox yang menggantung dapat dicoba ulang", () => {
  // Versi lama menyetel PROCESSING lalu tidak pernah mengembalikannya saat gagal,
  // sehingga baris tersebut hilang dari antrean selamanya.
  assert.match(perf, /function public\.inbound_reap_stuck_gsheet/);
  assert.match(perf, /where sync_status='PROCESSING' and updated_at < now\(\) - p_older_than/);
  assert.match(gsheet, /inbound_reap_stuck_gsheet/);
  assert.match(gsheet, /p_success: false, p_error: message/);
  assert.match(cron, /inbound-reap-gsheet-15m/);
});

test("pagination memakai tiebreaker unik", () => {
  // ORDER BY tanpa kolom unik dapat melewatkan atau menduplikasi baris antar halaman.
  assert.match(api, /tiebreaker = ""/);
  assert.match(api, /if \(tiebreaker\) query = query\.order\(tiebreaker, \{ ascending: true \}\)/);
  assert.match(api, /fetchAll\("inbound_operational_rows", "\*", "created_at", false, "ticket_po_id"\)/);
});

test("sync Superset melakukan hashing dan upsert secara paralel serta membersihkan stage yang gagal", () => {
  assert.match(superset, /await Promise\.all\(scoped\.map\(async \(row\)/);
  assert.match(superset, /CHUNK_CONCURRENCY/);
  assert.match(superset, /Promise\.all\(batch\.map\(\(chunk\) => db\.from\("superset_po_stage"\)\.upsert\(chunk\)\)\)/);
  // Baris kembar dalam satu run akan menabrak primary key (run_id, source_row_key).
  assert.match(superset, /new Map\(staged\.map\(\(row\) => \[row\.source_row_key, row\]\)\)/);
  // Stage run gagal harus dibuang, kalau tidak tabel stage terus tumbuh.
  assert.match(superset, /from\("superset_po_stage"\)\.delete\(\)\.eq\("run_id", runId\)/);
});

test("index tersedia untuk jalur kueri yang panas", () => {
  const indexes = [
    "tickets_site_operational_idx",
    "tickets_site_status_idx",
    "tickets_updated_idx",
    "superset_po_site_idx",
    "superset_po_location_idx",
    "ba_documents_site_date_idx",
  ];
  for (const name of indexes) {
    assert.match(multiSite, new RegExp(`create index if not exists ${name}`), `${name} hilang`);
  }
  assert.match(perf, /create index if not exists gsheet_outbox_pending_idx/);
  // Index parsial hanya mencakup baris yang benar-benar diambil worker.
  assert.match(perf, /where sync_status in \('PENDING','FAILED'\)/);
});

test("regex project ref Supabase menerima ref yang mengandung angka", () => {
  assert.match(cron, /\^https:\/\/\[a-z0-9\]\[a-z0-9-\]\*\\\.supabase\\\.co/);
  assert.match(cron, /timeout_milliseconds/);
});

test("health check memakai satu RPC, bukan hitungan tabel penuh", () => {
  assert.match(api, /action === "health"[\s\S]{0,120}inbound_health/);
  assert.match(perf, /function public\.inbound_health/);
  assert.match(perf, /'gsheet_backlog'/);
  assert.match(perf, /'last_superset_sync'/);
});

test("CORS tidak memantulkan asal yang tidak terdaftar", () => {
  assert.match(
    http,
    /allowed\.length === 0 \? "\*" : \(allowed\.includes\(origin\) \? origin : allowed\[0\]\)/,
  );
  assert.match(http, /"vary": "Origin, Accept-Encoding, If-None-Match"/);
});
