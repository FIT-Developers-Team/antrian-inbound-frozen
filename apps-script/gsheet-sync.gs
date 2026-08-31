/**
 * Antrian Inbound Frozen - Supabase to Google Sheets mirror.
 * Deploy as a Web App (execute as owner, access: anyone) and set these Script Properties:
 *   GSHEET_SYNC_SECRET = a long random secret shared only with the Supabase Edge Function
 */

var GSHEET_SYNC_SPREADSHEET_ID = "1Q9R1TQuksL5pCc94vWfwKFUrzdN9nQlwXJZvtBxRbfE";
var GSHEET_SYNC_SHEET_NAME = "Output form";

var GSHEET_SYNC_HEADERS = [
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
  "site_code", "arrived_at", "sla_deadline_at"
];

var GSHEET_SYNC_PLAIN_TEXT_HEADERS = {
  Timestamp: true,
  created_at: true,
  register_time: true,
  called_at: true,
  updated_at: true,
  completed_at: true,
  start_unloading_at: true,
  last_call_attempt_at: true,
  expired_at: true,
  sla_finished_at: true,
  last_call_at: true,
  waiting_gr_at: true,
  done_gr_at: true,
  handover_grn_at: true,
  finish_unloading_at: true,
  checker_started_at: true,
  checker_done_at: true,
  ktp_6_digit: true,
  po_number: true,
  driver_waiting_duration: true,
  unloading_duration: true,
  checker_duration: true,
  gr_wait_duration: true,
  inbound_sla_duration: true,
  arrived_at: true,
  sla_deadline_at: true
};

function doGet(e) {
  var action = String((e && e.parameter && e.parameter.action) || "").trim();
  if (action !== "health") return gsheetSyncJson_({ status: "error", message: "Unknown action" });
  return gsheetSyncJson_({
    status: "success",
    service: "Antrian Inbound Frozen GSheet Sync",
    sheet: GSHEET_SYNC_SHEET_NAME,
    timestamp: new Date().toISOString()
  });
}

function doPost(e) {
  try {
    var body = gsheetSyncParseBody_(e);
    var action = String((e && e.parameter && e.parameter.action) || body.action || "").trim();
    if (action !== "submitSecurity" && action !== "syncInboundRows") {
      throw new Error("Unknown action: " + action);
    }

    var payload = body.payload || body;
    gsheetSyncAuthorize_(payload.sync_secret);
    var rows = Array.isArray(payload.rows) ? payload.rows : [];
    var result = gsheetSyncUpsertRows_(rows);
    return gsheetSyncJson_({
      status: "success",
      action: action,
      received_rows: rows.length,
      inserted_rows: result.inserted,
      updated_rows: result.updated,
      skipped_rows: result.skipped
    });
  } catch (error) {
    return gsheetSyncJson_({ status: "error", message: String(error && error.message || error) });
  }
}

function gsheetSyncAuthorize_(suppliedSecret) {
  var expected = String(
    PropertiesService.getScriptProperties().getProperty("GSHEET_SYNC_SECRET") || ""
  ).trim();
  if (!expected) throw new Error("GSHEET_SYNC_SECRET belum diset di Script Properties");
  if (String(suppliedSecret || "").trim() !== expected) throw new Error("Unauthorized");
}

function gsheetSyncUpsertRows_(rows) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var spreadsheet = SpreadsheetApp.openById(GSHEET_SYNC_SPREADSHEET_ID);
    var sheet = spreadsheet.getSheetByName(GSHEET_SYNC_SHEET_NAME);
    if (!sheet) sheet = spreadsheet.insertSheet(GSHEET_SYNC_SHEET_NAME);
    var headers = gsheetSyncEnsureHeaders_(sheet);
    gsheetSyncPreparePlainTextColumns_(sheet, headers);
    var keyIndex = headers.indexOf("ticket_po_id");
    if (keyIndex < 0) throw new Error("Header ticket_po_id tidak tersedia");

    var lastRow = sheet.getLastRow();
    var existingKeys = {};
    if (lastRow > 1) {
      var keyValues = sheet.getRange(2, keyIndex + 1, lastRow - 1, 1).getDisplayValues();
      keyValues.forEach(function(value, index) {
        var key = String(value[0] || "").trim();
        if (key) existingKeys[key] = { rowNumber: index + 2, appendIndex: -1 };
      });
    }

    var appended = [];
    var updated = 0;
    var skipped = 0;
    rows.forEach(function(row) {
      var key = String(row && row.ticket_po_id || "").trim();
      if (!key) {
        skipped += 1;
        return;
      }
      var values = headers.map(function(header) {
        return gsheetSyncSafeCell_(row[header], header);
      });
      var existing = existingKeys[key];
      if (existing && existing.rowNumber > 0) {
        sheet.getRange(existing.rowNumber, 1, 1, headers.length).setValues([values]);
        updated += 1;
      } else if (existing && existing.appendIndex >= 0) {
        appended[existing.appendIndex] = values;
      } else {
        existingKeys[key] = { rowNumber: 0, appendIndex: appended.length };
        appended.push(values);
      }
    });

    if (appended.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, appended.length, headers.length).setValues(appended);
    }
    return { inserted: appended.length, updated: updated, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

function gsheetSyncEnsureHeaders_(sheet) {
  var lastColumn = sheet.getLastColumn();
  var headers = lastColumn > 0
    ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0].map(function(value) {
        return String(value || "").trim();
      })
    : [];
  if (!headers.some(function(value) { return Boolean(value); })) {
    headers = GSHEET_SYNC_HEADERS.slice();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return headers;
  }
  GSHEET_SYNC_HEADERS.forEach(function(header) {
    if (headers.indexOf(header) < 0) headers.push(header);
  });
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return headers;
}

function gsheetSyncSafeCell_(value, header) {
  if (value === undefined || value === null) return "";
  if (GSHEET_SYNC_PLAIN_TEXT_HEADERS[header] && value !== "") {
    return "=\"" + String(value).replace(/\"/g, "\"\"") + "\"";
  }
  if (typeof value === "string" && /^[=+@]/.test(value)) return "'" + value;
  return value;
}

function gsheetSyncPreparePlainTextColumns_(sheet, headers) {
  var maxRow = Math.max(sheet.getMaxRows(), 2);
  var ranges = Object.keys(GSHEET_SYNC_PLAIN_TEXT_HEADERS).map(function(header) {
    var index = headers.indexOf(header);
    return index < 0 ? "" : sheet.getRange(2, index + 1, maxRow - 1, 1).getA1Notation();
  }).filter(function(value) { return Boolean(value); });
  if (ranges.length) sheet.getRangeList(ranges).setNumberFormat("@");
}

function gsheetSyncParseBody_(e) {
  var raw = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
  try {
    return JSON.parse(raw || "{}");
  } catch (error) {
    throw new Error("Body JSON tidak valid");
  }
}

function gsheetSyncJson_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
