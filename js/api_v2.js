function parseInboundDateSafe(value) {
  if (value === undefined || value === null || value === "") return null;

  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : new Date(value.getTime());
  }

  if (typeof value === "number" && isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return isNaN(date.getTime()) ? null : date;
  }

  const text = String(value).trim();
  if (!text) return null;

  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    const ms = text.length === 10 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    if (!isNaN(date.getTime())) return date;
  }

  let match = text.match(
    /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (match) {
    const date = new Date(
      Number(match[3]),
      Number(match[2]) - 1,
      Number(match[1]),
      Number(match[4] || 0),
      Number(match[5] || 0),
      Number(match[6] || 0),
    );
    return isNaN(date.getTime()) ? null : date;
  }

  match = text.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/,
  );
  if (match) {
    const native = new Date(text);
    if (!isNaN(native.getTime())) return native;

    const date = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4] || 0),
      Number(match[5] || 0),
      Number(match[6] || 0),
    );
    return isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? null : parsed;
}

const API_URL_V2 =
  "https://script.google.com/macros/s/AKfycbyjby6UR8H0H397xkHbpx9F57BhPKeTCndn3Ic3aKpqvEeQnIGYUmwBMa9JzPBhIoeD/exec";

// Operational queue and PO master now live behind a Supabase Edge Function.
// The URL is public configuration; privileged database credentials remain in
// Supabase Edge Function secrets and are never shipped to the browser.
const MOTHERDUCK_API_URL = window.INBOUND_BACKEND_URL;

const columns = [
  "Timestamp",
  "location_id",
  "request_shipping_date",
  "arrived_time",
  "slot",
  "destination_name",
  "vendor_name",
  "po_status",
  "po_number",
  "receiving_time",
  "done_time",
  "total_request_quantity",
  "actual_quantity",
  "Count SKU",
  "Is Cancelled",
  "WH TYPE",
  "Destination Name Adjusted",
  "Req Ship Date",
  "Date Arrival",
  "Licence Plate",
  "Vhiecle Type",
  "Vhiecle Max Handling Hour Duration",
  "Slot Adjusted",
  "SLA Slot Time",
  "End Time Slot",
  "Status SO Adjusted",
  "Duration\nArrived Time To SLA Slot Time",
  "Arrive to now",
  "Arrival Status",
  "Max Late Duration",
  "Max Early Duration",
  "Arrive to Receive\nDuration",
  "Processing Duration",
  "Target SLA Processing Duration",
  "SLA Time Refrence",
  "SLA Finished At",
  "OLD SLA Status",
  "NEW SLA Status",
  "Active Duration",
  "Qty Refrences",
];

const LOCAL_TICKETS_KEY = "inbound_frozen_manual_tickets_v1";
let v2RawResponse = null;
let v2PoIndex = null;
let securitySubmitBusy = false;
let fullDataLoadBusy = false;

function hasApiV2() {
  return API_URL_V2 && !API_URL_V2.includes("PASTE_GAS_WEB_APP_URL_HERE");
}

function apiUrlV2(action, params = {}) {
  const u = new URL(API_URL_V2);
  if (action && action !== "raw") u.searchParams.set("action", action);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
  });
  u.searchParams.set("_", Date.now());
  return u.toString();
}

async function apiGetV2(action = "raw", params = {}) {
  if (!hasApiV2()) throw new Error("API_URL_V2 belum diganti.");
  const res = await fetch(apiUrlV2(action, params), {
    method: "GET",
    redirect: "follow",
  });
  const json = await res.json();
  if (json.status && json.status !== "success") {
    throw new Error(json.message || "API V2 error");
  }
  return json.data || json;
}

async function apiPostV2(action, payload = {}) {
  if (
    [
      "updateChecker",
      "startCheckerPo",
      "doneCheckerPo",
      "doneGrPo",
      "doneGrPos",
      "handoverGrn",
      "failCall",
    ].includes(action)
  ) {
    return motherDuckApiPost(action, payload);
  }
  if (!hasApiV2()) throw new Error("API_URL_V2 belum diganti.");
  const res = await fetch(apiUrlV2(action), {
    method: "POST",
    redirect: "follow",
    body: JSON.stringify({
      action,
      payload,
      timestamp: new Date().toISOString(),
    }),
  });

  const json = await res.json();
  if (json.status && json.status !== "success") {
    throw new Error(json.message || "API V2 POST error");
  }
  return json.data || json;
}

/** Kode gudang aktif yang sedang dilihat operator. Ikut di setiap request. */
function currentSiteCode() {
  return window.InboundSites?.current?.()?.code || "";
}

/**
 * Menyalin katalog gudang + gate dari backend ke registry frontend.
 * Mengaktifkan SRG / BIT / CSI cukup dilakukan lewat `site_master` di Supabase;
 * UI langsung mengikuti tanpa deploy ulang.
 */
function applyServerSiteCatalog(response = {}) {
  const sites = response?.sites;
  const gates = response?.gates;
  if (!Array.isArray(sites) && !Array.isArray(gates)) return;
  window.InboundSites?.applyServerCatalog?.({ sites, gates });
  if (typeof window.renderSiteSwitcher === "function") window.renderSiteSwitcher();
}

