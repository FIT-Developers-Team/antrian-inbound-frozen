/**
 * DEPRECATED — backend Vercel + MotherDuck warisan.
 *
 * Produksi sudah berjalan di Supabase Edge Functions (`supabase/functions/`)
 * dengan Postgres sebagai penyimpanan. File ini tidak dipanggil frontend mana
 * pun, tidak ikut ter-deploy (lihat .vercelignore), dan hanya dipertahankan
 * sebagai referensi rollback sesuai MIGRATION_RUNBOOK.md.
 *
 * Jangan menambah fitur di sini. Hapus setelah Supabase terbukti stabil dan
 * hosting Vercel resmi dinonaktifkan.
 */
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const { randomUUID, createHash, createHmac, timingSafeEqual } = require("crypto");
const { waitUntil } = require("@vercel/functions");

let pool;
let schemaReady = false;
let schemaReadyPromise = null;

function json(res, status, body) {
  res.status(status).json(body);
}

function getPool() {
  if (pool) return pool;

  const host = clean(process.env.MOTHERDUCK_POSTGRES_HOST);
  if (host) {
    const token = process.env.MOTHERDUCK_TOKEN;
    if (!token) throw new Error("MOTHERDUCK_TOKEN belum diset di Vercel.");
    pool = new Pool({
      host,
      port: 5432,
      user: "postgres",
      password: token,
      database: "md:",
      max: 5,
      ssl: { rejectUnauthorized: true },
    });
    return pool;
  }

  const configuredValue = process.env.MOTHERDUCK_POSTGRES_URL;
  if (!configuredValue) {
    throw new Error("MOTHERDUCK_POSTGRES_URL belum diset di Vercel.");
  }

  // The MotherDuck UI may display a full `psql` command. Accept that paste
  // format too, while only passing the actual PostgreSQL URL to node-postgres.
  const urlMatch = configuredValue.match(/postgres(?:ql)?:\/\/[^\s'"`]+/i);
  const connectionString = urlMatch ? urlMatch[0] : configuredValue.trim();

  // MotherDuck's copyable Postgres URL can include libpq SSL options such as
  // `sslrootcert=system`. The Node `pg` parser treats that value as a local
  // filename, which does not exist in a Vercel Function. TLS is configured
  // explicitly below instead.
  const parsedUrl = new URL(connectionString);
  ["sslmode", "sslcert", "sslkey", "sslrootcert"].forEach((key) => {
    parsedUrl.searchParams.delete(key);
  });

  pool = new Pool({
    connectionString: parsedUrl.toString(),
    max: 5,
    ssl: { rejectUnauthorized: true },
  });
  return pool;
}

function isAuthorized(req) {
  const expected = process.env.INBOUND_API_KEY;
  const supplied = req.headers["x-inbound-api-key"];
  return Boolean(expected && supplied && supplied === expected);
}

function isCronAuthorized(req) {
  const secret = clean(process.env.CRON_SECRET);
  const authorization = clean(req.headers.authorization);
  return Boolean(secret && authorization === `Bearer ${secret}`);
}

function isGsheetBackfillAuthorized(req) {
  const expected = clean(process.env.GSHEET_BACKFILL_SECRET);
  const supplied = clean(req.headers["x-gsheet-backfill-secret"]);
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

const REALTIME_TOPIC = "inbound-cbt-operations";
const REALTIME_EVENT = "ticket-changed";

function realtimeSettings() {
  const url = clean(process.env.SUPABASE_REALTIME_URL).replace(/\/+$/, "");
  const publishableKey = clean(process.env.SUPABASE_REALTIME_PUBLISHABLE_KEY);
  const secretKey = clean(process.env.SUPABASE_REALTIME_SECRET_KEY);
  return {
    enabled: Boolean(url && publishableKey && secretKey),
    url,
    publishableKey,
    secretKey,
  };
}

function realtimePublicConfig() {
  const settings = realtimeSettings();
  return {
    enabled: settings.enabled,
    url: settings.enabled ? settings.url : "",
    publishable_key: settings.enabled ? settings.publishableKey : "",
    topic: REALTIME_TOPIC,
    event: REALTIME_EVENT,
  };
}

async function publishRealtimeChange() {
  const settings = realtimeSettings();
  if (!settings.enabled) return false;

  const endpoint =
    `${settings.url}/realtime/v1/api/broadcast/` +
    `${encodeURIComponent(REALTIME_TOPIC)}/events/${encodeURIComponent(REALTIME_EVENT)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        apikey: settings.secretKey,
        Authorization: `Bearer ${settings.secretKey}`,
        "Content-Type": "application/json",
      },
      // Broadcast hanya berfungsi sebagai invalidation signal. Data tiket
      // tetap dibaca dari MotherDuck melalui endpoint delta yang terautentikasi.
      body: JSON.stringify({ changed_at: new Date().toISOString() }),
    });
    if (!response.ok) {
      throw new Error(`Supabase Broadcast HTTP ${response.status}`);
    }
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleRealtimeChange() {
  const task = publishRealtimeChange().catch((error) => {
    // Broadcast tidak boleh menggagalkan transaksi operasional. Polling delta
    // 10 detik tetap menjadi fallback bila kanal realtime sedang bermasalah.
    console.error("Supabase Realtime broadcast gagal", error);
  });
  try {
    waitUntil(task);
  } catch {
    // Local/dev runtimes may not expose a Vercel request context.
    void task;
  }
}

function gsheetSyncSettings(overrides = null) {
  if (overrides) return overrides;
  const url = clean(process.env.GSHEET_SYNC_URL);
  const enabledValue = clean(process.env.GSHEET_SYNC_ENABLED || (url ? "true" : "false")).toLowerCase();
  return {
    enabled: !["0", "false", "off", "disabled"].includes(enabledValue),
    url,
    secret: clean(process.env.GSHEET_SYNC_SECRET),
  };
}

const GSHEET_OUTPUT_HEADERS = [
  "Timestamp", "ticket_id", "queue_no", "ticket_type", "slot", "fleet_type",
  "plat_number", "driver_name", "phone_number", "ktp_6_digit", "vendor_name",
  "po_number", "total_po_qty", "actual_quantity", "count_po_sku", "status",
  "gate", "unload_sla", "source", "created_at", "register_time", "called_at",
  "updated_at", "completed_at", "start_unloading_at", "driver_waiting_duration",
  "driver_waiting_minutes", "unloading_duration", "unloading_duration_minutes",
  "sla_target_hours", "sla_status", "wa_call_status", "wa_call_sent_at",
  "wa_call_error", "wa_call_provider", "wa_call_target", "call_count",
  "last_call_attempt_at", "expired_at", "expired_reason", "sla_finished_at",
  "operational_date", "data_source", "last_call_at", "waiting_gr_at", "done_gr_at",
  "handover_grn_at", "wa_handover_status", "wa_handover_sent_at",
  "wa_handover_error", "wa_handover_target", "ticket_po_id", "po_sequence",
  "ticket_po_count", "ticket_total_qty", "ticket_total_sku", "finish_unloading_at",
  "checker_id", "checker_name", "checker_status", "checker_started_at",
  "checker_done_at", "checker_started_by", "checker_done_by", "checker_duration",
  "checker_duration_minutes", "gr_status", "done_gr_by", "gr_wait_duration",
  "gr_wait_minutes", "inbound_sla_duration", "inbound_sla_minutes",
  "wa_ticket_status", "wa_ticket_sent_at", "wa_ticket_error", "wa_ticket_target",
];

function gsheetDuration(from, to) {
  const start = from ? new Date(from) : null;
  const end = to ? new Date(to) : null;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    return { text: "", minutes: "" };
  }
  const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  return { text: `${hours}:${String(minutes % 60).padStart(2, "0")}:00`, minutes };
}

function gsheetDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return clean(value);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function gsheetSlaTargetHours(row) {
  const fleet = clean(row.fleet_type).toUpperCase().replace(/\s+/g, " ");
  const sku = Number(row.ticket_total_sku || row.count_po_sku || 0) || 0;
  if (fleet.includes("FUSO") || fleet.includes("WINGBOX") || fleet.includes("WING BOX")) return 4;
  if (["CDD", "CDDL", "CDE", "CDEL"].some((name) => fleet.includes(name))) return sku > 40 ? 4 : 2;
  if (["VAN", "PICKUP", "PICK UP", "L300 BOX", "MOBIL", "GRANDMAX"].some((name) => fleet.includes(name))) return 1;
  return 0;
}

function gsheetSlaStatus(row, targetHours) {
  const status = clean(row.status).toUpperCase();
  if (status.includes("EXPIRED") || row.expired_at) return "EXPIRED";
  if (!targetHours) return "NO SLA";
  const start = row.start_unloading_at ? new Date(row.start_unloading_at) : null;
  if (!start || Number.isNaN(start.getTime())) return "WAITING START UNLOADING";
  const allDoneGr = row.ticket_all_done_gr === true || String(row.ticket_all_done_gr).toLowerCase() === "true";
  const final = status.includes("COMPLETED") || allDoneGr;
  const endValue = final
    ? (row.ticket_done_gr_at || row.done_gr_at || row.finish_unloading_at)
    : new Date();
  const end = endValue ? new Date(endValue) : null;
  if (!end || Number.isNaN(end.getTime()) || end < start) return final ? "SLA OK" : "ON PROCESS";
  const actualMinutes = Math.floor((end.getTime() - start.getTime()) / 60000);
  const missed = actualMinutes > targetHours * 60;
  if (final) return missed ? "SLA MISS" : "SLA OK";
  return missed ? "SLA MISS" : "ON PROCESS";
}

function gsheetSixDigits(value) {
  const text = clean(value);
  return /^\d{1,6}$/.test(text) ? text.padStart(6, "0") : text;
}

function gsheetPoNumber(row) {
  const value = clean(row.po_number);
  const match = clean(row.ticket_po_id).match(/-PO-(\d+)-\d+$/);
  if (match && /^\d+$/.test(value) && Number(match[1]) === Number(value)) return match[1];
  return value;
}

function formatGsheetOutputRow(row) {
  const finish = row.finish_unloading_at || "";
  const driverWaiting = gsheetDuration(row.created_at || row.register_time, row.start_unloading_at || finish);
  const unloading = gsheetDuration(row.start_unloading_at, finish);
  const checker = gsheetDuration(row.checker_started_at, row.checker_done_at);
  const grWait = gsheetDuration(row.checker_done_at, row.done_gr_at);
  const inboundSla = gsheetDuration(row.start_unloading_at, finish || row.done_gr_at);
  const slaTargetHours = gsheetSlaTargetHours(row);
  const slaStatus = gsheetSlaStatus(row, slaTargetHours);
  return {
    Timestamp: gsheetDateTime(row.created_at || row.register_time),
    ticket_id: row.ticket_id || "", queue_no: row.queue_no || "",
    ticket_type: row.ticket_type || "", slot: row.slot || "",
    fleet_type: row.fleet_type || "", plat_number: row.plat_number || "",
    driver_name: row.driver_name || "", phone_number: row.phone_number || "",
    ktp_6_digit: gsheetSixDigits(row.ktp_6_digit), vendor_name: row.vendor_name || "",
    po_number: gsheetPoNumber(row), total_po_qty: row.total_po_qty || 0,
    actual_quantity: row.actual_quantity || 0, count_po_sku: row.count_po_sku || 0,
    status: row.status || "", gate: row.gate || "", unload_sla: row.unload_sla || "",
    source: row.source || "MotherDuck", created_at: gsheetDateTime(row.created_at),
    register_time: gsheetDateTime(row.register_time || row.created_at), called_at: gsheetDateTime(row.called_at),
    updated_at: gsheetDateTime(row.updated_at || row.po_updated_at),
    completed_at: clean(row.status).toUpperCase() === "COMPLETED" ? gsheetDateTime(finish) : "",
    start_unloading_at: gsheetDateTime(row.start_unloading_at),
    driver_waiting_duration: driverWaiting.text, driver_waiting_minutes: driverWaiting.minutes,
    unloading_duration: unloading.text, unloading_duration_minutes: unloading.minutes,
    sla_target_hours: slaTargetHours, sla_status: slaStatus,
    wa_call_status: "", wa_call_sent_at: "", wa_call_error: "",
    wa_call_provider: "", wa_call_target: "", call_count: row.call_count || 0,
    last_call_attempt_at: gsheetDateTime(row.last_call_at), expired_at: gsheetDateTime(row.expired_at),
    expired_reason: row.expired_reason || "", sla_finished_at: gsheetDateTime(finish),
    operational_date: row.operational_date || "", data_source: "MotherDuck",
    last_call_at: gsheetDateTime(row.last_call_at), waiting_gr_at: gsheetDateTime(row.checker_done_at),
    done_gr_at: gsheetDateTime(row.done_gr_at), handover_grn_at: gsheetDateTime(row.handover_grn_at),
    wa_handover_status: "", wa_handover_sent_at: "", wa_handover_error: "",
    wa_handover_target: "", ticket_po_id: row.ticket_po_id || "",
    po_sequence: Number(row.po_sequence || 0),
    ticket_po_count: Number(row.ticket_po_count || 0),
    ticket_total_qty: Number(row.ticket_total_qty || 0),
    ticket_total_sku: Number(row.ticket_total_sku || 0),
    finish_unloading_at: gsheetDateTime(finish), checker_id: row.checker_id || "",
    checker_name: row.checker_name || "", checker_status: row.checker_status || "",
    checker_started_at: gsheetDateTime(row.checker_started_at), checker_done_at: gsheetDateTime(row.checker_done_at),
    checker_started_by: "", checker_done_by: "", checker_duration: checker.text,
    checker_duration_minutes: checker.minutes, gr_status: row.gr_status || "",
    done_gr_by: "", gr_wait_duration: grWait.text, gr_wait_minutes: grWait.minutes,
    inbound_sla_duration: inboundSla.text, inbound_sla_minutes: inboundSla.minutes,
    wa_ticket_status: "", wa_ticket_sent_at: "", wa_ticket_error: "", wa_ticket_target: "",
  };
}

async function syncPendingGsheetRows(
  client,
  fetchImpl = fetch,
  settings = gsheetSyncSettings(),
  onlyTicketPoIds = [],
) {
  if (!settings.enabled || !settings.url) return { enabled: false, queued: 0, synced: 0 };

  const scopedIds = Array.isArray(onlyTicketPoIds)
    ? [...new Set(onlyTicketPoIds.map(clean).filter(Boolean))].slice(0, 100)
    : [];
  const scopedWhere = scopedIds.length
    ? `AND o.ticket_po_id IN (${scopedIds.map((_, index) => `$${index + 1}`).join(",")})`
    : "";

  const pending = await client.query(`WITH ranked_pos AS (
      SELECT p.*,
        ROW_NUMBER() OVER (PARTITION BY p.ticket_id ORDER BY p.created_at ASC) AS po_sequence,
        COUNT(*) OVER (PARTITION BY p.ticket_id) AS ticket_po_count,
        COALESCE(SUM(p.request_quantity) OVER (PARTITION BY p.ticket_id), 0) AS ticket_total_qty,
        COALESCE(SUM(p.count_sku) OVER (PARTITION BY p.ticket_id), 0) AS ticket_total_sku
        , MAX(p.gr_done_at) OVER (PARTITION BY p.ticket_id) AS ticket_done_gr_at
        , COUNT(*) FILTER (WHERE UPPER(COALESCE(p.gr_status, '')) = 'DONE GR') OVER (PARTITION BY p.ticket_id)
            = COUNT(*) OVER (PARTITION BY p.ticket_id) AS ticket_all_done_gr
      FROM ticket_pos p
    )
    SELECT
      o.ticket_po_id,
      t.ticket_id, t.queue_no, t.ticket_type, t.status,
      COALESCE(p.vendor_name, t.vendor_name) AS vendor_name,
      t.fleet_type, t.plat_number, t.driver_name, t.driver_phone AS phone_number,
      t.ktp_6_digit, t.gate, t.slot, t.operational_date, t.registered_by,
      t.unload_sla, t.source, t.called_at, t.arrived_at,
      t.start_unloading_at, t.done_unloading_at AS finish_unloading_at,
      t.expired_at, t.expired_reason, t.call_count, t.last_call_at,
      t.created_at AS register_time, t.created_at, t.updated_at,
      p.po_number, p.request_quantity AS total_po_qty, p.actual_quantity,
      p.count_sku AS count_po_sku, p.checker_status, p.gr_status,
      p.checker_id, p.checker_name, p.checking_started_at AS checker_started_at,
      p.checking_done_at AS checker_done_at, p.gr_done_at AS done_gr_at,
      p.handover_grn_at, p.updated_at AS po_updated_at,
      p.ticket_po_count, p.ticket_total_qty, p.ticket_total_sku, p.po_sequence
    FROM gsheet_sync_outbox o
    JOIN ranked_pos p ON p.ticket_po_id = o.ticket_po_id
    JOIN tickets t ON t.ticket_id = p.ticket_id
    WHERE (
      (o.sync_status IN ('PENDING', 'FAILED') AND o.attempt_count < 10)
      OR (o.sync_status = 'PROCESSING' AND o.updated_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes')
    )
    ${scopedWhere}
    ORDER BY o.created_at ASC
    LIMIT 100`, scopedIds);
  if (!pending.rows.length) return { enabled: true, queued: 0, synced: 0 };

  const ids = pending.rows.map((row) => clean(row.ticket_po_id)).filter(Boolean);
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(",");
  const claimed = await client.query(
    `UPDATE gsheet_sync_outbox
     SET sync_status = 'PROCESSING', updated_at = CURRENT_TIMESTAMP
     WHERE ticket_po_id IN (${placeholders})
       AND (
         sync_status IN ('PENDING', 'FAILED')
         OR (sync_status = 'PROCESSING' AND updated_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes')
       )
     RETURNING ticket_po_id`,
    ids,
  );
  const claimedIds = new Set(claimed.rows.map((row) => clean(row.ticket_po_id)));
  const rows = pending.rows.filter((row) => claimedIds.has(clean(row.ticket_po_id)));
  if (!rows.length) return { enabled: true, queued: pending.rows.length, synced: 0 };

  const claimedRowIds = rows.map((row) => clean(row.ticket_po_id));
  const claimedPlaceholders = claimedRowIds.map((_, index) => `$${index + 1}`).join(",");
  const outputRows = rows.map(formatGsheetOutputRow);
  try {
    const targetUrl = new URL(settings.url);
    targetUrl.searchParams.set("action", "submitSecurity");
    const response = await fetchImpl(targetUrl.toString(), {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "submitSecurity",
        payload: {
          rows: outputRows,
          send_whatsapp: false,
          wa_event: "DISABLED",
          sync_mode: "upsert",
          sync_key: "ticket_po_id",
          ...(settings.secret ? { sync_secret: settings.secret } : {}),
        },
        timestamp: new Date().toISOString(),
      }),
    });
    let responsePayload = null;
    try {
      responsePayload = await response.json();
    } catch {
      responsePayload = null;
    }
    if (!response.ok) throw new Error(`Google Sheets sync HTTP ${response.status}`);
    if (responsePayload?.status && responsePayload.status !== "success") {
      throw new Error(responsePayload.message || "Google Sheets sync ditolak Apps Script");
    }
    await client.query(
      `UPDATE gsheet_sync_outbox
       SET sync_status = 'SYNCED', attempt_count = attempt_count + 1,
           last_error = NULL, synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE ticket_po_id IN (${claimedPlaceholders})`,
      claimedRowIds,
    );
    return { enabled: true, queued: pending.rows.length, synced: rows.length };
  } catch (error) {
    await client.query(
      `UPDATE gsheet_sync_outbox
       SET sync_status = 'FAILED', attempt_count = attempt_count + 1,
           last_error = $1, updated_at = CURRENT_TIMESTAMP
       WHERE ticket_po_id IN (${claimedRowIds.map((_, index) => `$${index + 2}`).join(",")})`,
      [clean(error.message).slice(0, 500), ...claimedRowIds],
    );
    throw error;
  }
}

async function gsheetBackfillStatus(client) {
  const result = await client.query(`SELECT
    (SELECT COUNT(*)::INTEGER FROM ticket_pos) AS total_rows,
    (SELECT COUNT(*)::INTEGER FROM gsheet_sync_outbox WHERE sync_status = 'SYNCED') AS synced_rows,
    (SELECT COUNT(*)::INTEGER FROM gsheet_sync_outbox WHERE sync_status = 'PENDING') AS pending_rows,
    (SELECT COUNT(*)::INTEGER FROM gsheet_sync_outbox WHERE sync_status = 'FAILED') AS failed_rows`);
  const row = result.rows[0] || {};
  return {
    total_rows: Number(row.total_rows || 0),
    synced_rows: Number(row.synced_rows || 0),
    pending_rows: Number(row.pending_rows || 0),
    failed_rows: Number(row.failed_rows || 0),
  };
}

async function backfillGsheetBatch(client, body, syncImpl = syncPendingGsheetRows) {
  const cursor = clean(body.cursor);
  const requestedLimit = Number(body.limit || 100);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 100, 1), 100);
  const candidates = await client.query(
    `SELECT ticket_po_id, ticket_id
     FROM ticket_pos
     WHERE ($1 = '' OR ticket_po_id > $1)
     ORDER BY ticket_po_id ASC
     LIMIT ${limit}`,
    [cursor],
  );
  if (!candidates.rows.length) {
    return {
      done: true,
      cursor,
      selected_rows: 0,
      synced_rows: 0,
      status: await gsheetBackfillStatus(client),
    };
  }

  const ids = candidates.rows.map((row) => clean(row.ticket_po_id)).filter(Boolean);
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(",");
  await client.query(
    `INSERT INTO gsheet_sync_outbox (
       ticket_po_id, ticket_id, sync_status, attempt_count, last_error,
       synced_at, created_at, updated_at
     )
     SELECT ticket_po_id, ticket_id, 'PENDING', 0, NULL,
            NULL, now(), now()
     FROM ticket_pos
     WHERE ticket_po_id IN (${placeholders})
     ON CONFLICT (ticket_po_id) DO UPDATE SET
       ticket_id = excluded.ticket_id,
       sync_status = 'PENDING', attempt_count = 0,
       last_error = NULL, synced_at = NULL,
       updated_at = now()`,
    ids,
  );

  const syncResult = await syncImpl(client, fetch, gsheetSyncSettings(), ids);
  return {
    done: candidates.rows.length < limit,
    cursor: ids[ids.length - 1],
    selected_rows: ids.length,
    synced_rows: Number(syncResult.synced || 0),
    status: await gsheetBackfillStatus(client),
  };
}

async function drainGsheetSyncOutbox() {
  const client = await getPool().connect();
  try {
    await ensureDatabaseReady(client);
    return await syncPendingGsheetRows(client);
  } finally {
    client.release();
  }
}

function scheduleGsheetSync() {
  const task = drainGsheetSyncOutbox().catch((error) => {
    // GSheet adalah mirror. Gangguan Google tidak boleh membatalkan transaksi
    // antrean yang sudah berhasil di MotherDuck; job tetap FAILED untuk retry.
    console.error("Google Sheets background sync gagal", error);
  });
  try {
    waitUntil(task);
  } catch {
    void task;
  }
}

function operationalJson(res, status, data) {
  scheduleRealtimeChange();
  scheduleGsheetSync();
  return json(res, status, { ok: true, data });
}

async function requeueGsheetRowsForTickets(client, ticketIds = []) {
  const ids = [...new Set((Array.isArray(ticketIds) ? ticketIds : [ticketIds]).map(clean).filter(Boolean))];
  if (!ids.length) return 0;
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(",");
  const result = await client.query(
    `INSERT INTO gsheet_sync_outbox (
       ticket_po_id, ticket_id, sync_status, attempt_count, last_error,
       created_at, updated_at, synced_at
     )
     SELECT p.ticket_po_id, p.ticket_id, 'PENDING', 0, NULL,
       now(), now(), NULL
     FROM ticket_pos p
     WHERE p.ticket_id IN (${placeholders})
     ON CONFLICT (ticket_po_id) DO UPDATE SET
       ticket_id = excluded.ticket_id, sync_status = 'PENDING',
       attempt_count = 0, last_error = NULL, synced_at = NULL,
       updated_at = now()`,
    ids,
  );
  return Number(result.rowCount || 0);
}

function cookieValue(req, name) {
  const prefix = `${name}=`;
  return String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length) || "";
}

function authSecret() {
  const secret = clean(process.env.INBOUND_AUTH_SECRET);
  if (!secret) throw new Error("INBOUND_AUTH_SECRET belum diset di Vercel.");
  return secret;
}

function configuredUsers() {
  try {
    const users = JSON.parse(clean(process.env.INBOUND_AUTH_USERS || "[]"));
    return Array.isArray(users) ? users : [];
  } catch {
    throw new Error("INBOUND_AUTH_USERS harus berformat JSON array.");
  }
}

function signSession(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", authSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function readSession(req) {
  const token = cookieValue(req, "inbound_session");
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const expected = createHmac("sha256", authSecret()).update(encoded).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const session = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return Number(session.exp) > Date.now() ? session : null;
  } catch {
    return null;
  }
}

function setSessionCookie(res, session) {
  res.setHeader(
    "Set-Cookie",
    `inbound_session=${signSession(session)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`,
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "inbound_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
}

function canUseAction(session, action) {
  if (!session) return false;
  const role = clean(session.role).toUpperCase();
  if (["delete_tickets_by_date", "delete_single_ticket"].includes(action)) return ["ADMIN", "DEVELOPER"].includes(role);
  if (action === "bulk_complete_operational") return role === "DEVELOPER";
  if (["state", "state_delta", "realtime_config", "tickets", "export_rows", "create_ticket", "create_tickets_bulk"].includes(action)) return ["SECURITY", "CHECKER", "SPV", "ADMIN", "DEVELOPER"].includes(role);
  if (action === "superset_freshness") return ["SPV", "ADMIN", "DEVELOPER"].includes(role);
  if (["ba_list", "ba_detail", "product_lookup", "create_ba"].includes(action)) return ["SPV", "ADMIN", "DEVELOPER"].includes(role);
  if (["updatechecker", "startcheckerpo", "donecheckerpo", "donegrpo", "donegrpos", "handovergrn", "failcall", "update_ticket_status"].includes(action)) return ["CHECKER", "SPV", "ADMIN", "DEVELOPER"].includes(role);
  return false;
}

const BA_REASONS = [
  "MSLOR", "BARANG RUSAK", "KURANG KIRIM", "TIDAK DATANG", "LEBIH KIRIM",
  "BARANG TIDAK ADA DI PO", "TOLAK BEDA SKU", "TOLAK BEDA GRAMASI", "SALAH BAWA BARANG",
];

function parseCsvRows(raw) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"') {
      if (quoted && raw[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && raw[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function productMasterSeed() {
  const csvPath = path.join(process.cwd(), "data", "product_master.csv");
  if (!fs.existsSync(csvPath)) throw new Error("File master product tidak ditemukan di deployment.");
  const rows = parseCsvRows(fs.readFileSync(csvPath, "utf8"));
  const header = rows.shift().map((value) => clean(value).toLowerCase());
  const skuAt = header.indexOf("sku_number");
  const nameAt = header.indexOf("product_name");
  const productAt = header.indexOf("product_id");
  if (skuAt < 0 || nameAt < 0 || productAt < 0) throw new Error("Header master product tidak valid.");
  return rows.map((row) => ({
    sku_number: clean(row[skuAt]), product_name: clean(row[nameAt]), product_id: clean(row[productAt]),
  })).filter((row) => row.sku_number && row.product_name);
}

function authenticateUser(body) {
  const username = clean(body.username).toLowerCase();
  const password = String(body.password || "");
  const user = configuredUsers().find((candidate) =>
    clean(candidate.username).toLowerCase() === username && String(candidate.password || "") === password,
  );
  if (!user) return null;
  return {
    username: clean(user.username),
    role: clean(user.role).toUpperCase(),
    display_name: clean(user.display_name) || clean(user.username),
    exp: Date.now() + 12 * 60 * 60 * 1000,
  };
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  try {
    return JSON.parse(req.body);
  } catch {
    return {};
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

// Hari operasional inbound dimulai 04:00 WIB (UTC+7), bukan tengah malam.
function operationalWindowWib(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  const localDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  if (Number(parts.hour) < 4) localDate.setUTCDate(localDate.getUTCDate() - 1);
  const key = localDate.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate(), -3));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { key, start, end };
}

function calendarDateWib(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeTicketType(value) {
  const type = clean(value || "REG").toUpperCase().replace(/\s+/g, "-");
  return type === "DROP" ? "DROP-OFF" : type;
}

const CHECKER_SEED = [
  ["MP-001", "pandu"], ["MP-002", "adit"], ["MP-003", "prety"],
  ["46916", "Ali Fahrudin"], ["46917", "Dian Ramdani"], ["46918", "SAMLAWI"],
  ["42892", "Mohamad Nursalim"], ["9339", "A.reza faisal"], ["42889", "Abdul Wahid Rohman"],
  ["48378", "Agim"], ["48371", "Agil"], ["49612", "Mulyadi"],
  ["46117", "Septian Dinariyanto"], ["51839", "Sendi arya ramadhani"],
  ["68843", "Alfian Dwi Prasetyo"], ["68844", "Syamsul Bahri"], ["69330", "Dede Rinaldo"],
  ["70111", "Sabila rifqa aprilian"], ["73398", "Bayu prastio"],
  ["75048", "Muhammad fauzan pradita nurramadhan"], ["75050", "Dedi hidayat"],
  ["75049", "MUHAMAD ANSOR FAUJI"], ["75796", "Abd wahab"],
  ["70725", "M RIZKI HIDAYATULLAH"], ["70730", "Antonius albert Gea"],
  ["76925", "Khoirul imam alfad"], ["77465", "Septian Esa Putra"],
  ["77474", "MUHAMMAD WAHYU JOYO NUGROHO"], ["77473", "Yoga Irawan"],
  ["77587", "Muhammad Luthfi Alfian Zauhari"], ["77612", "yoga jatnika"],
  ["77900", "M.Rizky.Ardiansyah"], ["77911", "Ganang akhtas saputra"],
  ["77912", "Devrizal Oktavian"], ["77915", "Alung Ramadhan"],
  ["77916", "Dimas Wibisono prasetyo"], ["78018", "Randi Wira Sakti"],
  ["78039", "Junaedi Abdullah paqih"], ["78042", "Aditya Yusuf"],
  ["78044", "Ibrohim"], ["78060", "Tulus Rachmawan Adiar"],
  ["78155", "Aldi putra kurniawan"], ["78386", "RAFA RIZKI RAMADHAN"],
];

function databaseName() {
  const name = clean(process.env.MOTHERDUCK_DATABASE || "inbound_cbt_app");
  if (!/^[a-z][a-z0-9_]*$/i.test(name)) {
    throw new Error("MOTHERDUCK_DATABASE hanya boleh berisi huruf, angka, dan underscore.");
  }
  return name;
}

async function ensureSchema(client) {
  const db = databaseName();
  await client.query(`CREATE DATABASE IF NOT EXISTS ${db}`);
  await client.query(`USE ${db}`);
  await client.query(`CREATE TABLE IF NOT EXISTS tickets (
    ticket_id VARCHAR PRIMARY KEY, queue_no VARCHAR NOT NULL,
    ticket_type VARCHAR NOT NULL DEFAULT 'REG', status VARCHAR NOT NULL DEFAULT 'WAITING',
    vendor_name VARCHAR, fleet_type VARCHAR, plat_number VARCHAR, driver_name VARCHAR,
    driver_phone VARCHAR, gate VARCHAR, slot VARCHAR, operational_date VARCHAR, registered_by VARCHAR,
    called_at TIMESTAMP, arrived_at TIMESTAMP, start_unloading_at TIMESTAMP,
    done_unloading_at TIMESTAMP, expired_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS ticket_pos (
    ticket_po_id VARCHAR PRIMARY KEY, ticket_id VARCHAR NOT NULL, po_number VARCHAR NOT NULL,
    vendor_name VARCHAR, request_quantity DOUBLE DEFAULT 0, actual_quantity DOUBLE DEFAULT 0,
    count_sku INTEGER DEFAULT 0, checker_status VARCHAR DEFAULT 'PENDING',
    checking_started_at TIMESTAMP, checking_done_at TIMESTAMP, gr_done_at TIMESTAMP,
    handover_grn_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS ticket_events (
    event_id VARCHAR PRIMARY KEY, ticket_id VARCHAR NOT NULL, event_type VARCHAR NOT NULL,
    actor_role VARCHAR, actor_name VARCHAR, payload_json VARCHAR,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS gates (
    gate_name VARCHAR PRIMARY KEY, status VARCHAR NOT NULL DEFAULT 'KOSONG',
    ticket_id VARCHAR, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS checker_master (
    mp_id VARCHAR PRIMARY KEY, checker_name VARCHAR NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS call_count INTEGER DEFAULT 0`);
  await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS last_call_at TIMESTAMP`);
  await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS expired_reason VARCHAR`);
  await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS operational_date VARCHAR`);
  await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ktp_6_digit VARCHAR`);
  await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS unload_sla VARCHAR`);
  await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS source VARCHAR`);
  await client.query(`ALTER TABLE ticket_pos ADD COLUMN IF NOT EXISTS gr_status VARCHAR DEFAULT 'PENDING'`);
  await client.query(`ALTER TABLE ticket_pos ADD COLUMN IF NOT EXISTS checker_id VARCHAR`);
  await client.query(`ALTER TABLE ticket_pos ADD COLUMN IF NOT EXISTS checker_name VARCHAR`);
  await client.query(`ALTER TABLE ticket_pos ADD COLUMN IF NOT EXISTS checker_started_at TIMESTAMP`);
  await client.query(`ALTER TABLE ticket_pos ADD COLUMN IF NOT EXISTS checker_done_at TIMESTAMP`);
  await client.query(`ALTER TABLE ticket_pos ADD COLUMN IF NOT EXISTS done_gr_at TIMESTAMP`);
  await client.query(`ALTER TABLE ticket_pos ADD COLUMN IF NOT EXISTS handover_grn_at TIMESTAMP`);
  await client.query(`CREATE TABLE IF NOT EXISTS superset_po_master (
    source_row_key VARCHAR PRIMARY KEY,
    po_number VARCHAR NOT NULL,
    vendor_name VARCHAR,
    location_id VARCHAR,
    location_name VARCHAR,
    request_shipping_date VARCHAR,
    fulfillment_arrived_start_at VARCHAR,
    schedule_type VARCHAR,
    po_status VARCHAR,
    fulfillment_receiving_start_at VARCHAR,
    fulfillment_completed_at VARCHAR,
    request_quantity DOUBLE DEFAULT 0,
    actual_quantity DOUBLE DEFAULT 0,
    count_sku BIGINT DEFAULT 0,
    synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS product_master (
    sku_number VARCHAR PRIMARY KEY, product_name VARCHAR NOT NULL, product_id VARCHAR,
    imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS product_master_product_id_idx ON product_master(product_id)`);
  await client.query(`CREATE TABLE IF NOT EXISTS gsheet_sync_outbox (
    ticket_po_id VARCHAR PRIMARY KEY,
    ticket_id VARCHAR NOT NULL,
    sync_status VARCHAR NOT NULL DEFAULT 'PENDING',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error VARCHAR,
    synced_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS ba_sequences (
    sequence_key VARCHAR PRIMARY KEY, last_number INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS ba_documents (
    ba_id VARCHAR PRIMARY KEY, ba_number VARCHAR UNIQUE NOT NULL, ba_date VARCHAR NOT NULL,
    day_name VARCHAR NOT NULL, po_number VARCHAR, supplier_name VARCHAR, note VARCHAR,
    created_by VARCHAR, created_role VARCHAR, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS ba_items (
    ba_item_id VARCHAR PRIMARY KEY, ba_id VARCHAR NOT NULL, sku_number VARCHAR,
    product_id VARCHAR, product_name VARCHAR NOT NULL, quantity VARCHAR NOT NULL,
    reason VARCHAR NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  const productCount = await client.query(`SELECT COUNT(*)::int AS count FROM product_master`);
  if (Number(productCount.rows[0]?.count || 0) === 0) {
    const master = productMasterSeed();
    // MotherDuck does not prepare table-function array parameters consistently.
    // This local CSV is trusted deployment data, so seed it in bounded escaped batches.
    const literal = (value) => `'${String(value ?? "").replace(/'/g, "''")}'`;
    for (let start = 0; start < master.length; start += 5000) {
      const values = master.slice(start, start + 5000).map((row) =>
        `(${literal(row.sku_number)},${literal(row.product_name)},${literal(row.product_id)},CURRENT_TIMESTAMP)`,
      ).join(",");
      await client.query(
        `INSERT INTO product_master (sku_number, product_name, product_id, imported_at) VALUES ${values}
         ON CONFLICT (sku_number) DO UPDATE SET
           product_name = excluded.product_name, product_id = excluded.product_id, imported_at = excluded.imported_at`,
      );
    }
  }

  const checkerCount = await client.query(`SELECT COUNT(*) AS count FROM checker_master`);
  if (Number(checkerCount.rows[0]?.count || 0) === 0) {
    const values = CHECKER_SEED.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2}, TRUE)`).join(", ");
    await client.query(
      `INSERT INTO checker_master (mp_id, checker_name, active) VALUES ${values}`,
      CHECKER_SEED.flat(),
    );
  }
}

async function ensureDatabaseReady(client) {
  if (!schemaReady) {
    if (!schemaReadyPromise) {
      schemaReadyPromise = ensureSchema(client)
        .then(() => {
          schemaReady = true;
        })
        .catch((error) => {
          schemaReadyPromise = null;
          throw error;
        });
    }
    await schemaReadyPromise;
  }
  // `USE` berlaku per koneksi MotherDuck/Postgres, sehingga tetap dijalankan
  // sekali pada client yang dipinjam tanpa mengulang seluruh DDL/migrasi.
  await client.query(`USE ${databaseName()}`);
}

function resetSchemaCacheForTests() {
  schemaReady = false;
  schemaReadyPromise = null;
}

function supersetConfig() {
  const rawCookie = clean(process.env.SUPERSET_SESSION_COOKIE);
  if (!rawCookie) {
    throw new Error("SUPERSET_SESSION_COOKIE belum diset di Vercel.");
  }
  return {
    baseUrl: clean(process.env.SUPERSET_BASE_URL || "https://dash.astronauts.id").replace(/\/$/, ""),
    cookie: rawCookie.startsWith("session=") ? rawCookie : `session=${rawCookie}`,
  };
}

async function fetchSupersetPoRows() {
  const { baseUrl, cookie } = supersetConfig();
  const commonHeaders = { accept: "application/json", cookie, referer: `${baseUrl}/` };
  const chartResponse = await fetch(
    `${baseUrl}/api/v1/chart/20662/data/?force=true`,
    { headers: commonHeaders },
  );
  if (!chartResponse.ok) {
    throw new Error(`Superset saved chart gagal: HTTP ${chartResponse.status}`);
  }
  const chartPayload = await chartResponse.json();
  const data = chartPayload?.result?.[0]?.data;
  if (!Array.isArray(data)) {
    throw new Error("Format saved chart Superset tidak berisi result[0].data.");
  }
  return data;
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function sourceRowKey(row) {
  return createHash("sha256").update(JSON.stringify([
    row.po_number, row.location_id, row.request_shipping_date, row.fulfillment_arrived_start_at,
    row.schedule_type, row.company_name, row.po_status, row.fulfillment_receiving_start_at,
    row.fulfillment_completed_at,
  ])).digest("hex");
}

async function syncSupersetPoMaster(client) {
  const rows = await fetchSupersetPoRows();
  const fieldsPerRow = 15;
  const batchSize = 250;
  let written = 0;

  await client.query("BEGIN");
  try {
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      const values = [];
      const placeholders = batch.map((row, rowIndex) => {
        const start = rowIndex * fieldsPerRow;
        values.push(
          sourceRowKey(row), clean(row.po_number), clean(row.company_name) || null,
          clean(row.location_id) || null, clean(row.location_name) || null,
          clean(row.request_shipping_date) || null, clean(row.fulfillment_arrived_start_at) || null,
          clean(row.schedule_type) || null, clean(row.po_status) || null,
          clean(row.fulfillment_receiving_start_at) || null, clean(row.fulfillment_completed_at) || null,
          asNumber(row["SUM(request_quantity)"]), asNumber(row["SUM(actual_quantity)"]),
          Math.trunc(asNumber(row["COUNT_DISTINCT(sku_number)"])), new Date().toISOString(),
        );
        return `(${Array.from({ length: fieldsPerRow }, (_, index) => `$${start + index + 1}`).join(",")})`;
      });
      await client.query(
        `INSERT INTO superset_po_master (
          source_row_key, po_number, vendor_name, location_id, location_name,
          request_shipping_date, fulfillment_arrived_start_at, schedule_type, po_status,
          fulfillment_receiving_start_at, fulfillment_completed_at, request_quantity,
          actual_quantity, count_sku, synced_at
        ) VALUES ${placeholders.join(",")}
        ON CONFLICT (source_row_key) DO UPDATE SET
          vendor_name = excluded.vendor_name, location_name = excluded.location_name,
          po_status = excluded.po_status, request_quantity = excluded.request_quantity,
          actual_quantity = excluded.actual_quantity, count_sku = excluded.count_sku,
          synced_at = excluded.synced_at`,
        values,
      );
      written += batch.length;
    }
    await client.query("COMMIT");
    return { fetched: rows.length, written };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function appendEvent(client, ticketId, eventType, actor = {}, payload = {}) {
  await client.query(
    `INSERT INTO ticket_events (
      event_id, ticket_id, event_type, actor_role, actor_name, payload_json
    ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      randomUUID(),
      ticketId,
      eventType,
      clean(actor.role) || null,
      clean(actor.name) || null,
      JSON.stringify(payload),
    ],
  );
}

async function listTickets(client, status) {
  const args = [];
  const where = status ? "WHERE t.status = $1" : "";
  if (status) args.push(status);

  const { rows } = await client.query(
    `SELECT
       t.ticket_id, t.queue_no, t.ticket_type, t.status, t.vendor_name,
       t.fleet_type, t.plat_number, t.driver_name, t.driver_phone, t.gate,
       t.slot, t.operational_date, t.registered_by, t.called_at, t.arrived_at,
       t.start_unloading_at, t.done_unloading_at, t.expired_at,
       t.created_at, t.updated_at,
       COALESCE(SUM(p.request_quantity), 0) AS request_quantity,
       COALESCE(SUM(p.actual_quantity), 0) AS actual_quantity,
       COUNT(p.ticket_po_id) AS po_count
     FROM tickets t
     LEFT JOIN ticket_pos p ON p.ticket_id = t.ticket_id
     ${where}
     GROUP BY ALL
     ORDER BY t.created_at DESC`,
    args,
  );
  return rows;
}

async function listOperationalRows(client, ticketId = null, updatedSince = null) {
  const args = [];
  const conditions = [];
  if (ticketId) {
    args.push(ticketId);
    conditions.push(`t.ticket_id = $${args.length}`);
  }
  if (updatedSince) {
    args.push(updatedSince);
    conditions.push(
      `GREATEST(
        COALESCE(t.updated_at, t.created_at),
        COALESCE(p.updated_at, p.created_at, t.updated_at, t.created_at)
      ) >= $${args.length}`,
    );
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await client.query(
    `SELECT
       t.ticket_id, t.queue_no, t.ticket_type, t.status, t.vendor_name,
       t.fleet_type, t.plat_number, t.driver_name, t.driver_phone AS phone_number,
       t.gate, t.slot, t.operational_date, t.registered_by, t.ktp_6_digit, t.unload_sla,
       t.source, t.called_at, t.arrived_at,
       t.start_unloading_at, t.done_unloading_at AS finish_unloading_at,
       t.expired_at, t.expired_reason, t.call_count, t.last_call_at,
       t.created_at AS register_time, t.created_at, t.updated_at,
       p.ticket_po_id, p.po_number, p.vendor_name AS po_vendor_name,
       p.request_quantity AS total_po_qty, p.actual_quantity,
       p.count_sku AS count_po_sku, p.checker_status, p.gr_status,
       p.checker_id, p.checker_name, p.checking_started_at AS checker_started_at,
       p.checking_done_at AS checker_done_at, p.gr_done_at AS done_gr_at,
       p.handover_grn_at, p.created_at AS po_created_at, p.updated_at AS po_updated_at
     FROM tickets t
     LEFT JOIN ticket_pos p ON p.ticket_id = t.ticket_id
     ${where}
     ORDER BY t.created_at DESC, p.created_at ASC`,
    args,
  );
  return rows;
}

async function lookupProduct(client, query) {
  const value = clean(query);
  if (!value) throw new Error("SKU atau Product ID wajib diisi.");
  const { rows } = await client.query(
    `SELECT sku_number, product_id, product_name
     FROM product_master
     WHERE sku_number = $1 OR product_id = $1
     ORDER BY CASE WHEN sku_number = $1 THEN 0 ELSE 1 END
     LIMIT 1`,
    [value],
  );
  return rows[0] || null;
}

async function listBaDocuments(client) {
  const { rows } = await client.query(
    `SELECT ba_id, ba_number, ba_date, day_name, po_number, supplier_name, note,
       created_by, created_role, created_at,
       COUNT(i.ba_item_id)::int AS item_count
     FROM ba_documents d
     LEFT JOIN ba_items i ON i.ba_id = d.ba_id
     GROUP BY ALL
     ORDER BY d.created_at DESC
     LIMIT 100`,
  );
  return rows;
}

async function getBaDetail(client, baId) {
  const document = await client.query(`SELECT * FROM ba_documents WHERE ba_id = $1`, [clean(baId)]);
  if (!document.rows[0]) throw new Error("Dokumen BA tidak ditemukan.");
  const items = await client.query(`SELECT * FROM ba_items WHERE ba_id = $1 ORDER BY created_at ASC`, [clean(baId)]);
  return { document: document.rows[0], items: items.rows };
}

function toBaDayName(dateText) {
  const date = new Date(`${dateText}T12:00:00Z`);
  const days = ["MINGGU", "SENIN", "SELASA", "RABU", "KAMIS", "JUMAT", "SABTU"];
  return Number.isNaN(date.getTime()) ? "" : days[date.getUTCDay()];
}

async function createBaDocument(client, body, session) {
  const baDate = /^\d{4}-\d{2}-\d{2}$/.test(clean(body.ba_date)) ? clean(body.ba_date) : calendarDateWib();
  const items = Array.isArray(body.items) ? body.items : [];
  const validItems = items.map((item) => ({
    sku_number: clean(item.sku_number), product_id: clean(item.product_id),
    product_name: clean(item.product_name), quantity: clean(item.quantity), reason: clean(item.reason).toUpperCase(),
  })).filter((item) => item.sku_number || item.product_name);
  if (!validItems.length) throw new Error("Isi minimal satu barang BA.");
  for (const item of validItems) {
    if (!item.product_name) throw new Error("Deskripsi barang wajib diisi.");
    if (!item.quantity) throw new Error("Qty barang wajib diisi.");
    if (!BA_REASONS.includes(item.reason)) throw new Error("Reason BA tidak valid.");
  }
  const [year, month] = baDate.split("-");
  const sequenceKey = `${year}-${month}`;
  await client.query("BEGIN");
  try {
    const sequence = await client.query(
      `INSERT INTO ba_sequences (sequence_key, last_number, updated_at) VALUES ($1, 1, CURRENT_TIMESTAMP)
       ON CONFLICT (sequence_key) DO UPDATE SET last_number = ba_sequences.last_number + 1, updated_at = CURRENT_TIMESTAMP
       RETURNING last_number`, [sequenceKey],
    );
    const number = String(sequence.rows[0].last_number).padStart(6, "0");
    const baId = randomUUID();
    const baNumber = `${number}/CBT/${month}/${year}`;
    const dayName = clean(body.day_name) || toBaDayName(baDate);
    await client.query(
      `INSERT INTO ba_documents (ba_id, ba_number, ba_date, day_name, po_number, supplier_name, note, created_by, created_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [baId, baNumber, baDate, dayName, clean(body.po_number) || null, clean(body.supplier_name) || null,
        clean(body.note) || null, clean(session.display_name || session.username), clean(session.role)],
    );
    const params = [];
    const values = validItems.map((item, index) => {
      const start = index * 7;
      params.push(randomUUID(), baId, item.sku_number || null, item.product_id || null, item.product_name, item.quantity, item.reason);
      return `($${start + 1},$${start + 2},$${start + 3},$${start + 4},$${start + 5},$${start + 6},$${start + 7})`;
    });
    await client.query(`INSERT INTO ba_items (ba_item_id, ba_id, sku_number, product_id, product_name, quantity, reason) VALUES ${values.join(",")}`, params);
    await client.query("COMMIT");
    return getBaDetail(client, baId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function deleteTicketsByDate(client, operationalDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(operationalDate)) {
    throw new Error("operational_date harus format YYYY-MM-DD.");
  }
  await client.query("BEGIN");
  try {
    const found = await client.query(
      `SELECT ticket_id FROM tickets
       WHERE operational_date = $1 OR CAST(created_at AS DATE) = CAST($1 AS DATE)`,
      [operationalDate],
    );
    const ticketIds = found.rows.map((row) => row.ticket_id);
    if (!ticketIds.length) {
      await client.query("COMMIT");
      return { operational_date: operationalDate, tickets_deleted: 0, po_rows_deleted: 0, events_deleted: 0 };
    }
    const args = ticketIds;
    const placeholders = args.map((_, index) => `$${index + 1}`).join(",");
    const events = await client.query(`DELETE FROM ticket_events WHERE ticket_id IN (${placeholders})`, args);
    const pos = await client.query(`DELETE FROM ticket_pos WHERE ticket_id IN (${placeholders})`, args);
    await client.query(`UPDATE gates SET status = 'KOSONG', ticket_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE ticket_id IN (${placeholders})`, args);
    const tickets = await client.query(`DELETE FROM tickets WHERE ticket_id IN (${placeholders})`, args);
    await client.query("COMMIT");
    return {
      operational_date: operationalDate,
      tickets_deleted: tickets.rowCount,
      po_rows_deleted: pos.rowCount,
      events_deleted: events.rowCount,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

// Deletes exactly one accidental ticket. The queue, plate, and operational date
// combination prevents a broad date cleanup from affecting active operations.
async function deleteSingleTicket(client, body) {
  const queueNo = clean(body.queue_no);
  const plateNumber = clean(body.plat_number).replace(/\s+/g, "").toUpperCase();
  const operationalDate = clean(body.operational_date);
  if (!queueNo || !plateNumber || !/^\d{4}-\d{2}-\d{2}$/.test(operationalDate)) {
    throw new Error("Queue No, Plat Number, dan tanggal operasional wajib diisi.");
  }

  const found = await client.query(
    `SELECT ticket_id, queue_no, plat_number, operational_date
     FROM tickets
     WHERE queue_no = $1
       AND UPPER(REPLACE(COALESCE(plat_number, ''), ' ', '')) = $2
       AND operational_date = $3`,
    [queueNo, plateNumber, operationalDate],
  );
  if (!found.rows.length) {
    throw new Error("Ticket tidak ditemukan. Pastikan Queue No, plat, dan tanggal operasional sudah tepat.");
  }
  if (found.rows.length > 1) {
    throw new Error("Ditemukan lebih dari satu ticket. Hubungi Developer untuk pengecekan ticket_id.");
  }

  const ticket = found.rows[0];
  await client.query("BEGIN");
  try {
    const events = await client.query("DELETE FROM ticket_events WHERE ticket_id = $1", [ticket.ticket_id]);
    const pos = await client.query("DELETE FROM ticket_pos WHERE ticket_id = $1", [ticket.ticket_id]);
    await client.query(
      "UPDATE gates SET status = 'KOSONG', ticket_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE ticket_id = $1",
      [ticket.ticket_id],
    );
    const tickets = await client.query("DELETE FROM tickets WHERE ticket_id = $1", [ticket.ticket_id]);
    await client.query("COMMIT");
    return {
      deleted_ticket: ticket,
      tickets_deleted: tickets.rowCount,
      po_rows_deleted: pos.rowCount,
      events_deleted: events.rowCount,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

// Developer-only tool for closing test/stuck operational tickets without deleting
// their audit trail. Any blank actual quantity follows the PO request quantity.
async function bulkCompleteOperational(client, body, session) {
  const operationalDate = clean(body.operational_date) || operationalWindowWib().key;
  const allActive = body.all_active === true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(operationalDate)) {
    throw new Error("operational_date harus format YYYY-MM-DD.");
  }

  const active = await client.query(
    `SELECT ticket_id, queue_no, gate, operational_date
     FROM tickets
     WHERE UPPER(COALESCE(status, 'WAITING')) NOT IN ('COMPLETED', 'EXPIRED')
       ${allActive ? "" : "AND operational_date = $1"}
     ORDER BY created_at ASC`,
    allActive ? [] : [operationalDate],
  );
  if (!active.rows.length) {
    return { operational_date: operationalDate, all_active: allActive, tickets_completed: 0, po_completed: 0 };
  }

  const actor = {
    role: clean(session?.role) || "DEVELOPER",
    name: clean(session?.display_name || session?.username) || "Developer",
  };
  const ticketIds = active.rows.map((row) => row.ticket_id);
  const ticketPlaceholders = ticketIds.map((_, index) => `$${index + 1}`).join(",");
  const poPlaceholders = ticketIds.map((_, index) => `$${index + 3}`).join(",");

  await client.query("BEGIN");
  try {
    const pos = await client.query(
      `UPDATE ticket_pos
       SET checker_id = COALESCE(NULLIF(checker_id, ''), $1),
           checker_name = COALESCE(NULLIF(checker_name, ''), $2),
           checker_status = 'DONE',
           checking_started_at = COALESCE(checking_started_at, CURRENT_TIMESTAMP),
           checking_done_at = COALESCE(checking_done_at, CURRENT_TIMESTAMP),
           actual_quantity = CASE
             WHEN COALESCE(actual_quantity, 0) <= 0 THEN COALESCE(request_quantity, 0)
             ELSE actual_quantity
           END,
           gr_status = 'DONE GR',
           gr_done_at = COALESCE(gr_done_at, CURRENT_TIMESTAMP),
           handover_grn_at = COALESCE(handover_grn_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE ticket_id IN (${poPlaceholders})`,
      [actor.name, actor.name, ...ticketIds],
    );
    const tickets = await client.query(
      `UPDATE tickets
       SET status = 'COMPLETED',
           called_at = COALESCE(called_at, CURRENT_TIMESTAMP),
           start_unloading_at = COALESCE(start_unloading_at, CURRENT_TIMESTAMP),
           done_unloading_at = COALESCE(done_unloading_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE ticket_id IN (${ticketPlaceholders})`,
      ticketIds,
    );

    for (const ticket of active.rows) {
      await appendEvent(client, ticket.ticket_id, "DEVELOPER_BULK_COMPLETE", actor, {
        operational_date: operationalDate,
        all_active: allActive,
        flow: ["CALLED", "UNLOADING", "DONE CHECKER", "DONE GR", "HANDOVER GRN"],
        gate: clean(ticket.gate) || null,
        note: "Developer bulk completion; actual qty kosong memakai request qty PO.",
      });
    }
    await requeueGsheetRowsForTickets(client, ticketIds);
    await client.query("COMMIT");
    return {
      operational_date: operationalDate,
      all_active: allActive,
      operational_dates: [...new Set(active.rows.map((row) => row.operational_date).filter(Boolean))],
      tickets_completed: tickets.rowCount,
      po_completed: pos.rowCount,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function getAppState(client) {
  const [master, outputForm, inboundMp] = await Promise.all([
    client.query(`SELECT
       po_number, vendor_name, '3' AS slot,
       request_quantity AS total_request_quantity,
       count_sku AS "Count SKU", location_id, location_name,
       request_shipping_date, fulfillment_arrived_start_at,
       schedule_type, po_status
     FROM superset_po_master
     ORDER BY synced_at DESC, po_number ASC`),
    listOperationalRows(client),
    client.query(`SELECT mp_id, mp_id AS checker_id, checker_name
      FROM checker_master WHERE active = TRUE ORDER BY checker_name ASC`),
  ]);
  return {
    status: "success",
    timestamp: new Date().toISOString(),
    tablev2: master.rows,
    outputForm,
    inboundMp: inboundMp.rows,
  };
}

async function getAppStateDelta(client, sinceValue) {
  const parsedSince = new Date(clean(sinceValue));
  if (Number.isNaN(parsedSince.getTime())) {
    throw new Error("Parameter since wajib berupa timestamp ISO yang valid.");
  }
  const cursor = new Date().toISOString();
  const [outputForm, ticketIds, inboundMp] = await Promise.all([
    listOperationalRows(client, null, parsedSince.toISOString()),
    client.query(`SELECT ticket_id FROM tickets ORDER BY ticket_id ASC`),
    client.query(`SELECT mp_id, mp_id AS checker_id, checker_name
      FROM checker_master WHERE active = TRUE ORDER BY checker_name ASC`),
  ]);
  return {
    status: "success",
    timestamp: cursor,
    outputForm,
    ticket_ids: ticketIds.rows.map((row) => row.ticket_id),
    inboundMp: inboundMp.rows,
  };
}

async function getSupersetFreshness(client) {
  const receivedDate = calendarDateWib();
  const [year, month, day] = receivedDate.split("-");
  const datePatterns = [
    `%${receivedDate}%`,
    `%${day}/${month}/${year}%`,
    `%${day}-${month}-${year}%`,
  ];
  const summary = await client.query(`
    SELECT
      COUNT(*)::int AS total_master_po,
      MAX(synced_at) AS last_synced_at,
      COUNT(*) FILTER (
        WHERE COALESCE(fulfillment_arrived_start_at, '') LIKE $1
           OR COALESCE(fulfillment_arrived_start_at, '') LIKE $2
           OR COALESCE(fulfillment_arrived_start_at, '') LIKE $3
      )::int AS received_today_count
    FROM superset_po_master
  `, datePatterns);
  const samples = await client.query(`
    SELECT po_number, vendor_name, fulfillment_arrived_start_at,
      request_shipping_date, po_status, synced_at
    FROM superset_po_master
    WHERE COALESCE(fulfillment_arrived_start_at, '') LIKE $1
       OR COALESCE(fulfillment_arrived_start_at, '') LIKE $2
       OR COALESCE(fulfillment_arrived_start_at, '') LIKE $3
    ORDER BY synced_at DESC, po_number ASC
    LIMIT 8
  `, datePatterns);
  return {
    received_date_wib: receivedDate,
    ...summary.rows[0],
    received_today_samples: samples.rows,
  };
}

async function createTicketRecord(client, body, operational = operationalWindowWib()) {
  const ticket = body.ticket || body;
  const ticketId = clean(ticket.ticket_id) || randomUUID();
  const ticketType = normalizeTicketType(ticket.ticket_type);
  const slot = clean(ticket.slot) || "3";
  const poRows = Array.isArray(body.pos) ? body.pos : [];

  if (!poRows.length) throw new Error("Minimal satu PO wajib diisi.");

  const poNumbers = [...new Set(poRows.map((po) => clean(po.po_number)).filter(Boolean))];
  if (poNumbers.length !== poRows.length) throw new Error("po_number wajib diisi.");
  const masterPoNumbers = [
    ...new Set(
      poRows
        .filter((po) => po.is_manual !== true)
        .map((po) => clean(po.po_number))
        .filter(Boolean),
    ),
  ];
  if (masterPoNumbers.length) {
    const knownPos = await client.query(
      `SELECT DISTINCT po_number FROM superset_po_master WHERE po_number IN (${masterPoNumbers.map((_, i) => `$${i + 1}`).join(",")})`,
      masterPoNumbers,
    );
    if (knownPos.rows.length !== masterPoNumbers.length) {
      throw new Error("Ada PO yang tidak ditemukan di master MotherDuck. Pilih opsi PO manual jika memang belum tersedia.");
    }
  }
  for (const po of poRows.filter((item) => item.is_manual === true)) {
    if (!clean(po.vendor_name) && !clean(ticket.vendor_name)) {
      throw new Error("Vendor Name wajib diisi untuk PO manual.");
    }
  }

  // Nomor queue selalu dihitung di transaksi backend. Insert sebelumnya dalam
  // bulk yang sama sudah terlihat di sini, sehingga sequence per slot/hari
  // tetap berurutan tanpa mempercayai nomor prediksi browser.
  const existing = await client.query(
    `SELECT queue_no FROM tickets
     WHERE slot = $1 AND ticket_type = $2
       AND created_at >= $3 AND created_at < $4`,
    [slot, ticketType, operational.start, operational.end],
  );
  const maxSequence = existing.rows.reduce((max, row) => {
    const match = clean(row.queue_no).match(/-\s*(\d+)\s*$/);
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0);
  const queueNo = `${ticketType} ${slot}-${maxSequence + 1}`;

  await client.query(
    `INSERT INTO tickets (
      ticket_id, queue_no, ticket_type, status, vendor_name, fleet_type,
      plat_number, driver_name, driver_phone, gate, slot, operational_date, registered_by,
      ktp_6_digit, unload_sla, source
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      ticketId, queueNo, ticketType,
      clean(ticket.status) || "WAITING", clean(ticket.vendor_name) || null,
      clean(ticket.fleet_type) || null, clean(ticket.plat_number) || null,
      clean(ticket.driver_name) || null, clean(ticket.driver_phone) || null,
      clean(ticket.gate) || null, slot, operational.key,
      clean(ticket.registered_by) || null, clean(ticket.ktp_6_digit) || null,
      clean(ticket.unload_sla) || "ON PROCESS", clean(ticket.source) || "MotherDuck",
    ],
  );

  for (const po of poRows) {
    const poNumber = clean(po.po_number);
    if (!poNumber) throw new Error("po_number wajib diisi.");
    const ticketPoId = clean(po.ticket_po_id) || randomUUID();
    await client.query(
      `INSERT INTO ticket_pos (
        ticket_po_id, ticket_id, po_number, vendor_name, request_quantity,
        actual_quantity, count_sku, checker_status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        ticketPoId, ticketId, poNumber, clean(po.vendor_name) || clean(ticket.vendor_name) || null,
        Number(po.request_quantity || 0), Number(po.actual_quantity || 0),
        Number(po.count_sku || 0), clean(po.checker_status) || "PENDING",
      ],
    );
    await client.query(
      `INSERT INTO gsheet_sync_outbox (
        ticket_po_id, ticket_id, sync_status, attempt_count, created_at, updated_at
      ) VALUES ($1,$2,'PENDING',0,now(),now())
      ON CONFLICT (ticket_po_id) DO UPDATE SET
        ticket_id = excluded.ticket_id, sync_status = 'PENDING',
        attempt_count = 0, last_error = NULL, synced_at = NULL,
        updated_at = now()`,
      [ticketPoId, ticketId],
    );
  }

  await appendEvent(client, ticketId, "SECURITY_REGISTERED", body.actor, {
    queue_no: queueNo,
    po_count: poRows.length,
  });
  return { ticket_id: ticketId, queue_no: queueNo, operational_date: operational.key };
}

async function createTicket(client, body) {
  await client.query("BEGIN");
  try {
    const created = await createTicketRecord(client, body);
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function createTicketsBulk(client, body) {
  const tickets = Array.isArray(body.tickets) ? body.tickets : [];
  if (!tickets.length) throw new Error("Minimal satu ticket wajib diisi.");
  if (tickets.length > 50) throw new Error("Maksimal 50 ticket per submit.");
  const ticketIds = tickets.map((item) => clean(item?.ticket?.ticket_id || item?.ticket_id)).filter(Boolean);
  if (new Set(ticketIds).size !== ticketIds.length) throw new Error("ticket_id duplikat dalam satu submit.");

  await client.query("BEGIN");
  try {
    const operational = operationalWindowWib();
    const created = [];
    for (const ticketBody of tickets) {
      created.push(await createTicketRecord(client, ticketBody, operational));
    }
    await client.query("COMMIT");
    return { created, inserted_tickets: created.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function updateTicketStatus(client, body) {
  const ticketId = clean(body.ticket_id);
  const status = clean(body.status).toUpperCase();
  if (!ticketId || !status) throw new Error("ticket_id dan status wajib diisi.");

  const timeColumn = {
    CALLED: "called_at",
    ARRIVED: "arrived_at",
    UNLOADING: "start_unloading_at",
    COMPLETED: "done_unloading_at",
    EXPIRED: "expired_at",
  }[status];

  const fields = ["status = $1", "updated_at = CURRENT_TIMESTAMP"];
  const values = [status];
  if (clean(body.gate)) {
    values.push(clean(body.gate));
    fields.push(`gate = $${values.length}`);
  }
  if (timeColumn) fields.push(`${timeColumn} = CURRENT_TIMESTAMP`);
  values.push(ticketId);

  await client.query("BEGIN");
  try {
    const result = await client.query(
      `UPDATE tickets SET ${fields.join(", ")} WHERE ticket_id = $${values.length} RETURNING *`,
      values,
    );
    if (!result.rowCount) throw new Error("Ticket tidak ditemukan.");
    await appendEvent(client, ticketId, `STATUS_${status}`, body.actor, {
      gate: clean(body.gate) || null,
    });
    await requeueGsheetRowsForTickets(client, [ticketId]);
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function updateTicketPos(client, body, action) {
  const ticketId = clean(body.ticket_id);
  const poIds = Array.isArray(body.ticket_po_ids)
    ? body.ticket_po_ids.map(clean).filter(Boolean)
    : [clean(body.ticket_po_id)].filter(Boolean);
  if (!ticketId) throw new Error("ticket_id wajib diisi.");

  await client.query("BEGIN");
  try {
    if (action === "startcheckerpo" || action === "donecheckerpo") {
      if (!poIds.length) throw new Error("ticket_po_id wajib diisi.");
      const params = [ticketId, ...poIds];
      const ids = poIds.map((_, index) => `$${index + 2}`).join(",");
      if (action === "startcheckerpo") {
        const started = await client.query(
          `UPDATE ticket_pos SET checker_id = $${params.length + 1}, checker_name = $${params.length + 2},
             checker_status = 'CHECKING', checking_started_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
           WHERE ticket_id = $1 AND ticket_po_id IN (${ids})
             AND UPPER(COALESCE(checker_status, 'PENDING')) = 'PENDING'
           RETURNING ticket_po_id`,
          [...params, clean(body.checker_id) || null, clean(body.checker_name) || null],
        );
        if (started.rowCount !== poIds.length) {
          throw new Error("Ada PO yang sudah sedang atau selesai checking. Refresh data lalu pilih PO PENDING saja.");
        }
        await client.query(`UPDATE tickets SET status = 'UNLOADING', start_unloading_at = COALESCE(start_unloading_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE ticket_id = $1`, [ticketId]);
      } else {
        const finished = await client.query(
          `UPDATE ticket_pos SET checker_status = 'DONE', checking_done_at = CURRENT_TIMESTAMP,
             gr_status = CASE WHEN gr_status = 'DONE GR' THEN gr_status ELSE 'WAITING GR' END,
             updated_at = CURRENT_TIMESTAMP
           WHERE ticket_id = $1 AND ticket_po_id IN (${ids})
             AND UPPER(COALESCE(checker_status, 'PENDING')) = 'CHECKING'
           RETURNING ticket_po_id`,
          params,
        );
        if (finished.rowCount !== poIds.length) {
          throw new Error("Done Checker hanya berlaku untuk PO berstatus CHECKING. Refresh data terlebih dahulu.");
        }

        const autoFinish = await client.query(
          `UPDATE tickets
           SET status = 'WAITING GR', done_unloading_at = COALESCE(done_unloading_at, CURRENT_TIMESTAMP),
               updated_at = CURRENT_TIMESTAMP
           WHERE ticket_id = $1
             AND status NOT IN ('WAITING GR', 'COMPLETED', 'EXPIRED')
             AND EXISTS (SELECT 1 FROM ticket_pos WHERE ticket_id = $1)
             AND NOT EXISTS (
               SELECT 1 FROM ticket_pos
               WHERE ticket_id = $1 AND UPPER(COALESCE(checker_status, 'PENDING')) <> 'DONE'
             )
           RETURNING ticket_id`,
          [ticketId],
        );
        if (autoFinish.rowCount) {
          await appendEvent(client, ticketId, "AUTO_FINISH_UNLOADING", body.actor, {
            reason: "Semua PO selesai Done Checking",
          });
        }
      }
    } else if (action === "donegrpo") {
      const poId = clean(body.ticket_po_id);
      if (!poId) throw new Error("ticket_po_id wajib diisi.");
      await client.query(
        `UPDATE ticket_pos SET actual_quantity = $3, gr_status = 'DONE GR', gr_done_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP WHERE ticket_id = $1 AND ticket_po_id = $2`,
        [ticketId, poId, Number(body.actual_quantity || 0)],
      );
    } else if (action === "donegrpos") {
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) throw new Error("Minimal satu Actual Qty wajib diisi.");
      for (const item of items) {
        const poId = clean(item.ticket_po_id);
        const quantity = Number(item.actual_quantity || 0);
        if (!poId || !Number.isFinite(quantity) || quantity <= 0) {
          throw new Error("Setiap Actual Qty harus lebih dari 0.");
        }
        await client.query(
          `UPDATE ticket_pos SET actual_quantity = $3, gr_status = 'DONE GR', gr_done_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
           WHERE ticket_id = $1 AND ticket_po_id = $2
             AND UPPER(COALESCE(checker_status, 'PENDING')) = 'DONE'
             AND UPPER(COALESCE(gr_status, 'PENDING')) <> 'DONE GR'`,
          [ticketId, poId, quantity],
        );
      }
    } else if (action === "handovergrn") {
      await client.query(`UPDATE ticket_pos SET handover_grn_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE ticket_id = $1`, [ticketId]);
      await client.query(`UPDATE tickets SET status = 'COMPLETED', done_unloading_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE ticket_id = $1`, [ticketId]);
    } else if (action === "failcall") {
      await client.query(`UPDATE tickets SET status = 'EXPIRED', expired_at = CURRENT_TIMESTAMP, expired_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE ticket_id = $1`, [ticketId, clean(body.reason) || null]);
    } else {
      const status = clean(body.status).toUpperCase();
      const fields = ["updated_at = CURRENT_TIMESTAMP"];
      const values = [ticketId];
      if (status) { values.push(status); fields.push(`status = $${values.length}`); }
      if (clean(body.gate)) { values.push(clean(body.gate)); fields.push(`gate = $${values.length}`); }
      if (status === "CALLED") { fields.push("called_at = COALESCE(called_at, CURRENT_TIMESTAMP)", "last_call_at = CURRENT_TIMESTAMP", "call_count = call_count + 1"); }
      if (status === "UNLOADING") fields.push("start_unloading_at = COALESCE(start_unloading_at, CURRENT_TIMESTAMP)");
      if (status === "WAITING GR") fields.push("done_unloading_at = COALESCE(done_unloading_at, CURRENT_TIMESTAMP)");
      if (status === "COMPLETED") fields.push("done_unloading_at = CURRENT_TIMESTAMP");
      await client.query(`UPDATE tickets SET ${fields.join(", ")} WHERE ticket_id = $1`, values);
    }
    await requeueGsheetRowsForTickets(client, [ticketId]);
    const rows = await listOperationalRows(client, ticketId);
    await client.query("COMMIT");
    const allDoneGr = rows.length > 0 && rows.every((row) => String(row.gr_status).toUpperCase() === "DONE GR");
    return { rows, all_done_gr: allDoneGr };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

module.exports = async (req, res) => {
  const appOrigin = clean(process.env.APP_ORIGIN);
  if (appOrigin && req.headers.origin === appOrigin) {
    res.setHeader("Access-Control-Allow-Origin", appOrigin);
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Inbound-Api-Key");
  if (req.method === "OPTIONS") return res.status(204).end();

  const requestBody = parseBody(req);
  const action = clean(req.query?.action || requestBody.action).toLowerCase();
  try {
    // Realtime config tidak membutuhkan koneksi MotherDuck. Menjawabnya sebelum
    // pool checkout menghindari cold-start database saat browser membuka socket.
    if (req.method === "GET" && action === "realtime_config") {
      const session = readSession(req);
      if (!canUseAction(session, action)) {
        return json(res, 401, { ok: false, message: "Unauthorized" });
      }
      return json(res, 200, { ok: true, data: realtimePublicConfig() });
    }

    const client = await getPool().connect();
    try {
      await ensureDatabaseReady(client);

      if (req.method === "GET" && action === "health") {
        const [result, products] = await Promise.all([
          client.query("SELECT current_timestamp AS connected_at"),
          client.query("SELECT COUNT(*)::INTEGER AS product_master_count FROM product_master"),
        ]);
        return json(res, 200, {
          ok: true,
          database: databaseName(),
          product_master_count: Number(products.rows[0]?.product_master_count || 0),
          ...result.rows[0],
        });
      }

      if (req.method === "POST" && action === "login") {
        const session = authenticateUser(requestBody);
        if (!session) return json(res, 401, { ok: false, message: "Username atau password salah." });
        setSessionCookie(res, session);
        return json(res, 200, { ok: true, data: { user: { username: session.username, role: session.role, display_name: session.display_name } } });
      }
      if (req.method === "POST" && action === "logout") {
        clearSessionCookie(res);
        return json(res, 200, { ok: true });
      }

      const apiKeyValid = isAuthorized(req);
      const cronSync = req.method === "GET" && action === "cron_sync_superset";
      let session = null;
      if (action === "backfill_gsheet") {
        if (req.method !== "POST" || !isGsheetBackfillAuthorized(req)) {
          return json(res, 401, { ok: false, message: "Unauthorized" });
        }
      } else if (action === "sync_superset_pos") {
        if (!apiKeyValid) return json(res, 401, { ok: false, message: "Unauthorized" });
      } else if (cronSync) {
        if (!isCronAuthorized(req)) return json(res, 401, { ok: false, message: "Unauthorized" });
      } else {
        session = readSession(req);
        if (!canUseAction(session, action)) {
          return json(res, 401, { ok: false, message: "Unauthorized" });
        }
      }

      if (req.method === "GET" && action === "state") {
        return json(res, 200, { ok: true, data: await getAppState(client) });
      }
      if (req.method === "GET" && action === "state_delta") {
        return json(res, 200, { ok: true, data: await getAppStateDelta(client, req.query?.since) });
      }
      if (req.method === "GET" && action === "superset_freshness") {
        return json(res, 200, { ok: true, data: await getSupersetFreshness(client) });
      }

      if (req.method === "GET" && action === "tickets") {
        return json(res, 200, { ok: true, data: await listTickets(client, clean(req.query.status) || null) });
      }
      if (req.method === "GET" && action === "export_rows") {
        return json(res, 200, { ok: true, data: await listOperationalRows(client) });
      }
      if (req.method === "GET" && action === "product_lookup") {
        return json(res, 200, { ok: true, data: await lookupProduct(client, req.query.q) });
      }
      if (req.method === "GET" && action === "ba_list") {
        return json(res, 200, { ok: true, data: await listBaDocuments(client) });
      }
      if (req.method === "GET" && action === "ba_detail") {
        return json(res, 200, { ok: true, data: await getBaDetail(client, req.query.ba_id) });
      }
      if (cronSync) {
        return json(res, 200, { ok: true, data: await syncSupersetPoMaster(client) });
      }

      const body = requestBody;
      if (req.method === "POST" && action === "backfill_gsheet") {
        return json(res, 200, { ok: true, data: await backfillGsheetBatch(client, body) });
      }
      if (req.method === "POST" && action === "sync_superset_pos") {
        return json(res, 200, { ok: true, data: await syncSupersetPoMaster(client) });
      }
      if (req.method === "POST" && action === "delete_tickets_by_date") {
        return operationalJson(res, 200, await deleteTicketsByDate(client, clean(body.operational_date)));
      }
      if (req.method === "POST" && action === "delete_single_ticket") {
        return operationalJson(res, 200, await deleteSingleTicket(client, body));
      }
      if (req.method === "POST" && action === "bulk_complete_operational") {
        return operationalJson(res, 200, await bulkCompleteOperational(client, body, session));
      }
      if (req.method === "POST" && action === "create_ticket") {
        return operationalJson(res, 201, await createTicket(client, body));
      }
      if (req.method === "POST" && action === "create_tickets_bulk") {
        return operationalJson(res, 201, await createTicketsBulk(client, body));
      }
      if (req.method === "POST" && action === "create_ba") {
        return json(res, 201, { ok: true, data: await createBaDocument(client, body, session) });
      }
      if (req.method === "POST" && action === "update_ticket_status") {
        return operationalJson(res, 200, await updateTicketStatus(client, body));
      }
      if (req.method === "POST" && ["updatechecker", "startcheckerpo", "donecheckerpo", "donegrpo", "donegrpos", "handovergrn", "failcall"].includes(action)) {
        return operationalJson(res, 200, await updateTicketPos(client, body, action));
      }

      return json(res, 404, { ok: false, message: "Action tidak ditemukan." });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Inbound API error", error);
    return json(res, 500, { ok: false, message: error.message || "Database error" });
  }
};

// Narrow test hooks for transaction and queue-number regression tests.
module.exports._test = {
  createTicketsBulk,
  ensureDatabaseReady,
  publishRealtimeChange,
  realtimePublicConfig,
  resetSchemaCacheForTests,
  backfillGsheetBatch,
  formatGsheetOutputRow,
  GSHEET_OUTPUT_HEADERS,
  isGsheetBackfillAuthorized,
  syncPendingGsheetRows,
  updateTicketPos,
  updateTicketStatus,
};
