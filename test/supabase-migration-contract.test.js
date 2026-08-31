const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
// Normalisasi akhir baris: berkas dapat ter-checkout sebagai CRLF di Windows
// dan LF di CI Linux. Assertion pada teks sumber tidak boleh bergantung pada itu.
const read = (file) =>
  fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");

test("production frontend calls Supabase Edge Function with bearer session", () => {
  const config = read("js/supabase_backend.js");
  const api = read("js/api_v2.js");
  const app = read("js/app.js");
  assert.match(config, /supabase\.co\/functions\/v1\/inbound-api/);
  assert.match(api, /getInboundSessionToken/);
  assert.match(app, /setInboundSessionToken/);
  assert.doesNotMatch(config, /service[_-]?role/i);
});

test("Vercel deployment package excludes every backend and secret-bearing file", () => {
  const ignored = read(".vercelignore").split(/\r?\n/).filter(Boolean);
  for (const required of ["api", "supabase", "data", ".env*", "package.json"]) {
    assert.ok(ignored.includes(required), `${required} must be excluded from Vercel`);
  }
});

test("Supabase package owns schema, RLS, API, sync, and scheduler", () => {
  const files = [
    "supabase/migrations/20260824010000_inbound_core.sql",
    "supabase/migrations/20260824011000_inbound_admin_and_ba.sql",
    "supabase/migrations/20260824012000_inbound_cron.sql",
    "supabase/functions/inbound-api/index.ts",
    "supabase/functions/sync-superset/index.ts",
    "supabase/functions/sync-gsheet/index.ts",
  ].map(read).join("\n");
  assert.match(files, /enable row level security/i);
  assert.match(files, /inbound_create_tickets_bulk/i);
  assert.match(files, /inbound_finalize_superset_sync/i);
  assert.match(files, /\*\/5 \* \* \* \*/);
});