function inboundApiUrl(action, params = {}) {
  const url = new URL(MOTHERDUCK_API_URL, window.location.origin);
  if (action) url.searchParams.set("action", action);
  const site = currentSiteCode();
  if (site) url.searchParams.set("site", site);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

/**
 * Cache ETag per action+site. Saat data belum berubah backend menjawab 304
 * tanpa body, sehingga polling 10 detik tidak lagi mengirim ulang payload penuh.
 */
const inboundEtagCache = new Map();

function etagCacheKey(action) {
  return `${action}|${currentSiteCode()}`;
}

function clearInboundEtagCache() {
  inboundEtagCache.clear();
}
window.clearInboundEtagCache = clearInboundEtagCache;

/**
 * Entri cache selalu dikembalikan sebagai salinan.
 * Tanpa ini, pemanggil yang mengubah objek hasil akan ikut mengubah isi cache,
 * sehingga respons 304 berikutnya menyajikan data yang sudah tercemar — bug
 * yang sangat sulit dilacak karena hanya muncul saat data tidak berubah.
 */
function cloneCachedPayload(value) {
  if (value === null || typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

async function inboundApiGet(action, params = {}, { useEtag = false } = {}) {
  const cacheKey = etagCacheKey(action);
  const cached = useEtag ? inboundEtagCache.get(cacheKey) : null;
  const headers = {
    Authorization: `Bearer ${window.getInboundSessionToken?.() || ""}`,
  };
  if (cached?.etag) headers["If-None-Match"] = cached.etag;

  const response = await fetch(inboundApiUrl(action, params), {
    method: "GET",
    headers,
    cache: "no-store",
  });

  if (response.status === 304 && cached) return cloneCachedPayload(cached.data);

  const json = await response.json();
  if (!response.ok || json.ok === false) {
    throw new Error(json.message || "Inbound API error");
  }
  const data = json.data || json;
  if (useEtag) {
    const etag = response.headers.get("etag");
    // Tanpa header ETag (mis. CORS belum mengekspos) cache dibuang supaya
    // klien tidak pernah menampilkan data basi.
    if (etag) inboundEtagCache.set(cacheKey, { etag, data: cloneCachedPayload(data) });
    else inboundEtagCache.delete(cacheKey);
  }
  return data;
}

async function inboundApiPost(action, payload = {}) {
  const response = await fetch(inboundApiUrl(action), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${window.getInboundSessionToken?.() || ""}`,
    },
    body: JSON.stringify({ site_code: currentSiteCode(), ...payload }),
  });
  const json = await response.json();
  if (!response.ok || json.ok === false) {
    throw new Error(json.message || "Inbound API error");
  }
  // Setiap mutasi membuat snapshot lama usang; ETag harus dibuang agar
  // polling berikutnya benar-benar mengambil data baru.
  clearInboundEtagCache();
  return json.data || json;
}

// Nama lama dipertahankan supaya seluruh call site yang ada tetap jalan.
// Sengaja function declaration, bukan const: hanya bentuk ini yang tetap
// terpasang di `window` seperti versi sebelumnya.
function motherDuckApiUrl(action, params = {}) {
  return inboundApiUrl(action, params);
}
function motherDuckApiGet(action, params = {}, options = {}) {
  return inboundApiGet(action, params, options);
}
function motherDuckApiPost(action, payload = {}) {
  return inboundApiPost(action, payload);
}

async function deleteTicketsByOperationalDate() {
  const input = document.getElementById("cleanup-operational-date");
  const button = document.getElementById("cleanup-operational-button");
  const result = document.getElementById("cleanup-operational-result");
  const operationalDate = String(input?.value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(operationalDate)) {
    showToast("Pilih tanggal operasional yang valid.", "error");
    return;
  }
  if (!confirm(`Hapus PERMANEN seluruh ticket, detail PO, dan event tanggal ${operationalDate}?`)) return;
  if (button) button.disabled = true;
  if (result) result.textContent = "Menghapus data dari MotherDuck...";
  try {
    const deleted = await motherDuckApiPost("delete_tickets_by_date", { operational_date: operationalDate });
    const message = `Terhapus: ${Number(deleted.tickets_deleted || 0)} ticket, ${Number(deleted.po_rows_deleted || 0)} PO, ${Number(deleted.events_deleted || 0)} event.`;
    if (result) result.textContent = message;
    showToast(message, "success");
  } catch (error) {
    const message = error?.message || "Gagal menghapus data.";
    if (result) result.textContent = message;
    showToast(message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function deleteSingleTicket() {
  const queueInput = document.getElementById("single-ticket-queue-no");
  const plateInput = document.getElementById("single-ticket-plate-number");
  const dateInput = document.getElementById("single-ticket-operational-date");
  const button = document.getElementById("single-ticket-delete-button");
  const result = document.getElementById("single-ticket-delete-result");
  const queueNo = String(queueInput?.value || "").trim();
  const plateNumber = String(plateInput?.value || "").replace(/\s+/g, "").toUpperCase();
  const operationalDate = String(dateInput?.value || "").trim();
  if (!queueNo || !plateNumber || !/^\d{4}-\d{2}-\d{2}$/.test(operationalDate)) {
    showToast("Isi Queue No, Plat Number, dan tanggal operasional secara lengkap.", "error");
    return;
  }
  if (!confirm(`HAPUS PERMANEN satu ticket ini?\n\nQueue: ${queueNo}\nPlat: ${plateNumber}\nTanggal operasional: ${operationalDate}\n\nTicket, detail PO, dan event terkait akan dihapus.`)) return;
  if (button) button.disabled = true;
  if (result) result.textContent = "Mencari dan menghapus satu ticket di MotherDuck...";
  try {
    const deleted = await motherDuckApiPost("delete_single_ticket", {
      queue_no: queueNo,
      plat_number: plateNumber,
      operational_date: operationalDate,
    });
    const message = `Ticket ${deleted?.deleted_ticket?.queue_no || queueNo} (${plateNumber}) terhapus: ${Number(deleted.tickets_deleted || 0)} ticket, ${Number(deleted.po_rows_deleted || 0)} PO, ${Number(deleted.events_deleted || 0)} event.`;
    if (result) result.textContent = message;
    showToast(message, "success");
    await refreshDashboard();
  } catch (error) {
    const message = error?.message || "Gagal menghapus ticket.";
    if (result) result.textContent = message;
    showToast(message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function bulkCompleteOperationalTasks() {
  const input = document.getElementById("bulk-complete-operational-date");
  const button = document.getElementById("bulk-complete-operational-button");
  const result = document.getElementById("bulk-complete-operational-result");
  const operationalDate = String(input?.value || "").trim();
  const allActive = Boolean(document.getElementById("bulk-complete-all-dates")?.checked);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(operationalDate)) {
    showToast("Pilih tanggal operasional yang valid.", "error");
    return;
  }
  const warning = [
    allActive
      ? "Clear semua tiket AKTIF dari seluruh tanggal operasional?"
      : `Clear semua tiket AKTIF tanggal ${operationalDate}?`,
    "",
    "Status akan diproses sampai COMPLETED.",
    "PO menjadi Done Checking + Done GR + Handover GRN.",
    "Actual Qty yang kosong akan memakai Qty PO.",
    "Riwayat ticket tidak dihapus.",
  ].join("\n");
  if (!confirm(warning)) return;
  if (button) button.disabled = true;
  if (result) result.textContent = "Memproses tiket aktif di MotherDuck...";
  try {
    const completed = await motherDuckApiPost("bulk_complete_operational", {
      operational_date: operationalDate,
      all_active: allActive,
    });
    const scope = completed.all_active ? "semua tanggal aktif" : `tanggal ${operationalDate}`;
    const message = `Selesai (${scope}): ${Number(completed.tickets_completed || 0)} tiket dan ${Number(completed.po_completed || 0)} PO menjadi COMPLETED.`;
    if (result) result.textContent = message;
    showToast(message, "success");
    await refreshDashboard();
  } catch (error) {
    const message = error?.message || "Gagal clear task otomatis.";
    if (result) result.textContent = message;
    showToast(message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function submitSecurityRowsToBackend(rows = []) {
  if (!rows.length) return { rows: [], ticket_wa_results: [] };
  const groups = new Map();
  rows.forEach((row) => {
    const ticketId = String(row.ticket_id || "").trim();
    if (!ticketId) return;
    if (!groups.has(ticketId)) groups.set(ticketId, []);
    groups.get(ticketId).push(row);
  });

  const ticketGroups = [...groups.values()];
  const tickets = ticketGroups.map((ticketRows) => {
    const master = ticketRows[0];
    return {
      ticket: {
        ticket_id: master.ticket_id,
        queue_no: master.queue_no,
        ticket_type: master.ticket_type,
        status: master.status || "WAITING",
        vendor_name: master.vendor_name,
        fleet_type: master.fleet_type,
        plat_number: master.plat_number,
        driver_name: master.driver_name,
        driver_phone: master.phone_number,
        ktp_6_digit: master.ktp_6_digit,
        gate: master.gate,
        slot: master.slot,
        registered_by: master.registered_by,
        unload_sla: master.unload_sla,
        source: master.source || "Security Web",
      },
      pos: ticketRows.map((row) => ({
        ticket_po_id: row.ticket_po_id,
        po_number: row.po_number,
        vendor_name: row.vendor_name,
        request_quantity: row.total_po_qty,
        actual_quantity: row.actual_quantity,
        count_sku: row.count_po_sku,
        checker_status: row.checker_status || "PENDING",
        is_manual:
          row.is_manual_po === true ||
          row.is_manual_vendor === true ||
          String(row.data_source || "").toUpperCase() === "MANUAL",
      })),
    };
  });
  const bulkResult = await motherDuckApiPost("create_tickets_bulk", { tickets });
  const created = Array.isArray(bulkResult?.created) ? bulkResult.created : [];
  if (created.length !== ticketGroups.length) {
    throw new Error("Jumlah ticket tersimpan tidak sesuai request. Refresh data lalu cek kembali.");
  }
  const persistedRows = [];
  ticketGroups.forEach((ticketRows, index) => {
    const result = created[index] || {};
    // Nomor antrean final berasal dari MotherDuck, bukan hasil prediksi browser.
    // Backend menghitung sequence berdasarkan slot dan hari operasional yang sama.
    persistedRows.push(
      ...ticketRows.map((row) => ({
        ...row,
        ticket_id: result.ticket_id || row.ticket_id,
        queue_no: result.queue_no || row.queue_no,
        operational_date: result.operational_date || row.operational_date,
      })),
    );
  });

  return {
    rows: persistedRows,
    created,
    inserted_tickets: Number(bulkResult?.inserted_tickets || created.length),
    ticket_wa_results: [],
  };
}

function getTicketWaFeedbackV171(result = {}) {
  const items = Array.isArray(result?.ticket_wa_results)
    ? result.ticket_wa_results
    : [];

  const normalizeStatus = (item) =>
    String(item?.status || "")
      .trim()
      .toUpperCase();

  const sent = items.filter((item) =>
    ["SENT", "AUTO_SENT", "SUCCESS"].includes(normalizeStatus(item)),
  );
  const failed = items.filter((item) =>
    ["FAILED", "AUTO_FAILED", "ERROR"].includes(normalizeStatus(item)),
  );
  const disabled = items.filter((item) => normalizeStatus(item) === "DISABLED");
  const targets = [
    ...new Set(
      sent.map((item) => String(item?.target || "").trim()).filter(Boolean),
    ),
  ];

  return { items, sent, failed, disabled, targets };
}

function buildTicketCreatedToastV171(result = {}, ticketCount = 1) {
  const count = Number(ticketCount || result?.inserted_tickets || 1) || 1;
  return `${count} tiket berhasil dibuat • WhatsApp nonaktif • QR siap`;
}

async function updateCheckerToBackend(body = {}) {
  return apiPostV2("updateChecker", body);
}

async function sendDriverWhatsAppToBackend(body = {}) {
  return apiPostV2("sendDriverWhatsApp", body);
}

async function failCallToBackend(body = {}) {
  return apiPostV2("failCall", body);
}

function outputRowKeyV12(row = {}) {
  const poId = String(row.ticket_po_id || "").trim();
  if (poId) return `po:${poId}`;
  return `ticket:${String(row.ticket_id || "").trim()}\u001f${String(row.po_number || "").trim()}`;
}

function mergeOutputDeltaV12(currentRows = [], deltaRows = [], activeTicketIds = null) {
  const hasActiveSnapshot = Array.isArray(activeTicketIds);
  const active = new Set((activeTicketIds || []).map((value) => String(value || "").trim()).filter(Boolean));
  const merged = new Map();
  (currentRows || []).forEach((row) => {
    const ticketId = String(row?.ticket_id || "").trim();
    if (!hasActiveSnapshot || active.has(ticketId)) merged.set(outputRowKeyV12(row), row);
  });
  (deltaRows || []).forEach((row) => {
    const ticketId = String(row?.ticket_id || "").trim();
    if (!hasActiveSnapshot || active.has(ticketId)) merged.set(outputRowKeyV12(row), row);
  });
  return [...merged.values()];
}

function overlapDeltaCursorV12(value) {
  const parsed = new Date(value || "");
  if (Number.isNaN(parsed.getTime())) return "";
  return new Date(parsed.getTime() - 2000).toISOString();
}

/**
 * Snapshot operasional saja (ticket + PO tiket + master checker).
 * Dipakai setiap polling, jadi payload-nya sengaja dijaga tetap kecil dan
 * memakai ETag supaya request yang tidak membawa perubahan dijawab 304.
 */
async function fetchOutputFormData() {
  return inboundApiGet("state", {}, { useEtag: true });
}

/**
 * Master PO Superset untuk halaman Daftar. Payload ini berat tetapi jarang
 * berubah (sync tiap 5 menit), sehingga hanya diambil saat benar-benar
 * dibutuhkan dan selalu lewat ETag.
 */
async function fetchPoMasterData() {
  return inboundApiGet("po_master", {}, { useEtag: true });
}

/**
 * Payload lengkap: snapshot operasional + master PO, diambil paralel.
 * Sebelumnya `state` mengirim keduanya dalam satu response sehingga setiap
 * refresh menarik seluruh master PO walau layarnya tidak memerlukan.
 */
async function fetchV2Data() {
  const [operational, poMaster] = await Promise.all([
    fetchOutputFormData(),
    fetchPoMasterData().catch((error) => {
      // Master PO gagal tidak boleh menjatuhkan seluruh layar operasional.
      console.error("Master PO gagal dimuat", error);
      return null;
    }),
  ]);
  return {
    ...operational,
    tablev2: Array.isArray(poMaster?.tablev2) ? poMaster.tablev2 : [],
    po_master_synced_at: poMaster?.last_synced_at || null,
  };
}

async function fetchOutputFormDelta(since) {
  const cursor = overlapDeltaCursorV12(since);
  if (!cursor) return fetchOutputFormData();
  return inboundApiGet("state_delta", { since: cursor });
}

// V15.1 FIX:
// Endpoint output juga membawa master checker dari sheet `inbound mp`.
// Nilai ini wajib ikut disalin setiap refresh/autosync. Kalau hanya Output form
// yang disalin, dropdown checker akan kosong walaupun GAS sudah membaca sheet.
function getInboundMpRowsV15(response = {}, fallback = []) {
  if (Array.isArray(response?.inboundMp)) return response.inboundMp;
  if (Array.isArray(response?.inbound_mp)) return response.inbound_mp;
  if (Array.isArray(response?.data?.inboundMp)) return response.data.inboundMp;
  if (Array.isArray(response?.data?.inbound_mp))
    return response.data.inbound_mp;
  return Array.isArray(fallback) ? fallback : [];
}

function normalizeFieldKeyV6(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getCell(row, keys, fallback = "") {
  if (!row || typeof row !== "object") return fallback;

  // Prioritas pertama tetap exact match agar tidak mengubah perilaku lama.
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      return row[key];
    }
  }

  // Fallback header fleksibel:
  // "Start Unloading At", "start_unloading_at", dan "start-unloading-at"
  // dianggap field yang sama.
  const normalizedRow = {};
  Object.keys(row).forEach((key) => {
    const normalized = normalizeFieldKeyV6(key);
    if (
      normalized &&
      normalizedRow[normalized] === undefined &&
      row[key] !== undefined &&
      row[key] !== null &&
      row[key] !== ""
    ) {
      normalizedRow[normalized] = row[key];
    }
  });

  for (const key of keys) {
    const value = normalizedRow[normalizeFieldKeyV6(key)];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return fallback;
}

function normalizeKey(v) {
  return String(v || "")
    .trim()
    .toUpperCase();
}

function toNumberV2(v) {
  if (typeof v === "number") return v;
  const n = Number(String(v || "0").replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : n;
}

function uniqueCount(arr) {
  return new Set(arr.map((x) => String(x || "").trim()).filter(Boolean)).size;
}

function buildPoIndex(tableRows = []) {
  const index = {};
  for (const row of tableRows) {
    const po = normalizeKey(
      getCell(row, ["po_number", "po", "PO Number", "PO NUMBER"]),
    );
    if (!po) continue;

    if (!index[po]) {
      index[po] = {
        po_number: getCell(row, ["po_number", "po", "PO Number", "PO NUMBER"]),
        vendor_name: getCell(row, [
          "vendor_name",
          "Vendor Name",
          "VENDOR NAME",
        ]),
        slot: String(getCell(row, ["Slot Adjusted", "slot"], "3") || "3"),
        total_po_qty: 0,
        count_po_sku: 0,
        rows: 0,
        sample: row,
      };
    }

    index[po].rows += 1;
    index[po].total_po_qty += toNumberV2(
      getCell(row, [
        "total_request_quantity",
        "total_request_qty",
        "Total Request Quantity",
      ]),
    );
    index[po].count_po_sku += toNumberV2(
      getCell(row, ["Count SKU", "count_sku", "SKU Count"]),
    );
  }
  return index;
}

function getLocalTickets() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_TICKETS_KEY) || "[]");
  } catch (err) {
    return [];
  }
}

function saveLocalTickets(rows) {
  localStorage.setItem(LOCAL_TICKETS_KEY, JSON.stringify(rows || []));
}

function buildQueueFromV2Table(tableRows = []) {
  const seqBySlot = {};
  return tableRows.map((row, idx) => {
    const slot =
      String(getCell(row, ["Slot Adjusted", "slot"], "3") || "3").trim() || "3";
    seqBySlot[slot] = (seqBySlot[slot] || 0) + 1;

    const status = String(
      getCell(
        row,
        ["Status SO Adjusted", "NEW SLA Status", "Arrival Status", "po_status"],
        "WAITING",
      ),
    ).toUpperCase();

    const arrived = getCell(row, ["arrived_time", "Date Arrival", "Timestamp"]);
    const done = getCell(row, ["done_time", "SLA Finished At"], "");
    const plate = normalizePlateValue(
      getCell(row, ["Licence Plate", "license_plate", "plat_number"], ""),
    );

    return {
      source: "DATA_V2",
      row_no: idx + 2,
      queue_no: `REG ${slot}-${seqBySlot[slot]}`,
      ticket_type: "REG",
      slot,
      created_at: arrived || getCell(row, ["Timestamp"]),
      completed_at: done,
      vendor_name: getCell(row, ["vendor_name", "Vendor Name"]),
      fleet_type: getCell(row, ["Vhiecle Type", "Vehicle Type", "fleet_type"]),
      plat_number: plate,
      driver_name: "",
      phone_number: "",
      ktp_6_digit: "",
      po_number: getCell(row, ["po_number", "po"]),
      gate: getCell(
        row,
        ["Destination Name Adjusted", "destination_name"],
        "-",
      ),
      status,
      po_status: getCell(row, ["po_status"]),
      arrival_status: getCell(row, ["Arrival Status"]),
      unload_sla: getCell(
        row,
        ["NEW SLA Status", "OLD SLA Status", "SLA Status"],
        "",
      ),
      total_po_qty: toNumberV2(getCell(row, ["total_request_quantity"])),
      actual_quantity: toNumberV2(getCell(row, ["actual_quantity"])),
      count_po_sku: toNumberV2(getCell(row, ["Count SKU"])),
      waiting_text: getCell(row, ["Arrive to now", "Active Duration"], ""),
      waiting_minutes: minutesFromCreated(arrived),
      raw: row,
    };
  });
}

function getOutputFormRows(response) {
  if (Array.isArray(response?.outputForm)) return response.outputForm;
  if (Array.isArray(response?.output_form)) return response.output_form;
  if (Array.isArray(response?.data?.outputForm))
    return response.data.outputForm;
  if (Array.isArray(response?.data?.output_form))
    return response.data.output_form;
  return [];
}

function hasOutputFormPayload(response) {
  return (
    Array.isArray(response?.outputForm) ||
    Array.isArray(response?.output_form) ||
    Array.isArray(response?.data?.outputForm) ||
    Array.isArray(response?.data?.output_form)
  );
}

function upsertOutputRowsToRawResponse(rows = []) {
  const incoming = Array.isArray(rows) ? rows : [];
  if (!incoming.length) return;

  if (!v2RawResponse) {
    v2RawResponse = {
      status: "success",
      timestamp: new Date().toISOString(),
      kpiRaw: [],
      table: [],
      tablev2: [],
      outputForm: [],
    };
  }

  const current = getOutputFormRows(v2RawResponse);
  const map = new Map();

  for (const row of current) {
    map.set(ticketIdentity(row), row);
  }

  for (const row of incoming) {
    map.set(ticketIdentity(row), row);
  }

  v2RawResponse = {
    ...v2RawResponse,
    timestamp: new Date().toISOString(),
    outputForm: Array.from(map.values()),
  };
}

function applyCheckerUpdateToQueue(body = {}) {
  const queue = state.dashboard?.queue || [];
  const bodyTicket = String(body.ticket_id || "").trim();
  const bodyQueue = String(body.queue_no || "").trim();
  const bodyPlate = normalizePlateValue(body.plat_number || "");

  let updated = false;

  const nextQueue = queue.map((row) => {
    const rowTicket = String(row.ticket_id || "").trim();
    const rowQueue = String(row.queue_no || "").trim();
    const rowOriginalQueue = String(row.original_queue_no || "").trim();
    const rowPlate = normalizePlateValue(row.plat_number || "");

    const match =
      (bodyTicket && rowTicket === bodyTicket) ||
      (bodyQueue &&
        (rowQueue === bodyQueue || rowOriginalQueue === bodyQueue)) ||
      (bodyPlate && rowPlate === bodyPlate);

    if (!match) return row;

    updated = true;
    return {
      ...row,
      ...body,
      queue_no: row.queue_no,
      original_queue_no: row.original_queue_no || body.queue_no || row.queue_no,
      plat_number: bodyPlate || row.plat_number,
      status: String(body.status || row.status || "WAITING").toUpperCase(),
      completed_at:
        body.completed_at !== undefined
          ? body.completed_at
          : row.completed_at || "",
      updated_at: body.updated_at || formatDateTimeLocal(new Date()),
      expired_at: body.expired_at || row.expired_at || "",
      expired_reason: body.expired_reason || row.expired_reason || "",
      call_count: toNumberV2(body.call_count ?? row.call_count ?? 0),
      wa_call_status: body.wa_call_status || row.wa_call_status || "",
      wa_call_sent_at: body.wa_call_sent_at || row.wa_call_sent_at || "",
      wa_call_error: body.wa_call_error || row.wa_call_error || "",
    };
  });

  if (updated && state.dashboard) {
    state.dashboard.queue = nextQueue;
    state.dashboard.report_preview = nextQueue;
    state.dashboard.priority = nextQueue
      .filter((q) => {
        const st = String(q.status || "").toUpperCase();
        return !st.includes("COMPLETED") && !st.includes("EXPIRED");
      })
      .slice(0, 8);
  }

  return updated;
}

function replaceOutputRowsInRawResponse(rows = []) {
  const incoming = Array.isArray(rows) ? rows : [];
  if (!incoming.length || !v2RawResponse) return;

  const current = getOutputFormRows(v2RawResponse);
  const incomingMap = new Map();
  incoming.forEach((row) => incomingMap.set(ticketIdentity(row), row));

  const nextOutput = current.map((row) => {
    const key = ticketIdentity(row);
    return incomingMap.get(key) || row;
  });

  for (const row of incoming) {
    const key = ticketIdentity(row);
    if (!nextOutput.some((existing) => ticketIdentity(existing) === key)) {
      nextOutput.unshift(row);
    }
  }

  v2RawResponse = {
    ...v2RawResponse,
    timestamp: new Date().toISOString(),
    outputForm: nextOutput,
  };
}

function ticketIdentity(row) {
  // Output form V15/V16 adalah 1 row per PO. ticket_id saja tidak unik karena
  // seluruh PO dalam satu mobil memakai ticket_id yang sama. Prioritaskan
  // ticket_po_id supaya hasil Start/Done Checker per PO tidak menimpa sibling PO.
  const ticketPoId = String(row?.ticket_po_id || "").trim();
  if (ticketPoId) return "ticket-po:" + ticketPoId;

  const ticketId = String(row?.ticket_id || "").trim();
  const poNumber = String(row?.po_number || row?.po || "").trim();
  if (ticketId && poNumber) {
    return ("ticket-po-fallback:" + ticketId + "|" + poNumber).toUpperCase();
  }
  if (ticketId) return "ticket:" + ticketId;

  return [
    "fallback",
    String(row?.queue_no || "").trim(),
    poNumber,
    normalizePlateValue(row?.plat_number || row?.["Licence Plate"] || ""),
  ]
    .join("|")
    .toUpperCase();
}

function mergeTicketQueues(serverQueue = [], localQueue = []) {
  const seen = new Set();
  const out = [];

  for (const row of serverQueue.concat(localQueue || [])) {
    const key = ticketIdentity(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }

  return out;
}

function queueSlotValue(row = {}) {
  const slotRaw =
    row.slot || String(row.queue_no || "").match(/\s(\d+)-/)?.[1] || "999";
  const n = Number(String(slotRaw).replace(/[^0-9]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 999;
}

function queueCreatedValue(row = {}) {
  const raw = row.created_at || row.register_time || row.Timestamp || "";
  if (!raw) return 0;

  if (/^\d{4}-\d{2}-\d{2}T/.test(String(raw))) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  if (/^\d{2}\/\d{2}\/\d{4}/.test(String(raw))) {
    const p = String(raw).split(/[\/ :]/);
    const d = new Date(
      Number(p[2]),
      Number(p[1]) - 1,
      Number(p[0]),
      Number(p[3] || 0),
      Number(p[4] || 0),
      Number(p[5] || 0),
    );
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  const d = new Date(raw);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function queueTypeValue(row = {}) {
  const type = String(row.ticket_type || row.queue_no || "REG").toUpperCase();
  if (type.includes("VIP")) return 0;
  if (type.includes("REG")) return 1;
  if (type.includes("DROP")) return 2;
  return 9;
}

function stableQueueSequenceValue(row = {}) {
  const queueNo = row.queue_no || row.original_queue_no || "";
  const seq =
    typeof queueSequenceNumber === "function"
      ? queueSequenceNumber(queueNo)
      : Number(String(queueNo).match(/-\s*(\d+)\s*$/)?.[1] || 0);
  if (Number.isFinite(seq) && seq > 0) return seq;
  const fallback = Number(row.queue_sequence || 0);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 999999;
}

function sortQueueBySlotSequence(queue = []) {
  return [...queue].sort((a, b) => {
    // Priority utama tetap SLOT.
    // Contoh: semua Slot 1 tampil dulu, baru Slot 2, dst.
    const slotDiff = queueSlotValue(a) - queueSlotValue(b);
    if (slotDiff) return slotDiff;

    // Di slot yang sama, VIP ngalahin REG/DROP.
    // VIP Slot 2 tidak akan naik di atas Slot 1.
    const typeDiff = queueTypeValue(a) - queueTypeValue(b);
    if (typeDiff) return typeDiff;

    // Setelah type, baru ikut nomor antrian / sequence yang stabil.
    const seqDiff = stableQueueSequenceValue(a) - stableQueueSequenceValue(b);
    if (seqDiff) return seqDiff;

    const createdDiff = queueCreatedValue(a) - queueCreatedValue(b);
    if (createdDiff) return createdDiff;

    return String(a.ticket_id || a.queue_no || "").localeCompare(
      String(b.ticket_id || b.queue_no || ""),
    );
  });
}

function normalizeQueueSequenceBySlot(queue = []) {
  const sorted = sortQueueBySlotSequence(queue);
  const seqBySlot = {};

  return sorted.map((row) => {
    const slot = String(row.slot || queueSlotValue(row) || "3").trim() || "3";
    const type = String(row.ticket_type || row.queue_no || "REG")
      .toUpperCase()
      .includes("VIP")
      ? "VIP"
      : String(row.ticket_type || row.queue_no || "REG")
            .toUpperCase()
            .includes("DROP")
        ? "DROP-OFF"
        : "REG";

    seqBySlot[slot] = (seqBySlot[slot] || 0) + 1;

    const existingQueueNo = String(row.queue_no || "").trim();
    const generatedQueueNo =
      type === "DROP-OFF"
        ? `DROP-OFF ${slot}-${seqBySlot[slot]}`
        : `${type} ${slot}-${seqBySlot[slot]}`;

    return {
      ...row,
      original_queue_no:
        row.original_queue_no || existingQueueNo || generatedQueueNo,
      queue_no: existingQueueNo || generatedQueueNo,
      slot,
      queue_sequence: queueSequenceNumber(existingQueueNo) || seqBySlot[slot],
    };
  });
}

function outputStatusRankV6(status = "") {
  const order = {
    WAITING: 0,
    CALLED: 1,
    UNLOADING: 2,
    "WAITING GR": 3,
    "DONE GR": 4,
    COMPLETED: 5,
    EXPIRED: 6,
  };
  return (
    order[
      String(status || "")
        .trim()
        .toUpperCase()
    ] ?? -1
  );
}

function fallbackDateValueV6(...values) {
  return (
    values.find((value) => {
      if (value === undefined || value === null || value === "") return false;
      return !!parseInboundDateSafe(value);
    }) || ""
  );
}

function normalizeOutputDateV7(...values) {
  const value = fallbackDateValueV6(...values);
  const date = parseInboundDateSafe(value);
  if (!date) return "";

  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function buildQueueFromOutputForm(outputRows = []) {
  return outputRows.map((row, idx) => {
    const status = String(
      getCell(row, ["status", "Status"], "WAITING") || "WAITING",
    )
      .trim()
      .toUpperCase();

    const rank = outputStatusRankV6(status);

    const timestamp = getCell(row, [
      "Timestamp",
      "timestamp",
      "created timestamp",
    ]);

    const created = normalizeOutputDateV7(
      getCell(row, ["created_at", "created at"]),
      getCell(row, ["register_time", "register time"]),
      timestamp,
    );

    const registerTime = normalizeOutputDateV7(
      getCell(row, ["register_time", "register time"]),
      getCell(row, ["created_at", "created at"]),
      timestamp,
    );

    const updatedAt = normalizeOutputDateV7(
      getCell(row, ["updated_at", "updated at"]),
      getCell(row, ["last_call_at", "last call at"]),
      timestamp,
    );

    let calledAt = fallbackDateValueV6(
      getCell(row, ["called_at", "called at"]),
      getCell(row, ["last_call_at", "last call at"]),
      getCell(row, ["last_call_attempt_at", "last call attempt at"]),
    );

    let startUnloadingAt = fallbackDateValueV6(
      getCell(row, [
        "start_unloading_at",
        "start unloading at",
        "unloading_start_at",
      ]),
    );

    const waitingGrAt = fallbackDateValueV6(
      getCell(row, ["waiting_gr_at", "waiting gr at"]),
    );
    const doneGrAt = fallbackDateValueV6(
      getCell(row, ["done_gr_at", "done gr at"]),
    );
    const handoverGrnAt = fallbackDateValueV6(
      getCell(row, ["handover_grn_at", "handover grn at"]),
    );
    let completedAt = fallbackDateValueV6(
      getCell(row, ["completed_at", "completed at"]),
      handoverGrnAt,
    );

    // Data lama kadang tidak memiliki kolom waktu transisi.
    // Gunakan timestamp perubahan terbaik yang tersedia agar monitor tetap hidup.
    if (!calledAt && rank >= 1 && status !== "EXPIRED") {
      calledAt = fallbackDateValueV6(
        startUnloadingAt,
        waitingGrAt,
        doneGrAt,
        handoverGrnAt,
        completedAt,
        updatedAt,
        registerTime,
      );
    }

    if (!startUnloadingAt && rank >= 2 && status !== "EXPIRED") {
      startUnloadingAt = fallbackDateValueV6(
        waitingGrAt,
        doneGrAt,
        handoverGrnAt,
        completedAt,
        updatedAt,
        calledAt,
        registerTime,
      );
    }

    if (!completedAt && status === "COMPLETED") {
      completedAt = fallbackDateValueV6(
        handoverGrnAt,
        updatedAt,
        doneGrAt,
        waitingGrAt,
        startUnloadingAt,
      );
    }

    calledAt = normalizeOutputDateV7(calledAt);
    startUnloadingAt = normalizeOutputDateV7(startUnloadingAt);
    completedAt = normalizeOutputDateV7(completedAt);

    const normalizedWaitingGrAt = normalizeOutputDateV7(waitingGrAt);
    const normalizedDoneGrAt = normalizeOutputDateV7(doneGrAt);
    const normalizedHandoverGrnAt = normalizeOutputDateV7(handoverGrnAt);

    const plate = normalizePlateValue(
      getCell(
        row,
        ["plat_number", "Licence Plate", "license_plate", "plat number"],
        "",
      ),
    );

    return {
      source: getCell(row, ["source"], "OUTPUT_FORM"),
      row_no: idx + 2,
      ticket_id: getCell(row, ["ticket_id", "ticket id"], ""),
      queue_no: getCell(
        row,
        ["queue_no", "queue no"],
        `REG ${getCell(row, ["slot"], "3")}-${idx + 1}`,
      ),
      ticket_type: getCell(row, ["ticket_type", "ticket type"], "REG"),
      slot: String(getCell(row, ["slot"], "3") || "3"),
      Timestamp: timestamp,
      created_at: created,
      register_time: registerTime,
      completed_at: completedAt,
      waiting_gr_at: normalizedWaitingGrAt,
      done_gr_at: normalizedDoneGrAt,
      handover_grn_at: normalizedHandoverGrnAt,
      called_at: calledAt,
      start_unloading_at: startUnloadingAt,
      updated_at: updatedAt,
      last_call_at: getCell(row, ["last_call_at", "last call at"], ""),
      expired_at: getCell(row, ["expired_at", "expired at"], ""),
      expired_reason: getCell(row, ["expired_reason", "expired reason"], ""),
      sla_finished_at: getCell(
        row,
        ["sla_finished_at", "SLA Finished At", "sla finished at"],
        "",
      ),
      sla_target_hours: toNumberV2(
        getCell(row, ["sla_target_hours", "sla target hours"], 0),
      ),
      sla_status: getCell(row, ["sla_status", "sla status"], ""),
      vendor_name: getCell(row, ["vendor_name", "Vendor Name"], ""),
      fleet_type: getCell(
        row,
        ["fleet_type", "Vhiecle Type", "Vehicle Type", "fleet type"],
        "",
      ),
      plat_number: plate,
      driver_name: getCell(row, ["driver_name", "driver name"], ""),
      phone_number: getCell(row, ["phone_number", "phone number"], ""),
      ktp_6_digit: getCell(row, ["ktp_6_digit", "ktp 6 digit"], ""),
      po_number: getCell(
        row,
        ["po_number", "po", "PO Number", "po number"],
        "",
      ),
      gate: getCell(row, ["gate"], "-") || "-",
      status,
      po_status: getCell(row, ["po_status"], ""),
      arrival_status: getCell(row, ["arrival_status"], ""),
      unload_sla: getCell(row, ["unload_sla", "sla_status", "SLA Status"], ""),
      total_po_qty: toNumberV2(
        getCell(row, ["total_po_qty", "total_request_quantity"], 0),
      ),
      actual_quantity: toNumberV2(getCell(row, ["actual_quantity"], 0)),
      count_po_sku: toNumberV2(getCell(row, ["count_po_sku", "Count SKU"], 0)),
      call_count: toNumberV2(getCell(row, ["call_count", "wa_call_count"], 0)),
      last_call_attempt_at: getCell(
        row,
        ["last_call_attempt_at", "last call attempt at"],
        "",
      ),
      wa_call_status: getCell(row, ["wa_call_status"], ""),
      wa_call_sent_at: getCell(row, ["wa_call_sent_at"], ""),
      wa_call_error: getCell(row, ["wa_call_error"], ""),
      waiting_text: getCell(row, ["waiting_text"], ""),
      waiting_minutes: minutesFromCreated(registerTime || created),
      raw: row,
    };
  });
}

function buildKpis(kpiRaw = [], tableRows = [], queue = []) {
  const raw = kpiRaw.length ? kpiRaw : tableRows;
  const totalRows = tableRows.length;
  const uniquePo = uniqueCount(
    tableRows.map((r) => getCell(r, ["po_number", "po"])),
  );
  const uniqueVendor = uniqueCount(
    tableRows.map((r) => getCell(r, ["vendor_name"])),
  );

  const totalRequestQty = raw.reduce(
    (s, r) =>
      s +
      toNumberV2(getCell(r, ["total_request_quantity", "total_request_qty"])),
    0,
  );

  const completed = queue.filter((q) => q.status.includes("COMPLETED")).length;
  const pending = queue.filter((q) => !q.status.includes("COMPLETED")).length;
  const late = queue.filter((q) => {
    const a = normalizeKey(q.arrival_status);
    const s = normalizeKey(q.unload_sla);
    return (
      a.includes("LATE") || s.includes("MISS") || q.status.includes("LATE")
    );
  }).length;
  const slaOk = queue.filter((q) => {
    const s = normalizeKey(q.unload_sla);
    return s.includes("OK") || s.includes("EARLY") || s.includes("ON TIME");
  }).length;
  const slaPct = queue.length
    ? Math.round((slaOk / queue.length) * 1000) / 10
    : 0;

  return [
    {
      label: "Total Data",
      display_value: num(totalRows),
      value: totalRows,
      icon: "database",
      color: "primary",
      source: "Data V2",
      metric: "rows",
    },
    {
      label: "Pending",
      display_value: num(pending),
      value: pending,
      icon: "schedule",
      color: "tertiary",
      source: "Data V2",
      metric: "not_completed",
    },
    {
      label: "Completed",
      display_value: num(completed),
      value: completed,
      icon: "check_circle",
      color: "success",
      source: "Data V2",
      metric: "completed",
    },
    {
      label: "Unique PO",
      display_value: num(uniquePo),
      value: uniquePo,
      icon: "inventory_2",
      color: "secondary",
      source: "Data V2",
      metric: "unique_po",
    },
    {
      label: "Total Qty",
      display_value: num(totalRequestQty),
      value: totalRequestQty,
      icon: "deployed_code",
      color: "primary",
      source: "Raw KPI",
      metric: "total_request_quantity",
    },
    {
      label: "Late / Miss",
      display_value: num(late),
      value: late,
      icon: "warning",
      color: late ? "error" : "success",
      source: "Data V2",
      metric: "late_rows",
    },
  ];
}

function buildSummary(kpiRaw = [], tableRows = [], queue = []) {
  const completed = queue.filter((q) => q.status.includes("COMPLETED")).length;
  const waiting = queue.filter(
    (q) =>
      q.status.includes("WAIT") ||
      q.status.includes("PENDING") ||
      q.status.includes("ON DELIVERY") ||
      !q.status.includes("COMPLETED"),
  ).length;
  const onDock = queue.filter(
    (q) =>
      q.status.includes("ON_DOCK") ||
      q.status.includes("ON DOCK") ||
      q.status.includes("RECEIVE"),
  ).length;
  const called = queue.filter((q) => q.status.includes("CALLED")).length;
  const late = queue.filter((q) =>
    normalizeKey(q.arrival_status).includes("LATE"),
  ).length;
  const totalRequestQty = tableRows.reduce(
    (s, r) => s + toNumberV2(getCell(r, ["total_request_quantity"])),
    0,
  );

  return {
    ticket: {
      count_waiting: waiting,
      count_called: called,
      count_on_dock: onDock,
      count_completed: completed,
    },
    checker: {
      on_process: onDock + called,
      completed,
      sla_ok_pct: queue.length
        ? Math.round((completed / queue.length) * 1000) / 10
        : 0,
      sla_miss: late,
    },
    caphand: {
      rows: tableRows.length,
      unique_po: uniqueCount(
        tableRows.map((r) => getCell(r, ["po_number", "po"])),
      ),
      unique_sku: tableRows.reduce(
        (s, r) => s + toNumberV2(getCell(r, ["Count SKU"])),
        0,
      ),
      unique_vendor: uniqueCount(
        tableRows.map((r) => getCell(r, ["vendor_name"])),
      ),
      total_request_qty: totalRequestQty,
      late_rows: late,
    },
  };
}

function buildOptionsFromV2(tableRows = []) {
  const vendors = [
    ...new Set(
      tableRows
        .map((r) => getCell(r, ["vendor_name", "Vendor Name", "VENDOR NAME"]))
        .filter(Boolean),
    ),
  ].sort();
  const po = [
    ...new Set(
      tableRows.map((r) => getCell(r, ["po_number", "po"])).filter(Boolean),
    ),
  ].sort();
  const vehicle = [
    ...new Set(
      tableRows
        .map((r) => getCell(r, ["Vhiecle Type", "Vehicle Type", "fleet_type"]))
        .filter(Boolean),
    ),
  ].sort();

  return {
    ...state.options,
    gate:
      typeof getCibitungGateOptions === "function"
        ? getCibitungGateOptions()
        : Array.from(
            { length: 10 },
            (_, i) => `Dock ${String(i + 1).padStart(2, "0")}`,
          ),
    vendor_name: vendors,
    po_number: po,
    fleet_type: vehicle.length ? vehicle : state.options.fleet_type,
  };
}

function getTableV2Rows(response) {
  // GAS terbaru return Data V2 di key `tablev2`.
  // Fallback `tableDatav2` dipasang untuk jaga-jaga kalau nama key berubah,
  // lalu `table` sebagai fallback versi lama.
  if (Array.isArray(response?.tablev2)) return response.tablev2;
  if (Array.isArray(response?.tableDatav2)) return response.tableDatav2;
  if (Array.isArray(response?.data?.tablev2)) return response.data.tablev2;
  if (Array.isArray(response?.data?.tableDatav2))
    return response.data.tableDatav2;
  if (Array.isArray(response?.table)) return response.table;
  return [];
}

function getKpiRawRows(response) {
  if (Array.isArray(response?.kpiRaw)) return response.kpiRaw;
  if (Array.isArray(response?.data?.kpiRaw)) return response.data.kpiRaw;
  return [];
}

function buildDashboardFromV2(response) {
  const tableRows = getTableV2Rows(response);
  const kpiRaw = getKpiRawRows(response);
  const outputRows = getOutputFormRows(response);
  v2PoIndex = buildPoIndex(tableRows);

  // Data V2 hanya dipakai untuk PO lookup/options.
  // Queue/Checker wajib dari hasil input Security: Output form.
  // LocalStorage hanya fallback saat payload Output form tidak ada sama sekali.
  // Kalau Output form dari server kosong, queue juga wajib kosong agar data yang sudah dihapus
  // dari GSheet tidak tetap muncul di Waiting List.
  const serverQueue = buildQueueFromOutputForm(outputRows);
  const serverHasOutputForm = hasOutputFormPayload(response);
  const localQueue = serverHasOutputForm ? [] : getLocalTickets();
  if (serverHasOutputForm) saveLocalTickets([]);
  const queue = normalizeQueueSequenceBySlot(
    serverHasOutputForm
      ? serverQueue
      : mergeTicketQueues(serverQueue, localQueue),
  );

  const summary = buildSummary(kpiRaw, tableRows, queue);
  const kpis = buildKpis(kpiRaw, tableRows, queue);

  const dockMap = {};
  const gates =
    typeof getCibitungGateOptions === "function"
      ? getCibitungGateOptions()
      : Array.from(
          { length: 10 },
          (_, i) => `Dock ${String(i + 1).padStart(2, "0")}`,
        );

  gates.forEach((gate) => {
    dockMap[gate] = { gate, status: "KOSONG", queue_no: "", plat_number: "" };
  });

  for (const q of queue) {
    const st = String(q.status || "").toUpperCase();
    if (st.includes("COMPLETED") || st.includes("EXPIRED")) continue;

    parseGateList(q.gate || "").forEach((gate) => {
      if (!dockMap[gate]) {
        dockMap[gate] = {
          gate,
          status: "KOSONG",
          queue_no: "",
          plat_number: "",
        };
      }
      if (st.includes("CALLED") || st.includes("UNLOADING")) {
        dockMap[gate] = {
          gate,
          status: q.status || "AKTIF",
          queue_no: q.queue_no,
          plat_number: q.plat_number,
        };
      }
    });
  }

  return {
    timestamp: response?.timestamp || new Date().toISOString(),
    kpis,
    summary,
    queue,
    priority: sortQueueBySlotSequence(
      queue.filter((q) => {
        const st = String(q.status || "").toUpperCase();
        return !st.includes("COMPLETED") && !st.includes("EXPIRED");
      }),
    ).slice(0, 8),
    dock: Object.values(dockMap).slice(0, 10),
    report_preview: queue,
    raw: {
      kpiRaw,
      tablev2: tableRows,
      outputForm: outputRows,
      table: Array.isArray(response?.table) ? response.table : [],
    },
    options: buildOptionsFromV2(tableRows),
  };
}

function updateApiPill(mode, text) {
  const pill = document.getElementById("api-pill");
  if (!pill) return;
  const color =
    mode === "on"
      ? "bg-success"
      : mode === "loading"
        ? "bg-warning"
        : "bg-error";
  pill.innerHTML = `<span class="w-2 h-2 rounded-full ${color} ${mode === "on" ? "status-pulse" : ""}"></span>${text}`;
}

function shouldUseOutputOnlyInitialLoad() {
  const page = String(
    state.page || (location.hash || "").replace("#", "") || "",
  ).trim();
  const role =
    typeof getAuthUser === "function"
      ? normalizeRole(getAuthUser()?.role || "")
      : "";

  if (role === "CHECKER" || role === "ADMIN") return true;
  if (
    ["checker", "monitor", "laporan", "panggil", "antrian"].includes(page) &&
    role !== "SECURITY"
  )
    return true;

  return false;
}

async function initApi() {
  updateApiPill("loading", "Cek API V2...");
  if (!hasApiV2()) {
    updateApiPill("off", "API V2 belum diset");
    return;
  }

  try {
    if (
      typeof shouldUseOutputOnlyInitialLoad === "function" &&
      shouldUseOutputOnlyInitialLoad()
    ) {
      const outputResponse = await fetchOutputFormData();
      v2RawResponse = {
        ...(v2RawResponse || {}),
        status: "success",
        timestamp: outputResponse?.timestamp || new Date().toISOString(),
        kpiRaw: [],
        table: [],
        // Master PO yang sudah pernah dimuat dipertahankan; layar Checker /
        // Monitor tidak memerlukannya, tetapi membuangnya memaksa halaman
        // Daftar mengunduh ulang seluruh master saat operator berpindah menu.
        tablev2: getTableV2Rows(v2RawResponse || {}),
        sites: outputResponse?.sites || v2RawResponse?.sites || [],
        gates: outputResponse?.gates || v2RawResponse?.gates || [],
        outputForm: getOutputFormRows(outputResponse),
        inboundMp: getInboundMpRowsV15(
          outputResponse,
          v2RawResponse?.inboundMp || v2RawResponse?.inbound_mp || [],
        ),
      };
    } else {
      v2RawResponse = await fetchV2Data();
    }
    applyServerSiteCatalog(v2RawResponse);

    state.dashboard = buildDashboardFromV2(v2RawResponse);
    state.options = state.dashboard.options || state.options;
    state.lastCalled =
      typeof getLatestCallTicket === "function"
        ? getLatestCallTicket(state.dashboard.queue)
        : state.dashboard.queue[0] || state.lastCalled;
    updateApiPill("on", "API live");
    window.startInboundRealtime?.();
    const nextPage =
      state.page === "login"
        ? getDefaultPageForRole(getAuthUser()?.role)
        : state.page || getDefaultPageForRole(getAuthUser()?.role);
    renderPage(nextPage, false);
  } catch (err) {
    console.error(err);
    if (/unauthorized/i.test(String(err?.message || ""))) {
      clearAuthUser?.();
      updateApiPill("off", "Sesi login berakhir");
      showToast("Sesi lama berakhir. Silakan login ulang.");
      renderPage("login", false);
      return;
    }
    updateApiPill("error", "API error");
    showToast("API V2 error: " + err.message);
  }
}

async function ensureFullDataForDaftar() {
  if (!hasApiV2()) return;
  if (fullDataLoadBusy) return;
  const tableRows = getTableV2Rows(v2RawResponse || {});
  if (tableRows.length) return;

  fullDataLoadBusy = true;
  try {
    updateApiPill("loading", "Memuat master PO...");
    // Snapshot operasional sudah ada di memori; yang kurang hanya master PO.
    const poMaster = await fetchPoMasterData();
    v2RawResponse = {
      ...(v2RawResponse || {}),
      tablev2: Array.isArray(poMaster?.tablev2) ? poMaster.tablev2 : [],
      po_master_synced_at: poMaster?.last_synced_at || null,
    };
    state.dashboard = buildDashboardFromV2(v2RawResponse);
    state.options = state.dashboard.options || state.options;
    updateApiPill("on", "API live");
    if (state.page === "daftar") renderPage("daftar", false);
  } catch (err) {
    console.error(err);
    updateApiPill("error", "API error");
    showToast("Master PO gagal dimuat: " + err.message);
  } finally {
    fullDataLoadBusy = false;
  }
}

async function refreshDashboard() {
  try {
    if (
      ["checker", "laporan", "monitor", "antrian", "panggil", "dropoff"].includes(
        state.page,
      ) &&
      v2RawResponse
    ) {
      updateApiPill("loading", "Refresh Output form...");
      const outputResponse = await fetchOutputFormData();
      v2RawResponse = {
        ...v2RawResponse,
        timestamp: outputResponse?.timestamp || new Date().toISOString(),
        sites: outputResponse?.sites || v2RawResponse?.sites || [],
        gates: outputResponse?.gates || v2RawResponse?.gates || [],
        outputForm: getOutputFormRows(outputResponse),
        inboundMp: getInboundMpRowsV15(
          outputResponse,
          v2RawResponse?.inboundMp || v2RawResponse?.inbound_mp || [],
        ),
      };
      applyServerSiteCatalog(v2RawResponse);
      state.dashboard = buildDashboardFromV2(v2RawResponse);
      state.options = state.dashboard.options || state.options;
      state.lastCalled =
        typeof getLatestCallTicket === "function"
          ? getLatestCallTicket(state.dashboard.queue)
          : state.dashboard.queue[0] || state.lastCalled;
      updateApiPill("on", "API live");
      renderPage(state.page || "checker", false);
      showToast("Output form refresh");
      return;
    }

    await initApi();
    showToast("Data refresh");
  } catch (err) {
    console.error(err);
    updateApiPill("error", "API error");
    showToast("Refresh gagal: " + err.message);
  }
}

function parsePoNumbers(value) {
  return [
    ...new Set(
      String(value || "")
        .split(/[,\n;]+/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

function lookupMultiplePo(poText, vendorText = "") {
  const poNumbers = parsePoNumbers(poText);
  const selectedVendor = String(vendorText || "").trim();
  const selectedVendorKey = normalizeKey(selectedVendor);
  const items = [];
  const missing = [];
  const vendorMismatch = [];

  for (const po of poNumbers) {
    const key = normalizeKey(po);
    const found = v2PoIndex?.[key];
    if (found) {
      const foundVendor = String(found.vendor_name || "").trim();
      const foundVendorKey = normalizeKey(foundVendor);

      if (
        selectedVendorKey &&
        foundVendorKey &&
        !foundVendorKey.includes(selectedVendorKey) &&
        !selectedVendorKey.includes(foundVendorKey)
      ) {
        vendorMismatch.push({
          ...found,
          po_number: found.po_number || po,
          po_input: po,
          vendor_name: foundVendor,
        });
        continue;
      }

      items.push({
        ...found,
        po_number: found.po_number || po,
        po_input: po,
      });
    } else {
      missing.push(po);
    }
  }

  const vendors = [
    ...new Set(
      items.map((x) => String(x.vendor_name || "").trim()).filter(Boolean),
    ),
  ];

  const slots = [
    ...new Set(items.map((x) => String(x.slot || "").trim()).filter(Boolean)),
  ];

  const totalQty = items.reduce(
    (sum, x) => sum + toNumberV2(x.total_po_qty),
    0,
  );
  const totalSku = items.reduce(
    (sum, x) => sum + toNumberV2(x.count_po_sku),
    0,
  );

  return {
    found: items.length > 0,
    all_found:
      poNumbers.length > 0 &&
      missing.length === 0 &&
      vendorMismatch.length === 0,
    po_numbers: poNumbers,
    items,
    missing_po: missing,
    vendor_mismatch: vendorMismatch,
    summary: {
      po_number: poNumbers.join(", "),
      po_numbers: poNumbers,
      vendor_name: selectedVendor || vendors.join(", "),
      vendor_names: vendors,
      slot: slots[0] || "3",
      slots,
      total_po_qty: totalQty,
      count_po_sku: totalSku,
      found_count: items.length,
      missing_count: missing.length,
      vendor_mismatch_count: vendorMismatch.length,
    },
  };
}

function updatePoLookupUi(lookup) {
  const form = document.getElementById("security-form");
  if (!form) return;

  if (form.vendor_name && lookup?.summary?.vendor_name) {
    const currentVendor = String(form.vendor_name.value || "").trim();
    // Vendor tetap bisa diinput manual. Auto-fill hanya kalau field masih kosong.
    if (!currentVendor)
      form.vendor_name.value = lookup.summary.vendor_name || "";
  }

  // Slot dari master PO hanya merupakan suggestion. Jika Security sudah memilih
  // slot secara manual, pilihan tersebut tidak boleh ditimpa oleh lookup ulang
  // (lookup juga dipanggil lagi saat Buat Tiket).
  if (form.slot && lookup?.summary?.slot && form.slot.dataset.manualSelection !== "true")
    form.slot.value = String(lookup.summary.slot || form.slot.value || "3");

  const total = document.getElementById("security-total-qty");
  const sku = document.getElementById("security-count-sku");
  if (total) total.textContent = num(lookup?.summary?.total_po_qty || 0);
  if (sku) sku.textContent = num(lookup?.summary?.count_po_sku || 0);

  if (typeof renderPoSelectedChips === "function") {
    renderPoSelectedChips(parsePoNumbers(form.po_number?.value || ""));
  }
  if (typeof filterPoDropdown === "function") filterPoDropdown();

  const box = document.getElementById("po-lookup-summary");
  if (box && typeof renderPoLookupSummary === "function") {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = renderPoLookupSummary(lookup);
    const next = wrapper.firstElementChild;
    if (next) box.replaceWith(next);
  }
}

function queueSequenceNumber(queueNo = "") {
  const match = String(queueNo || "").match(/-\s*(\d+)\s*$/);
  const n = match ? Number(match[1]) : 0;
  return Number.isFinite(n) ? n : 0;
}

function nextLocalQueueNoFromList(ticketType, slot, queue = []) {
  const type = String(ticketType || "REG").toUpperCase();
  const slotText = String(slot || "3").trim() || "3";

  const sameSlot = queue.filter((q) => {
    const qSlot = String(q.slot || queueSlotValue(q) || "").trim();
    return qSlot === slotText;
  });

  // Pakai max sequence dari queue_no existing, bukan count rows.
  // Ini mencegah nomor berubah/duplicate kalau ada row yang dihapus atau data refresh.
  const maxSeq = sameSlot.reduce((max, q) => {
    const seq = queueSequenceNumber(q.queue_no || q.original_queue_no || "");
    return Math.max(max, seq);
  }, 0);

  const nextSeq = maxSeq + 1;

  if (type === "DROP" || type === "DROP-OFF")
    return `DROP-OFF ${slotText}-${nextSeq}`;

  return `${type} ${slotText}-${nextSeq}`;
}

function nextLocalQueueNo(ticketType, slot) {
  const queue = (state.dashboard?.queue || []).concat(getLocalTickets());
  return nextLocalQueueNoFromList(ticketType, slot, queue);
}

function lookupPo(silent = false) {
  const form = document.getElementById("security-form");
  if (!form) return null;

  const poText = form.po_number?.value || "";
  const vendorText = form.vendor_name?.value || "";
  const poNumbers = parsePoNumbers(poText);
  if (!poNumbers.length) {
    state.poLookup = null;
    updatePoLookupUi(null);
    return null;
  }

  const lookup = lookupMultiplePo(poText, vendorText);
  state.poLookup = lookup;
  updatePoLookupUi(lookup);

  if (!silent) {
    if (lookup.all_found) {
      showToast(`${lookup.items.length} PO valid dari Data V2`);
    } else if (lookup.vendor_mismatch?.length) {
      showToast(
        `${lookup.vendor_mismatch.length} PO beda vendor dari Vendor Name yang dipilih`,
      );
    } else if (lookup.found) {
      showToast(
        `${lookup.items.length} PO ditemukan, ${lookup.missing_po.length} tidak ketemu`,
      );
    } else {
      showToast("PO tidak ketemu di Data V2");
    }
  }

  return lookup.found ? lookup : null;
}

function nextLocalQueueNo(ticketType, slot) {
  const queue = (state.dashboard?.queue || []).concat(getLocalTickets());
  const type = String(ticketType || "REG").toUpperCase();
  const slotText = String(slot || "3");

  if (type === "DROP" || type === "DROP-OFF") {
    const count =
      queue.filter((q) => String(q.queue_no || "").startsWith("DROP")).length +
      1;
    return `DROP-OFF ${slotText}-${count}`;
  }

  const count =
    queue.filter((q) =>
      String(q.queue_no || "").startsWith(`${type} ${slotText}-`),
    ).length + 1;
  return `${type} ${slotText}-${count}`;
}

function parseMultiInputValues(value) {
  return String(value || "")
    .split(/[,\n;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeIndoPhone(value = "") {
  let phone = String(value || "").trim();
  phone = phone.replace(/[^\d]/g, "");

  if (!phone) return "";

  // 0812xxxx -> 62812xxxx
  if (phone.startsWith("0")) {
    phone = "62" + phone.slice(1);
  }

  // 812xxxx -> 62812xxxx
  if (phone.startsWith("8")) {
    phone = "62" + phone;
  }

  // Kalau sudah 62, biarin. Selain itu dianggap invalid.
  if (!phone.startsWith("62")) return "";

  // Validasi kasar nomor Indonesia/WA.
  if (phone.length < 10 || phone.length > 16) return "";

  return phone;
}

function parseAndNormalizePhones(value = "") {
  const seen = new Set();
  return String(value || "")
    .split(/[,;\n|]+/)
    .map(normalizeIndoPhone)
    .filter((phone) => {
      if (!phone || seen.has(phone)) return false;
      seen.add(phone);
      return true;
    });
}

function normalizePhoneInputValue(value = "") {
  return parseAndNormalizePhones(value).join(", ");
}

function normalizePhoneFieldOnBlur(el) {
  if (!el) return "";
  const normalized = normalizePhoneInputValue(el.value);
  el.value = normalized;
  el.classList.toggle("invalid", !normalized);
  return normalized;
}

function parseMultiPlateValues(value) {
  return parseMultiInputValues(value).map(normalizePlateValue).filter(Boolean);
}

function pickMultiValue(list = [], index = 0) {
  if (!Array.isArray(list) || !list.length) return "";
  if (list.length === 1) return list[0];
  return list[index] || list[list.length - 1] || list[0] || "";
}

function getRegisteredPoSetApi() {
  const set = new Set();
  const rows = state.dashboard?.queue || [];

  rows.forEach((row) => {
    const rawValues = [];
    if (Array.isArray(row.po_numbers)) rawValues.push(...row.po_numbers);
    if (row.po_number) rawValues.push(row.po_number);
    if (row.raw?.po_number) rawValues.push(row.raw.po_number);

    rawValues.forEach((value) => {
      parsePoNumbers(value).forEach((po) => {
        const key = normalizeKey(po);
        if (key) set.add(key);
      });
    });
  });

  return set;
}

function sumPoItems(items = []) {
  return {
    po_number: items
      .map((x) => x.po_number)
      .filter(Boolean)
      .join(", "),
    po_numbers: items.map((x) => x.po_number).filter(Boolean),
    vendor_name: [
      ...new Set(
        items.map((x) => String(x.vendor_name || "").trim()).filter(Boolean),
      ),
    ].join(", "),
    total_po_qty: items.reduce((sum, x) => sum + toNumberV2(x.total_po_qty), 0),
    count_po_sku: items.reduce((sum, x) => sum + toNumberV2(x.count_po_sku), 0),
    slot: String(items[0]?.slot || "3"),
  };
}

function splitPoItemsByPlate(poItems = [], plateCount = 1) {
  const count = Math.max(1, Number(plateCount || 1));

  // 1 plat = 1 mobil. Semua PO vendor sama digabung jadi 1 row/antrian.
  if (count === 1) return [poItems];

  // Jika jumlah PO sama dengan jumlah plat, mapping 1 PO per plat sesuai urutan.
  if (poItems.length === count) return poItems.map((item) => [item]);

  // Jika PO lebih banyak dari plat, bagi rata berurutan tanpa duplikasi.
  if (poItems.length > count) {
    const groups = Array.from({ length: count }, () => []);
    poItems.forEach((item, idx) => {
      const groupIndex = Math.min(
        count - 1,
        Math.floor((idx * count) / poItems.length),
      );
      groups[groupIndex].push(item);
    });
    return groups.map((group) => (group.length ? group : [poItems[0]]));
  }

  // Jika plat lebih banyak dari PO, PO akan dipakai bergilir sebagai fallback.
  return Array.from({ length: count }, (_, idx) => [
    poItems[idx % poItems.length],
  ]);
}

async function submitSecurity(e) {
  e?.preventDefault?.();

  // Security tidak boleh tersimpan dari Enter, scanner suffix Enter,
  // implicit browser submit, atau event form lain.
  // Hanya explicitSecuritySubmit() dari tombol Buat Nomor yang diizinkan.
  if (!e || e.explicitSecuritySubmit !== true) {
    console.warn("Blocked implicit Security submit");
    return;
  }

  if (securitySubmitBusy) {
    showToast("Submit sedang diproses, tunggu sebentar.");
    return;
  }

  const form = e.target;
  if (typeof syncPlateMultiInput === "function") syncPlateMultiInput();

  if (!validateSecurityForm(form)) return;

  const lookup = lookupPo(true);
  if (!lookup || !lookup.all_found) {
    const mismatchText = lookup?.vendor_mismatch?.length
      ? " PO beda vendor: " +
        lookup.vendor_mismatch.map((x) => x.po_number || x.po_input).join(", ")
      : "";
    const missingText = lookup?.missing_po?.length
      ? " Missing: " + lookup.missing_po.join(", ")
      : "";
    showToast(
      "Semua PO wajib valid dan sesuai Vendor Name." +
        mismatchText +
        missingText,
    );
    return;
  }

  securitySubmitBusy = true;
  const submitBtn = document.getElementById("security-submit-btn");
  const submitText = document.getElementById("security-submit-text");
  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.textContent = "Menyimpan...";

  try {
    const base = Object.fromEntries(new FormData(form).entries());
    const poItems = lookup.items || [];

    if (!poItems.length) {
      showToast("PO belum valid.");
      return;
    }

    const registeredSet = getRegisteredPoSetApi();
    const duplicatedPo = poItems
      .map((item) => item.po_number || item.po_input)
      .filter((po) => registeredSet.has(normalizeKey(po)));

    if (duplicatedPo.length) {
      showToast(
        "PO sudah daftar dan tidak bisa didaftarkan lagi: " +
          duplicatedPo.join(", "),
      );
      return;
    }

    const plateList = parseMultiPlateValues(base.plat_number);
    const driverList = parseMultiInputValues(base.driver_name);
    const phoneList = parseAndNormalizePhones(base.phone_number);
    base.phone_number = phoneList.join(", ");

    if (!plateList.length) {
      showToast("Plat number wajib diisi.");
      return;
    }
    if (!driverList.length) {
      showToast("Driver name wajib diisi.");
      return;
    }
    if (!phoneList.length) {
      showToast(
        "Phone number wajib diisi dan harus nomor WhatsApp Indonesia. Contoh: 081287402496",
      );
      return;
    }

    if (phoneList.length > 1 && phoneList.length !== plateList.length) {
      showToast(
        "Jumlah nomor WhatsApp harus sama dengan jumlah plat, atau isi 1 nomor saja untuk semua plat.",
      );
      return;
    }

    const rows = getLocalTickets();
    const newRows = [];
    const registerTime = base.register_time || formatDateTimeLocal(new Date());
    let queuePool = (state.dashboard?.queue || []).concat(rows);

    const poGroups = splitPoItemsByPlate(poItems, plateList.length);

    for (const [index, plate] of plateList.entries()) {
      const groupItems = poGroups[index] || poItems;
      const grouped = sumPoItems(groupItems);
      const rowSlot =
        String(base.ticket_type || "").toUpperCase() === "DROP-OFF"
          ? base.slot || grouped.slot || "3"
          : base.slot || grouped.slot || "3";

      const driver = pickMultiValue(driverList, index);
      const phone = pickMultiValue(phoneList, index);

      const row = {
        ...base,
        ticket_id:
          "IBT-" +
          Date.now().toString(36).toUpperCase() +
          "-" +
          String(newRows.length + 1).padStart(2, "0"),
        po_number: grouped.po_number,
        po_numbers: grouped.po_numbers,
        vendor_name: base.vendor_name || grouped.vendor_name || "",
        slot: rowSlot,
        plat_number: plate,
        driver_name: driver,
        phone_number: phone,
        status: "WAITING",
        total_po_qty: grouped.total_po_qty,
        count_po_sku: grouped.count_po_sku,
        created_at: registerTime,
        register_time: registerTime,
        queue_no: nextLocalQueueNoFromList(
          base.ticket_type,
          rowSlot,
          queuePool.concat(newRows),
        ),
        gate: "-",
        unload_sla: "",
        source: "SECURITY_INPUT",
      };

      newRows.push(row);
    }

    // Buka popup print di event klik yang sama supaya tidak diblokir browser.
    const printWindow =
      typeof openSecurityPrintWindow === "function"
        ? openSecurityPrintWindow("Menyimpan ticket dan menyiapkan print...")
        : null;

    // Local fallback tetap disimpan supaya UI langsung punya data walau backend lambat.
    rows.unshift(...newRows);
    saveLocalTickets(rows);

    try {
      showToast("Menyimpan ticket ke Output form...");
      const result = await submitSecurityRowsToBackend(newRows);
      const waFeedbackV171 = getTicketWaFeedbackV171(result);
      window.__lastTicketWaResultsV171 = waFeedbackV171.items;
      console.log("WA ticket result V17.1:", waFeedbackV171.items);

      // Tidak fetch full API lagi. Row hasil POST langsung dimasukkan ke state.
      const savedRows =
        Array.isArray(result?.rows) && result.rows.length
          ? result.rows
          : newRows;
      state.lastSecurityRows = savedRows;
      try {
        localStorage.setItem(
          "inbound_frozen_last_print_rows",
          JSON.stringify(savedRows),
        );
      } catch (err) {}

      // Auto popup print setelah ticket berhasil tersimpan.
      // Pakai savedRows supaya nomor antrian di Daftar, Checker, dan QR tetap sama.
      if (typeof printSecurityTickets === "function") {
        printSecurityTickets(savedRows, printWindow);
      }

      upsertOutputRowsToRawResponse(savedRows);
      state.dashboard = buildDashboardFromV2(v2RawResponse);
      state.options = state.dashboard.options || state.options;

      showToast(buildTicketCreatedToastV171(result, newRows.length));
    } catch (err) {
      console.error(err);

      // Tetap tampilkan ticket lokal supaya Checker langsung bisa proses.
      if (v2RawResponse) {
        upsertOutputRowsToRawResponse(newRows);
        state.dashboard = buildDashboardFromV2(v2RawResponse);
        state.options = state.dashboard.options || state.options;
      } else {
        state.dashboard.queue.unshift(...newRows);
        state.dashboard.report_preview.unshift(...newRows);
      }

      if (typeof showSecurityPrintError === "function") {
        showSecurityPrintError(
          printWindow,
          "Backend gagal menyimpan ticket: " + err.message,
        );
      }
      showToast("Backend gagal, ticket tersimpan lokal: " + err.message);
    }

    state.lastCalled =
      (state.lastSecurityRows && state.lastSecurityRows[0]) || newRows[0];
    if (!state.lastSecurityRows || !state.lastSecurityRows.length) {
      state.lastSecurityRows = newRows;
      try {
        localStorage.setItem(
          "inbound_frozen_last_print_rows",
          JSON.stringify(newRows),
        );
      } catch (err) {}
    }
    const queueEl = document.getElementById("new-queue-number");
    if (queueEl)
      queueEl.textContent = state.lastCalled?.queue_no || newRows[0].queue_no;
    renderPage("checker", false);
  } finally {
    securitySubmitBusy = false;
    const activeBtn = document.getElementById("security-submit-btn");
    const activeText = document.getElementById("security-submit-text");
    if (activeBtn) activeBtn.disabled = false;
    if (activeText) activeText.textContent = "Buat Nomor";
  }
}

function getQueueRowByCheckerBody(body = {}) {
  const bodyTicket = String(body.ticket_id || "").trim();
  const bodyQueue = String(body.queue_no || "").trim();
  const bodyPlate = normalizePlateValue(body.plat_number || "");

  return (state.dashboard?.queue || []).find((row) => {
    const rowTicket = String(row.ticket_id || "").trim();
    const rowQueue = String(row.queue_no || "").trim();
    const rowOriginalQueue = String(row.original_queue_no || "").trim();
    const rowPlate = normalizePlateValue(row.plat_number || "");
    return (
      (bodyTicket && rowTicket === bodyTicket) ||
      (bodyQueue &&
        (rowQueue === bodyQueue || rowOriginalQueue === bodyQueue)) ||
      (bodyPlate && rowPlate === bodyPlate)
    );
  });
}

function buildUpdatedOutputRowFromBody(body = {}) {
  const old = getQueueRowByCheckerBody(body) || {};
  return {
    ...old.raw,
    ...old,
    ...body,
    queue_no: body.queue_no || old.original_queue_no || old.queue_no || "",
    ticket_id: body.ticket_id || old.ticket_id || "",
    plat_number: body.plat_number || old.plat_number || "",
    gate: body.gate || old.gate || "-",
    status: body.status || old.status || "WAITING",
    unload_sla: body.unload_sla || old.unload_sla || "",
    updated_at: body.updated_at || formatDateTimeLocal(new Date()),
    completed_at: body.completed_at || "",
  };
}

async function submitChecker(e) {
  e.preventDefault();
  const form = e.target;

  if (form.dataset.saving === "1") {
    showToast("Data sedang disimpan, tunggu sebentar.");
    return;
  }

  form.dataset.saving = "1";
  if (typeof setCheckerSubmitButtonState === "function") {
    setCheckerSubmitButtonState("saving", "Menyimpan...");
  }

  const requiredOk = validateRequiredFields(form);
  const plateOk = validatePlateInput(form.plat_number);

  if (typeof syncCheckerGateInput === "function" && !syncCheckerGateInput()) {
    showToast(
      "Wingbox bisa pilih 1 sampai 3 gate berbeda dan tidak boleh duplicate.",
    );
    form.dataset.saving = "0";
    if (typeof updateCheckerStatusPreview === "function") {
      updateCheckerStatusPreview(form.status?.value || "CALLED");
    }
    return;
  }

  if (!requiredOk || !plateOk) {
    showToast("Pilih data dari List Security dan isi Gate.");
    form.dataset.saving = "0";
    if (typeof updateCheckerStatusPreview === "function") {
      updateCheckerStatusPreview(form.status?.value || "CALLED");
    }
    return;
  }

  const body = Object.fromEntries(new FormData(form).entries());
  if (!body.gate) {
    body.gate =
      document.getElementById("checker-gate-value")?.value || "Dock 01";
  }

  body.plat_number = normalizePlateValue(body.plat_number);
  body.actor_role = String(getAuthUser?.()?.role || "CHECKER").toUpperCase();

  const requested = String(body.status || "CALLED")
    .trim()
    .toUpperCase();
  const targetStatus = requested.includes("WAITING GR")
    ? "WAITING GR"
    : requested.includes("UNLOADING")
      ? "UNLOADING"
      : "CALLED";

  body.status = targetStatus;
  body.unload_sla = targetStatus === "WAITING GR" ? "ON PROCESS" : "ON PROCESS";

  if (!body.operational_date && typeof getOperationalDateKey === "function") {
    body.operational_date = getOperationalDateKey(new Date());
  }

  const nowText = formatDateTimeLocal(new Date());
  body.updated_at = nowText;
  body.called_at =
    targetStatus === "CALLED"
      ? body.called_at || nowText
      : body.called_at || "";
  body.start_unloading_at =
    targetStatus === "UNLOADING"
      ? body.start_unloading_at || nowText
      : body.start_unloading_at || "";
  body.waiting_gr_at =
    targetStatus === "WAITING GR"
      ? body.waiting_gr_at || nowText
      : body.waiting_gr_at || "";
  body.completed_at = "";

  const local = getLocalTickets();
  for (const row of local) {
    let match = false;
    if (body.ticket_id) {
      match = String(row.ticket_id || "") === String(body.ticket_id);
    } else if (body.queue_no) {
      match =
        (row.queue_no === body.queue_no ||
          row.original_queue_no === body.queue_no) &&
        (!body.plat_number ||
          normalizePlateValue(row.plat_number) === body.plat_number);
    }
    if (!match) continue;
    Object.assign(row, body, {
      status: targetStatus,
      called_at:
        targetStatus === "CALLED"
          ? row.called_at || body.called_at
          : row.called_at || "",
      start_unloading_at:
        targetStatus === "UNLOADING"
          ? row.start_unloading_at || body.start_unloading_at
          : row.start_unloading_at || body.start_unloading_at || "",
      waiting_gr_at:
        targetStatus === "WAITING GR"
          ? row.waiting_gr_at || body.waiting_gr_at
          : row.waiting_gr_at || body.waiting_gr_at || "",
    });
  }
  saveLocalTickets(local);

  const optimisticRow = buildUpdatedOutputRowFromBody(body);
  applyCheckerUpdateToQueue(body);
  if (v2RawResponse) {
    replaceOutputRowsInRawResponse([optimisticRow]);
    state.dashboard = buildDashboardFromV2(v2RawResponse);
  }

  // V18.2: tampilkan perubahan langsung. Request GAS tetap berjalan di background.
  if (state.page === "checker") {
    renderPage("checker", false);
  }

  try {
    const result = await updateCheckerToBackend(body);
    if (Array.isArray(result?.rows) && result.rows.length) {
      replaceOutputRowsInRawResponse(result.rows);
      state.dashboard = buildDashboardFromV2(v2RawResponse);
    }

    if (targetStatus === "CALLED") {
      const freshRow = result?.rows?.[0] || optimisticRow;
      const count = Number(result?.call_count || freshRow.call_count || 1) || 1;
      showToast(`Nomor dipanggil ke monitor TV (${Math.min(count, 3)}/3)`);
    } else if (targetStatus === "UNLOADING") {
      showToast("Status berubah menjadi UNLOADING");
    } else {
      showToast("Finish unload berhasil. Status menjadi WAITING GR");
    }
  } catch (err) {
    console.error(err);
    try {
      const outputResponse = await fetchOutputFormData();
      v2RawResponse = {
        ...(v2RawResponse || {}),
        timestamp: outputResponse?.timestamp || new Date().toISOString(),
        outputForm: getOutputFormRows(outputResponse),
        inboundMp: getInboundMpRowsV15(
          outputResponse,
          v2RawResponse?.inboundMp || v2RawResponse?.inbound_mp || [],
        ),
      };
      state.dashboard = buildDashboardFromV2(v2RawResponse);
      if (state.page === "checker") renderPage("checker", false);
    } catch (refreshErr) {
      console.error("Rollback refresh checker gagal", refreshErr);
    }
    showToast("Checker backend gagal: " + err.message);
  } finally {
    form.dataset.saving = "0";
  }

  if (typeof setCheckerSubmitButtonState === "function") {
    setCheckerSubmitButtonState("done", "Data Sudah Diubah");
  }
  // V18.2: tidak menunggu render setelah response. Autosync hanya verifikasi server.
  setTimeout(() => window.forceGlobalAutoSyncV11?.(), 3500);
}

async function refreshCallMonitorData(renderAfter = false) {
  if (!hasApiV2() || !v2RawResponse) return;

  try {
    const outputResponse = await fetchOutputFormData();
    v2RawResponse = {
      ...v2RawResponse,
      timestamp: outputResponse?.timestamp || new Date().toISOString(),
      outputForm: getOutputFormRows(outputResponse),
      inboundMp: getInboundMpRowsV15(
        outputResponse,
        v2RawResponse?.inboundMp || v2RawResponse?.inbound_mp || [],
      ),
    };
    state.dashboard = buildDashboardFromV2(v2RawResponse);
    state.options = state.dashboard.options || state.options;
    state.lastCalled =
      typeof getLatestCallTicket === "function"
        ? getLatestCallTicket(state.dashboard.queue)
        : state.dashboard.queue[0] || state.lastCalled;

    if (renderAfter && state.page === "panggil") {
      renderPage("panggil", false);
    }
  } catch (err) {
    console.error("refreshCallMonitorData error", err);
  }
}

function callNext(btn) {
  if (btn) btn.classList.add("calling-effect");
  const gate = document.getElementById("call-gate")?.value || "Dock 01";
  const activeGateSet =
    typeof getActiveGateSet === "function" ? getActiveGateSet([]) : new Set();
  if (activeGateSet.has(gate)) {
    showToast(gate + " sedang aktif. Pilih gate lain.");
    if (btn) btn.classList.remove("calling-effect");
    return;
  }
  const local = getLocalTickets();
  const next = local.find((q) =>
    String(q.status || "")
      .toUpperCase()
      .includes("WAITING"),
  );

  if (next) {
    next.status = "CALLED";
    next.gate = gate;
    next.called_at = formatDateTimeLocal(new Date());
    saveLocalTickets(local);
    state.lastCalled = next;
    if (v2RawResponse) state.dashboard = buildDashboardFromV2(v2RawResponse);
    showToast("Memanggil " + next.queue_no + " ke " + gate);
  } else {
    const first = (state.dashboard?.queue || []).find(
      (q) => !String(q.status || "").includes("COMPLETED"),
    );
    state.lastCalled = first || state.lastCalled;
    showToast("Mode read-only: tampilkan data pertama dari Data V2");
  }

  setTimeout(() => {
    if (btn) btn.classList.remove("calling-effect");
    renderPage(state.page || "panggil", false);
  }, 450);
}

function recall() {
  if (typeof recallVoice === "function") {
    recallVoice();
    return;
  }
  showToast("Panggil ulang " + (state.lastCalled?.queue_no || "-"));
}

function buildBackendActionBodyFromRow(row = {}) {
  return {
    ticket_id: row.ticket_id || "",
    queue_no: row.original_queue_no || row.queue_no || "",
    plat_number: row.plat_number || "",
    po_number: row.po_number || "",
    vendor_name: row.vendor_name || "",
    fleet_type: row.fleet_type || "",
    driver_name: row.driver_name || "",
    phone_number: row.phone_number || "",
    gate: row.gate || "",
    status: row.status || "",
  };
}

function applyBackendActionResult(result = {}) {
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  if (rows.length) {
    replaceOutputRowsInRawResponse(rows);
    if (v2RawResponse) state.dashboard = buildDashboardFromV2(v2RawResponse);
    return rows;
  }
  return [];
}

async function sendDriverWhatsAppFromKey(encodedKey = "", btn = null) {
  let row =
    typeof findCheckerRowByKey === "function"
      ? findCheckerRowByKey(encodedKey)
      : null;
  if (!row) {
    showToast("Data ticket tidak ditemukan. Refresh dulu.");
    return;
  }
  row = await refreshOutputFormForFreshRow(row);
  const callCount = getDriverCallCountApi(row);
  if (callCount >= 3) {
    if (typeof showDriverNoShowSuggestionFromKey === "function")
      showDriverNoShowSuggestionFromKey(checkerRowKey(row), btn);
    else showToast("Limit panggilan 3x sudah tercapai.");
    return;
  }
  const phone = normalizePhoneInputValue(row.phone_number || "");
  if (!phone) {
    showToast("Nomor WhatsApp driver kosong / format tidak valid.");
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.classList.add("opacity-60", "cursor-wait");
  }
  try {
    const result = await sendDriverWhatsAppToBackend({
      ...buildBackendActionBodyFromRow(row),
      phone_number: phone,
    });
    const fresh = getFreshRowAfterAction(result, row);
    const newCount =
      Number(result?.call_count || fresh.call_count || callCount + 1) || 0;
    showToast(
      "WhatsApp terkirim ke driver" +
        (newCount ? ` (${Math.min(newCount, 3)}/3)` : ""),
    );
    if (["checker", "laporan", "monitor"].includes(state.page))
      renderPage(state.page, false);
    if (
      newCount >= 3 &&
      typeof showDriverNoShowSuggestionFromKey === "function"
    )
      setTimeout(
        () => showDriverNoShowSuggestionFromKey(checkerRowKey(fresh || row)),
        250,
      );
  } catch (err) {
    console.error(err);
    showToast("WA gagal: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("opacity-60", "cursor-wait");
    }
  }
}

async function markDriverCallFailedFromKey(encodedKey = "", btn = null) {
  const row =
    typeof findCheckerRowByKey === "function"
      ? findCheckerRowByKey(encodedKey)
      : null;
  if (!row) {
    showToast("Data ticket tidak ditemukan. Refresh dulu.");
    return;
  }

  const callCount = Number(row.call_count || row.wa_call_count || 0) || 0;
  if (callCount < 3) {
    showToast("Gagal panggil baru bisa dipakai setelah driver dipanggil 3x.");
    return;
  }

  const ok = confirm(
    `Expire antrian ${row.queue_no || "-"}? Driver wajib registrasi ulang kalau datang lagi.`,
  );
  if (!ok) return;

  if (btn) {
    btn.disabled = true;
    btn.classList.add("opacity-60", "cursor-wait");
  }

  try {
    const result = await failCallToBackend({
      ...buildBackendActionBodyFromRow(row),
      reason: "Driver tidak hadir setelah dipanggil 3x",
    });
    applyBackendActionResult(result);
    showToast("Antrian di-expire. Driver wajib registrasi ulang.");
    if (["checker", "laporan", "monitor", "panggil"].includes(state.page)) {
      renderPage(state.page, false);
    }
  } catch (err) {
    console.error(err);
    showToast("Gagal expire antrian: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("opacity-60", "cursor-wait");
    }
  }
}

async function loadDebug() {
  const out = document.getElementById("debug-output");
  if (out) out.textContent = "Loading debug V2...";
  try {
    if (!v2RawResponse) v2RawResponse = await fetchV2Data();
    const freshness = await motherDuckApiGet("superset_freshness");
    state.debug = {
      api_url: API_URL_V2,
      timestamp: v2RawResponse.timestamp,
      kpiRaw_rows: getKpiRawRows(v2RawResponse).length || 0,
      table_rows_old: Array.isArray(v2RawResponse.table)
        ? v2RawResponse.table.length
        : 0,
      tablev2_rows: getTableV2Rows(v2RawResponse).length || 0,
      output_form_rows: getOutputFormRows(v2RawResponse).length || 0,
      tablev2_sample: getTableV2Rows(v2RawResponse).slice(0, 3),
      output_form_sample: getOutputFormRows(v2RawResponse).slice(0, 5),
      table_old_sample: (Array.isArray(v2RawResponse.table)
        ? v2RawResponse.table
        : []
      ).slice(0, 3),
      kpi_sample: getKpiRawRows(v2RawResponse).slice(0, 3),
      po_index_sample: Object.values(v2PoIndex || {}).slice(0, 5),
      local_tickets: getLocalTickets(),
      superset_freshness: freshness,
    };
    renderSupersetFreshness(freshness);
    if (out) out.textContent = JSON.stringify(state.debug, null, 2);
    showToast("Debug V2 selesai");
  } catch (err) {
    if (out) out.textContent = err.stack || err.message;
    showToast("Debug gagal");
  }
}

function formatDebugTimestamp(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "medium",
  }).format(date) + " WIB";
}

function renderSupersetFreshness(freshness = null) {
  const target = document.getElementById("superset-freshness-output");
  if (!target) return;
  if (!freshness) {
    target.innerHTML = '<p class="text-sm text-on-surface-variant">Klik cek freshness untuk membaca data live MotherDuck.</p>';
    return;
  }
  const todayCount = Number(freshness.received_today_count || 0);
  const samples = Array.isArray(freshness.received_today_samples)
    ? freshness.received_today_samples : [];
  target.innerHTML = `
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
      <div class="rounded-lg border border-outline-variant bg-surface-container-low p-3"><p class="text-xs uppercase font-bold text-on-surface-variant">Master PO</p><p class="text-2xl font-black">${Number(freshness.total_master_po || 0).toLocaleString("id-ID")}</p></div>
      <div class="rounded-lg border border-primary/30 bg-primary-container/10 p-3"><p class="text-xs uppercase font-bold text-on-surface-variant">Received ${esc(freshness.received_date_wib || "hari ini")}</p><p class="text-2xl font-black text-primary">${todayCount.toLocaleString("id-ID")}</p></div>
      <div class="rounded-lg border border-outline-variant bg-surface-container-low p-3"><p class="text-xs uppercase font-bold text-on-surface-variant">Sync terakhir</p><p class="text-sm font-bold leading-5">${esc(formatDebugTimestamp(freshness.last_synced_at))}</p></div>
    </div>
    <p class="text-xs text-on-surface-variant mb-2">Sample PO dengan received time tanggal ${esc(freshness.received_date_wib || "hari ini")}</p>
    <div class="overflow-x-auto"><table class="w-full text-xs"><thead><tr class="text-left text-on-surface-variant border-b border-outline-variant"><th class="py-2 pr-3">PO</th><th class="py-2 pr-3">Vendor</th><th class="py-2">Received time</th></tr></thead><tbody>${samples.length ? samples.map((row) => `<tr class="border-b border-outline-variant/50"><td class="py-2 pr-3 font-bold">${esc(row.po_number || "-")}</td><td class="py-2 pr-3">${esc(row.vendor_name || "-")}</td><td class="py-2">${esc(row.fulfillment_arrived_start_at || "-")}</td></tr>`).join("") : '<tr><td colspan="3" class="py-3 text-on-surface-variant">Belum ada received time yang cocok untuk tanggal ini.</td></tr>'}</tbody></table></div>`;
}

async function loadSupersetFreshness() {
  const target = document.getElementById("superset-freshness-output");
  if (target) target.innerHTML = '<p class="text-sm text-on-surface-variant">Membaca freshness MotherDuck...</p>';
  try {
    const freshness = await motherDuckApiGet("superset_freshness");
    state.debug = { ...(state.debug || {}), superset_freshness: freshness };
    renderSupersetFreshness(freshness);
    showToast("Freshness Superset diperbarui", "success");
  } catch (error) {
    if (target) target.innerHTML = `<p class="text-sm text-error">Gagal membaca freshness: ${esc(error.message || "Unknown error")}</p>`;
    showToast("Freshness Superset gagal dibaca", "error");
  }
}

function openApi(action) {
  if (!hasApiV2()) {
    showToast("API_URL_V2 belum diset");
    return;
  }

  if (action === "reload") {
    initApi();
    return;
  }

  if (action === "debug") {
    switchPage("debug");
    setTimeout(loadDebug, 100);
    return;
  }

  const safeAction = action === "raw" ? "inboundRaw" : action;
  window.open(apiUrlV2(safeAction), "_blank");
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-page]");
  if (!btn) return;
  e.preventDefault();
  updateActiveNav(btn.dataset.page);
  switchPage(btn.dataset.page);
});

window.addEventListener("hashchange", () =>
  renderPage((location.hash || "#daftar").replace("#", ""), false),
);

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  if (typeof initSidebarVisibility === "function") initSidebarVisibility();
  if (typeof initTvModeListeners === "function") initTvModeListeners();
  setInterval(tickClock, 1000);
  tickClock();
  initShader();
  renderPage((location.hash || "#daftar").replace("#", ""), false);

  // Tanpa sesi, initApi() hanya menghasilkan dua request 401 dan menampilkan
  // "API error" di layar login. Data baru diambil setelah login berhasil.
  if (typeof isLoggedIn === "function" && isLoggedIn()) initApi();

  setInterval(() => {
    if (!["monitor", "laporan", "antrian", "checker"].includes(state.page)) return;
    // Melalui jalur auto sync, bukan renderPage() langsung: jalur ini
    // mempertahankan scroll, filter, dan detail PO yang sedang terbuka.
    if (typeof window.forceGlobalAutoSyncV11 === "function") {
      window.forceGlobalAutoSyncV11();
      return;
    }
    renderPage(state.page, false);
  }, 60000);
});

/* =========================================================
 * CALL LIMIT 3X - BACKEND ACTION OVERRIDES
 * ========================================================= */
function getDriverCallCountApi(row = {}) {
  return Number(row.call_count || row.wa_call_count || 0) || 0;
}

function getFreshRowAfterAction(result = {}, fallback = {}) {
  const rows = applyBackendActionResult(result);
  return rows[0] || fallback || {};
}
async function refreshOutputFormForFreshRow(fallback = {}) {
  if (typeof fetchOutputFormData !== "function") return fallback || {};
  try {
    const outputResponse = await fetchOutputFormData();
    v2RawResponse = {
      ...(v2RawResponse || {}),
      status: "success",
      timestamp: outputResponse?.timestamp || new Date().toISOString(),
      outputForm: getOutputFormRows(outputResponse),
      inboundMp: getInboundMpRowsV15(
        outputResponse,
        v2RawResponse?.inboundMp || v2RawResponse?.inbound_mp || [],
      ),
    };
    state.dashboard = buildDashboardFromV2(v2RawResponse);
    const key = checkerRowKey(fallback || {});
    const fresh =
      key && typeof findCheckerRowByKey === "function"
        ? findCheckerRowByKey(key)
        : null;
    return fresh || fallback || {};
  } catch (err) {
    console.warn("refreshOutputFormForFreshRow failed", err);
    return fallback || {};
  }
}

async function recallDriverFromKey(encodedKey = "", btn = null) {
  const row =
    typeof findCheckerRowByKey === "function"
      ? findCheckerRowByKey(encodedKey)
      : null;
  if (!row) {
    showToast("Data ticket tidak ditemukan. Refresh dulu.");
    return;
  }

  const callCount = getDriverCallCountApi(row);
  if (callCount >= 3) {
    if (typeof showDriverNoShowSuggestionFromKey === "function") {
      showDriverNoShowSuggestionFromKey(encodedKey, btn);
    } else {
      showToast(
        "Driver sudah dipanggil 3x. Driver wajib buat nomor antrian baru jika tidak datang.",
      );
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.classList.add("opacity-60", "cursor-wait");
  }

  try {
    const body = {
      ...buildBackendActionBodyFromRow(row),
      status: "CALLED",
      unload_sla: "ON PROCESS",
      gate: row.gate || "",
      called_at: row.called_at || formatDateTimeLocal(new Date()),
      updated_at: formatDateTimeLocal(new Date()),
    };

    const result = await updateCheckerToBackend(body);
    const fresh = getFreshRowAfterAction(result, row);
    const newCount =
      Number(result?.call_count || fresh.call_count || callCount + 1) || 0;
    showToast(`Driver dipanggil ulang (${Math.min(newCount, 3)}/3)`);

    if (["checker", "laporan", "monitor", "panggil"].includes(state.page)) {
      renderPage(state.page, false);
    }

    if (
      newCount >= 3 &&
      typeof showDriverNoShowSuggestionFromKey === "function"
    ) {
      setTimeout(
        () => showDriverNoShowSuggestionFromKey(checkerRowKey(fresh || row)),
        250,
      );
    }
  } catch (err) {
    console.error(err);
    showToast("Panggil ulang gagal: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("opacity-60", "cursor-wait");
    }
  }
}

async function sendDriverWhatsAppFromKey(encodedKey = "", btn = null) {
  let row =
    typeof findCheckerRowByKey === "function"
      ? findCheckerRowByKey(encodedKey)
      : null;
  if (!row) {
    showToast("Data ticket tidak ditemukan. Refresh dulu.");
    return;
  }
  row = await refreshOutputFormForFreshRow(row);
  const callCount = getDriverCallCountApi(row);
  if (callCount >= 3) {
    if (typeof showDriverNoShowSuggestionFromKey === "function")
      showDriverNoShowSuggestionFromKey(checkerRowKey(row), btn);
    else showToast("Limit panggilan 3x sudah tercapai.");
    return;
  }
  const phone = normalizePhoneInputValue(row.phone_number || "");
  if (!phone) {
    showToast("Nomor WhatsApp driver kosong / format tidak valid.");
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.classList.add("opacity-60", "cursor-wait");
  }
  try {
    const result = await sendDriverWhatsAppToBackend({
      ...buildBackendActionBodyFromRow(row),
      phone_number: phone,
    });
    const fresh = getFreshRowAfterAction(result, row);
    const newCount =
      Number(result?.call_count || fresh.call_count || callCount + 1) || 0;
    showToast(
      "WhatsApp terkirim ke driver" +
        (newCount ? ` (${Math.min(newCount, 3)}/3)` : ""),
    );
    if (["checker", "laporan", "monitor"].includes(state.page))
      renderPage(state.page, false);
    if (
      newCount >= 3 &&
      typeof showDriverNoShowSuggestionFromKey === "function"
    )
      setTimeout(
        () => showDriverNoShowSuggestionFromKey(checkerRowKey(fresh || row)),
        250,
      );
  } catch (err) {
    console.error(err);
    showToast("WA gagal: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("opacity-60", "cursor-wait");
    }
  }
}

async function markDriverCallFailedFromKey(encodedKey = "", btn = null) {
  const row =
    typeof findCheckerRowByKey === "function"
      ? findCheckerRowByKey(encodedKey)
      : null;
  if (!row) {
    showToast("Data ticket tidak ditemukan. Refresh dulu.");
    return;
  }

  const callCount = getDriverCallCountApi(row);
  if (callCount < 3) {
    showToast("Gagal panggil baru bisa dipakai setelah driver dipanggil 3x.");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.classList.add("opacity-60", "cursor-wait");
  }

  try {
    const result = await failCallToBackend({
      ...buildBackendActionBodyFromRow(row),
      reason:
        "Driver tidak hadir setelah dipanggil 3x. Driver wajib buat nomor antrian baru.",
    });
    applyBackendActionResult(result);
    showToast("Antrian EXPIRED. Driver wajib buat nomor antrian baru.");
    if (["checker", "laporan", "monitor", "panggil"].includes(state.page)) {
      renderPage(state.page, false);
    }
  } catch (err) {
    console.error(err);
    showToast("Gagal expire antrian: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("opacity-60", "cursor-wait");
    }
  }
}

/* ==========================================================================
 * PATCH: Submit Security per Kendaraan
 * 1 kendaraan = 1 row Output form. Fleet Type, plat, driver, dan WA diambil dari
 * card Data Kendaraan, bukan field global.
 * ========================================================================== */

async function submitSecurity(e) {
  e?.preventDefault?.();

  // Security tidak boleh tersimpan dari Enter, scanner suffix Enter,
  // implicit browser submit, atau event form lain.
  // Hanya explicitSecuritySubmit() dari tombol Buat Nomor yang diizinkan.
  if (!e || e.explicitSecuritySubmit !== true) {
    console.warn("Blocked implicit Security submit");
    return;
  }

  if (securitySubmitBusy) {
    showToast("Submit sedang diproses, tunggu sebentar.");
    return;
  }

  const form = e.target;
  if (typeof syncVehicleMultiInput === "function") syncVehicleMultiInput();
  else if (typeof syncPlateMultiInput === "function") syncPlateMultiInput();

  if (!validateSecurityForm(form)) return;

  const lookup = lookupPo(true);
  if (!lookup || !lookup.all_found) {
    const mismatchText = lookup?.vendor_mismatch?.length
      ? " PO beda vendor: " +
        lookup.vendor_mismatch.map((x) => x.po_number || x.po_input).join(", ")
      : "";
    const missingText = lookup?.missing_po?.length
      ? " Missing: " + lookup.missing_po.join(", ")
      : "";
    showToast(
      "Semua PO wajib valid dan sesuai Vendor Name." +
        mismatchText +
        missingText,
    );
    return;
  }

  securitySubmitBusy = true;
  const submitBtn = document.getElementById("security-submit-btn");
  const submitText = document.getElementById("security-submit-text");
  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.textContent = "Menyimpan...";

  try {
    const base = Object.fromEntries(new FormData(form).entries());
    const poItems = lookup.items || [];

    if (!poItems.length) {
      showToast("PO belum valid.");
      return;
    }

    const registeredSet = getRegisteredPoSetApi();
    const duplicatedPo = poItems
      .map((item) => item.po_number || item.po_input)
      .filter((po) => registeredSet.has(normalizeKey(po)));

    if (duplicatedPo.length) {
      showToast(
        "PO sudah daftar dan tidak bisa didaftarkan lagi: " +
          duplicatedPo.join(", "),
      );
      return;
    }

    const vehicleList =
      typeof getSecurityVehicleRows === "function"
        ? getSecurityVehicleRows()
        : parseMultiPlateValues(base.plat_number).map((plate, index) => ({
            index,
            fleet_type: base.fleet_type,
            plat_number: plate,
            driver_name: pickMultiValue(
              parseMultiInputValues(base.driver_name),
              index,
            ),
            phone_number: pickMultiValue(
              parseAndNormalizePhones(base.phone_number),
              index,
            ),
            ktp_6_digit: base.ktp_6_digit || "",
          }));

    if (!vehicleList.length) {
      showToast("Data kendaraan wajib diisi.");
      return;
    }

    const duplicatePlates = vehicleList
      .map((v) => normalizePlateValue(v.plat_number))
      .filter((plate, idx, arr) => plate && arr.indexOf(plate) !== idx);
    if (duplicatePlates.length) {
      showToast(
        "Plat duplicate tidak boleh: " +
          [...new Set(duplicatePlates)].join(", "),
      );
      return;
    }

    for (const vehicle of vehicleList) {
      if (
        !vehicle.fleet_type ||
        !vehicle.plat_number ||
        !vehicle.driver_name ||
        !vehicle.phone_number
      ) {
        showToast(
          "Setiap kendaraan wajib isi Fleet Type, Plat, Driver, dan WhatsApp.",
        );
        return;
      }
      if (!isValidPlate(vehicle.plat_number)) {
        showToast("Plat belum valid: " + vehicle.plat_number);
        return;
      }
      if (vehicle.ktp_6_digit && !/^\d{6}$/.test(String(vehicle.ktp_6_digit))) {
        showToast("KTP driver opsional, tapi kalau diisi harus 6 digit angka.");
        return;
      }
    }

    const rows = getLocalTickets();
    const newRows = [];
    const registerTime = base.register_time || formatDateTimeLocal(new Date());
    let queuePool = (state.dashboard?.queue || []).concat(rows);
    const poGroups = splitPoItemsByPlate(poItems, vehicleList.length);

    vehicleList.forEach((vehicle, index) => {
      const groupItems = poGroups[index] || poItems;
      const grouped = sumPoItems(groupItems);
      const rowSlot =
        String(base.ticket_type || "").toUpperCase() === "DROP-OFF"
          ? base.slot || grouped.slot || "3"
          : base.slot || grouped.slot || "3";

      const row = {
        ...base,
        ticket_id:
          "IBT-" +
          Date.now().toString(36).toUpperCase() +
          "-" +
          String(newRows.length + 1).padStart(2, "0"),
        po_number: grouped.po_number,
        po_numbers: grouped.po_numbers,
        vendor_name: base.vendor_name || grouped.vendor_name || "",
        slot: rowSlot,
        fleet_type: vehicle.fleet_type,
        plat_number: normalizePlateValue(vehicle.plat_number),
        driver_name: vehicle.driver_name,
        phone_number: vehicle.phone_number,
        ktp_6_digit: vehicle.ktp_6_digit || "",
        status: "WAITING",
        total_po_qty: grouped.total_po_qty,
        count_po_sku: grouped.count_po_sku,
        created_at: registerTime,
        register_time: registerTime,
        queue_no: nextLocalQueueNoFromList(
          base.ticket_type,
          rowSlot,
          queuePool.concat(newRows),
        ),
        gate: "-",
        unload_sla: "",
        source: "SECURITY_INPUT",
      };

      newRows.push(row);
    });

    const printWindow =
      typeof openSecurityPrintWindow === "function"
        ? openSecurityPrintWindow("Menyimpan ticket dan menyiapkan print...")
        : null;

    rows.unshift(...newRows);
    saveLocalTickets(rows);

    try {
      showToast("Menyimpan ticket ke Output form...");
      const result = await submitSecurityRowsToBackend(newRows);
      const waFeedbackV171 = getTicketWaFeedbackV171(result);
      window.__lastTicketWaResultsV171 = waFeedbackV171.items;
      console.log("WA ticket result V17.1:", waFeedbackV171.items);
      const savedRows =
        Array.isArray(result?.rows) && result.rows.length
          ? result.rows
          : newRows;

      state.lastSecurityRows = savedRows;
      try {
        localStorage.setItem(
          "inbound_frozen_last_print_rows",
          JSON.stringify(savedRows),
        );
      } catch (err) {}

      if (typeof printSecurityTickets === "function") {
        printSecurityTickets(savedRows, printWindow);
      }

      upsertOutputRowsToRawResponse(savedRows);
      state.dashboard = buildDashboardFromV2(v2RawResponse);
      state.options = state.dashboard.options || state.options;

      showToast(buildTicketCreatedToastV171(result, newRows.length));
    } catch (err) {
      console.error(err);

      if (v2RawResponse) {
        upsertOutputRowsToRawResponse(newRows);
        state.dashboard = buildDashboardFromV2(v2RawResponse);
        state.options = state.dashboard.options || state.options;
      } else {
        state.dashboard.queue.unshift(...newRows);
        state.dashboard.report_preview.unshift(...newRows);
      }

      if (typeof showSecurityPrintError === "function") {
        showSecurityPrintError(
          printWindow,
          "Backend gagal menyimpan ticket: " + err.message,
        );
      }
      showToast("Backend gagal, ticket tersimpan lokal: " + err.message);
    }

    state.lastCalled =
      (state.lastSecurityRows && state.lastSecurityRows[0]) || newRows[0];
    if (!state.lastSecurityRows || !state.lastSecurityRows.length) {
      state.lastSecurityRows = newRows;
      try {
        localStorage.setItem(
          "inbound_frozen_last_print_rows",
          JSON.stringify(newRows),
        );
      } catch (err) {}
    }

    const queueEl = document.getElementById("new-queue-number");
    if (queueEl)
      queueEl.textContent = state.lastCalled?.queue_no || newRows[0].queue_no;
    renderPage("checker", false);
  } finally {
    securitySubmitBusy = false;
    const activeBtn = document.getElementById("security-submit-btn");
    const activeText = document.getElementById("security-submit-text");
    if (activeBtn) activeBtn.disabled = false;
    if (activeText) activeText.textContent = "Buat Nomor";
  }
}

/* ==========================================================================
 * OPERATIONAL DAY + HISTORY ANALYTICS + MANUAL SOURCE PATCH
 * Operational Date berganti setiap jam 04:00 WIB.
 * Contoh:
 * 13 Jul 04:00 s/d 14 Jul 03:59 = Operational Date 13 Jul.
 * ========================================================================== */
(function inboundOperationalDatePatch() {
  window.getOperationalDateKey = function getOperationalDateKey(
    value = new Date(),
  ) {
    let d;
    if (value instanceof Date) d = new Date(value);
    else d = parseInboundDateSafe(value);
    if (!d || isNaN(d.getTime())) d = new Date();
    if (d.getHours() < 4) d.setDate(d.getDate() - 1);
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("-");
  };

  window.getRowOperationalDateKey = function getRowOperationalDateKey(
    row = {},
  ) {
    const direct = String(
      row.operational_date || row.raw?.operational_date || "",
    ).trim();
    if (direct) {
      const m = direct.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
      const dmy = direct.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
      if (dmy)
        return `${dmy[3]}-${String(dmy[2]).padStart(2, "0")}-${String(dmy[1]).padStart(2, "0")}`;
    }
    return getOperationalDateKey(
      row.register_time || row.created_at || row.Timestamp || new Date(),
    );
  };

  const originalSubmitRows =
    typeof submitSecurityRowsToBackend === "function"
      ? submitSecurityRowsToBackend
      : null;

  if (originalSubmitRows) {
    window.submitSecurityRowsToBackend = function patchedSubmitSecurityRows(
      rows = [],
    ) {
      const manual =
        typeof getManualSecurityEntry === "function"
          ? getManualSecurityEntry()
          : null;
      const next = (rows || []).map((row) => ({
        ...row,
        operational_date:
          row.operational_date ||
          getOperationalDateKey(
            row.register_time || row.created_at || new Date(),
          ),
        data_source: row.data_source || (manual?.valid ? "MANUAL" : "BACKEND"),
      }));
      return originalSubmitRows(next);
    };
  }

  const originalBuildDashboard =
    typeof buildDashboardFromV2 === "function" ? buildDashboardFromV2 : null;

  if (originalBuildDashboard) {
    window.buildDashboardFromV2 = function patchedBuildDashboard(response) {
      const allOutputRows = getOutputFormRows(response);
      const currentOp = getOperationalDateKey(new Date());

      // Operasional: tampilkan data current operational date.
      // Carry-over aktif dari hari sebelumnya tetap terlihat sampai selesai,
      // tetapi completed/expired lama tidak ikut memenuhi monitoring.
      const operationalRows = allOutputRows.filter((row) => {
        const op = getRowOperationalDateKey(row);
        const st = String(row.status || "WAITING").toUpperCase();
        const active = !st.includes("COMPLETED") && !st.includes("EXPIRED");
        return op === currentOp || active;
      });

      const cloned = {
        ...(response || {}),
        outputForm: operationalRows,
        output_form: operationalRows,
        data: response?.data
          ? {
              ...response.data,
              outputForm: operationalRows,
              output_form: operationalRows,
            }
          : response?.data,
      };

      const dashboard = originalBuildDashboard(cloned);

      // History tetap disimpan untuk Dashboard SPV, search global, dan detail popup.
      const allQueue = buildQueueFromOutputForm(allOutputRows).map((row) => ({
        ...row,
        operational_date: getRowOperationalDateKey(row),
        data_source:
          row.data_source ||
          row.raw?.data_source ||
          (String(row.source || "")
            .toUpperCase()
            .includes("MANUAL")
            ? "MANUAL"
            : "BACKEND"),
      }));

      dashboard.history_queue = allQueue;
      dashboard.all_queue = allQueue;
      dashboard.operational_date = currentOp;
      dashboard.raw = {
        ...(dashboard.raw || {}),
        outputFormAll: allOutputRows,
        outputFormOperational: operationalRows,
      };

      dashboard.queue = (dashboard.queue || []).map((row) => ({
        ...row,
        operational_date: getRowOperationalDateKey(row),
        data_source:
          row.data_source ||
          row.raw?.data_source ||
          (String(row.source || "")
            .toUpperCase()
            .includes("MANUAL")
            ? "MANUAL"
            : "BACKEND"),
      }));
      dashboard.report_preview = dashboard.queue;

      return dashboard;
    };
  }

  // Duplicate PO hanya berlaku dalam operational date yang sama.
  window.getRegisteredPoSetApi = function getRegisteredPoSetApiOperational() {
    const set = new Set();
    const currentOp = getOperationalDateKey(new Date());
    const rows =
      state.dashboard?.history_queue ||
      state.dashboard?.all_queue ||
      state.dashboard?.queue ||
      [];

    rows.forEach((row) => {
      const st = String(row.status || "").toUpperCase();
      if (st.includes("EXPIRED")) return;
      if (getRowOperationalDateKey(row) !== currentOp) return;

      const rawValues = [];
      if (Array.isArray(row.po_numbers)) rawValues.push(...row.po_numbers);
      if (row.po_number) rawValues.push(row.po_number);
      if (row.raw?.po_number) rawValues.push(row.raw.po_number);

      rawValues.forEach((value) => {
        parsePoNumbers(value).forEach((po) => {
          const key = normalizeKey(po);
          if (key) set.add(key);
        });
      });
    });

    return set;
  };
})();

/* ==========================================================================
 * MOBILE CHECKER CONFIRMATION PATCH
 * Konfirmasi hanya muncul pada perangkat touch untuk aksi:
 * - Panggil ke Gate
 * - Mulai Unloading
 * - Selesai Unloading
 * ========================================================================== */
(function installMobileCheckerConfirmationPatch() {
  if (window.__inboundMobileCheckerConfirmationInstalled) return;
  window.__inboundMobileCheckerConfirmationInstalled = true;

  const originalSubmitChecker =
    typeof window.submitChecker === "function"
      ? window.submitChecker
      : typeof submitChecker === "function"
        ? submitChecker
        : null;

  if (!originalSubmitChecker) return;

  function isMobileTouchDevice() {
    return (
      (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
      Number(navigator.maxTouchPoints || 0) > 0
    );
  }

  function checkerActionMessage(form) {
    const status = String(form?.status?.value || "CALLED").toUpperCase();
    const queue = String(form?.queue_no?.value || "-").trim() || "-";
    const plate = String(form?.plat_number?.value || "-").trim() || "-";
    const gate =
      String(
        document.getElementById("checker-gate-value")?.value ||
          form?.gate?.value ||
          "-",
      ).trim() || "-";

    if (status.includes("WAITING GR")) {
      return [
        "Selesaikan unloading?",
        "",
        "Queue: " + queue,
        "Plat: " + plate,
        "Gate: " + gate,
        "",
        "Status akan menjadi WAITING GR dan gate akan dilepas.",
      ].join("\n");
    }

    if (status.includes("UNLOADING")) {
      return [
        "Mulai unloading?",
        "",
        "Queue: " + queue,
        "Plat: " + plate,
        "Gate: " + gate,
        "",
        "Timer bongkar dan estimasi selesai akan mulai berjalan.",
      ].join("\n");
    }

    return [
      "Panggil driver ke gate?",
      "",
      "Queue: " + queue,
      "Plat: " + plate,
      "Gate: " + gate,
      "",
      "Status akan menjadi CALLED.",
    ].join("\n");
  }

  window.submitChecker = async function mobileSafeSubmitChecker(event) {
    const form = event?.target;

    if (
      isMobileTouchDevice() &&
      form?.id === "checker-form" &&
      form.dataset.mobileConfirmed !== "1"
    ) {
      event?.preventDefault?.();

      const requiredFieldsFilled =
        String(form.queue_no?.value || "").trim() &&
        String(form.plat_number?.value || "").trim();

      if (requiredFieldsFilled) {
        const approved = window.confirm(checkerActionMessage(form));
        if (!approved) return;
      }

      form.dataset.mobileConfirmed = "1";
    }

    try {
      return await originalSubmitChecker.call(this, event);
    } finally {
      if (form) delete form.dataset.mobileConfirmed;
    }
  };
})();

/* ==========================================================================
 * STATUS FLOW V3 + CALL COOLDOWN + ROLE ACTIONS
 * WAITING -> CALLED -> UNLOADING -> WAITING GR -> DONE GR -> COMPLETED
 * Panggilan real maksimal 3x. Step ke-4 adalah EXPIRED.
 * ========================================================================== */
(function installInboundStatusFlowV3Api() {
  if (window.__inboundStatusFlowV3ApiInstalled) return;
  window.__inboundStatusFlowV3ApiInstalled = true;

  window.getCallCooldownRemainingSeconds =
    function getCallCooldownRemainingSeconds(row = {}) {
      const last = parseInboundDateSafe(
        row.last_call_attempt_at || row.raw?.last_call_attempt_at || "",
      );
      if (!last) return 0;
      return Math.max(0, 60 - Math.floor((Date.now() - last.getTime()) / 1000));
    };

  window.advanceGrStatusFromKey = async function advanceGrStatusFromKey(
    encodedKey = "",
    targetStatus = "",
    btn = null,
  ) {
    const row =
      typeof findCheckerRowByKey === "function"
        ? findCheckerRowByKey(encodedKey)
        : null;
    if (!row) {
      showToast("Ticket tidak ditemukan. Refresh dulu.");
      return;
    }

    const role = String(getAuthUser?.()?.role || "").toUpperCase();
    const target = String(targetStatus || "")
      .trim()
      .toUpperCase();
    const allowed =
      (target === "DONE GR" && ["ADMIN", "SPV"].includes(role)) ||
      (target === "COMPLETED" && ["SECURITY", "SPV"].includes(role));

    if (!allowed) {
      showToast("Role ini tidak punya akses untuk update status tersebut.");
      return;
    }

    const label = target === "DONE GR" ? "Done GR" : "Handover GRN";
    const ok = confirm(
      `${label} untuk ${row.queue_no || "-"}?\n\nPlat: ${row.plat_number || "-"}\nStatus akan menjadi ${target}.`,
    );
    if (!ok) return;

    if (btn) {
      btn.disabled = true;
      btn.classList.add("opacity-60", "cursor-wait");
    }

    try {
      const nowText = formatDateTimeLocal(new Date());
      const body = {
        ...buildBackendActionBodyFromRow(row),
        status: target,
        actor_role: role,
        updated_at: nowText,
        done_gr_at: target === "DONE GR" ? nowText : row.done_gr_at || "",
        handover_grn_at:
          target === "COMPLETED" ? nowText : row.handover_grn_at || "",
        completed_at: target === "COMPLETED" ? nowText : row.completed_at || "",
      };
      const result = await updateCheckerToBackend(body);
      applyBackendActionResult(result);

      if (target === "COMPLETED") {
        showToast("Handover GRN berhasil. Status COMPLETED.");
      } else {
        showToast(`${label} berhasil. Status ${target}.`);
      }

      renderPage("laporan", false);
    } catch (err) {
      console.error(err);
      showToast(`${label} gagal: ${err.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove("opacity-60", "cursor-wait");
      }
    }
  };

  window.recallDriverFromKey = async function recallDriverFromKeyV3(
    encodedKey = "",
    btn = null,
  ) {
    let row =
      typeof findCheckerRowByKey === "function"
        ? findCheckerRowByKey(encodedKey)
        : null;
    if (!row) {
      showToast("Data ticket tidak ditemukan. Refresh dulu.");
      return;
    }
    row = await refreshOutputFormForFreshRow(row);
    const callCount = Number(row.call_count || 0) || 0;
    if (callCount >= 3) {
      showDriverNoShowSuggestionFromKey(encodedKey, btn);
      return;
    }
    const remaining = getCallCooldownRemainingSeconds(row);
    if (remaining > 0) {
      showToast(`Panggil ulang tersedia dalam ${remaining} detik.`);
      return;
    }
    const buttonHtmlBeforeV155 = btn?.innerHTML || "";
    if (btn) {
      btn.disabled = true;
      btn.classList.add("opacity-60", "cursor-wait");
      btn.setAttribute("aria-busy", "true");
      btn.innerHTML =
        '<span class="material-symbols-outlined text-base animate-spin">progress_activity</span> Menyimpan...';
    }
    showToast(
      action === "start"
        ? "Menyimpan Start Checker..."
        : "Menyimpan Done Checker...",
    );
    try {
      const result = await updateCheckerToBackend({
        ...buildBackendActionBodyFromRow(row),
        status: "CALLED",
        actor_role: String(getAuthUser?.()?.role || "CHECKER").toUpperCase(),
        unload_sla: "ON PROCESS",
        gate: row.gate || "",
        updated_at: formatDateTimeLocal(new Date()),
      });
      applyBackendActionResult(result);
      const fresh = result?.rows?.[0] || row;
      const newCount =
        Number(result?.call_count || fresh.call_count || callCount + 1) || 0;
      showToast(`Driver dipanggil ulang (${Math.min(newCount, 3)}/3)`);
      renderPage("checker", false);
    } catch (err) {
      console.error(err);
      showToast("Panggil ulang gagal: " + err.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove("opacity-60", "cursor-wait");
      }
    }
  };

  window.markDriverCallFailedFromKey = async function markDriverCallFailedV3(
    encodedKey = "",
    btn = null,
  ) {
    let row =
      typeof findCheckerRowByKey === "function"
        ? findCheckerRowByKey(encodedKey)
        : null;
    if (!row) {
      showToast("Data ticket tidak ditemukan. Refresh dulu.");
      return;
    }
    row = await refreshOutputFormForFreshRow(row);
    const callCount = Number(row.call_count || 0) || 0;
    if (callCount < 3) {
      showToast(
        `Expired 4/4 baru aktif setelah 3 kali panggilan. Saat ini ${callCount}/3.`,
      );
      return;
    }
    const remaining = getCallCooldownRemainingSeconds(row);
    if (remaining > 0) {
      showToast(`Expired 4/4 tersedia dalam ${remaining} detik.`);
      return;
    }
    const ok = confirm(
      `Yakin ticket ${row.queue_no || "-"} akan dibuat EXPIRED pada step 4/4?\n\nDriver sudah dipanggil 3 kali dan tidak datang. Setelah expired, driver wajib registrasi ulang.`,
    );
    if (!ok) return;
    if (btn) {
      btn.disabled = true;
      btn.classList.add("opacity-60", "cursor-wait");
    }
    try {
      const result = await failCallToBackend({
        ...buildBackendActionBodyFromRow(row),
        actor_role: String(getAuthUser?.()?.role || "CHECKER").toUpperCase(),
        reason:
          "Driver tidak hadir setelah 3x panggilan. Expired pada step 4/4.",
      });
      applyBackendActionResult(result);
      showToast("Ticket EXPIRED 4/4. Driver wajib registrasi ulang.");
      renderPage("checker", false);
    } catch (err) {
      console.error(err);
      showToast("Gagal expire ticket: " + err.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove("opacity-60", "cursor-wait");
      }
    }
  };

  // WA tidak lagi menambah call_count. Call count hanya dari aksi Panggil.
  window.sendDriverWhatsAppFromKey = async function sendDriverWhatsAppFromKeyV3(
    encodedKey = "",
    btn = null,
  ) {
    const actorRole = String(getAuthUser?.()?.role || "").toUpperCase();
    if (actorRole !== "SPV") {
      showToast("Kirim WhatsApp manual hanya tersedia untuk SPV.");
      return;
    }

    let row =
      typeof findCheckerRowByKey === "function"
        ? findCheckerRowByKey(encodedKey)
        : null;
    if (!row) {
      showToast("Data ticket tidak ditemukan. Refresh dulu.");
      return;
    }
    row = await refreshOutputFormForFreshRow(row);
    const phone = normalizePhoneInputValue(row.phone_number || "");
    if (!phone) {
      showToast("Nomor WhatsApp driver kosong / format tidak valid.");
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.classList.add("opacity-60", "cursor-wait");
    }
    try {
      const result = await sendDriverWhatsAppToBackend({
        ...buildBackendActionBodyFromRow(row),
        phone_number: phone,
        actor_role: actorRole,
      });
      applyBackendActionResult(result);
      showToast("WhatsApp terkirim ke driver.");
      if (["checker", "laporan", "monitor"].includes(state.page))
        renderPage(state.page, false);
    } catch (err) {
      console.error(err);
      showToast("WA gagal: " + err.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove("opacity-60", "cursor-wait");
      }
    }
  };

  const originalDriverWaitingLabelV3 =
    window.driverWaitingLabel ||
    (typeof driverWaitingLabel === "function" ? driverWaitingLabel : null);
  window.driverWaitingLabel = function driverWaitingLabelV3(row = {}) {
    const st = String(row.status || "").toUpperCase();
    if (st === "WAITING GR" || st === "DONE GR" || st === "COMPLETED") {
      return "Bongkar selesai";
    }
    return originalDriverWaitingLabelV3
      ? originalDriverWaitingLabelV3(row)
      : "-";
  };
})();

/* ==========================================================================
 * GLOBAL AUTO SYNC V11
 * - Cek perubahan operasional setiap 10 detik.
 * - Hanya rebuild data ketika signature berubah.
 * - Semua PC mendapat perubahan status tanpa menekan Refresh.
 * ========================================================================== */
(function installGlobalAutoSyncApiV11() {
  if (window.__globalAutoSyncApiV11Installed) return;
  window.__globalAutoSyncApiV11Installed = true;

  const INTERVAL_MS = 10000;
  const FULL_REFRESH_MS = 5 * 60 * 1000;
  let timer = null;
  let busy = false;
  let lastSignature = "";
  let lastCursor = "";
  let lastFullRefreshAt = Date.now();
  let uiPending = false;
  let rerunRequested = false;
  let stopped = false;

  function outputFieldV11(row = {}, aliases = []) {
    if (typeof getCell === "function") return getCell(row, aliases, "");
    for (const alias of aliases) {
      if (row?.[alias] !== undefined && row?.[alias] !== null) {
        return row[alias];
      }
    }
    return "";
  }

  function rowSignatureV11(row = {}) {
    return [
      outputFieldV11(row, ["ticket_id", "ticket id"]),
      outputFieldV11(row, ["queue_no", "queue no"]),
      outputFieldV11(row, ["plat_number", "plate number", "Licence Plate"]),
      outputFieldV11(row, ["vendor_name", "vendor name"]),
      outputFieldV11(row, ["po_number", "po number"]),
      outputFieldV11(row, ["status"]),
      outputFieldV11(row, ["gate"]),
      outputFieldV11(row, ["call_count", "call count"]),
      outputFieldV11(row, ["register_time", "register time", "created_at"]),
      outputFieldV11(row, ["called_at", "called at", "last_call_at"]),
      outputFieldV11(row, ["start_unloading_at", "start unloading at"]),
      outputFieldV11(row, ["waiting_gr_at", "waiting gr at"]),
      outputFieldV11(row, ["done_gr_at", "done gr at"]),
      outputFieldV11(row, ["handover_grn_at", "handover grn at"]),
      outputFieldV11(row, ["completed_at", "completed at"]),
      outputFieldV11(row, ["expired_at", "expired at"]),
      outputFieldV11(row, ["updated_at", "updated at"]),
    ]
      .map((value) => String(value ?? "").trim())
      .join("\u001f");
  }

  function hashTextV11(text = "") {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function buildOutputSignatureV11(rows = []) {
    const normalized = rows
      .map(rowSignatureV11)
      .sort((a, b) => a.localeCompare(b))
      .join("\u001e");

    return `${rows.length}:${hashTextV11(normalized)}`;
  }

  function updateSyncIndicatorV11(status, text) {
    if (typeof window.updateGlobalAutoSyncIndicatorV11 === "function") {
      window.updateGlobalAutoSyncIndicatorV11(status, text);
    }
  }

  function applySnapshotV11(outputResponse, rows) {
    v2RawResponse = {
      ...(v2RawResponse || {}),
      status: "success",
      timestamp:
        outputResponse?.timestamp ||
        v2RawResponse?.timestamp ||
        new Date().toISOString(),
      sites: outputResponse?.sites || v2RawResponse?.sites || [],
      gates: outputResponse?.gates || v2RawResponse?.gates || [],
      outputForm: rows,
      inboundMp: getInboundMpRowsV15(
        outputResponse,
        v2RawResponse?.inboundMp || v2RawResponse?.inbound_mp || [],
      ),
    };

    applyServerSiteCatalog(v2RawResponse);
    state.dashboard = buildDashboardFromV2(v2RawResponse);
    state.options = state.dashboard.options || state.options;
    state.lastCalled =
      typeof getLatestCallTicket === "function"
        ? getLatestCallTicket(state.dashboard.queue)
        : state.dashboard.queue?.[0] || state.lastCalled;
  }

  async function runAutoSyncV11(forceUi = false) {
    if (
      stopped ||
      busy ||
      document.visibilityState === "hidden" ||
      !navigator.onLine ||
      !hasApiV2() ||
      !isLoggedIn?.()
    ) {
      if (forceUi && busy) rerunRequested = true;
      return;
    }

    busy = true;
    updateSyncIndicatorV11("checking", "Mengecek perubahan...");

    try {
      const currentRows = getOutputFormRows(v2RawResponse || {});
      if (!lastSignature && currentRows.length) {
        lastSignature = buildOutputSignatureV11(currentRows);
      }
      const cursor = lastCursor || v2RawResponse?.timestamp || "";
      const needsFullSnapshot =
        !cursor || Date.now() - lastFullRefreshAt >= FULL_REFRESH_MS;
      const outputResponse = needsFullSnapshot
        ? await fetchOutputFormData()
        : await fetchOutputFormDelta(cursor);
      const responseRows = getOutputFormRows(outputResponse);
      const rows = !needsFullSnapshot
        ? mergeOutputDeltaV12(
            currentRows,
            responseRows,
            Array.isArray(outputResponse?.ticket_ids) ? outputResponse.ticket_ids : null,
          )
        : responseRows;
      const signature = buildOutputSignatureV11(rows);
      const changed = signature !== lastSignature;
      lastCursor = outputResponse?.timestamp || new Date().toISOString();
      if (needsFullSnapshot) lastFullRefreshAt = Date.now();

      if (!lastSignature) {
        lastSignature = signature;
        updateSyncIndicatorV11("online", "Sinkron otomatis aktif");
        return;
      }

      if (changed) {
        applySnapshotV11(outputResponse, rows);
        lastSignature = signature;
      }

      if (
        (changed || uiPending || forceUi) &&
        typeof window.onGlobalAutoSyncDataChangedV11 === "function"
      ) {
        const applied = window.onGlobalAutoSyncDataChangedV11({
          changed,
          pending: uiPending,
          signature,
          rows,
          syncedAt: new Date(),
        });

        uiPending = applied === false;
      }

      updateSyncIndicatorV11(
        uiPending ? "pending" : "online",
        uiPending
          ? "Perubahan menunggu form selesai"
          : `Tersinkron ${new Date().toLocaleTimeString("id-ID")}`,
      );
    } catch (error) {
      console.error("Global auto sync gagal", error);
      updateSyncIndicatorV11("error", "Sinkron otomatis gagal");
    } finally {
      busy = false;
      if (rerunRequested && !stopped && document.visibilityState === "visible") {
        rerunRequested = false;
        setTimeout(() => runAutoSyncV11(true), 100);
      }
    }
  }

  window.startGlobalAutoSyncV11 = function startGlobalAutoSyncV11() {
    stopped = false;
    if (timer) clearInterval(timer);

    updateSyncIndicatorV11("online", "Sinkron otomatis aktif");
    setTimeout(() => runAutoSyncV11(false), 1200);
    timer = setInterval(() => runAutoSyncV11(false), INTERVAL_MS);
  };

  window.stopGlobalAutoSyncV11 = function stopGlobalAutoSyncV11() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    updateSyncIndicatorV11("off", "Sinkron otomatis berhenti");
  };

  window.forceGlobalAutoSyncV11 = function forceGlobalAutoSyncV11() {
    return runAutoSyncV11(true);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      setTimeout(() => runAutoSyncV11(true), 250);
    }
  });

  window.addEventListener("online", () => {
    updateSyncIndicatorV11("online", "Koneksi kembali");
    setTimeout(() => runAutoSyncV11(true), 250);
  });

  window.addEventListener("offline", () => {
    updateSyncIndicatorV11("error", "Tidak ada koneksi");
  });

  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => window.startGlobalAutoSyncV11(), 2200);
  });
})();

