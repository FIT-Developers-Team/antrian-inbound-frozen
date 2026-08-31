import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { clean, constantTimeEqual, jsonResponse, optionsResponse } from "../_shared/http.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type SiteRow = { site_code: string; location_id: string; site_name: string };

const CHUNK_SIZE = 500;
const CHUNK_CONCURRENCY = 4;

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Gudang yang boleh masuk snapshot. site_master adalah sumber kebenarannya. */
async function activeSites(): Promise<SiteRow[]> {
  const { data, error } = await db.from("site_master")
    .select("site_code,location_id,site_name").eq("active", true).order("sort_order");
  if (error) throw error;
  if (!data?.length) throw new Error("Tidak ada gudang aktif di site_master; sync dibatalkan.");
  return data as SiteRow[];
}

function chartId(): string {
  return clean(Deno.env.get("SUPERSET_CHART_ID")) || "20662";
}

function locationColumn(): string {
  return clean(Deno.env.get("SUPERSET_LOCATION_COLUMN")) || "location_id";
}

function supersetBaseUrl(): string {
  return clean(Deno.env.get("SUPERSET_BASE_URL") || "https://dash.astronauts.id").replace(/\/$/, "");
}

function supersetHeaders(): Record<string, string> {
  const rawCookie = clean(Deno.env.get("SUPERSET_SESSION_COOKIE"));
  if (!rawCookie) throw new Error("SUPERSET_SESSION_COOKIE belum diset di Supabase Secrets.");
  return {
    accept: "application/json",
    cookie: rawCookie.startsWith("session=") ? rawCookie : `session=${rawCookie}`,
    referer: `${supersetBaseUrl()}/`,
  };
}

function rowsFromPayload(payload: unknown): Record<string, unknown>[] {
  const rows = (payload as { result?: { data?: unknown }[] } | null)?.result?.[0]?.data;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/**
 * Menyuntikkan filter gudang ke query_context chart.
 *
 * Filter lokasi lama menempel di saved chart (CBT/819), sehingga menyalinnya
 * apa adanya akan terus menarik gudang yang salah. Filter pada kolom lokasi
 * dibuang lalu diganti dengan daftar location_id gudang aktif, sehingga sync
 * benar-benar meminta PGS (160) ke Superset, bukan sekadar menyaring hasilnya.
 */
function withSiteFilter(queryContext: Record<string, unknown>, locationIds: string[]): Record<string, unknown> {
  const column = locationColumn();
  const queries = Array.isArray(queryContext.queries) ? queryContext.queries : [];
  return {
    ...queryContext,
    force: true,
    result_format: "json",
    result_type: "full",
    queries: queries.map((query) => {
      const q = query as Record<string, unknown>;
      const existing = Array.isArray(q.filters) ? (q.filters as Record<string, unknown>[]) : [];
      return {
        ...q,
        filters: [
          ...existing.filter((filter) => clean(filter?.col) !== column),
          { col: column, op: "IN", val: locationIds },
        ],
      };
    }),
  };
}

/** Jalur utama: query_context chart + filter gudang aktif, dieksekusi via POST. */
async function fetchRowsWithSiteFilter(locationIds: string[]): Promise<Record<string, unknown>[]> {
  const baseUrl = supersetBaseUrl();
  const headers = supersetHeaders();

  const chartResponse = await fetch(`${baseUrl}/api/v1/chart/${chartId()}`, { headers });
  if (!chartResponse.ok) throw new Error(`Baca chart gagal: HTTP ${chartResponse.status}`);
  const chartPayload = await chartResponse.json();
  const rawContext = chartPayload?.result?.query_context;
  if (!rawContext) throw new Error("Chart tidak menyimpan query_context.");

  const queryContext = typeof rawContext === "string" ? JSON.parse(rawContext) : rawContext;
  const dataResponse = await fetch(`${baseUrl}/api/v1/chart/data`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(withSiteFilter(queryContext, locationIds)),
  });
  if (!dataResponse.ok) throw new Error(`Eksekusi chart data gagal: HTTP ${dataResponse.status}`);
  return rowsFromPayload(await dataResponse.json());
}

