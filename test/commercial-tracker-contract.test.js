const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
// Normalisasi akhir baris: berkas dapat ter-checkout sebagai CRLF di Windows
// dan LF di CI Linux. Assertion pada teks sumber tidak boleh bergantung pada itu.
const read = (file) =>
  fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const commercialSection = (source) => source.slice(
  source.indexOf("V23 — COMERCIAL"),
  source.indexOf("/* V19 — bulk Actual Qty", source.indexOf("V23 — COMERCIAL")),
);

test("COMERCIAL has desktop and mobile navigation with a dedicated read-only role", () => {
  const html = read("index.html");
  const app = read("js/app.js");

  assert.equal((html.match(/data-page="commercial"/g) || []).length, 2);
  assert.match(app, /ROLE_ACCESS\.COMERCIAL\s*=\s*\["commercial"\]/);
  assert.match(app, /ROLE_DEFAULT_PAGE\.COMERCIAL\s*=\s*"commercial"/);
  assert.match(app, /COMERCIAL Ticket Tracker/);
  assert.doesNotMatch(
    commercialSection(app),
    /phone_number|ktp_6_digit|updateCheckerToBackend|advanceDropoffTicket/,
  );
});

test("COMERCIAL reuses the QR driver dataset and tracking helpers", () => {
  const app = read("js/app.js");
  const section = commercialSection(app);

  assert.match(section, /state\.dashboard\?\.queue/);
  assert.match(section, /getInboundSlaInfo\(row\)/);
  assert.match(section, /getUnloadingEstimateInfo\(row\)/);
  assert.match(section, /makeDriverTrackUrl\(row\)/);
  assert.match(section, /checker_progress/);
  assert.match(section, /gr_progress/);
  assert.match(section, /po_rows/);
  assert.match(section, /id="commercial-date-filter" type="date"/);
  assert.match(section, /operationalDateOf\(row\) !== view\.date/);
  assert.match(section, /timeZone: "Asia\/Jakarta"/);
});

test("Supabase grants COMERCIAL only read actions", () => {
  const source = read("supabase/functions/inbound-api/index.ts");

  // Peran baca dan tulis kini berupa konstanta bernama, sehingga pengujian
  // memeriksa isi konstantanya, bukan susunan literal di dalam `if`.
  const readRoles = source.match(/const READ_ROLES = \[([^\]]*)\]/)?.[1] || "";
  const writeRoles = source.match(/const WRITE_ROLES = \[([^\]]*)\]/)?.[1] || "";

  assert.match(readRoles, /"COMERCIAL"/, "COMERCIAL must keep read access");
  assert.doesNotMatch(writeRoles, /"COMERCIAL"/, "COMERCIAL must never write");

  // Aksi baca memakai READ_ROLES; aksi tulis memakai WRITE_ROLES.
  assert.match(
    source,
    /if \(\["state", "state_delta", "realtime_config", "tickets", "export_rows", "sites"\]\.includes\(action\)\) \{\s*return READ_ROLES\.includes\(role\);/,
  );
  assert.match(
    source,
    /if \(\["create_ticket", "create_tickets_bulk"\]\.includes\(action\)\) \{\s*return WRITE_ROLES\.includes\(role\);/,
  );
  // Master PO adalah payload berat untuk layar pendaftaran; COMERCIAL tidak berhak.
  assert.match(source, /if \(action === "po_master"\) return WRITE_ROLES\.includes\(role\);/);

  assert.match(source, /Deno\.env\.get\("INBOUND_COMMERCIAL_USER"\)/);
  assert.match(source, /return \[\.\.\.users, \.\.\.commercialUsers\]/);
});
