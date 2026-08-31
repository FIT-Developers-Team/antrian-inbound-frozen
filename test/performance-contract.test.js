const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const frontendSource = fs.readFileSync(
  path.join(__dirname, "..", "js", "api_v2.js"),
  "utf8",
);
const appSource = fs.readFileSync(
  path.join(__dirname, "..", "js", "app.js"),
  "utf8",
);
const styleSource = fs.readFileSync(
  path.join(__dirname, "..", "style.css"),
  "utf8",
);
const backendSource = fs.readFileSync(
  path.join(__dirname, "..", "api", "inbound.js"),
  "utf8",
);

function extractFunction(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  const end = source.indexOf(nextSignature, start);
  assert.ok(start >= 0 && end > start, `${signature} must be present`);
  return source.slice(start, end);
}

test("security multi-ticket submit uses one bulk HTTP request", async () => {
  const functionSource = extractFunction(
    frontendSource,
    "async function submitSecurityRowsToBackend",
    "\nfunction getTicketWaFeedbackV171",
  );
  const calls = [];
  const context = {
    Map,
    String,
    motherDuckApiPost: async (action, payload) => {
      calls.push({ action, payload });
      return {
        created: payload.tickets.map((item) => ({
          ticket_id: item.ticket.ticket_id,
          queue_no: item.ticket.queue_no,
          operational_date: "2026-08-02",
        })),
      };
    },
  };
  vm.runInNewContext(
    `${functionSource}; globalThis.__submit = submitSecurityRowsToBackend;`,
    context,
  );
  const rows = Array.from({ length: 6 }, (_, index) => ({
    ticket_id: `T-${index + 1}`,
    queue_no: `REG 1-${index + 1}`,
    po_number: `PO-${index + 1}`,
    data_source: index === 0 ? "MANUAL" : "BACKEND",
  }));

  const result = await context.__submit(rows);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "create_tickets_bulk");
  assert.equal(calls[0].payload.tickets.length, 6);
  assert.equal(calls[0].payload.tickets[0].pos[0].is_manual, true);
  assert.equal(calls[0].payload.tickets[1].pos[0].is_manual, false);
  assert.equal(result.rows.length, 6);
});

test("Daftar exposes explicit manual vendor and PO choices", () => {
  assert.match(appSource, /function commitManualVendor/);
  assert.match(appSource, /Gunakan vendor manual/);
  assert.match(appSource, /Gunakan PO manual/);
  assert.match(appSource, /Tambah \/ Manual/);
  assert.match(
    appSource,
    /function commitPendingManualSecurityInputs[\s\S]*commitPendingManualSecurityInputs\(form\);/,
  );
  assert.match(appSource, /if \(!currentVendorIsMaster \|\| !getPoMeta\(po\)\) return true;/);
});

