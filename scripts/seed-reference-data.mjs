import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");

function parseCsv(raw) {
  const rows = []; let row = []; let field = ""; let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"') {
      if (quoted && raw[index + 1] === '"') { field += '"'; index += 1; } else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && raw[index + 1] === "\n") index += 1;
      row.push(field); field = ""; if (row.some(Boolean)) rows.push(row); row = [];
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function loadEnv() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  const envPath = path.join(root, ".env.supabase.local");
  const raw = await fs.readFile(envPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

async function upsert(table, rows, conflict) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(conflict)}`;
  for (let offset = 0; offset < rows.length; offset += 500) {
    let response;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        response = await fetch(url, { method: "POST", headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal",
        }, body: JSON.stringify(rows.slice(offset, offset + 500)) });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      }
    }
    if (!response.ok) throw new Error(`${table} HTTP ${response.status}: ${await response.text()}`);
  }
}

await loadEnv();
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Isi .env.supabase.local terlebih dahulu.");

/** CSV -> array objek, dikunci pada nama kolom bukan urutan kolom. */
async function readCsvRows(file) {
  const rows = parseCsv(await fs.readFile(path.join(root, "data", file), "utf8"));
  const headers = rows.shift().map((value) => value.trim().toLowerCase());
  return rows.map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, (row[index] ?? "").trim()])),
  );
}

const products = (await readCsvRows("product_master.csv"))
  .map((row) => ({
    sku_number: row.sku_number,
    product_name: row.product_name,
    product_id: row.product_id || null,
  }))
  .filter((row) => row.sku_number && row.product_name);

// Master checker kini tinggal di data/checker_master.csv. Sebelumnya nilai ini
// di-scrape dari api/inbound.js, sehingga seeding bergantung pada backend lama
// yang sudah tidak dipakai dan tidak ikut ter-deploy.
const checkers = (await readCsvRows("checker_master.csv"))
  .map((row) => ({
    mp_id: row.mp_id,
    checker_name: row.checker_name,
    active: String(row.active || "true").toLowerCase() !== "false",
  }))
  .filter((row) => row.mp_id && row.checker_name);

if (!products.length) throw new Error("data/product_master.csv kosong atau tidak terbaca.");
if (!checkers.length) throw new Error("data/checker_master.csv kosong atau tidak terbaca.");

await upsert("product_master", products, "sku_number");
await upsert("checker_master", checkers, "mp_id");
console.log(JSON.stringify({ products: products.length, checkers: checkers.length }));
