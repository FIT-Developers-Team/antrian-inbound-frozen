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
const CHART_ID = process.env.SUPERSET_CHART_ID || "20662";
const LOCATION_COLUMN = process.env.SUPERSET_LOCATION_COLUMN || "location_id";
const BASE_URL = (process.env.SUPERSET_BASE_URL || "https://dash.astronauts.id").replace(/\/$/, "");

function enabled() {
  return Boolean(process.env.SUPERSET_SESSION_COOKIE);
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

async function fetchRows(locationIds) {
  // Jalur utama: jalankan query_context milik chart dengan filter gudang aktif.
  try {
    const chart = await fetch(`${BASE_URL}/api/v1/chart/${CHART_ID}`, { headers: headers() });
    const meta = await chart.json();
    const raw = meta?.result?.query_context;
    if (raw) {
      const context = withSiteFilter(typeof raw === "string" ? JSON.parse(raw) : raw, locationIds);
      const response = await fetch(`${BASE_URL}/api/v1/chart/data`, {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify(context),
      });
      if (response.ok) return { rows: rowsFromPayload(await response.json()), mode: "query_context_filtered" };
    }
  } catch (error) {
    console.warn("[superset] query_context gagal, memakai saved chart:", error.message);
  }

  // Cadangan: chart tanpa query_context tersimpan.
  const response = await fetch(`${BASE_URL}/api/v1/chart/${CHART_ID}/data/?force=true`, { headers: headers() });
  if (!response.ok) throw new Error(`Superset menjawab HTTP ${response.status}`);
  return { rows: rowsFromPayload(await response.json()), mode: "saved_chart" };
}

const text = (value) => (value === null || value === undefined ? null : String(value));
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

export async function runSupersetSync(pool) {
  if (!enabled()) {
    console.warn("[superset] SUPERSET_SESSION_COOKIE belum diset; sync dilewati.");
    return { skipped: true };
  }

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

    const client = await pool.connect();
    let written = 0;
    try {
      await client.query("begin");
      for (const row of scoped) {
        const locationId = String(row[LOCATION_COLUMN]);
        const poNumber = text(row.po_number ?? row.po ?? row.PO);
        if (!poNumber) continue;
        const key = `${locationId}|${poNumber}`;
        await client.query(
          `insert into superset_po_master(source_row_key, po_number, vendor_name, location_id,
             location_name, site_code, request_shipping_date, fulfillment_arrived_start_at,
             schedule_type, po_status, fulfillment_receiving_start_at, fulfillment_completed_at,
             request_quantity, actual_quantity, count_sku, synced_at)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
           on conflict (source_row_key) do update set
             po_number=excluded.po_number, vendor_name=excluded.vendor_name,
             location_id=excluded.location_id, location_name=excluded.location_name,
             site_code=excluded.site_code, request_shipping_date=excluded.request_shipping_date,
             fulfillment_arrived_start_at=excluded.fulfillment_arrived_start_at,
             schedule_type=excluded.schedule_type, po_status=excluded.po_status,
             fulfillment_receiving_start_at=excluded.fulfillment_receiving_start_at,
             fulfillment_completed_at=excluded.fulfillment_completed_at,
             request_quantity=excluded.request_quantity, actual_quantity=excluded.actual_quantity,
             count_sku=excluded.count_sku, synced_at=now()`,
          [
            key, poNumber, text(row.vendor_name), locationId, text(row.location_name),
            byLocation.get(locationId), text(row.request_shipping_date),
            text(row.fulfillment_arrived_start_at), text(row.schedule_type), text(row.po_status),
            text(row.fulfillment_receiving_start_at), text(row.fulfillment_completed_at),
            number(row.request_quantity), number(row.actual_quantity), number(row.count_sku),
          ],
        );
        written += 1;
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    await pool.query(
      "update sync_runs set status='SUCCESS', fetched_count=$2, written_count=$3, finished_at=now() where run_id=$1",
      [runId, rows.length, written],
    );
    console.log(`[superset] ${written} PO tersimpan (${mode}).`);
    return { fetched: rows.length, written, mode };
  } catch (error) {
    await pool.query(
      "update sync_runs set status='FAILED', error_message=$2, finished_at=now() where run_id=$1",
      [runId, error.message],
    );
    console.error("[superset] sync gagal:", error.message);
    return { error: error.message };
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