test("Waiting Monitor keeps gate visibility and makes the full queue the primary workspace", () => {
  assert.match(appSource, /function gatePanelV22\(rows\)/);
  assert.match(appSource, /Visibilitas Gate Bongkar/);
  assert.match(appSource, /Klik gate aktif untuk memfilter Queue Operasional/);
  // Gate panel tidak lagi menyaring hardcoded "STL-"; sekarang hanya gate
  // milik gudang yang sedang dipilih yang ditampilkan.
  assert.match(appSource, /gate\.toUpperCase\(\)\.startsWith\(`\$\{siteCode\}-`\)/);
  assert.doesNotMatch(appSource, /startsWith\("STL-"\)/);
  assert.match(appSource, /wm19-layout[\s\S]*tableV19\(rows\)[\s\S]*riskListV19\(rows\)[\s\S]*flowV19\(rows\)/);
  assert.doesNotMatch(
    extractFunction(appSource, "function tableV19", "\n  window.wmFilterV19"),
    /slice\(0, 12\)/,
  );
  assert.match(styleSource, /\.wm19-table-wrap \{ max-height:680px; overflow:auto;/);
  assert.match(styleSource, /\.wm19-gate-grid \{ display:grid; grid-template-columns:repeat\(5/);
});

test("auto sync polls no faster than every ten seconds", () => {
  const interval = Number(
    frontendSource.match(/const INTERVAL_MS = (\d+);/)?.[1],
  );
  assert.ok(interval >= 10_000, `poll interval was ${interval}ms`);
  assert.match(frontendSource, /document\.visibilityState === "hidden"/);
  assert.match(frontendSource, /const FULL_REFRESH_MS = 5 \* 60 \* 1000;/);
});

test("backend exposes authorized transactional bulk ticket creation", () => {
  assert.match(backendSource, /"create_tickets_bulk"/);
  assert.match(
    backendSource,
    /async function createTicketsBulk[\s\S]*client\.query\("BEGIN"\)[\s\S]*client\.query\("COMMIT"\)[\s\S]*client\.query\("ROLLBACK"\)/,
  );
  assert.match(
    backendSource,
    /req\.method === "POST" && action === "create_tickets_bulk"/,
  );
});

test("Superset sync follows the latest saved chart query context", () => {
  const functionSource = extractFunction(
    backendSource,
    "async function fetchSupersetPoRows",
    "\nfunction asNumber",
  );
  assert.match(
    functionSource,
    /\/api\/v1\/chart\/20662\/data\/\?force=true/,
  );
  assert.doesNotMatch(functionSource, /security\/csrf_token/);
  assert.doesNotMatch(functionSource, /supersetChartRequest/);
});

test("delta merge updates changed rows and removes deleted tickets", () => {
  const functionSource = extractFunction(
    frontendSource,
    "function outputRowKeyV12",
    "\nasync function fetchV2Data",
  );
  const context = { String, Set, Map, Array };
  vm.runInNewContext(
    `${functionSource}; globalThis.__merge = mergeOutputDeltaV12;`,
    context,
  );
  const current = [
    { ticket_id: "T-1", ticket_po_id: "P-1", status: "WAITING" },
    { ticket_id: "T-2", ticket_po_id: "P-2", status: "WAITING" },
  ];
  const delta = [
    { ticket_id: "T-1", ticket_po_id: "P-1", status: "UNLOADING" },
    { ticket_id: "T-3", ticket_po_id: "P-3", status: "WAITING" },
  ];

  const merged = context.__merge(current, delta, ["T-1", "T-3"]);

  assert.deepEqual(
    JSON.parse(JSON.stringify(merged)),
    [
      { ticket_id: "T-1", ticket_po_id: "P-1", status: "UNLOADING" },
      { ticket_id: "T-3", ticket_po_id: "P-3", status: "WAITING" },
    ],
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__merge(current, [], []))),
    [],
  );
});

test("backend delta endpoint is authenticated and accepts a cursor", () => {
  assert.match(backendSource, /"state_delta"/);
  assert.match(backendSource, /async function getAppStateDelta/);
  assert.match(
    backendSource,
    /req\.method === "GET" && action === "state_delta"/,
  );
});

test("realtime broadcast only signals clients and keeps polling as fallback", () => {
  const indexSource = fs.readFileSync(
    path.join(__dirname, "..", "index.html"),
    "utf8",
  );
  const realtimeSource = fs.readFileSync(
    path.join(__dirname, "..", "js", "realtime_client_source.js"),
    "utf8",
  );

  assert.match(indexSource, /js\/realtime_client\.js\?v=/);
  assert.match(realtimeSource, /action=realtime_config/);
  assert.match(realtimeSource, /\.on\("broadcast"/);
  assert.match(realtimeSource, /forceGlobalAutoSyncV11/);
  assert.match(realtimeSource, /Polling cadangan aktif/);
  assert.match(backendSource, /waitUntil\(task\)/);
  assert.match(backendSource, /realtime\/v1\/api\/broadcast/);
});

test("public realtime config never exposes the server secret", () => {
  const hooks = require("../api/inbound.js")._test;
  const previous = {
    url: process.env.SUPABASE_REALTIME_URL,
    publishable: process.env.SUPABASE_REALTIME_PUBLISHABLE_KEY,
    secret: process.env.SUPABASE_REALTIME_SECRET_KEY,
  };
  process.env.SUPABASE_REALTIME_URL = "https://project.supabase.co";
  process.env.SUPABASE_REALTIME_PUBLISHABLE_KEY = "sb_publishable_test";
  process.env.SUPABASE_REALTIME_SECRET_KEY = "sb_secret_never_expose";
  try {
    const config = hooks.realtimePublicConfig();
    assert.equal(config.enabled, true);
    assert.equal(config.publishable_key, "sb_publishable_test");
    assert.equal(JSON.stringify(config).includes("sb_secret_never_expose"), false);
  } finally {
    if (previous.url === undefined) delete process.env.SUPABASE_REALTIME_URL;
    else process.env.SUPABASE_REALTIME_URL = previous.url;
    if (previous.publishable === undefined) delete process.env.SUPABASE_REALTIME_PUBLISHABLE_KEY;
    else process.env.SUPABASE_REALTIME_PUBLISHABLE_KEY = previous.publishable;
    if (previous.secret === undefined) delete process.env.SUPABASE_REALTIME_SECRET_KEY;
    else process.env.SUPABASE_REALTIME_SECRET_KEY = previous.secret;
  }
});

test("realtime broadcast sends only an invalidation timestamp", async () => {
  const hooks = require("../api/inbound.js")._test;
  const previous = {
    url: process.env.SUPABASE_REALTIME_URL,
    publishable: process.env.SUPABASE_REALTIME_PUBLISHABLE_KEY,
    secret: process.env.SUPABASE_REALTIME_SECRET_KEY,
    fetch: global.fetch,
  };
  const calls = [];
  process.env.SUPABASE_REALTIME_URL = "https://project.supabase.co/";
  process.env.SUPABASE_REALTIME_PUBLISHABLE_KEY = "sb_publishable_test";
  process.env.SUPABASE_REALTIME_SECRET_KEY = "sb_secret_server_only";
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200 };
  };
  try {
    assert.equal(await hooks.publishRealtimeChange(), true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /realtime\/v1\/api\/broadcast\/inbound-cbt-operations\/events\/ticket-changed$/);
    assert.equal(calls[0].options.headers.apikey, "sb_secret_server_only");
    assert.deepEqual(Object.keys(JSON.parse(calls[0].options.body)), ["changed_at"]);
  } finally {
    global.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.SUPABASE_REALTIME_URL;
    else process.env.SUPABASE_REALTIME_URL = previous.url;
    if (previous.publishable === undefined) delete process.env.SUPABASE_REALTIME_PUBLISHABLE_KEY;
    else process.env.SUPABASE_REALTIME_PUBLISHABLE_KEY = previous.publishable;
    if (previous.secret === undefined) delete process.env.SUPABASE_REALTIME_SECRET_KEY;
    else process.env.SUPABASE_REALTIME_SECRET_KEY = previous.secret;
  }
});

