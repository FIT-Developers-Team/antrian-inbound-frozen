/* ============================================================================
 * SERVER PENGEMBANGAN LOKAL
 *
 * Menjalankan `npm run dev` menyajikan berkas statis di http://localhost:4173
 * dan MEMPROKSIKAN permintaan API ke Supabase Edge Function.
 *
 * Proksi ini menyamakan pengembangan dengan produksi: di kedua tempat browser
 * memanggil `/api/inbound` pada origin yang sama, sehingga tidak ada perilaku
 * CORS yang hanya muncul di salah satunya.
 *
 * Berkas ini tidak pernah ikut ter-deploy: `.vercelignore` mengecualikan
 * `scripts`, dan paket statis produksi hanya berisi index.html, style.css,
 * js/, dan assets/.
 * ========================================================================== */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.env.PORT) || 4173;
// API lokal. Jalankan `docker compose up -d db api` lalu `npm run dev`.
const UPSTREAM = process.env.API_UPSTREAM || "http://localhost:8080/api/inbound";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Meneruskan permintaan API apa adanya, termasuk header Authorization. */
async function proxy(request, response, requestUrl) {
  const target = UPSTREAM + requestUrl.search;
  const headers = {};
  for (const name of ["authorization", "content-type", "if-none-match"]) {
    const value = request.headers[name];
    if (value) headers[name] = value;
  }

  let body;
  if (request.method === "POST") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }

  try {
    const upstream = await fetch(target, { method: request.method, headers, body });
    const text = await upstream.text();
    const etag = upstream.headers.get("etag");
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
      ...(etag ? { etag } : {}),
    });
    response.end(text);
  } catch (error) {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, message: `Proksi gagal: ${error.message}` }));
  }
}

async function serveStatic(response, pathname) {
  // Normalisasi lebih dulu supaya "../" tidak dapat keluar dari folder proyek.
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(ROOT, safe === "/" || safe === "\\" ? "index.html" : safe);
  if (!file.startsWith(ROOT)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const content = await readFile(file);
    response.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      // Tanpa ini, modul yang baru disunting tetap dilayani dari cache browser
      // dan perubahan seolah tidak berpengaruh.
      "cache-control": "no-store",
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("404 Not Found");
  }
}

createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://localhost:${PORT}`);
  if (requestUrl.pathname === "/api/inbound") {
    await proxy(request, response, requestUrl);
    return;
  }
  await serveStatic(response, decodeURIComponent(requestUrl.pathname));
}).listen(PORT, () => {
  console.log(`\n  Antrian Inbound Frozen — pengembangan lokal`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  API diproksikan ke ${UPSTREAM}\n`);
});