/* ==========================================================================
 * V15 — MULTI-PO OUTPUT + CHECKER PER PO + GR PER PO
 * ========================================================================== */
(function installInboundMultiPoV15Api() {
  window.__inboundMultiPoV15Api = true;

  function responseInboundMpV15(response) {
    if (Array.isArray(response?.inboundMp)) return response.inboundMp;
    if (Array.isArray(response?.inbound_mp)) return response.inbound_mp;
    if (Array.isArray(response?.data?.inboundMp))
      return response.data.inboundMp;
    return [];
  }

  window.startCheckerPoToBackendV15 = function startCheckerPoToBackendV15(
    body = {},
  ) {
    return apiPostV2("startCheckerPo", body);
  };

  window.doneCheckerPoToBackendV15 = function doneCheckerPoToBackendV15(
    body = {},
  ) {
    return apiPostV2("doneCheckerPo", body);
  };

  window.doneGrPoToBackendV15 = function doneGrPoToBackendV15(body = {}) {
    return apiPostV2("doneGrPo", body);
  };

  window.doneGrPosToBackendV19 = function doneGrPosToBackendV19(body = {}) {
    return apiPostV2("doneGrPos", body);
  };

  window.handoverGrnToBackendV15 = function handoverGrnToBackendV15(body = {}) {
    return apiPostV2("handoverGrn", body);
  };

  window.ticketIdentity = function ticketIdentityV15(row = {}) {
    const ticketPoId = String(
      row.ticket_po_id || row.raw?.ticket_po_id || "",
    ).trim();
    if (ticketPoId) return `ticket-po:${ticketPoId}`;

    const ticketId = String(row.ticket_id || row.raw?.ticket_id || "").trim();
    const po = String(row.po_number || row.raw?.po_number || "").trim();
    if (ticketId && po && !po.includes(","))
      return `ticket-po-fallback:${ticketId}|${po}`.toUpperCase();
    if (ticketId) return `ticket:${ticketId}`;

    return [
      "fallback",
      String(row.queue_no || "").trim(),
      po,
      normalizePlateValue(row.plat_number || row["Licence Plate"] || ""),
    ]
      .join("|")
      .toUpperCase();
  };

  function mapOutputPoRowV15(row = {}, idx = 0) {
    const status = String(
      getCell(row, ["status", "Status"], "WAITING") || "WAITING",
    )
      .trim()
      .toUpperCase();
    const timestamp = getCell(row, ["Timestamp", "timestamp"], "");
    const created = normalizeOutputDateV7(
      getCell(row, ["created_at", "created at"]),
      getCell(row, ["register_time", "register time"]),
      timestamp,
    );
    const registerTime = normalizeOutputDateV7(
      getCell(row, ["register_time", "register time"]),
      getCell(row, ["created_at", "created at"]),
      timestamp,
    );

    const dateField = (...names) =>
      normalizeOutputDateV7(getCell(row, names, ""));
    const plate = normalizePlateValue(
      getCell(
        row,
        ["plat_number", "Licence Plate", "license_plate", "plat number"],
        "",
      ),
    );

    return {
      source: getCell(row, ["source"], "OUTPUT_FORM"),
      row_no: idx + 2,
      ticket_id: getCell(row, ["ticket_id", "ticket id"], ""),
      ticket_po_id: getCell(row, ["ticket_po_id", "ticket po id"], ""),
      po_sequence: toNumberV2(getCell(row, ["po_sequence"], idx + 1)),
      ticket_po_count: toNumberV2(getCell(row, ["ticket_po_count"], 0)),
      ticket_total_qty: toNumberV2(getCell(row, ["ticket_total_qty"], 0)),
      ticket_total_sku: toNumberV2(getCell(row, ["ticket_total_sku"], 0)),
      queue_no: getCell(row, ["queue_no", "queue no"], ""),
      original_queue_no: getCell(row, ["queue_no", "queue no"], ""),
      ticket_type: getCell(row, ["ticket_type", "ticket type"], "REG"),
      slot: String(getCell(row, ["slot"], "3") || "3"),
      Timestamp: timestamp,
      created_at: created,
      register_time: registerTime,
      called_at: dateField("called_at", "called at", "last_call_at"),
      start_unloading_at: dateField("start_unloading_at", "start unloading at"),
      finish_unloading_at: dateField(
        "finish_unloading_at",
        "finish unloading at",
      ),
      waiting_gr_at: dateField("waiting_gr_at", "waiting gr at"),
      done_gr_at: dateField("done_gr_at", "done gr at"),
      handover_grn_at: dateField("handover_grn_at", "handover grn at"),
      completed_at: dateField(
        "completed_at",
        "completed at",
        "handover_grn_at",
      ),
      updated_at: dateField("updated_at", "updated at", "last_call_at"),
      last_call_at: dateField("last_call_at", "last call at"),
      last_call_attempt_at: dateField(
        "last_call_attempt_at",
        "last call attempt at",
      ),
      expired_at: dateField("expired_at", "expired at"),
      expired_reason: getCell(row, ["expired_reason", "expired reason"], ""),
      operational_date: getCell(row, ["operational_date"], ""),
      data_source: getCell(row, ["data_source"], "BACKEND"),
      vendor_name: getCell(row, ["vendor_name", "Vendor Name"], ""),
      fleet_type: getCell(
        row,
        ["fleet_type", "Vhiecle Type", "Vehicle Type"],
        "",
      ),
      plat_number: plate,
      driver_name: getCell(row, ["driver_name", "driver name"], ""),
      phone_number: getCell(row, ["phone_number", "phone number"], ""),
      ktp_6_digit: getCell(row, ["ktp_6_digit"], ""),
      po_number: getCell(row, ["po_number", "po", "PO Number"], ""),
      total_po_qty: toNumberV2(
        getCell(row, ["total_po_qty", "total_request_quantity"], 0),
      ),
      count_po_sku: toNumberV2(getCell(row, ["count_po_sku", "Count SKU"], 0)),
      actual_quantity: toNumberV2(getCell(row, ["actual_quantity"], 0)),
      gate: getCell(row, ["gate"], "-") || "-",
      status,
      unload_sla: getCell(row, ["unload_sla", "sla_status"], ""),
      sla_status: getCell(row, ["sla_status", "unload_sla"], ""),
      sla_target_hours: toNumberV2(getCell(row, ["sla_target_hours"], 0)),
      sla_finished_at: dateField("sla_finished_at", "SLA Finished At"),
      inbound_sla_duration: getCell(row, ["inbound_sla_duration"], ""),
      inbound_sla_minutes: toNumberV2(getCell(row, ["inbound_sla_minutes"], 0)),
      unloading_duration: getCell(row, ["unloading_duration"], ""),
      unloading_duration_minutes: toNumberV2(
        getCell(row, ["unloading_duration_minutes"], 0),
      ),
      checker_id: getCell(row, ["checker_id"], ""),
      checker_name: getCell(row, ["checker_name"], ""),
      checker_status: String(
        getCell(row, ["checker_status"], "PENDING") || "PENDING",
      ).toUpperCase(),
      checker_started_at: dateField("checker_started_at"),
      checker_done_at: dateField("checker_done_at"),
      checker_started_by: getCell(row, ["checker_started_by"], ""),
      checker_done_by: getCell(row, ["checker_done_by"], ""),
      checker_duration: getCell(row, ["checker_duration"], ""),
      checker_duration_minutes: toNumberV2(
        getCell(row, ["checker_duration_minutes"], 0),
      ),
      gr_status: String(
        getCell(row, ["gr_status"], "PENDING") || "PENDING",
      ).toUpperCase(),
      done_gr_by: getCell(row, ["done_gr_by"], ""),
      gr_wait_duration: getCell(row, ["gr_wait_duration"], ""),
      gr_wait_minutes: toNumberV2(getCell(row, ["gr_wait_minutes"], 0)),
      call_count: toNumberV2(getCell(row, ["call_count"], 0)),
      wa_call_status: getCell(row, ["wa_call_status"], ""),
      wa_call_sent_at: dateField("wa_call_sent_at"),
      wa_call_error: getCell(row, ["wa_call_error"], ""),
      wa_ticket_status: getCell(row, ["wa_ticket_status"], ""),
      wa_ticket_sent_at: dateField("wa_ticket_sent_at"),
      wa_ticket_error: getCell(row, ["wa_ticket_error"], ""),
      wa_ticket_target: getCell(row, ["wa_ticket_target"], ""),
      wa_handover_status: getCell(row, ["wa_handover_status"], ""),
      wa_handover_sent_at: dateField("wa_handover_sent_at"),
      wa_handover_error: getCell(row, ["wa_handover_error"], ""),
      wa_handover_target: getCell(row, ["wa_handover_target"], ""),
      raw: row,
    };
  }

  function latestDateTextV15(values = []) {
    const valid = values
      .map((value) => ({ value, date: parseInboundDateSafe(value) }))
      .filter((item) => item.date)
      .sort((a, b) => b.date.getTime() - a.date.getTime());
    return valid[0]?.value || "";
  }

  function earliestDateTextV15(values = []) {
    const valid = values
      .map((value) => ({ value, date: parseInboundDateSafe(value) }))
      .filter((item) => item.date)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    return valid[0]?.value || "";
  }

  function deriveMasterStatusV15(poRows = []) {
    if (!poRows.length) return "WAITING";
    const statuses = poRows.map((row) =>
      String(row.status || "WAITING").toUpperCase(),
    );
    if (statuses.every((status) => status === "COMPLETED")) return "COMPLETED";
    if (statuses.some((status) => status === "EXPIRED")) return "EXPIRED";

    const hasFinishUnloading = poRows.some((row) => !!row.finish_unloading_at);
    const hasStartUnloading =
      poRows.some((row) => !!row.start_unloading_at) ||
      statuses.some((status) => status === "UNLOADING");
    const allDoneGr = poRows.every(
      (row) => String(row.gr_status || "").toUpperCase() === "DONE GR",
    );

    if (hasFinishUnloading && allDoneGr) return "DONE GR";
    if (hasFinishUnloading) return "WAITING GR";
    if (hasStartUnloading) return "UNLOADING";
    if (statuses.some((status) => status === "CALLED")) return "CALLED";
    return "WAITING";
  }

  function groupOutputRowsV15(outputRows = []) {
    const mapped = outputRows.map(mapOutputPoRowV15);
    const groups = new Map();

    mapped.forEach((row) => {
      const key =
        String(row.ticket_id || "").trim() ||
        [
          row.queue_no,
          row.plat_number,
          row.operational_date ||
            getOperationalDateKey?.(row.register_time || new Date()),
        ].join("|");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });

    return [...groups.values()].map((poRows) => {
      poRows.sort(
        (a, b) =>
          (a.po_sequence || 0) - (b.po_sequence || 0) ||
          String(a.po_number).localeCompare(String(b.po_number)),
      );
      const first = poRows[0];
      const status = deriveMasterStatusV15(poRows);
      const poNumbers = poRows.map((row) => row.po_number).filter(Boolean);
      const ticketTypeV18 = String(first.ticket_type || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "-");
      const fleetTypeV18 = String(first.fleet_type || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "-");
      const dropOffV18 =
        ticketTypeV18 === "DROP" ||
        ticketTypeV18 === "DROP-OFF" ||
        fleetTypeV18 === "DROP-OFF";
      const checkerDone = poRows.filter((row) => {
        const value = String(row.checker_status || "").toUpperCase();
        return value === "DONE" || (dropOffV18 && value === "SKIPPED");
      }).length;
      const grDone = poRows.filter((row) => {
        const value = String(row.gr_status || "").toUpperCase();
        return value === "DONE GR" || (dropOffV18 && value === "SKIPPED");
      }).length;
      const checkerNames = [
        ...new Set(poRows.map((row) => row.checker_name).filter(Boolean)),
      ];
      const allDoneGr = poRows.length > 0 && grDone === poRows.length;
      const allCheckerDone = poRows.length > 0 && checkerDone === poRows.length;
      const totalQty = poRows.reduce(
        (sum, row) => sum + toNumberV2(row.total_po_qty),
        0,
      );
      const totalSku = poRows.reduce(
        (sum, row) => sum + toNumberV2(row.count_po_sku),
        0,
      );
      const actualQtyTotal = poRows.reduce(
        (sum, row) => sum + toNumberV2(row.actual_quantity),
        0,
      );
      const doneGrAt = allDoneGr
        ? latestDateTextV15(poRows.map((row) => row.done_gr_at))
        : "";
      const completedAt =
        status === "COMPLETED"
          ? latestDateTextV15(
              poRows.map((row) => row.completed_at || row.handover_grn_at),
            )
          : "";

      return {
        ...first,
        raw: first.raw,
        po_rows: poRows,
        ticket_row_count: poRows.length,
        ticket_po_count:
          Number(first.ticket_po_count || poRows.length) || poRows.length,
        po_numbers: poNumbers,
        po_number: poNumbers.join(", "),
        total_po_qty: Number(first.ticket_total_qty || totalQty) || totalQty,
        actual_quantity: actualQtyTotal,
        count_po_sku: Number(first.ticket_total_sku || totalSku) || totalSku,
        ticket_total_qty:
          Number(first.ticket_total_qty || totalQty) || totalQty,
        ticket_total_sku:
          Number(first.ticket_total_sku || totalSku) || totalSku,
        status,
        checker_done_count: checkerDone,
        checker_total_count: poRows.length,
        checker_progress: dropOffV18
          ? "SKIP"
          : `${checkerDone}/${poRows.length}`,
        gr_done_count: grDone,
        gr_total_count: poRows.length,
        gr_progress: dropOffV18 ? "SKIP" : `${grDone}/${poRows.length}`,
        checker_names: checkerNames,
        checker_name: checkerNames.join(", "),
        all_checker_done: allCheckerDone,
        all_done_gr: allDoneGr,
        called_at: earliestDateTextV15(poRows.map((row) => row.called_at)),
        start_unloading_at: earliestDateTextV15(
          poRows.map((row) => row.start_unloading_at),
        ),
        finish_unloading_at: latestDateTextV15(
          poRows.map((row) => row.finish_unloading_at),
        ),
        waiting_gr_at: latestDateTextV15(
          poRows.map((row) => row.waiting_gr_at),
        ),
        done_gr_at: doneGrAt,
        completed_at: completedAt,
        handover_grn_at:
          completedAt ||
          latestDateTextV15(poRows.map((row) => row.handover_grn_at)),
        sla_status: allDoneGr
          ? poRows.some(
              (row) => String(row.sla_status).toUpperCase() === "LATE",
            )
            ? "LATE"
            : "TERCAPAI"
          : poRows.some(
                (row) => String(row.sla_status).toUpperCase() === "LATE",
              )
            ? "LATE"
            : first.start_unloading_at
              ? "ON PROCESS"
              : "WAITING START UNLOADING",
        unload_sla: allDoneGr
          ? poRows.some(
              (row) => String(row.sla_status).toUpperCase() === "LATE",
            )
            ? "LATE"
            : "TERCAPAI"
          : poRows.some(
                (row) => String(row.sla_status).toUpperCase() === "LATE",
              )
            ? "LATE"
            : first.start_unloading_at
              ? "ON PROCESS"
              : "WAITING START UNLOADING",
      };
    });
  }

  window.buildQueueFromOutputForm = function buildQueueFromOutputFormV15(
    outputRows = [],
  ) {
    return groupOutputRowsV15(outputRows);
  };

  function responseHasOutputV15(response) {
    return hasOutputFormPayload(response);
  }

  window.buildDashboardFromV2 = function buildDashboardFromV2V15(
    response = {},
  ) {
    const tableRows = getTableV2Rows(response);
    const kpiRaw = getKpiRawRows(response);
    const allOutputRows = getOutputFormRows(response);
    const inboundMp = responseInboundMpV15(response);
    v2PoIndex = buildPoIndex(tableRows);

    const currentOp =
      typeof getOperationalDateKey === "function"
        ? getOperationalDateKey(new Date())
        : "";
    const operationalRows = allOutputRows.filter((row) => {
      const op =
        typeof getRowOperationalDateKey === "function"
          ? getRowOperationalDateKey(row)
          : String(row.operational_date || "");
      const status = String(row.status || "WAITING").toUpperCase();
      const active = !["COMPLETED", "EXPIRED"].includes(status);
      return !currentOp || op === currentOp || active;
    });

    const serverHasOutput = responseHasOutputV15(response);
    const serverQueue = groupOutputRowsV15(operationalRows);
    const localQueue = serverHasOutput
      ? []
      : groupOutputRowsV15(getLocalTickets());
    if (serverHasOutput) saveLocalTickets([]);
    const queue = normalizeQueueSequenceBySlot(
      serverHasOutput
        ? serverQueue
        : mergeTicketQueues(serverQueue, localQueue),
    );
    const allQueue = groupOutputRowsV15(allOutputRows);

    const summary = buildSummary(kpiRaw, tableRows, queue);
    const kpis = buildKpis(kpiRaw, tableRows, queue);
    const options = {
      ...buildOptionsFromV2(tableRows),
      inbound_mp: inboundMp,
      checker_mp: inboundMp,
      checker_names: inboundMp.map((item) => item.checker_name),
    };

    const dockMap = {};
    const gates =
      typeof getCibitungGateOptions === "function"
        ? getCibitungGateOptions()
        : Array.from(
            { length: 10 },
            (_, i) => `Dock ${String(i + 1).padStart(2, "0")}`,
          );
    gates.forEach((gate) => {
      dockMap[gate] = { gate, status: "KOSONG", queue_no: "", plat_number: "" };
    });
    queue.forEach((ticket) => {
      if (
        !["CALLED", "UNLOADING"].includes(
          String(ticket.status || "").toUpperCase(),
        )
      )
        return;
      parseGateList(ticket.gate || "").forEach((gate) => {
        dockMap[gate] = {
          gate,
          status: ticket.status,
          queue_no: ticket.queue_no,
          plat_number: ticket.plat_number,
        };
      });
    });

    return {
      timestamp: response.timestamp || new Date().toISOString(),
      operational_date: currentOp,
      kpis,
      summary,
      queue,
      history_queue: allQueue,
      all_queue: allQueue,
      priority: sortQueueBySlotSequence(
        queue.filter(
          (row) =>
            !["COMPLETED", "EXPIRED"].includes(
              String(row.status || "").toUpperCase(),
            ),
        ),
      ).slice(0, 8),
      dock: Object.values(dockMap),
      report_preview: queue,
      options,
      raw: {
        kpiRaw,
        tablev2: tableRows,
        outputForm: operationalRows,
        outputFormAll: allOutputRows,
        outputFormOperational: operationalRows,
        table: Array.isArray(response.table) ? response.table : [],
        inboundMp,
      },
    };
  };

  function makeTicketPoIdClientV15(ticketId, poNumber, sequence) {
    const safePo = String(poNumber || "PO")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(-22);
    return `${ticketId}-PO-${safePo}-${String(sequence || 1).padStart(2, "0")}`;
  }

  window.submitSecurity = async function submitSecurityMultiPoV15(e) {
    e?.preventDefault?.();
    if (!e || e.explicitSecuritySubmit !== true) {
      console.warn("Blocked implicit Security submit");
      return;
    }
    if (securitySubmitBusy) {
      showToast("Submit sedang diproses, tunggu sebentar.");
      return;
    }

    const form = e.target;
    if (typeof syncVehicleMultiInput === "function") syncVehicleMultiInput();
    else if (typeof syncPlateMultiInput === "function") syncPlateMultiInput();
    if (!validateSecurityForm(form)) return;

    const lookup = lookupPo(true);
    if (!lookup || !lookup.all_found) {
      showToast("Semua PO wajib valid dan sesuai Vendor Name.");
      return;
    }

    securitySubmitBusy = true;
    const submitBtn = document.getElementById("security-submit-btn");
    const submitText = document.getElementById("security-submit-text");
    if (submitBtn) submitBtn.disabled = true;
    if (submitText) submitText.textContent = "Menyimpan tiket...";

    try {
      const base = Object.fromEntries(new FormData(form).entries());
      const poItems = lookup.items || [];
      const registeredSet = getRegisteredPoSetApi();
      const duplicatedPo = poItems
        .map((item) => item.po_number || item.po_input)
        .filter((po) => registeredSet.has(normalizeKey(po)));
      if (duplicatedPo.length) {
        showToast(`PO sudah daftar: ${duplicatedPo.join(", ")}`);
        return;
      }

      const vehicleList =
        typeof getSecurityVehicleRows === "function"
          ? getSecurityVehicleRows()
          : parseMultiPlateValues(base.plat_number).map((plate, index) => ({
              index,
              fleet_type: base.fleet_type,
              plat_number: plate,
              driver_name: pickMultiValue(
                parseMultiInputValues(base.driver_name),
                index,
              ),
              phone_number: pickMultiValue(
                parseAndNormalizePhones(base.phone_number),
                index,
              ),
              ktp_6_digit: base.ktp_6_digit || "",
            }));

      if (!vehicleList.length) {
        showToast("Data kendaraan wajib diisi.");
        return;
      }

      for (const vehicle of vehicleList) {
        if (
          !vehicle.fleet_type ||
          !vehicle.plat_number ||
          !vehicle.driver_name ||
          !vehicle.phone_number
        ) {
          showToast(
            "Setiap kendaraan wajib isi Fleet, Plat, Driver, dan WhatsApp.",
          );
          return;
        }
        if (!isValidPlate(vehicle.plat_number)) {
          showToast(`Plat belum valid: ${vehicle.plat_number}`);
          return;
        }
      }

      const poGroups = splitPoItemsByPlate(poItems, vehicleList.length);
      const registerTime =
        base.register_time || formatDateTimeLocal(new Date());
      const currentQueue = state.dashboard?.queue || [];
      const ticketMasters = [];
      const outputRows = [];

      vehicleList.forEach((vehicle, vehicleIndex) => {
        const groupItems = poGroups[vehicleIndex] || poItems;
        const grouped = sumPoItems(groupItems);
        const rowSlot =
          String(base.ticket_type || "").toUpperCase() === "DROP-OFF"
            ? base.slot || grouped.slot || "3"
            : base.slot || grouped.slot || "3";
        const ticketId = `IBT-${Date.now().toString(36).toUpperCase()}-${String(vehicleIndex + 1).padStart(2, "0")}`;
        const queueNo = nextLocalQueueNoFromList(
          base.ticket_type,
          rowSlot,
          currentQueue.concat(ticketMasters),
        );
        const totalQty = groupItems.reduce(
          (sum, item) => sum + toNumberV2(item.total_po_qty),
          0,
        );
        const totalSku = groupItems.reduce(
          (sum, item) => sum + toNumberV2(item.count_po_sku),
          0,
        );

        const master = {
          ...base,
          ticket_id: ticketId,
          queue_no: queueNo,
          ticket_type: base.ticket_type || "REG",
          slot: rowSlot,
          vendor_name: base.vendor_name || grouped.vendor_name || "",
          fleet_type: vehicle.fleet_type,
          plat_number: normalizePlateValue(vehicle.plat_number),
          driver_name: vehicle.driver_name,
          phone_number: vehicle.phone_number,
          ktp_6_digit: vehicle.ktp_6_digit || "",
          status: "WAITING",
          gate: "-",
          register_time: registerTime,
          created_at: registerTime,
          source: "SECURITY_INPUT",
          ticket_po_count: groupItems.length,
          ticket_total_qty: totalQty,
          ticket_total_sku: totalSku,
        };
        ticketMasters.push(master);

        groupItems.forEach((item, poIndex) => {
          outputRows.push({
            ...master,
            ticket_po_id: makeTicketPoIdClientV15(
              ticketId,
              item.po_number,
              poIndex + 1,
            ),
            po_sequence: poIndex + 1,
            po_number: item.po_number || item.po_input || "",
            total_po_qty: toNumberV2(item.total_po_qty),
            count_po_sku: toNumberV2(item.count_po_sku),
            checker_status: "PENDING",
            gr_status: "PENDING",
            operational_date:
              typeof getOperationalDateKey === "function"
                ? getOperationalDateKey(registerTime)
                : "",
            data_source:
              item.data_source === "MANUAL" ||
              item.is_manual_po ||
              item.is_manual_vendor ||
              (typeof getManualSecurityEntry === "function" &&
                getManualSecurityEntry()?.valid)
                ? "MANUAL"
                : "BACKEND",
            is_manual_po: item.is_manual_po === true,
            is_manual_vendor: item.is_manual_vendor === true,
          });
        });
      });

      showToast("Menyimpan tiket digital...");
      const result = await submitSecurityRowsToBackend(outputRows);
      const waFeedbackV171 = getTicketWaFeedbackV171(result);
      window.__lastTicketWaResultsV171 = waFeedbackV171.items;
      console.log("WA ticket result V17.1:", waFeedbackV171.items);
      const savedRows =
        Array.isArray(result?.rows) && result.rows.length
          ? result.rows
          : outputRows;
      // Cache lokal hanya diisi setelah MotherDuck mengonfirmasi ticket tersimpan.
      // Ini mencegah nomor terlihat sukses di device Security tetapi tidak muncul di Checker.
      const savedTicketIds = new Set(savedRows.map((row) => String(row.ticket_id || "")));
      const localRowsV15 = getLocalTickets().filter(
        (row) => !savedTicketIds.has(String(row.ticket_id || "")),
      );
      localRowsV15.unshift(...savedRows);
      saveLocalTickets(localRowsV15);
      upsertOutputRowsToRawResponse(savedRows);
      if (!v2RawResponse) {
        v2RawResponse = {
          status: "success",
          timestamp: new Date().toISOString(),
          tablev2: [],
          outputForm: savedRows,
        };
      }
      state.dashboard = buildDashboardFromV2(v2RawResponse);
      state.options = state.dashboard.options || state.options;
      state.lastSecurityRows = buildQueueFromOutputForm(savedRows);
      state.lastCalled = state.lastSecurityRows[0] || ticketMasters[0];

      showToast(buildTicketCreatedToastV171(result, ticketMasters.length));

      const queueEl = document.getElementById("new-queue-number");
      if (queueEl) queueEl.textContent = state.lastCalled?.queue_no || "-";

      // Submit eksplisit selesai: bersihkan pilihan PO/form, tetap di menu Security.
      state.poLookup = null;
      window.__poBatchSelection?.clear?.();
      window.manualSecurityEntryEnabled = false;
      form.reset?.();
      renderPage("daftar", false);
      setTimeout(() => {
        if (typeof showSecurityLobbyQrV152 === "function") {
          showSecurityLobbyQrV152(state.lastSecurityRows || ticketMasters);
        }
      }, 0);
    } catch (error) {
      console.error(error);
      showToast(`Gagal membuat tiket: ${error.message}`);
      try {
        await refreshDashboard();
      } catch (refreshError) {
        console.error(refreshError);
      }
    } finally {
      securitySubmitBusy = false;
      if (submitBtn) submitBtn.disabled = false;
      if (submitText) submitText.textContent = "Buat Nomor";
    }
  };

  window.submitChecker = async function submitCheckerV154(e) {
    e?.preventDefault?.();
    const form = e?.target;
    if (!form || form.id !== "checker-form") return;

    // Guard lokal + global: satu ticket/action hanya boleh punya satu request aktif.
    if (form.dataset.saving === "1" || form.dataset.saved === "1") {
      showToast("Perubahan sedang diproses atau sudah tersimpan.");
      return;
    }

    if (typeof syncCheckerGateInput === "function" && !syncCheckerGateInput()) {
      showToast("Gate belum dipilih, tidak valid, atau sedang aktif.");
      return;
    }
    if (
      !validateRequiredFields(form) ||
      !validatePlateInput(form.plat_number)
    ) {
      showToast("Pilih ticket dan isi gate.");
      return;
    }

    const body = Object.fromEntries(new FormData(form).entries());
    body.gate =
      document.getElementById("checker-gate-value")?.value || body.gate || "";
    body.plat_number = normalizePlateValue(body.plat_number);
    body.actor_role = String(getAuthUser?.()?.role || "CHECKER").toUpperCase();
    body.actor_name =
      getAuthUser?.()?.display_name ||
      getAuthUser?.()?.username ||
      body.actor_role;

    const requested = String(body.status || "CALLED")
      .trim()
      .toUpperCase();
    body.status = requested;
    body.updated_at = formatDateTimeLocal(new Date());
    if (body.status === "CALLED") body.called_at = body.updated_at;
    if (body.status === "UNLOADING") body.start_unloading_at = body.updated_at;
    if (body.status === "WAITING GR") {
      body.finish_unloading_at = body.updated_at;
    }
    if (typeof getOperationalDateKey === "function") {
      body.operational_date = getOperationalDateKey(new Date());
    }

    const isTouch =
      window.matchMedia?.("(pointer: coarse)")?.matches ||
      Number(navigator.maxTouchPoints || 0) > 0;

    if (isTouch && form.dataset.mobileConfirmed !== "1") {
      const label =
        body.status === "CALLED"
          ? "Panggil driver ke gate?"
          : body.status === "UNLOADING"
            ? "Mulai unloading?"
            : "Finish unloading? Semua PO wajib Done Checking.";

      const approved = confirm(
        `${label}\n\nQueue: ${body.queue_no || "-"}\nPlat: ${body.plat_number || "-"}\nGate: ${body.gate || "-"}`,
      );
      if (!approved) return;
    }

    const lockKey = [
      String(body.ticket_id || "").trim(),
      String(body.queue_no || "").trim(),
      String(body.plat_number || "").trim(),
      String(body.status || "").trim(),
    ].join("|");

    window.__checkerSubmitLocksV154 ||= new Set();
    if (window.__checkerSubmitLocksV154.has(lockKey)) {
      showToast("Aksi ticket ini sedang diproses. Tunggu data berubah.");
      return;
    }

    const submitButton = form.querySelector("#checker-submit-btn");
    const gateControls = [
      ...form.querySelectorAll(
        '[data-single-gate], [data-wingbox-gate], select[name="gate"]',
      ),
    ];

    function lockUiV154(label = "Menyimpan...") {
      form.dataset.saving = "1";
      window.__checkerSubmitLocksV154.add(lockKey);
      gateControls.forEach((control) => {
        control.dataset.disabledBeforeV154 = control.disabled ? "1" : "0";
        control.disabled = true;
        control.setAttribute("aria-disabled", "true");
      });
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.setAttribute("aria-disabled", "true");
        submitButton.style.pointerEvents = "none";
      }
      setCheckerSubmitButtonState?.("saving", label);
    }

    function unlockUiV154() {
      form.dataset.saving = "0";
      delete form.dataset.saved;
      window.__checkerSubmitLocksV154.delete(lockKey);
      gateControls.forEach((control) => {
        control.disabled = control.dataset.disabledBeforeV154 === "1";
        delete control.dataset.disabledBeforeV154;
        control.removeAttribute("aria-disabled");
      });
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.removeAttribute("aria-disabled");
        submitButton.style.pointerEvents = "";
      }
      updateCheckerStatusPreview?.(requested);
    }

    lockUiV154();
    let saved = false;

    // Tutup popup segera setelah konfirmasi. Request tetap berjalan dengan
    // referensi form/body yang sudah diambil, sehingga user tidak merasa freeze
    // dan tidak bisa menekan aksi yang sama dua kali.
    showToast("Menyimpan perubahan Checker...");
    try {
      window.closeMobileCheckerActionSheet?.();
    } catch (closeError) {
      document
        .getElementById("mobile-checker-action-sheet")
        ?.classList.remove("is-open");
      document.body.classList.remove("mobile-checker-action-sheet-open");
    }

    try {
      const result = await updateCheckerToBackend(body);
      applyBackendActionResult(result);
      saved = true;
      form.dataset.saved = "1";

      // Setelah backend sukses, form lama tidak boleh bisa digunakan kembali.
      setCheckerSubmitButtonState?.("done", "Tersimpan");
      gateControls.forEach((control) => {
        control.disabled = true;
        control.setAttribute("aria-disabled", "true");
      });
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.style.pointerEvents = "none";
      }

      if (body.status === "CALLED") {
        showToast(`Panggilan ${result.call_count || 1}/3 tersimpan.`);
      } else if (body.status === "UNLOADING") {
        showToast("Unloading dimulai. SLA inbound mulai berjalan.");
      } else {
        showToast(
          "Finish unloading tersimpan. Ticket masuk WAITING GR / DONE GR.",
        );
      }

      // Tutup bottom sheet seketika agar gate/button stale tidak bisa diklik lagi.
      try {
        window.closeMobileCheckerActionSheet?.();
      } catch (closeError) {
        document
          .getElementById("mobile-checker-action-sheet")
          ?.classList.remove("is-open");
        document.body.classList.remove("mobile-checker-action-sheet-open");
      }

      // Render dari state hasil backend, lalu cek server lagi tanpa menunggu 5 detik.
      renderPage("checker", false);
      setTimeout(() => {
        window.forceGlobalAutoSyncV11?.();
      }, 150);
    } catch (error) {
      console.error(error);
      showToast(`Checker gagal: ${error.message}`);
      unlockUiV154();
    } finally {
      if (saved) {
        // Lock singkat mencegah tap ulang dari event/DOM lama setelah popup ditutup.
        setTimeout(() => {
          window.__checkerSubmitLocksV154?.delete(lockKey);
        }, 2500);
      }
    }
  };

  function actorPayloadV15() {
    const user = getAuthUser?.() || {};
    return {
      actor_role: String(user.role || "").toUpperCase(),
      actor_name: user.display_name || user.username || user.role || "",
      actor_username: user.username || "",
    };
  }

  window.runCheckerPoActionV15 = async function runCheckerPoActionV15(
    action,
    ticket,
    poIds,
    checker,
    btn = null,
  ) {
    if (!ticket || !poIds?.length || !checker) {
      showToast("Pilih nama checker dan minimal satu PO.");
      return null;
    }
    if (btn) {
      btn.disabled = true;
      btn.classList.add("opacity-60", "cursor-wait");
    }
    try {
      const payload = {
        ticket_id: ticket.ticket_id,
        queue_no: ticket.original_queue_no || ticket.queue_no,
        plat_number: ticket.plat_number,
        operational_date: ticket.operational_date,
        ticket_po_ids: poIds,
        checker_id: checker.checker_id || checker.mp_id,
        checker_name: checker.checker_name,
        ...actorPayloadV15(),
      };
      const result =
        action === "start"
          ? await startCheckerPoToBackendV15(payload)
          : await doneCheckerPoToBackendV15(payload);
      applyBackendActionResult(result);
      showToast(
        action === "start"
          ? `${poIds.length} PO mulai dikerjakan ${checker.checker_name}.`
          : `${poIds.length} PO selesai checker.`,
      );
      renderPage("checker", false);
      return result;
    } catch (error) {
      console.error(error);
      showToast(`Proses checker gagal: ${error.message}`);
      return null;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove("opacity-60", "cursor-wait");
        btn.removeAttribute("aria-busy");
        if (document.body.contains(btn)) btn.innerHTML = buttonHtmlBeforeV155;
      }
    }
  };

  window.doneGrPoV15 = async function doneGrPoV15(
    ticketId,
    ticketPoId,
    btn = null,
  ) {
    const ticket = (state.dashboard?.queue || []).find(
      (row) => String(row.ticket_id) === String(ticketId),
    );
    if (!ticket) return showToast("Ticket tidak ditemukan.");

    const po = ticket.po_rows?.find(
      (row) => String(row.ticket_po_id) === String(ticketPoId),
    );
    if (!po) return showToast("PO tidak ditemukan.");

    const ticketType = String(ticket.ticket_type || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "-");
    const fleetType = String(ticket.fleet_type || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "-");
    if (
      ticketType === "DROP" ||
      ticketType === "DROP-OFF" ||
      fleetType === "DROP-OFF"
    ) {
      return showToast("DROP-OFF tidak memerlukan Done GR.");
    }

    const qtyInputId = `actual-qty-${String(
      po.ticket_po_id || po.po_number || "",
    ).replace(/[^A-Za-z0-9_-]/g, "_")}`;
    const qtyInput = document.getElementById(qtyInputId);
    const actualQuantity = Number(qtyInput?.value || po.actual_quantity || 0);

    if (!Number.isFinite(actualQuantity) || actualQuantity <= 0) {
      qtyInput?.classList.add("invalid");
      qtyInput?.focus();
      return showToast(
        `Actual Qty PO ${po.po_number || "-"} wajib diisi dan harus lebih dari 0.`,
      );
    }

    if (
      !confirm(
        `Done GR untuk PO ${po.po_number || "-"}?\n\nPO Qty: ${
          po.total_po_qty || 0
        }\nActual Qty: ${actualQuantity}`,
      )
    )
      return;

    const waitingSnapshot = window.captureWaitingViewportV155?.() || null;
    const buttonHtmlBeforeV155 = btn?.innerHTML || "";
    let successV155 = false;

    if (btn) {
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      btn.classList.add("opacity-60", "cursor-wait");
      btn.innerHTML =
        '<span class="material-symbols-outlined text-base animate-spin">progress_activity</span> Menyimpan...';
    }

    showToast(
      `Menyimpan Actual Qty ${actualQuantity} dan Done GR PO ${
        po.po_number || "-"
      }...`,
    );

    try {
      const result = await doneGrPoToBackendV15({
        ticket_id: ticket.ticket_id,
        ticket_po_id: po.ticket_po_id,
        po_number: po.po_number,
        actual_quantity: actualQuantity,
        queue_no: ticket.queue_no,
        plat_number: ticket.plat_number,
        operational_date: ticket.operational_date,
        ...actorPayloadV15(),
      });

      applyBackendActionResult(result);
      successV155 = true;
      showToast(
        result?.all_done_gr
          ? "Actual Qty tersimpan. Semua PO DONE GR dan siap Handover GRN."
          : `Actual Qty ${actualQuantity} tersimpan. PO ${po.po_number} selesai GR.`,
      );

      renderPage("laporan", false);
      setTimeout(() => {
        window.restoreWaitingViewportV155?.(waitingSnapshot);
      }, 0);
    } catch (error) {
      console.error(error);
      showToast(`Done GR gagal: ${error.message}`);
    } finally {
      if (btn && !successV155 && document.body.contains(btn)) {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
        btn.classList.remove("opacity-60", "cursor-wait");
        btn.innerHTML = buttonHtmlBeforeV155;
      }
    }
  };

  window.handoverGrnTicketV15 = async function handoverGrnTicketV15(
    ticketId,
    btn = null,
  ) {
    const ticket = (state.dashboard?.queue || []).find(
      (row) => String(row.ticket_id) === String(ticketId),
    );
    if (!ticket) return showToast("Ticket tidak ditemukan.");
    if (!ticket.all_done_gr) {
      return showToast(
        `Handover belum bisa. GR selesai ${ticket.gr_done_count || 0}/${ticket.gr_total_count || ticket.po_rows?.length || 0} PO.`,
      );
    }
    if (!confirm(`Handover GRN ${ticket.queue_no || "-"}?`)) return;

    const waitingSnapshot = window.captureWaitingViewportV155?.() || null;
    const buttonHtmlBeforeV155 = btn?.innerHTML || "";
    let successV155 = false;

    if (btn) {
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      btn.classList.add("opacity-60", "cursor-wait");
      btn.innerHTML =
        '<span class="material-symbols-outlined text-base animate-spin">progress_activity</span> Menyimpan...';
    }

    showToast("Menyimpan Handover GRN...");

    try {
      const result = await handoverGrnToBackendV15({
        ticket_id: ticket.ticket_id,
        queue_no: ticket.queue_no,
        plat_number: ticket.plat_number,
        operational_date: ticket.operational_date,
        ...actorPayloadV15(),
      });

      applyBackendActionResult(result);
      successV155 = true;
      showToast("Handover GRN selesai.");
      renderPage("laporan", false);
      setTimeout(() => {
        window.restoreWaitingViewportV155?.(waitingSnapshot);
      }, 0);
    } catch (error) {
      console.error(error);
      showToast(`Handover GRN gagal: ${error.message}`);
    } finally {
      if (btn && !successV155 && document.body.contains(btn)) {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
        btn.classList.remove("opacity-60", "cursor-wait");
        btn.innerHTML = buttonHtmlBeforeV155;
      }
    }
  };

  window.advanceGrStatusFromKey = async function advanceGrStatusFromKeyV15(
    encodedKey = "",
    targetStatus = "",
    btn = null,
  ) {
    const ticket =
      typeof findCheckerRowByKey === "function"
        ? findCheckerRowByKey(encodedKey)
        : null;
    if (!ticket) return showToast("Ticket tidak ditemukan.");
    const target = String(targetStatus || "").toUpperCase();
    if (target === "COMPLETED")
      return handoverGrnTicketV15(ticket.ticket_id, btn);
    showToast("Done GR sekarang dilakukan per PO melalui Detail Waiting List.");
  };
})();