test("bulk backend keeps queue sequences independent per type and slot", async () => {
  const { createTicketsBulk } = require("../api/inbound.js")._test;
  const tickets = [];
  const transactionLog = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
        transactionLog.push(normalized);
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("SELECT DISTINCT po_number FROM superset_po_master")) {
        return { rows: params.map((po_number) => ({ po_number })), rowCount: params.length };
      }
      if (normalized.startsWith("SELECT queue_no FROM tickets")) {
        return {
          rows: tickets
            .filter((ticket) => ticket.slot === params[0] && ticket.ticket_type === params[1])
            .map((ticket) => ({ queue_no: ticket.queue_no })),
          rowCount: tickets.length,
        };
      }
      if (normalized.startsWith("INSERT INTO tickets")) {
        tickets.push({
          ticket_id: params[0],
          queue_no: params[1],
          ticket_type: params[2],
          slot: params[10],
        });
        return { rows: [], rowCount: 1 };
      }
      if (
        normalized.startsWith("INSERT INTO ticket_pos") ||
        normalized.startsWith("INSERT INTO ticket_events") ||
        normalized.startsWith("INSERT INTO gsheet_sync_outbox")
      ) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in test: ${normalized}`);
    },
  };
  const body = {
    tickets: [
      { ticket: { ticket_id: "T-1", ticket_type: "REG", slot: "1" }, pos: [{ po_number: "PO-1" }] },
      { ticket: { ticket_id: "T-2", ticket_type: "DROP-OFF", slot: "1" }, pos: [{ po_number: "DROP-OFF" }] },
      { ticket: { ticket_id: "T-3", ticket_type: "REG", slot: "1" }, pos: [{ po_number: "PO-2" }] },
      { ticket: { ticket_id: "T-4", ticket_type: "VIP", slot: "1" }, pos: [{ po_number: "PO-3" }] },
      { ticket: { ticket_id: "T-5", ticket_type: "REG", slot: "2" }, pos: [{ po_number: "PO-4" }] },
    ],
  };

  const result = await createTicketsBulk(client, body);

  assert.deepEqual(result.created.map((ticket) => ticket.queue_no), [
    "REG 1-1",
    "DROP-OFF 1-1",
    "REG 1-2",
    "VIP 1-1",
    "REG 2-1",
  ]);
  assert.deepEqual(transactionLog, ["BEGIN", "COMMIT"]);
});

test("Drop-Off domain separates long-running tickets from the main queue", () => {
  const modulePath = path.join(__dirname, "..", "js", "dropoff_domain.js");
  assert.equal(fs.existsSync(modulePath), true, "Drop-Off domain module must exist");
  const domain = require(modulePath);
  const rows = [
    { ticket_id: "REG-1", ticket_type: "REG", status: "WAITING" },
    { ticket_id: "VIP-1", ticket_type: "VIP", status: "CALLED" },
    { ticket_id: "DROP-1", ticket_type: "DROP-OFF", status: "WAITING" },
    { ticket_id: "DROP-2", fleet_type: "DROP OFF", status: "UNLOADING" },
    { ticket_id: "DROP-3", queue_no: "DROP-OFF 2-7", status: "COMPLETED" },
  ];

  assert.deepEqual(domain.mainQueueRows(rows).map((row) => row.ticket_id), ["REG-1", "VIP-1"]);
  assert.deepEqual(domain.dropoffRows(rows).map((row) => row.ticket_id), ["DROP-1", "DROP-2", "DROP-3"]);
  assert.deepEqual(domain.summarizeDropoffs(rows), {
    total: 3,
    active: 2,
    waiting: 1,
    called: 0,
    unloading: 1,
    completed: 1,
    expired: 0,
  });
  assert.equal(
    domain.ageLabel(
      {
        created_at: "2026-08-09T02:00:00.000Z",
        register_time: "2026-08-11T16:00:00.000Z",
      },
      new Date("2026-08-11T16:00:00.000Z"),
    ),
    "2 hari 14 jam",
  );
  assert.equal(
    domain.ageLabel(
      { created_at: "09/08/2026 09:00:00" },
      new Date("2026-08-11T09:00:00+07:00"),
    ),
    "2 hari 0 jam",
  );
});

test("Drop-Off has a dedicated navigation route", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.equal((html.match(/data-page="dropoff"/g) || []).length, 2);
  assert.match(appSource, /installDropoffWorkspaceV21/);
  assert.match(appSource, /domain\.mainQueueRows/);
});

test("security ticket print targets one physical A6 portrait page", () => {
  const start = appSource.indexOf("function printSecurityTickets");
  const end = appSource.indexOf("\nfunction pageDaftar", start);
  const printSource = appSource.slice(start, end);

  assert.match(printSource, /@page \{ size: 105mm 148mm; margin: 5mm; \}/);
  assert.match(printSource, /width: 95mm; height: 138mm;/);
  assert.match(printSource, /break-after: page;/);
  assert.doesNotMatch(printSource, /size: A5/i);
});

test("Drop-Off start unloading persists its timestamp and requeues GSheet", async () => {
  const { updateTicketPos } = require("../api/inbound.js")._test;
  assert.equal(typeof updateTicketPos, "function");

  const statements = [];
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      statements.push(normalized);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("UPDATE tickets SET")) {
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO gsheet_sync_outbox")) {
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("SELECT t.ticket_id")) {
        return {
          rows: [{ ticket_id: "DROP-UNLOAD-1", status: "UNLOADING", gr_status: "PENDING" }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected SQL in test: ${normalized}`);
    },
  };

  await updateTicketPos(
    client,
    { ticket_id: "DROP-UNLOAD-1", status: "UNLOADING", gate: "Dock 01" },
    "updatechecker",
  );

  assert.match(
    statements.find((sql) => sql.startsWith("UPDATE tickets SET")) || "",
    /start_unloading_at = COALESCE\(start_unloading_at, CURRENT_TIMESTAMP\)/,
  );
  const requeueSql = statements.find((sql) => sql.startsWith("INSERT INTO gsheet_sync_outbox")) || "";
  assert.match(requeueSql, /ON CONFLICT \(ticket_po_id\) DO UPDATE SET/);
  assert.match(requeueSql, /sync_status = 'PENDING'/);
  assert.match(requeueSql, /SELECT p\.ticket_po_id, p\.ticket_id, 'PENDING', 0, NULL, now\(\), now\(\), NULL/);
  assert.doesNotMatch(requeueSql, /CURRENT_TIMESTAMP/);
  assert.deepEqual(statements.filter((sql) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)), ["BEGIN", "COMMIT"]);
});

