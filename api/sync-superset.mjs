/* ============================================================================
 * SINKRONISASI MASTER PO DARI SUPERSET
 *
 * Menggantikan pasangan `pg_cron` + `pg_net` milik Supabase. Penjadwalnya kini
 * timer di dalam proses API.
 *
 * Itu bukan sekadar pemindahan: sebelumnya kegagalan sync terjadi di dalam
 * Postgres, dan satu-satunya jejaknya adalah baris di tabel `sync_runs`.
 * Sekarang kegagalan muncul di log kontainer yang sama dengan sisa aplikasi,
 * dan cookie Superset yang kedaluwarsa — penyebab tersering sync membeku —
 * terlihat pada percobaan pertama, bukan berjam-jam kemudian.
 * ========================================================================== */

const INTERVAL_MS = Number(process.env.SUPERSET_SYNC_INTERVAL_MS) || 5 * 60_000;

/**
 * Batas waktu permintaan ke Superset.
 *
 * `fetch` tanpa batas waktu menunggu selamanya. Superset yang menggantung —
 * bukan yang mati, yang menggantung — karena itu membekukan sync tanpa satu pun
 * baris di log, dan `sync_runs` menyimpan baris RUNNING yang tidak pernah
 * selesai. Setiap interval berikutnya menambah satu lagi.
 */
const FETCH_TIMEOUT_MS = Number(process.env.SUPERSET_FETCH_TIMEOUT_MS) || 45_000;

/** Baris per pernyataan insert. Lihat catatan di writeRows(). */
const BATCH_SIZE = 500;
const CHART_ID = process.env.SUPERSET_CHART_ID || "20662";
const LOCATION_COLUMN = process.env.SUPERSET_LOCATION_COLUMN || "location_id";
const BASE_URL = (process.env.SUPERSET_BASE_URL || "https://dash.astronauts.id").replace(/\/$/, "");

function enabled() {
  return Boolean(process.env.SUPERSET_SESSION_COOKIE);
}

function timeoutSignal() {
  return AbortSignal.timeout(FETCH_TIMEOUT_MS);
}

function headers() {
  const cookie = String(process.env.SUPERSET_SESSION_COOKIE || "").trim();
  return {
    accept: "application/json",
    cookie: cookie.startsWith("session=") ? cookie : `session=${cookie}`,
    referer: `${BASE_URL}/`,
  };
}

function rowsFromPayload(payload) {
  const rows = payload?.result?.[0]?.data;
  return Array.isArray(rows) ? rows : [];
}

/**
 * Menyuntikkan filter gudang ke query_context chart.
 *
 * Filter lokasi lama menempel pada saved chart, sehingga memakainya apa adanya
 * akan terus menarik gudang yang salah. Filter pada kolom lokasi dibuang lalu
 * diganti daftar location_id gudang aktif, sehingga permintaan benar-benar
 * meminta PGS (160) ke Superset, bukan sekadar menyaring hasilnya.
 */
function withSiteFilter(queryContext, locationIds) {
  const queries = Array.isArray(queryContext.queries) ? queryContext.queries : [];
  return {
    ...queryContext,
    force: true,
    result_format: "json",
    result_type: "full",
    queries: queries.map((query) => {
      const filters = (query.filters || []).filter((filter) => filter.col !== LOCATION_COLUMN);
      return { ...query, filters: [...filters, { col: LOCATION_COLUMN, op: "IN", val: locationIds }] };
    }),
  };
}

/**
 * Cookie Superset yang kedaluwarsa adalah kegagalan tersering di sini, dan
 * selama ini ia menyamar sebagai galat HTTP biasa.
 *
 * Superset menjawab 401 atau 403 ketika sesinya mati, dan pesan yang tercatat
 * hanyalah "Superset menjawab HTTP 401" — kalimat yang benar tetapi tidak
 * memberi tahu siapa pun apa yang harus dilakukan. Cookie itu berumur terbatas
 * dan HARUS diperbarui manual; membedakannya dari gangguan jaringan berarti
 * membedakan "tunggu sebentar" dari "ada yang harus login ke Superset dan
 * menyalin cookie baru".
 */
export class SupersetAuthError extends Error {
  constructor(status) {
    super(
      `Cookie Superset sudah kedaluwarsa (HTTP ${status}). ` +
        "Masuk ke Superset, salin nilai cookie `session` yang baru ke SUPERSET_SESSION_COOKIE, lalu deploy ulang.",
    );
    this.name = "SupersetAuthError";
    this.status = status;
    this.kind = "COOKIE_EXPIRED";
  }
}