/* ==========================================================================
 * V16 — MANUAL SECURITY INPUT + CHECKER ACTION FEEDBACK
 * ========================================================================== */
(function installInboundV16ApiUi() {
  if (window.__inboundV16ApiUiInstalled) return;
  window.__inboundV16ApiUiInstalled = true;

  function ticketTypeV16() {
    const form = document.getElementById("security-form");
    return String(form?.ticket_type?.value || "REG")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "-");
  }

  window.lookupMultiplePo = function lookupMultiplePoV16(
    poText,
    vendorText = "",
  ) {
    const poNumbers = parsePoNumbers(poText);
    const selectedVendor = String(vendorText || "").trim();
    const selectedVendorKey = normalizeKey(selectedVendor);
    const selectedVendorIsMaster = (state.options?.vendor_name || []).some(
      (vendor) => normalizeKey(vendor) === selectedVendorKey,
    );
    const items = [];
    const vendorMismatch = [];

    for (const po of poNumbers) {
      const key = normalizeKey(po);
      const found = v2PoIndex?.[key];

      if (!found) {
        // PO manual tetap dibuat sebagai child row dengan qty/SKU default 0.
        items.push({
          po_number: po,
          po_input: po,
          vendor_name: selectedVendor,
          slot: String(
            document.querySelector('#security-form [name="slot"]')?.value ||
              "3",
          ),
          total_po_qty: 0,
          count_po_sku: 0,
          data_source: "MANUAL",
          is_manual_po: true,
        });
        continue;
      }

      const foundVendor = String(found.vendor_name || "").trim();
      const foundVendorKey = normalizeKey(foundVendor);
      const mismatch =
        selectedVendorKey &&
        foundVendorKey &&
        !foundVendorKey.includes(selectedVendorKey) &&
        !selectedVendorKey.includes(foundVendorKey);

      // Vendor master yang berbeda tetap diblokir. Vendor manual boleh override.
      if (mismatch && selectedVendorIsMaster) {
        vendorMismatch.push({
          ...found,
          po_number: found.po_number || po,
          po_input: po,
          vendor_name: foundVendor,
        });
        continue;
      }

      items.push({
        ...found,
        po_number: found.po_number || po,
        po_input: po,
        vendor_name: mismatch ? selectedVendor : foundVendor || selectedVendor,
        is_manual_vendor: mismatch,
      });
    }

    const dropOff = ["DROP", "DROP-OFF"].includes(ticketTypeV16());
    if (dropOff && !poNumbers.length) {
      items.push({
        po_number: "",
        po_input: "",
        vendor_name: selectedVendor,
        slot: String(
          document.querySelector('#security-form [name="slot"]')?.value || "3",
        ),
        total_po_qty: 0,
        count_po_sku: 0,
        data_source: "MANUAL",
        is_drop_off: true,
      });
    }

    const vendors = [
      ...new Set(
        items
          .map((item) => String(item.vendor_name || "").trim())
          .filter(Boolean),
      ),
    ];
    const slots = [
      ...new Set(
        items.map((item) => String(item.slot || "").trim()).filter(Boolean),
      ),
    ];
    const totalQty = items.reduce(
      (sum, item) => sum + toNumberV2(item.total_po_qty),
      0,
    );
    const totalSku = items.reduce(
      (sum, item) => sum + toNumberV2(item.count_po_sku),
      0,
    );

    return {
      found: items.length > 0,
      all_found:
        items.length > 0 &&
        vendorMismatch.length === 0 &&
        (poNumbers.length > 0 || dropOff),
      po_numbers: poNumbers,
      items,
      missing_po: [],
      vendor_mismatch: vendorMismatch,
      summary: {
        po_number: poNumbers.join(", "),
        po_numbers: poNumbers,
        vendor_name: selectedVendor || vendors.join(", "),
        vendor_names: vendors,
        slot: ["1", "2", "3"].includes(slots[0]) ? slots[0] : "3",
        slots,
        total_po_qty: totalQty,
        count_po_sku: totalSku,
        found_count: items.length,
        missing_count: 0,
        vendor_mismatch_count: vendorMismatch.length,
        manual_count: items.filter(
          (item) =>
            item.is_manual_po || item.is_manual_vendor || item.is_drop_off,
        ).length,
      },
    };
  };
  try {
    lookupMultiplePo = window.lookupMultiplePo;
  } catch (error) {}

  window.lookupPo = function lookupPoV16(silent = false) {
    const form = document.getElementById("security-form");
    if (!form) return null;

    const poText = form.po_number?.value || "";
    const vendorText = form.vendor_name?.value || "";
    const dropOff = ["DROP", "DROP-OFF"].includes(ticketTypeV16());

    if (!parsePoNumbers(poText).length && !dropOff) {
      state.poLookup = null;
      updatePoLookupUi(null);
      return null;
    }

    const lookup = window.lookupMultiplePo(poText, vendorText);
    state.poLookup = lookup;
    updatePoLookupUi(lookup);

    if (!silent) {
      if (dropOff && !parsePoNumbers(poText).length) {
        showToast("DROP-OFF aktif. PO Number tidak wajib.");
      } else if (lookup.all_found) {
        showToast(`${lookup.items.length} PO siap digunakan.`);
      } else if (lookup.vendor_mismatch?.length) {
        showToast(`${lookup.vendor_mismatch.length} PO berbeda vendor.`);
      }
    }

    return lookup.found ? lookup : null;
  };
  try {
    lookupPo = window.lookupPo;
  } catch (error) {}

  window.nextLocalQueueNoFromList = function nextLocalQueueNoFromListV16(
    ticketType,
    slot,
    queue = [],
  ) {
    const rawType = String(ticketType || "REG")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "-");
    const type = rawType === "DROP" ? "DROP-OFF" : rawType;
    const slotText = ["1", "2", "3"].includes(String(slot))
      ? String(slot)
      : "3";
    const operationalDate =
      typeof getOperationalDateKey === "function"
        ? getOperationalDateKey(new Date())
        : "";
    const sameSlot = queue.filter((row) =>
      String(row.slot || queueSlotValue(row) || "") === slotText &&
      (!operationalDate ||
        (typeof getRowOperationalDateKey === "function"
          ? getRowOperationalDateKey(row)
          : String(row.operational_date || "")) === operationalDate),
    );
    const nextSeq =
      sameSlot.reduce(
        (max, row) =>
          Math.max(
            max,
            queueSequenceNumber(row.queue_no || row.original_queue_no || ""),
          ),
        0,
      ) + 1;
    return `${type} ${slotText}-${nextSeq}`;
  };
  try {
    nextLocalQueueNoFromList = window.nextLocalQueueNoFromList;
  } catch (error) {}

  // Finish unloading tidak boleh dikirim bila checker belum seluruhnya DONE.
  const submitCheckerBeforeV16 = window.submitChecker;
  window.submitChecker = async function submitCheckerV16(event) {
    const form = event?.target;
    const targetStatus = String(form?.status?.value || "").toUpperCase();
    if (
      targetStatus === "WAITING GR" &&
      form?.dataset?.allCheckerDoneV16 !== "1"
    ) {
      const progress = form?.dataset?.checkerProgressV16 || "0/0";
      showToast(`Belum bisa Finish Unloading. Done Checking baru ${progress}.`);
      return;
    }
    return submitCheckerBeforeV16.apply(this, arguments);
  };
  try {
    submitChecker = window.submitChecker;
  } catch (error) {}

  // V16.7: helper actor wajib berada di scope IIFE V16.
  // Helper V15 berada di IIFE lama sehingga tidak dapat dipanggil langsung di sini.
  function actorPayloadV16() {
    const user = typeof getAuthUser === "function" ? getAuthUser() || {} : {};
    return {
      actor_role: String(user.role || "").toUpperCase(),
      actor_name: user.display_name || user.username || user.role || "",
      actor_username: user.username || "",
    };
  }

  // Feedback Start/Done checker: status di modal langsung diperbarui dan modal
  // dibuka ulang dari state hasil backend, bukan menunggu auto-sync 5 detik.
  window.runCheckerPoActionV15 = async function runCheckerPoActionV16(
    action,
    ticket,
    poIds,
    checker,
    btn = null,
  ) {
    if (!ticket || !poIds?.length || !checker) {
      showToast("Pilih nama checker dan minimal satu PO.");
      return null;
    }

    const oldHtml = btn?.innerHTML || "";
    if (btn) {
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      btn.classList.add("opacity-60", "cursor-wait");
      btn.innerHTML =
        '<span class="material-symbols-outlined text-base animate-spin">progress_activity</span> Menyimpan...';
    }

    try {
      const payload = {
        ticket_id: ticket.ticket_id,
        queue_no: ticket.original_queue_no || ticket.queue_no,
        plat_number: ticket.plat_number,
        operational_date: ticket.operational_date,
        ticket_po_ids: poIds,
        checker_id: checker.checker_id || checker.mp_id,
        checker_name: checker.checker_name,
        ...actorPayloadV16(),
      };

      const result =
        action === "start"
          ? await startCheckerPoToBackendV15(payload)
          : await doneCheckerPoToBackendV15(payload);

      applyBackendActionResult(result);
      showToast(
        action === "start"
          ? `${poIds.length} PO mulai dikerjakan ${checker.checker_name}.`
          : `${poIds.length} PO selesai checking dan siap GR.`,
      );
      renderPage("checker", false);
      return result;
    } catch (error) {
      console.error(error);
      showToast(`Proses checker gagal: ${error.message}`);
      return null;
    } finally {
      if (btn && document.body.contains(btn)) {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
        btn.classList.remove("opacity-60", "cursor-wait");
        btn.innerHTML = oldHtml;
      }
    }
  };

  window.submitCheckerPoModalV15 = async function submitCheckerPoModalV16(
    action,
    btn,
  ) {
    const modal = document.getElementById("inbound-modal-v15");
    const ticketId = modal?.dataset.ticketId;
    const ticket = (state.dashboard?.queue || []).find(
      (row) => String(row.ticket_id || "") === String(ticketId || ""),
    );
    const checkerId = document.getElementById("checker-mp-select-v15")?.value;
    const checker = (
      state.options?.inbound_mp ||
      state.options?.checker_mp ||
      []
    ).find(
      (item) => String(item.checker_id || item.mp_id) === String(checkerId),
    );
    const poIds = [
      ...document.querySelectorAll(".checker-po-choice-v15:checked"),
    ].map((input) => input.value);

    if (!checker || !poIds.length) {
      showToast("Pilih nama checker dan PO.");
      return;
    }

    // V16.6 FIX: function expression `runCheckerPoActionV16` hanya punya
    // scope di dalam function itu sendiri. Panggil handler yang diekspos di
    // window supaya tombol Start/Done Checker benar-benar menjalankan request.
    const result = await window.runCheckerPoActionV15(
      action,
      ticket,
      poIds,
      checker,
      btn,
    );
    if (!result) return;

    closeInboundModalV15?.();
    setTimeout(() => {
      openCheckerPoPanelV15?.(ticketId);
      const select = document.getElementById("checker-mp-select-v15");
      if (select) select.value = checkerId;
    }, 0);
    setTimeout(() => forceGlobalAutoSyncV11?.(), 3500);
  };
})();