test("direct ticket status changes also requeue every GSheet PO row", async () => {
  const { updateTicketStatus } = require("../api/inbound.js")._test;
  assert.equal(typeof updateTicketStatus, "function");

  const statements = [];
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      statements.push(normalized);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("UPDATE tickets SET")) {
        return { rows: [{ ticket_id: "DROP-DIRECT-1", status: "CALLED" }], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO ticket_events")) {
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO gsheet_sync_outbox")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in test: ${normalized}`);
    },
  };

  await updateTicketStatus(client, {
    ticket_id: "DROP-DIRECT-1",
    status: "CALLED",
    actor: { role: "CHECKER", name: "QA" },
  });

  assert.match(
    statements.find((sql) => sql.startsWith("INSERT INTO gsheet_sync_outbox")) || "",
    /WHERE p\.ticket_id IN \(\$1\)/,
  );
  assert.deepEqual(statements.filter((sql) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)), ["BEGIN", "COMMIT"]);
});

test("bulk backend accepts an explicitly manual PO outside Superset master", async () => {
  const { createTicketsBulk } = require("../api/inbound.js")._test;
  let masterLookupCount = 0;
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("SELECT DISTINCT po_number FROM superset_po_master")) {
        masterLookupCount += 1;
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("SELECT queue_no FROM tickets")) {
        return { rows: [], rowCount: 0 };
      }
      if (
        normalized.startsWith("INSERT INTO tickets") ||
        normalized.startsWith("INSERT INTO ticket_pos") ||
        normalized.startsWith("INSERT INTO ticket_events") ||
        normalized.startsWith("INSERT INTO gsheet_sync_outbox")
      ) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in test: ${normalized} ${params}`);
    },
  };

  const result = await createTicketsBulk(client, {
    tickets: [
      {
        ticket: {
          ticket_id: "T-MANUAL-1",
          ticket_type: "REG",
          slot: "3",
          vendor_name: "PT VENDOR DARURAT",
        },
        pos: [
          {
            po_number: "PO-MANUAL-001",
            vendor_name: "PT VENDOR DARURAT",
            is_manual: true,
          },
        ],
      },
    ],
  });

  assert.equal(result.inserted_tickets, 1);
  assert.equal(masterLookupCount, 0);
});

test("schema initialization is cached after the first request", async () => {
  const hooks = require("../api/inbound.js")._test;
  assert.equal(typeof hooks.ensureDatabaseReady, "function");
  hooks.resetSchemaCacheForTests();

  function fakeClient() {
    const queries = [];
    return {
      queries,
      async query(sql) {
        const normalized = String(sql).replace(/\s+/g, " ").trim();
        queries.push(normalized);
        if (normalized.includes("COUNT(*)::int AS count FROM product_master")) {
          return { rows: [{ count: 1 }], rowCount: 1 };
        }
        if (normalized.includes("COUNT(*) AS count FROM checker_master")) {
          return { rows: [{ count: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
  }

  const first = fakeClient();
  const second = fakeClient();
  await hooks.ensureDatabaseReady(first);
  await hooks.ensureDatabaseReady(second);

  assert.ok(first.queries.length > 20, "first request should initialize the schema");
  assert.deepEqual(second.queries, ["USE inbound_cbt_app"]);
});

test("ticket creation queues one durable GSheet sync job per PO", async () => {
  const hooks = require("../api/inbound.js")._test;
  const queued = [];
  let outboxInsertSql = "";
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("SELECT queue_no FROM tickets")) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("SELECT DISTINCT po_number FROM superset_po_master")) {
        return { rows: [{ po_number: "PO-1" }, { po_number: "PO-2" }], rowCount: 2 };
      }
      if (normalized.startsWith("INSERT INTO gsheet_sync_outbox")) {
        outboxInsertSql = normalized;
        queued.push(params[0]);
        return { rows: [], rowCount: 1 };
      }
      if (
        normalized.startsWith("INSERT INTO tickets") ||
        normalized.startsWith("INSERT INTO ticket_pos") ||
        normalized.startsWith("INSERT INTO ticket_events") ||
        normalized.startsWith("INSERT INTO gsheet_sync_outbox")
      ) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in test: ${normalized} ${params}`);
    },
  };

  await hooks.createTicketsBulk(client, {
    tickets: [{
      ticket: { ticket_id: "T-GSHEET-1", ticket_type: "REG", slot: "3" },
      pos: [
        { ticket_po_id: "TP-1", po_number: "PO-1" },
        { ticket_po_id: "TP-2", po_number: "PO-2" },
      ],
    }],
  });

  assert.deepEqual(queued, ["TP-1", "TP-2"]);
  assert.match(outboxInsertSql, /\bnow\(\)/i);
  assert.doesNotMatch(outboxInsertSql, /\bCURRENT_TIMESTAMP\b/i);
});

