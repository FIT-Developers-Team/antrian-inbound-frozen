/* ============================================================================
 * PENYAJIAN BERKAS STATIS
 *
 * Proses Node yang sama menyajikan index.html, style.css, js/, dan assets/
 * sekaligus melayani API. Tidak ada nginx di antaranya.
 *
 * Itu keputusan yang disengaja. Susunan sebelumnya menaruh nginx di depan API
 * sebagai kontainer terpisah, dan SETIAP kegagalan deployment yang terjadi
 * bermuara pada sambungan di antara keduanya: proxy hidup, API tidak, dan
 * operator melihat 502 — atau lebih buruk, "username atau password salah".
 * Menyatukan keduanya menghapus seluruh kelas kegagalan itu: bila halaman
 * termuat, API-nya pasti ikut hidup, karena keduanya proses yang sama.
 * ========================================================================== */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Kebijakan cache.
 *
 * Hanya index.html yang menautkan `app.js?v=N` dan `style.css?v=N`. Sebelas
 * modul yang diimpor app.js diminta TANPA query versi, karena begitulah
 * `import "./config.js"` bekerja. Karena itu js/ dan css tidak boleh di-cache
 * lama: sekali di-cache, deploy berikutnya mengirim app.js baru di atas modul
 * lama, dan aplikasinya rusak dengan cara yang sangat sulit dilacak.
 *
 * assets/ aman di-cache lama karena isinya stabil.
 */
function cacheControl(pathname) {
  if (pathname.startsWith("/assets/")) return "public, max-age=2592000";
  return "no-cache";
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

export function createStaticHandler(rootDir) {
  const ROOT = resolve(rootDir);

  return async function serveStatic(request, response, pathname) {
    // Normalisasi lebih dulu supaya "../" tidak dapat keluar dari folder publik.
    const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(ROOT, safe === "/" || safe === "\\" ? "index.html" : safe);

    if (!file.startsWith(ROOT)) {
      response.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
      return true;
    }

    let info;
    try {
      info = await stat(file);
      if (info.isDirectory()) {
        file = join(file, "index.html");
        info = await stat(file);
      }
    } catch {
      // Rute yang tidak dikenal dikembalikan ke index.html; aplikasi ini satu
      // halaman, jadi memuat ulang di jalur mana pun tetap harus berhasil.
      try {
        file = join(ROOT, "index.html");
        info = await stat(file);
      } catch {
        response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return true;
      }
    }

    // ETag dari ukuran + waktu ubah sudah cukup untuk berkas statis, dan jauh
    // lebih murah daripada membaca isinya untuk di-hash pada setiap permintaan.
    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { etag }).end();
      return true;
    }

    response.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": cacheControl(pathname),
      "content-length": info.size,
      etag,
      ...SECURITY_HEADERS,
    });
    createReadStream(file).pipe(response);
    return true;
  };
}