/* ==========================================================================
 * V18.0 — CONFIRM SHARED GATE
 * Gate aktif tetap dapat dipilih. Web meminta konfirmasi sebelum request
 * dikirim, sedangkan backend menyimpan warning tanpa memblokir proses.
 * ========================================================================== */
(function installSharedGateConfirmV180() {
  if (window.__sharedGateConfirmV180Installed) return;
  window.__sharedGateConfirmV180Installed = true;

  const submitCheckerBeforeV180 =
    typeof window.submitChecker === "function"
      ? window.submitChecker
      : typeof submitChecker === "function"
        ? submitChecker
        : null;

  if (!submitCheckerBeforeV180) return;

  function activeGateConflictsV180(form) {
    const selected =
      typeof parseGateList === "function"
        ? parseGateList(
            document.getElementById("checker-gate-value")?.value ||
              form?.gate?.value ||
              "",
          )
        : [];

    if (!selected.length) return [];

    const ticketId = String(form?.ticket_id?.value || "").trim();
    const queueNo = String(form?.queue_no?.value || "").trim();
    const plate =
      typeof normalizePlateValue === "function"
        ? normalizePlateValue(form?.plat_number?.value || "")
        : String(form?.plat_number?.value || "").trim();

    const conflicts = [];
    (state.dashboard?.queue || []).forEach((row) => {
      const status = String(row.status || "")
        .trim()
        .toUpperCase();
      if (!["CALLED", "UNLOADING"].includes(status)) return;

      const sameTicket =
        (ticketId && String(row.ticket_id || "").trim() === ticketId) ||
        (queueNo &&
          String(row.original_queue_no || row.queue_no || "").trim() ===
            queueNo) ||
        (plate &&
          typeof normalizePlateValue === "function" &&
          normalizePlateValue(row.plat_number || "") === plate);
      if (sameTicket) return;

      const rowGates =
        typeof parseGateList === "function"
          ? parseGateList(row.gate || "")
          : [];
      const overlap = selected.filter((gate) => rowGates.includes(gate));
      if (!overlap.length) return;

      conflicts.push({
        gates: overlap,
        queue_no: row.queue_no || row.ticket_id || "Ticket lain",
        plat_number: row.plat_number || "-",
        status,
        start_unloading_at: row.start_unloading_at || row.called_at || "-",
      });
    });

    return conflicts;
  }

  window.submitChecker = async function submitCheckerSharedGateV180(event) {
    const form = event?.target;
    if (!form || form.id !== "checker-form") {
      return submitCheckerBeforeV180(event);
    }

    const requested = String(form.status?.value || "CALLED")
      .trim()
      .toUpperCase();

    if (["CALLED", "UNLOADING"].includes(requested)) {
      if (typeof syncCheckerGateInput === "function") {
        syncCheckerGateInput();
      }

      const conflicts = activeGateConflictsV180(form);
      if (conflicts.length) {
        const detail = conflicts
          .map(
            (item) =>
              `${item.gates.join(", ")} sedang dipakai ${item.queue_no} — ${
                item.plat_number
              } (${item.status}, sejak ${item.start_unloading_at})`,
          )
          .join("\n");

        const approved = confirm(
          `Gate yang dipilih sedang aktif untuk kendaraan lain:\n\n${detail}\n\nTetap gunakan gate yang sama untuk bongkar?`,
        );
        if (!approved) {
          showToast("Pemilihan gate dibatalkan.");
          return;
        }
      }
    }

    return submitCheckerBeforeV180(event);
  };

  try {
    submitChecker = window.submitChecker;
  } catch (error) {}
})();