test("GSheet worker uses legacy submitSecurity contract and marks rows synced", async () => {
  const hooks = require("../api/inbound.js")._test;
  const updates = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.includes("FROM gsheet_sync_outbox o")) {
        return {
          rows: [
            { ticket_po_id: "TP-1", ticket_id: "T-1", queue_no: "REG 3-1", po_number: "PO-1" },
            { ticket_po_id: "TP-2", ticket_id: "T-1", queue_no: "REG 3-1", po_number: "PO-2" },
          ],
          rowCount: 2,
        };
      }
      if (normalized.startsWith("UPDATE gsheet_sync_outbox SET sync_status = 'PROCESSING'")) {
        return {
          rows: params.map((ticketPoId) => ({ ticket_po_id: ticketPoId })),
          rowCount: params.length,
        };
      }
      if (normalized.startsWith("UPDATE gsheet_sync_outbox SET sync_status = 'SYNCED'")) {
        updates.push(params);
        return { rows: [], rowCount: params.length };
      }
      throw new Error(`Unexpected SQL in test: ${normalized} ${params}`);
    },
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      async json() { return { status: "success" }; },
    };
  };

  const result = await hooks.syncPendingGsheetRows(client, fetchImpl, {
    url: "https://script.google.test/exec",
    secret: "server-secret",
    enabled: true,
  });

  assert.equal(result.synced, 2);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /[?&]action=submitSecurity/);
  assert.equal(requests[0].body.action, "submitSecurity");
  assert.equal(requests[0].body.payload.rows.length, 2);
  assert.equal(requests[0].body.payload.sync_mode, "upsert");
  assert.equal(requests[0].body.payload.sync_secret, "server-secret");
  assert.deepEqual(updates, [["TP-1", "TP-2"]]);
});