/** Cadangan: saved chart apa adanya, disaring di sisi kita. */
async function fetchRowsFromSavedChart(): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${supersetBaseUrl()}/api/v1/chart/${chartId()}/data/?force=true`, {
    headers: supersetHeaders(),
  });
  if (!response.ok) throw new Error(`Superset saved chart gagal: HTTP ${response.status}`);
  return rowsFromPayload(await response.json());
}

async function fetchChartRows(locationIds: string[]): Promise<{ rows: Record<string, unknown>[]; mode: string }> {
  try {
    const rows = await fetchRowsWithSiteFilter(locationIds);
    if (rows.length) return { rows, mode: "query_context_filtered" };
    // Nol baris di sini biasanya berarti filter kolomnya keliru, bukan bahwa
    // gudangnya benar-benar kosong; jatuh ke saved chart agar tetap ada data.
    console.warn("sync-superset: filter query_context menghasilkan 0 baris, memakai saved chart.");
  } catch (error) {
    console.warn("sync-superset: query_context tidak dapat dipakai:", error instanceof Error ? error.message : error);
  }
  const rows = await fetchRowsFromSavedChart();
  if (!rows.length) throw new Error("Snapshot Superset kosong/tidak valid; snapshot lama dipertahankan.");
  return { rows, mode: "saved_chart" };
}

/** Upsert stage berjalan paralel terbatas; sekuensial membuat sync lambat sekali. */
async function upsertStage(staged: Record<string, unknown>[]): Promise<void> {
  const chunks: Record<string, unknown>[][] = [];
  for (let offset = 0; offset < staged.length; offset += CHUNK_SIZE) {
    chunks.push(staged.slice(offset, offset + CHUNK_SIZE));
  }
  for (let index = 0; index < chunks.length; index += CHUNK_CONCURRENCY) {
    const batch = chunks.slice(index, index + CHUNK_CONCURRENCY);
    const results = await Promise.all(batch.map((chunk) => db.from("superset_po_stage").upsert(chunk)));
    const failed = results.find((result) => result.error);
    if (failed?.error) throw failed.error;
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  const expected = clean(Deno.env.get("SYNC_SECRET"));
  const supplied = clean(request.headers.get("authorization")).replace(/^Bearer\s+/i, "");
  if (!expected || !constantTimeEqual(expected, supplied)) return jsonResponse(request, 401, { ok: false, message: "Unauthorized" });

  const requestUrl = new URL(request.url);
  if (requestUrl.searchParams.get("action") === "configure-cron") {
    const functionBaseUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
    const { data, error } = await db.rpc("configure_inbound_cron", {
      p_function_base_url: functionBaseUrl,
      p_sync_secret: expected,
    });
    if (error) return jsonResponse(request, 500, { ok: false, message: error.message });
    return jsonResponse(request, 200, { ok: true, data });
  }

  const runId = crypto.randomUUID();
  try {
    const sites = await activeSites();
    const siteByLocation = new Map(sites.map((site) => [site.location_id, site]));
    const { rows, mode } = await fetchChartRows(sites.map((site) => site.location_id));

    // Filter gudang dilakukan di sini, bukan hanya di Superset. Apa pun yang
    // dikembalikan chart, hanya location_id gudang aktif yang tersimpan.
    const scoped = rows.filter((row) => siteByLocation.has(clean(row.location_id)));
    if (scoped.length === 0) {
      throw new Error(
        `Chart ${chartId()} tidak memuat satu pun location_id gudang aktif (${sites.map((site) => `${site.site_code}=${site.location_id}`).join(", ")}). ` +
        "Perbarui SUPERSET_CHART_ID atau filter chart; snapshot lama dipertahankan.",
      );
    }

    const staged = await Promise.all(scoped.map(async (row) => ({
      run_id: runId,
      source_row_key: await sha256([row.po_number, row.location_id, row.request_shipping_date, row.fulfillment_arrived_start_at,
        row.schedule_type, row.company_name, row.po_status, row.fulfillment_receiving_start_at, row.fulfillment_completed_at]),
      po_number: clean(row.po_number), vendor_name: clean(row.company_name) || null,
      location_id: clean(row.location_id) || null, location_name: clean(row.location_name) || null,
      site_code: siteByLocation.get(clean(row.location_id))?.site_code || null,
      request_shipping_date: clean(row.request_shipping_date) || null,
      fulfillment_arrived_start_at: clean(row.fulfillment_arrived_start_at) || null,
      schedule_type: clean(row.schedule_type) || null, po_status: clean(row.po_status) || null,
      fulfillment_receiving_start_at: clean(row.fulfillment_receiving_start_at) || null,
      fulfillment_completed_at: clean(row.fulfillment_completed_at) || null,
      request_quantity: number(row["SUM(request_quantity)"]), actual_quantity: number(row["SUM(actual_quantity)"]),
      count_sku: Math.trunc(number(row["COUNT_DISTINCT(sku_number)"])),
    })));

    // Baris kembar dalam satu run akan membuat upsert menabrak primary key
    // (run_id, source_row_key) di dalam batch yang sama.
    const deduped = [...new Map(staged.map((row) => [row.source_row_key, row])).values()];

    await upsertStage(deduped);
    const checksum = await sha256(deduped.map((row) => [row.source_row_key, row.request_quantity, row.actual_quantity, row.count_sku]));
    const { data, error } = await db.rpc("inbound_finalize_superset_sync", {
      p_run_id: runId, p_expected_count: deduped.length, p_checksum: checksum,
    });
    if (error) throw error;

    const perSite = sites.map((site) => ({
      site_code: site.site_code,
      location_id: site.location_id,
      rows: deduped.filter((row) => row.location_id === site.location_id).length,
    }));

    const retentionCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await db.from("sync_runs").delete().lt("started_at", retentionCutoff);
    return jsonResponse(request, 200, { ok: true, data: {
      ...data, run_id: runId, chart_id: chartId(), fetch_mode: mode,
      fetched_from_chart: rows.length, kept_for_active_sites: deduped.length, per_site: perSite,
    } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Stage run gagal harus dibuang; kalau tidak, tabel stage tumbuh terus.
    await db.from("superset_po_stage").delete().eq("run_id", runId);
    await db.from("sync_runs").upsert({ run_id: runId, sync_name: "superset_po", status: "FAILED",
      error_message: message.slice(0, 500), finished_at: new Date().toISOString() });
    console.error("sync-superset", { runId, message });
    return jsonResponse(request, 500, { ok: false, run_id: runId, message });
  }
});