function assertAuthorized(response) {
  if (response.status === 401 || response.status === 403) throw new SupersetAuthError(response.status);
}

async function fetchRows(locationIds) {
  // Jalur utama: jalankan query_context milik chart dengan filter gudang aktif.
  try {
    const chart = await fetch(`${BASE_URL}/api/v1/chart/${CHART_ID}`, {
      headers: headers(),
      signal: timeoutSignal(),
    });
    // Cookie mati tidak boleh jatuh ke jalur cadangan: cadangannya memakai
    // cookie yang sama dan pasti gagal juga, sehingga pesan yang tercatat
    // kehilangan sebab aslinya.
    assertAuthorized(chart);
    const meta = await chart.json();
    const raw = meta?.result?.query_context;
    if (raw) {
      const context = withSiteFilter(typeof raw === "string" ? JSON.parse(raw) : raw, locationIds);
      const response = await fetch(`${BASE_URL}/api/v1/chart/data`, {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify(context),
        signal: timeoutSignal(),
      });
      if (response.ok) return { rows: rowsFromPayload(await response.json()), mode: "query_context_filtered" };
    }
  } catch (error) {
    if (error instanceof SupersetAuthError) throw error;
    console.warn("[superset] query_context gagal, memakai saved chart:", error.message);
  }

  // Cadangan: chart tanpa query_context tersimpan.
  const response = await fetch(`${BASE_URL}/api/v1/chart/${CHART_ID}/data/?force=true`, {
    headers: headers(),
    signal: timeoutSignal(),
  });
  assertAuthorized(response);
  if (!response.ok) throw new Error(`Superset menjawab HTTP ${response.status}`);
  return { rows: rowsFromPayload(await response.json()), mode: "saved_chart" };
}

const text = (value) => (value === null || value === undefined ? null : String(value));
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

const COLUMNS = [
  "source_row_key", "po_number", "vendor_name", "location_id", "location_name", "site_code",
  "request_shipping_date", "fulfillment_arrived_start_at", "schedule_type", "po_status",
  "fulfillment_receiving_start_at", "fulfillment_completed_at",
  "request_quantity", "actual_quantity", "count_sku",
];

const UPSERT_ASSIGNMENTS = COLUMNS.filter((column) => column !== "source_row_key")
  .map((column) => `${column}=excluded.${column}`)
  .join(", ");

function rowValues(row, byLocation) {
  const locationId = String(row[LOCATION_COLUMN]);
  const poNumber = text(row.po_number ?? row.po ?? row.PO);
  if (!poNumber) return null;
  return [
    `${locationId}|${poNumber}`, poNumber, text(row.vendor_name), locationId,
    text(row.location_name), byLocation.get(locationId), text(row.request_shipping_date),
    text(row.fulfillment_arrived_start_at), text(row.schedule_type), text(row.po_status),
    text(row.fulfillment_receiving_start_at), text(row.fulfillment_completed_at),
    number(row.request_quantity), number(row.actual_quantity), number(row.count_sku),
  ];
}

/**
 * Menulis master PO dalam kelompok, bukan satu baris satu pernyataan.
 *
 * Bentuk sebelumnya mengirim satu INSERT per PO di dalam satu transaksi. Master
 * PGS berisi puluhan ribu baris, jadi itu puluhan ribu perjalanan pulang-pergi
 * ke Postgres pada setiap siklus lima menit — masing-masing hanya sepersekian
 * milidetik, tetapi dikalikan puluhan ribu menjadi menit-menit dengan transaksi
 * yang menahan kunci selama itu, dan autovacuum tertahan di belakangnya.
 *
 * Lima ratus baris per pernyataan menjaga jumlah parameter (7.500) jauh di
 * bawah batas 65.535 milik protokol wire Postgres, sambil memangkas jumlah
 * perjalanan menjadi seperlima ratusnya.
 */