test("GSheet worker records failure without failing the ticket transaction", async () => {
  const hooks = require("../api/inbound.js")._test;
  let failureParams = null;
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.includes("FROM gsheet_sync_outbox o")) {
        return { rows: [{ ticket_po_id: "TP-FAIL", ticket_id: "T-FAIL" }], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE gsheet_sync_outbox SET sync_status = 'PROCESSING'")) {
        return { rows: [{ ticket_po_id: "TP-FAIL" }], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE gsheet_sync_outbox SET sync_status = 'FAILED'")) {
        failureParams = params;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in test: ${normalized} ${params}`);
    },
  };
  const fetchImpl = async () => ({
    ok: false,
    status: 503,
    async json() { return {}; },
  });

  await assert.rejects(
    hooks.syncPendingGsheetRows(client, fetchImpl, {
      url: "https://script.google.test/exec",
      secret: "",
      enabled: true,
    }),
    /HTTP 503/,
  );
  assert.equal(failureParams[0], "Google Sheets sync HTTP 503");
  assert.deepEqual(failureParams.slice(1), ["TP-FAIL"]);
});

test("ticket response schedules GSheet sync without awaiting Google", () => {
  const operationalJsonSource = extractFunction(
    backendSource,
    "function operationalJson",
    "\nfunction cookieValue",
  );
  const schedulerSource = extractFunction(
    backendSource,
    "function scheduleGsheetSync",
    "\nfunction operationalJson",
  );

  assert.match(operationalJsonSource, /scheduleGsheetSync\(\);/);
  assert.doesNotMatch(operationalJsonSource, /await\s+scheduleGsheetSync/);
  assert.match(schedulerSource, /waitUntil\(task\)/);
  assert.match(schedulerSource, /\.catch\(\(error\) =>/);
});

test("GSheet target is configured server-side and has no stale URL fallback", () => {
  const settingsSource = extractFunction(
    backendSource,
    "function gsheetSyncSettings",
    "\nasync function syncPendingGsheetRows",
  );
  assert.match(settingsSource, /process\.env\.GSHEET_SYNC_URL/);
  assert.match(settingsSource, /process\.env\.GSHEET_SYNC_SECRET/);
  assert.doesNotMatch(settingsSource, /script\.google\.com/);
});

test("GSheet rows match the 76-column waiting-list CSV contract", () => {
  const hooks = require("../api/inbound.js")._test;
  const output = hooks.formatGsheetOutputRow({
    ticket_id: "IBT-TEST-01",
    ticket_po_id: "IBT-TEST-01-PO-01",
    ktp_6_digit: "2040",
    po_number: "000553",
    status: "COMPLETED",
    source: "SECURITY_INPUT",
    created_at: "2026-08-08T09:39:27.134Z",
    start_unloading_at: "2026-08-08T10:58:07.674Z",
    finish_unloading_at: "2026-08-08T10:58:14.210Z",
    checker_started_at: "2026-08-08T10:58:07.674Z",
    checker_done_at: "2026-08-08T10:58:14.210Z",
    done_gr_at: "2026-08-08T17:15:57.998Z",
    ticket_done_gr_at: "2026-08-08T17:15:57.998Z",
    ticket_all_done_gr: true,
    fleet_type: "CDD",
    unload_sla: "ON PROCESS",
    po_sequence: 1,
    ticket_po_count: 2,
    ticket_total_qty: 600,
    ticket_total_sku: 5,
  });

  assert.equal(hooks.GSHEET_OUTPUT_HEADERS.length, 76);
  assert.deepEqual(Object.keys(output), hooks.GSHEET_OUTPUT_HEADERS);
  assert.equal(output.Timestamp, "2026-08-08 16:39:27");
  assert.equal(output.completed_at, "2026-08-08 17:58:14");
  assert.equal(output.ktp_6_digit, "002040");
  assert.equal(output.po_number, "000553");
  assert.equal(output.driver_waiting_duration, "01:19:00");
  assert.equal(output.driver_waiting_minutes, 79);
  assert.equal(output.gr_wait_duration, "06:18:00");
  assert.equal(output.gr_wait_minutes, 378);
  assert.equal(output.sla_target_hours, 2);
  assert.equal(output.sla_status, "SLA MISS");
  assert.equal(output.data_source, "MotherDuck");
  assert.equal(output.ticket_po_count, 2);
  assert.equal(output.ticket_total_qty, 600);
  assert.equal(output.wa_ticket_status, "");

  const completedWithoutDoneGr = hooks.formatGsheetOutputRow({
    status: "COMPLETED",
    fleet_type: "VAN",
    ticket_total_sku: 2,
    start_unloading_at: "2026-08-08T10:00:00.000Z",
    finish_unloading_at: "2026-08-08T10:30:00.000Z",
    ticket_all_done_gr: false,
  });
  assert.equal(completedWithoutDoneGr.sla_target_hours, 1);
  assert.equal(completedWithoutDoneGr.sla_status, "SLA OK");
});

test("historical GSheet backfill is secret-protected", () => {
  const hooks = require("../api/inbound.js")._test;
  const previousSecret = process.env.GSHEET_BACKFILL_SECRET;
  process.env.GSHEET_BACKFILL_SECRET = "backfill-secret";
  try {
    assert.equal(hooks.isGsheetBackfillAuthorized({
      headers: { "x-gsheet-backfill-secret": "backfill-secret" },
    }), true);
    assert.equal(hooks.isGsheetBackfillAuthorized({
      headers: { "x-gsheet-backfill-secret": "wrong-secret" },
    }), false);
  } finally {
    if (previousSecret === undefined) delete process.env.GSHEET_BACKFILL_SECRET;
    else process.env.GSHEET_BACKFILL_SECRET = previousSecret;
  }
});

test("historical GSheet backfill enqueues and syncs one idempotent cursor batch", async () => {
  const hooks = require("../api/inbound.js")._test;
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT ticket_po_id, ticket_id FROM ticket_pos")) {
        return {
          rows: [
            { ticket_po_id: "TP-101", ticket_id: "T-1" },
            { ticket_po_id: "TP-102", ticket_id: "T-2" },
          ],
          rowCount: 2,
        };
      }
      if (normalized.startsWith("INSERT INTO gsheet_sync_outbox")) {
        return { rows: [], rowCount: 2 };
      }
      if (normalized.startsWith("SELECT (SELECT COUNT(*)::INTEGER FROM ticket_pos)")) {
        return {
          rows: [{ total_rows: 2, synced_rows: 2, pending_rows: 0, failed_rows: 0 }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected SQL in test: ${normalized} ${params}`);
    },
  };
  let scopedIds = null;
  const syncImpl = async (_client, _fetch, _settings, ids) => {
    scopedIds = ids;
    return { synced: ids.length };
  };

  const result = await hooks.backfillGsheetBatch(client, { cursor: "TP-100", limit: 10 }, syncImpl);

  assert.deepEqual(scopedIds, ["TP-101", "TP-102"]);
  assert.deepEqual(queries[0].params, ["TP-100"]);
  assert.deepEqual(queries[1].params, ["TP-101", "TP-102"]);
  assert.equal(result.done, true);
  assert.equal(result.cursor, "TP-102");
  assert.equal(result.selected_rows, 2);
  assert.equal(result.synced_rows, 2);
  assert.deepEqual(result.status, {
    total_rows: 2,
    synced_rows: 2,
    pending_rows: 0,
    failed_rows: 0,
  });
});
