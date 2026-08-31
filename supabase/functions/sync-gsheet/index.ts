import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { clean, constantTimeEqual, jsonResponse, optionsResponse } from "../_shared/http.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const BATCH_LIMIT = 100;

function dateTime(value: unknown): string {
  if (!value) return "";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return clean(value);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function duration(from: unknown, to: unknown): { text: string; minutes: number | "" } {
  const start = from ? new Date(String(from)) : null; const end = to ? new Date(String(to)) : null;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return { text: "", minutes: "" };
  const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
  return { text: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`, minutes };
}

function format(row: Record<string, unknown>): Record<string, unknown> {
  const finish = row.finish_unloading_at || "";
  // Waktu tunggu driver dihitung dari kedatangan aktual bila Security mencatatnya;
  // jam input data hanya dipakai sebagai cadangan untuk tiket lama.
  const driver = duration(
    row.waiting_started_at || row.arrived_at || row.created_at || row.register_time,
    row.start_unloading_at || finish,
  );
  const unloading = duration(row.start_unloading_at, finish);
  const checker = duration(row.checker_started_at, row.checker_done_at);
  const gr = duration(row.checker_done_at, row.done_gr_at);
  const inbound = duration(row.start_unloading_at, finish || row.done_gr_at);
  // Target SLA berasal dari `inbound_sla_target_hours` di database. Sebelumnya
  // fungsi ini menghitung sendiri dengan aturan yang berbeda dari js/app.js —
  // VAN/PICKUP/MOBIL/L300 1 jam di sini tetapi 2 jam di layar, dan RODA 2 serta
  // DROP-OFF dianggap tanpa SLA — sehingga angka di sheet tidak pernah cocok
  // dengan angka yang dilihat operator.
  const target = Number(row.sla_target_hours || 0);
  const status = clean(row.status).toUpperCase();
  const sla = status.includes("EXPIRED") ? "EXPIRED" : !target ? "NO SLA" : !row.start_unloading_at ? "WAITING START UNLOADING" :
    Number(inbound.minutes || 0) > target * 60 ? "SLA MISS" : status === "COMPLETED" ? "SLA OK" : "ON PROCESS";
  return {
    Timestamp: dateTime(row.created_at || row.register_time), ticket_id: row.ticket_id || "", queue_no: row.queue_no || "",
    ticket_type: row.ticket_type || "", slot: row.slot || "", fleet_type: row.fleet_type || "", plat_number: row.plat_number || "",
    driver_name: row.driver_name || "", phone_number: row.phone_number || "", ktp_6_digit: row.ktp_6_digit || "",
    vendor_name: row.vendor_name || "", po_number: row.po_number || "", total_po_qty: row.total_po_qty || 0,
    actual_quantity: row.actual_quantity || 0, count_po_sku: row.count_po_sku || 0, status: row.status || "", gate: row.gate || "",
    unload_sla: row.unload_sla || "", source: row.source || "Supabase", created_at: dateTime(row.created_at),
    register_time: dateTime(row.register_time || row.created_at), called_at: dateTime(row.called_at), updated_at: dateTime(row.updated_at || row.po_updated_at),
    completed_at: status === "COMPLETED" ? dateTime(finish) : "", start_unloading_at: dateTime(row.start_unloading_at),
    driver_waiting_duration: driver.text, driver_waiting_minutes: driver.minutes, unloading_duration: unloading.text,
    unloading_duration_minutes: unloading.minutes, sla_target_hours: target, sla_status: sla,
    wa_call_status: "", wa_call_sent_at: "", wa_call_error: "", wa_call_provider: "", wa_call_target: "", call_count: row.call_count || 0,
    last_call_attempt_at: dateTime(row.last_call_at), expired_at: dateTime(row.expired_at), expired_reason: row.expired_reason || "",
    sla_finished_at: dateTime(finish), operational_date: row.operational_date || "", data_source: "Supabase", last_call_at: dateTime(row.last_call_at),
    waiting_gr_at: dateTime(row.checker_done_at), done_gr_at: dateTime(row.done_gr_at), handover_grn_at: dateTime(row.handover_grn_at),
    wa_handover_status: "", wa_handover_sent_at: "", wa_handover_error: "", wa_handover_target: "", ticket_po_id: row.ticket_po_id || "",
    po_sequence: Number(row.po_sequence || 0), ticket_po_count: Number(row.ticket_po_count || 0), ticket_total_qty: Number(row.ticket_total_qty || 0),
    ticket_total_sku: Number(row.ticket_total_sku || 0), finish_unloading_at: dateTime(finish), checker_id: row.checker_id || "",
    checker_name: row.checker_name || "", checker_status: row.checker_status || "", checker_started_at: dateTime(row.checker_started_at),
    checker_done_at: dateTime(row.checker_done_at), checker_started_by: "", checker_done_by: "", checker_duration: checker.text,
    checker_duration_minutes: checker.minutes, gr_status: row.gr_status || "", done_gr_by: "", gr_wait_duration: gr.text,
    gr_wait_minutes: gr.minutes, inbound_sla_duration: inbound.text, inbound_sla_minutes: inbound.minutes,
    wa_ticket_status: "", wa_ticket_sent_at: "", wa_ticket_error: "", wa_ticket_target: "",
    // Kolom gudang dan jam kedatangan; Apps Script menambah header ini otomatis
    // bila belum ada di sheet.
    site_code: row.site_code || "",
    arrived_at: dateTime(row.arrived_at),
    sla_deadline_at: dateTime(row.sla_deadline_at),
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  const expected = clean(Deno.env.get("SYNC_SECRET"));
  const supplied = clean(request.headers.get("authorization")).replace(/^Bearer\s+/i, "");
  if (!expected || !constantTimeEqual(expected, supplied)) return jsonResponse(request, 401, { ok: false, message: "Unauthorized" });

  let claimedIds: string[] = [];
  try {
    const target = clean(Deno.env.get("GSHEET_SYNC_URL"));
    if (!target || ["0", "false", "off"].includes(clean(Deno.env.get("GSHEET_SYNC_ENABLED")).toLowerCase())) {
      return jsonResponse(request, 200, { ok: true, data: { enabled: false, queued: 0, synced: 0 } });
    }

    // Baris PROCESSING yang menggantung karena function timeout harus kembali
    // antre; tanpa ini baris tersebut terkunci selamanya di luar filter worker.
    const { data: reaped } = await db.rpc("inbound_reap_stuck_gsheet", { p_older_than: "10 minutes" });

    // Satu round-trip: klaim batch (FOR UPDATE SKIP LOCKED) sekaligus ambil rownya.
    const { data: claim, error: claimError } = await db.rpc("inbound_claim_gsheet_batch", { p_limit: BATCH_LIMIT });
    if (claimError) throw claimError;
    claimedIds = (claim?.ticket_po_ids || []) as string[];
    const rows = (claim?.rows || []) as Record<string, unknown>[];
    if (!claimedIds.length) {
      return jsonResponse(request, 200, { ok: true, data: { enabled: true, queued: 0, synced: 0, reaped: reaped ?? 0 } });
    }

    const endpoint = new URL(target); endpoint.searchParams.set("action", "submitSecurity");
    const response = await fetch(endpoint, { method: "POST", redirect: "follow", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "submitSecurity", payload: { rows: rows.map(format), send_whatsapp: false,
        wa_event: "DISABLED", sync_mode: "upsert", sync_key: "ticket_po_id", sync_secret: clean(Deno.env.get("GSHEET_SYNC_SECRET")) },
        timestamp: new Date().toISOString() }) });
    const result = await response.json().catch(() => null);
    if (!response.ok || (result?.status && result.status !== "success")) {
      throw new Error(result?.message || `Google Sheets sync HTTP ${response.status}`);
    }

    // Satu UPDATE untuk seluruh batch, bukan satu UPDATE per baris.
    const { error: settleError } = await db.rpc("inbound_settle_gsheet_batch", {
      p_ticket_po_ids: claimedIds, p_success: true, p_error: null,
    });
    if (settleError) throw settleError;
    return jsonResponse(request, 200, { ok: true, data: {
      enabled: true, queued: claimedIds.length, synced: rows.length, reaped: reaped ?? 0,
    } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "GSheet sync gagal";
    // Batch yang sudah diklaim harus dikembalikan ke FAILED agar dicoba ulang.
    if (claimedIds.length) {
      await db.rpc("inbound_settle_gsheet_batch", {
        p_ticket_po_ids: claimedIds, p_success: false, p_error: message,
      }).catch(() => {});
    }
    console.error("sync-gsheet", message);
    return jsonResponse(request, 500, { ok: false, message });
  }
});