async function writeRows(pool, rows, byLocation) {
  const values = rows.map((row) => rowValues(row, byLocation)).filter(Boolean);
  if (!values.length) return 0;

  const client = await pool.connect();
  try {
    await client.query("begin");
    for (let offset = 0; offset < values.length; offset += BATCH_SIZE) {
      const batch = values.slice(offset, offset + BATCH_SIZE);
      const placeholders = batch
        .map(
          (_, rowIndex) =>
            `(${COLUMNS.map((_, columnIndex) => `$${rowIndex * COLUMNS.length + columnIndex + 1}`).join(",")}, now())`,
        )
        .join(",");
      await client.query(
        `insert into superset_po_master(${COLUMNS.join(", ")}, synced_at)
         values ${placeholders}
         on conflict (source_row_key) do update set ${UPSERT_ASSIGNMENTS}, synced_at=now()`,
        batch.flat(),
      );
    }
    await client.query("commit");
    return values.length;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Penjaga tumpang-tindih.
 *
 * Master PGS besar dan Superset kadang lambat. Bila satu siklus berjalan lebih
 * lama dari intervalnya, timer berikutnya tetap menyala — dan dua sync yang
 * menulis tabel yang sama saling menunggu kunci, sehingga siklus ketiga menyusul
 * di belakang keduanya. Yang tampak di log adalah sync yang makin lama makin
 * lambat tanpa sebab; yang sebenarnya terjadi adalah antrean yang menumpuk.
 */
let running = false;

export async function runSupersetSync(pool) {
  if (!enabled()) {
    console.warn("[superset] SUPERSET_SESSION_COOKIE belum diset; sync dilewati.");
    return { skipped: true };
  }
  if (running) {
    console.warn("[superset] siklus sebelumnya masih berjalan; siklus ini dilewati.");
    return { skipped: true, reason: "overlap" };
  }
  running = true;

  const started = await pool.query(
    "insert into sync_runs(sync_name, status) values('superset','RUNNING') returning run_id",
  );
  const runId = started.rows[0].run_id;

  try {
    const { rows: siteRows } = await pool.query(
      "select site_code, location_id from site_master where active order by sort_order",
    );
    if (!siteRows.length) throw new Error("Tidak ada gudang aktif di site_master.");

    const byLocation = new Map(siteRows.map((row) => [String(row.location_id), row.site_code]));
    const { rows, mode } = await fetchRows(siteRows.map((row) => String(row.location_id)));

    // Hanya baris milik gudang aktif yang disimpan, apa pun yang dikirim chart.
    const scoped = rows.filter((row) => byLocation.has(String(row[LOCATION_COLUMN] ?? "")));

    const written = await writeRows(pool, scoped, byLocation);

    await pool.query(
      "update sync_runs set status='SUCCESS', fetched_count=$2, written_count=$3, finished_at=now() where run_id=$1",
      [runId, rows.length, written],
    );
    console.log(`[superset] ${written} PO tersimpan (${mode}).`);
    return { fetched: rows.length, written, mode };
  } catch (error) {
    // Pencatatan kegagalan tidak boleh melempar galat kedua: bila database
    // sendiri yang bermasalah, update ini ikut gagal, dan galat itulah yang
    // muncul di log — menyembunyikan penyebab aslinya.
    await pool
      .query(
        "update sync_runs set status=$2, error_message=$3, finished_at=now() where run_id=$1",
        // Status dibedakan supaya layar Pengaturan dapat menunjukkan tindakan
        // yang benar: cookie kedaluwarsa perlu orang, gangguan jaringan tidak.
        [runId, error?.kind === "COOKIE_EXPIRED" ? "COOKIE_EXPIRED" : "FAILED", String(error.message).slice(0, 500)],
      )
      .catch((secondary) => console.error("[superset] status gagal dicatat:", secondary.message));
    console.error("[superset] sync gagal:", error.message);
    return { error: error.message, kind: error?.kind || "FAILED" };
  } finally {
    running = false;
  }
}

export function startSupersetSync(pool) {
  if (!enabled()) {
    console.warn("[superset] sync tidak aktif (SUPERSET_SESSION_COOKIE kosong).");
    return;
  }
  // Sekali saat start supaya master PO terisi tanpa menunggu satu interval
  // penuh setelah deployment.
  runSupersetSync(pool).catch((error) => console.error("[superset]", error.message));
  const timer = setInterval(
    () => runSupersetSync(pool).catch((error) => console.error("[superset]", error.message)),
    INTERVAL_MS,
  );
  // Timer tidak boleh menahan proses tetap hidup saat shutdown.
  timer.unref?.();
  console.log(`[superset] sync tiap ${Math.round(INTERVAL_MS / 60_000)} menit.`);
}