/* ==========================================================================
 * V18.2 — INSTANT ACTION UI / OPTIMISTIC UPDATE
 * - Status di layar berubah sebelum request GAS selesai.
 * - Response backend tetap menjadi sumber kebenaran.
 * - Jika backend gagal, state dikembalikan otomatis.
 * - Tidak ada forced refresh 150ms setelah action.
 * - WA tetap nonaktif.
 * ========================================================================== */
(function installInboundInstantActionV182() {
  if (window.__inboundInstantActionV182Installed) return;
  window.__inboundInstantActionV182Installed = true;

  const pendingKeys = new Set();
  let verifyTimer = null;

  function nowV182() {
    return typeof formatDateTimeLocal === "function"
      ? formatDateTimeLocal(new Date())
      : new Date().toISOString();
  }

  function actorV182() {
    const user = typeof getAuthUser === "function" ? getAuthUser() || {} : {};
    return {
      actor_role: String(user.role || "").toUpperCase(),
      actor_name: user.display_name || user.username || user.role || "",
      actor_username: user.username || "",
    };
  }

  function cellV182(row, names, fallback = "") {
    if (typeof getCell === "function") return getCell(row, names, fallback);
    for (const name of names) {
      if (
        row?.[name] !== undefined &&
        row?.[name] !== null &&
        row?.[name] !== ""
      ) {
        return row[name];
      }
    }
    return fallback;
  }

  function ticketIdV182(row) {
    return String(cellV182(row, ["ticket_id", "ticket id"], "")).trim();
  }

  function ticketPoIdV182(row) {
    return String(cellV182(row, ["ticket_po_id", "ticket po id"], "")).trim();
  }

  function outputRowsV182() {
    return typeof getOutputFormRows === "function"
      ? getOutputFormRows(v2RawResponse || {})
      : [];
  }

  function cloneV182(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return value && typeof value === "object" ? { ...value } : value;
    }
  }

  function patchTicketRowsV182({ ticketId, poIds = null, patch }) {
    const output = outputRowsV182();
    const poSet = poIds ? new Set(poIds.map((id) => String(id))) : null;
    const before = [];
    const changed = [];

    const next = output.map((row) => {
      if (ticketIdV182(row) !== String(ticketId || "")) return row;
      if (poSet && !poSet.has(ticketPoIdV182(row))) return row;

      before.push(cloneV182(row));
      const updated = {
        ...row,
        ...(typeof patch === "function" ? patch(row) : patch || {}),
      };
      changed.push(updated);
      return updated;
    });

    if (!changed.length) return { before: [], changed: [] };

    v2RawResponse = {
      ...(v2RawResponse || {}),
      status: "success",
      timestamp: new Date().toISOString(),
      outputForm: next,
    };
    state.dashboard = buildDashboardFromV2(v2RawResponse);
    state.options = state.dashboard.options || state.options;
    return { before, changed };
  }

  function restoreRowsV182(snapshot = []) {
    if (!snapshot.length) return;
    const restoreMap = new Map(
      snapshot.map((row) => [
        typeof ticketIdentity === "function"
          ? ticketIdentity(row)
          : `${ticketIdV182(row)}|${ticketPoIdV182(row)}`,
        row,
      ]),
    );

    const next = outputRowsV182().map((row) => {
      const key =
        typeof ticketIdentity === "function"
          ? ticketIdentity(row)
          : `${ticketIdV182(row)}|${ticketPoIdV182(row)}`;
      return restoreMap.get(key) || row;
    });

    v2RawResponse = {
      ...(v2RawResponse || {}),
      timestamp: new Date().toISOString(),
      outputForm: next,
    };
    state.dashboard = buildDashboardFromV2(v2RawResponse);
    state.options = state.dashboard.options || state.options;
  }

  function renderInstantV182(page = state.page) {
    const safePage = String(page || state.page || "checker");
    const waitingSnapshot =
      safePage === "laporan" &&
      typeof window.captureWaitingViewportV155 === "function"
        ? window.captureWaitingViewportV155()
        : null;

    renderPage(safePage, false);

    if (waitingSnapshot) {
      requestAnimationFrame(() => {
        window.restoreWaitingViewportV155?.(waitingSnapshot);
      });
    }
  }

  function applyServerResultV182(result = {}) {
    if (typeof applyBackendActionResult === "function") {
      applyBackendActionResult(result);
    }
  }

  function verifyLaterV182() {
    clearTimeout(verifyTimer);
    verifyTimer = setTimeout(() => {
      if (document.visibilityState === "visible") {
        window.forceGlobalAutoSyncV11?.();
      }
    }, 3500);
  }

  async function runOptimisticV182({
    key,
    page,
    mutate,
    request,
    successMessage,
    errorPrefix,
  }) {
    if (pendingKeys.has(key)) {
      showToast("Aksi yang sama sedang diproses.");
      return null;
    }
    pendingKeys.add(key);

    const snapshot = mutate();
    renderInstantV182(page);

    try {
      const result = await request();
      applyServerResultV182(result);
      showToast(
        typeof successMessage === "function"
          ? successMessage(result)
          : successMessage,
      );
      verifyLaterV182();
      return result;
    } catch (error) {
      console.error(error);
      restoreRowsV182(snapshot?.before || []);
      renderInstantV182(page);
      showToast(`${errorPrefix}: ${error.message}`);
      return null;
    } finally {
      pendingKeys.delete(key);
    }
  }

  // Start / Done Checking per PO.
  window.runCheckerPoActionV15 = async function runCheckerPoActionV182(
    action,
    ticket,
    poIds,
    checker,
    btn = null,
  ) {
    const isStart = action === "start";
    if (!ticket || !poIds?.length || (isStart && !checker)) {
      showToast(
        isStart
          ? "Pilih nama checker dan minimal satu PO."
          : "Pilih minimal satu PO yang sedang CHECKING.",
      );
      return null;
    }

    const now = nowV182();
    const payload = {
      ticket_id: ticket.ticket_id,
      queue_no: ticket.original_queue_no || ticket.queue_no,
      plat_number: ticket.plat_number,
      operational_date: ticket.operational_date,
      ticket_po_ids: poIds,
      checker_id: checker?.checker_id || checker?.mp_id || "",
      checker_name: checker?.checker_name || "",
      ...actorV182(),
    };

    return runOptimisticV182({
      key: `checker:${action}:${ticket.ticket_id}:${poIds.join(",")}`,
      page: "checker",
      mutate: () =>
        patchTicketRowsV182({
          ticketId: ticket.ticket_id,
          poIds,
          patch: (row) =>
            isStart
              ? {
                  checker_id: payload.checker_id,
                  checker_name: payload.checker_name,
                  checker_status: "CHECKING",
                  checker_started_at:
                    cellV182(row, ["checker_started_at"], "") || now,
                  checker_started_by:
                    payload.actor_name || payload.actor_username,
                  updated_at: now,
                }
              : {
                  checker_id: cellV182(row, ["checker_id"], ""),
                  checker_name: cellV182(row, ["checker_name"], ""),
                  checker_status: "DONE",
                  checker_done_at: now,
                  checker_done_by: payload.actor_name || payload.actor_username,
                  gr_status:
                    String(
                      cellV182(row, ["gr_status"], "PENDING"),
                    ).toUpperCase() === "DONE GR"
                      ? "DONE GR"
                      : "WAITING GR",
                  waiting_gr_at: cellV182(row, ["waiting_gr_at"], "") || now,
                  updated_at: now,
                },
        }),
      request: () =>
        isStart
          ? startCheckerPoToBackendV15(payload)
          : doneCheckerPoToBackendV15(payload),
      successMessage: isStart
        ? `${poIds.length} PO mulai dikerjakan ${checker.checker_name}.`
        : `${poIds.length} PO selesai checking dan siap GR.`,
      errorPrefix: "Proses checker gagal",
    });
  };

  // Actual Qty + Done GR per PO.
  window.doneGrPoV15 = async function doneGrPoV182(
    ticketId,
    ticketPoId,
    btn = null,
  ) {
    const ticket = (state.dashboard?.queue || []).find(
      (row) => String(row.ticket_id) === String(ticketId),
    );
    if (!ticket) return showToast("Ticket tidak ditemukan.");

    const po = ticket.po_rows?.find(
      (row) => String(row.ticket_po_id) === String(ticketPoId),
    );
    if (!po) return showToast("PO tidak ditemukan.");

    const type = String(ticket.ticket_type || ticket.fleet_type || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "-");
    if (type.includes("DROP-OFF")) {
      return showToast("DROP-OFF tidak memerlukan Done GR.");
    }

    const qtyInputId = `actual-qty-${String(
      po.ticket_po_id || po.po_number || "",
    ).replace(/[^A-Za-z0-9_-]/g, "_")}`;
    const qtyInput = document.getElementById(qtyInputId);
    const actualQuantity = Number(qtyInput?.value || po.actual_quantity || 0);
    if (!Number.isFinite(actualQuantity) || actualQuantity <= 0) {
      qtyInput?.classList.add("invalid");
      qtyInput?.focus();
      return showToast(
        `Actual Qty PO ${po.po_number || "-"} wajib diisi dan harus lebih dari 0.`,
      );
    }

    if (
      !confirm(
        `Done GR untuk PO ${po.po_number || "-"}?\n\nPO Qty: ${
          po.total_po_qty || 0
        }\nActual Qty: ${actualQuantity}`,
      )
    )
      return null;

    const now = nowV182();
    const actor = actorV182();
    const payload = {
      ticket_id: ticket.ticket_id,
      ticket_po_id: po.ticket_po_id,
      po_number: po.po_number,
      actual_quantity: actualQuantity,
      queue_no: ticket.queue_no,
      plat_number: ticket.plat_number,
      operational_date: ticket.operational_date,
      ...actor,
    };

    return runOptimisticV182({
      key: `gr:${ticket.ticket_id}:${po.ticket_po_id}`,
      page: "laporan",
      mutate: () =>
        patchTicketRowsV182({
          ticketId: ticket.ticket_id,
          poIds: [po.ticket_po_id],
          patch: {
            actual_quantity: actualQuantity,
            gr_status: "DONE GR",
            done_gr_at: now,
            done_gr_by: actor.actor_name || actor.actor_username,
            updated_at: now,
          },
        }),
      request: () => doneGrPoToBackendV15(payload),
      successMessage: (result) =>
        result?.all_done_gr
          ? "Actual Qty tersimpan. Semua PO DONE GR dan siap Handover GRN."
          : `Actual Qty ${actualQuantity} tersimpan. PO ${po.po_number} selesai GR.`,
      errorPrefix: "Done GR gagal",
    });
  };

  // Handover GRN.
  window.handoverGrnTicketV15 = async function handoverGrnTicketV182(
    ticketId,
    btn = null,
  ) {
    const ticket = (state.dashboard?.queue || []).find(
      (row) => String(row.ticket_id) === String(ticketId),
    );
    if (!ticket) return showToast("Ticket tidak ditemukan.");
    if (!ticket.all_done_gr) {
      return showToast(
        `Handover belum bisa. GR selesai ${ticket.gr_done_count || 0}/${
          ticket.gr_total_count || ticket.po_rows?.length || 0
        } PO.`,
      );
    }
    if (!confirm(`Handover GRN ${ticket.queue_no || "-"}?`)) return null;

    const now = nowV182();
    const payload = {
      ticket_id: ticket.ticket_id,
      queue_no: ticket.queue_no,
      plat_number: ticket.plat_number,
      operational_date: ticket.operational_date,
      ...actorV182(),
    };

    return runOptimisticV182({
      key: `handover:${ticket.ticket_id}`,
      page: "laporan",
      mutate: () =>
        patchTicketRowsV182({
          ticketId: ticket.ticket_id,
          patch: {
            status: "COMPLETED",
            handover_grn_at: now,
            completed_at: now,
            updated_at: now,
          },
        }),
      request: () => handoverGrnToBackendV15(payload),
      successMessage: "Handover GRN selesai.",
      errorPrefix: "Handover GRN gagal",
    });
  };

  // Finish unloading. DROP-OFF langsung COMPLETED.
  window.finishUnloadingTicketV165 = async function finishUnloadingTicketV182(
    ticketId,
    btn = null,
  ) {
    const ticket = (state.dashboard?.queue || []).find(
      (row) => String(row.ticket_id || "") === String(ticketId || ""),
    );
    if (!ticket) return showToast("Ticket tidak ditemukan. Refresh dulu.");

    const type = String(ticket.ticket_type || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "-");
    const fleet = String(ticket.fleet_type || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "-");
    const dropOff =
      type === "DROP" || type === "DROP-OFF" || fleet === "DROP-OFF";

    if (!dropOff && !ticket.all_checker_done) {
      return showToast(
        `Belum bisa Finish Unloading. Done Checking baru ${
          ticket.checker_done_count || 0
        }/${ticket.checker_total_count || ticket.po_rows?.length || 0}.`,
      );
    }

    const now = nowV182();
    const actor = actorV182();
    const body = {
      ticket_id: ticket.ticket_id,
      queue_no: ticket.original_queue_no || ticket.queue_no,
      vendor_name: ticket.vendor_name || "",
      fleet_type: ticket.fleet_type || "",
      plat_number: normalizePlateValue(ticket.plat_number || ""),
      gate: ticket.gate || "",
      operational_date:
        ticket.operational_date ||
        (typeof getOperationalDateKey === "function"
          ? getOperationalDateKey(new Date())
          : ""),
      status: dropOff ? "COMPLETED" : "WAITING GR",
      unload_sla: "ON PROCESS",
      waiting_gr_at: now,
      finish_unloading_at: now,
      completed_at: dropOff ? now : "",
      updated_at: now,
      ...actor,
    };

    return runOptimisticV182({
      key: `finish:${ticket.ticket_id}`,
      page: "checker",
      mutate: () =>
        patchTicketRowsV182({
          ticketId: ticket.ticket_id,
          patch: (row) => {
            if (dropOff) {
              return {
                status: "COMPLETED",
                checker_status: "SKIPPED",
                gr_status: "SKIPPED",
                finish_unloading_at: now,
                completed_at: now,
                updated_at: now,
              };
            }
            const grDone =
              String(cellV182(row, ["gr_status"], "PENDING")).toUpperCase() ===
              "DONE GR";
            return {
              status: grDone ? "DONE GR" : "WAITING GR",
              finish_unloading_at: now,
              waiting_gr_at: cellV182(row, ["waiting_gr_at"], "") || now,
              gr_status: grDone ? "DONE GR" : "WAITING GR",
              updated_at: now,
            };
          },
        }),
      request: () => updateCheckerToBackend(body),
      successMessage: dropOff
        ? "DROP-OFF selesai bongkar dan langsung COMPLETED."
        : "Finish Unloading berhasil.",
      errorPrefix: "Finish Unloading gagal",
    });
  };

  // Panggil ulang: count langsung berubah di layar.
  window.recallDriverFromKey = async function recallDriverFromKeyV182(
    encodedKey = "",
    btn = null,
  ) {
    const row =
      typeof findCheckerRowByKey === "function"
        ? findCheckerRowByKey(encodedKey)
        : null;
    if (!row) return showToast("Data ticket tidak ditemukan. Refresh dulu.");

    const oldCount = Number(row.call_count || 0) || 0;
    if (oldCount >= 3) {
      window.showDriverNoShowSuggestionFromKey?.(encodedKey, btn);
      return null;
    }

    const now = nowV182();
    const body = {
      ...buildBackendActionBodyFromRow(row),
      status: "CALLED",
      unload_sla: "ON PROCESS",
      gate: row.gate || "",
      called_at: row.called_at || now,
      updated_at: now,
      ...actorV182(),
    };

    return runOptimisticV182({
      key: `recall:${row.ticket_id}`,
      page: state.page,
      mutate: () =>
        patchTicketRowsV182({
          ticketId: row.ticket_id,
          patch: {
            status: "CALLED",
            call_count: oldCount + 1,
            last_call_at: now,
            last_call_attempt_at: now,
            updated_at: now,
          },
        }),
      request: () => updateCheckerToBackend(body),
      successMessage: (result) =>
        `Driver dipanggil ulang (${Math.min(
          Number(result?.call_count || oldCount + 1),
          3,
        )}/3)`,
      errorPrefix: "Panggil ulang gagal",
    });
  };

  // Expired: status berubah langsung.
  window.markDriverCallFailedFromKey = async function markDriverCallFailedV182(
    encodedKey = "",
    btn = null,
  ) {
    const row =
      typeof findCheckerRowByKey === "function"
        ? findCheckerRowByKey(encodedKey)
        : null;
    if (!row) return showToast("Data ticket tidak ditemukan. Refresh dulu.");
    const callCount = Number(row.call_count || 0) || 0;
    if (callCount < 3) {
      return showToast(
        "Gagal panggil baru bisa dipakai setelah driver dipanggil 3x.",
      );
    }

    const now = nowV182();
    const payload = {
      ...buildBackendActionBodyFromRow(row),
      reason:
        "Driver tidak hadir setelah dipanggil 3x. Driver wajib buat nomor antrian baru.",
      ...actorV182(),
    };

    return runOptimisticV182({
      key: `expire:${row.ticket_id}`,
      page: state.page,
      mutate: () =>
        patchTicketRowsV182({
          ticketId: row.ticket_id,
          patch: {
            status: "EXPIRED",
            call_count: 4,
            expired_at: now,
            expired_reason: payload.reason,
            updated_at: now,
          },
        }),
      request: () => failCallToBackend(payload),
      successMessage: "Antrian EXPIRED. Driver wajib buat nomor antrian baru.",
      errorPrefix: "Gagal expire antrian",
    });
  };

  // Pastikan referensi global lama mengarah ke override terbaru.
  try {
    runCheckerPoActionV15 = window.runCheckerPoActionV15;
    doneGrPoV15 = window.doneGrPoV15;
    handoverGrnTicketV15 = window.handoverGrnTicketV15;
    finishUnloadingTicketV165 = window.finishUnloadingTicketV165;
    recallDriverFromKey = window.recallDriverFromKey;
    markDriverCallFailedFromKey = window.markDriverCallFailedFromKey;
  } catch (error) {}

  // Tandai pilihan slot yang dibuat operator agar lookup PO berikutnya tidak
  // mengembalikannya ke Slot Adjusted dari master data.
  document.addEventListener("change", (event) => {
    const slot = event.target?.closest?.('#security-form [name="slot"]');
    if (slot) slot.dataset.manualSelection = "true";
  });
})();

/* V19 — setelah Mulai Bongkar berhasil, tampilkan langsung section Bongkar & Checking. */
(function installCheckerSectionTransitionV19() {
  const submitCheckerBeforeV19 = window.submitChecker;
  if (typeof submitCheckerBeforeV19 !== "function") return;
  window.submitChecker = async function submitCheckerV19(event) {
    const requested = String(event?.target?.status?.value || "").toUpperCase();
    const result = await submitCheckerBeforeV19.apply(this, arguments);
    if (requested === "UNLOADING" && result !== null) {
      window.setCheckerSection?.("process");
    }
    return result;
  };
  try { submitChecker = window.submitChecker; } catch (error) {}
})();
