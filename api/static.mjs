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
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

import { MIN_COMPRESS_BYTES, compress, isCompressible, negotiateEncoding, taggedEtag } from "./compress.mjs";
import { SECURITY_HEADERS, transportHeaders } from "./headers.mjs";

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
 * `no-cache` bukan berarti "jangan simpan" — browser tetap menyimpan berkasnya
 * dan hanya wajib menanyakan apakah ia masih berlaku. Dengan ETag, pertanyaan
 * itu dijawab 304 tanpa body: sekitar 150 byte, bukan 40 KB.
 *
 * assets/ aman di-cache lama karena isinya stabil.
 */
function cacheControl(pathname) {
  if (pathname.startsWith("/assets/")) return "public, max-age=2592000";
  return "no-cache";
}

/**
 * Cache hasil kompresi.
 *
 * Paket statisnya kecil dan tetap — belasan berkas, totalnya di bawah 200 KB —
 * jadi seluruh varian terkompresinya muat di memori dan tidak pernah perlu
 * dihitung dua kali. Tanpa ini, setiap muat halaman pertama akan mem-brotli
 * style.css dari awal: puluhan milidetik CPU untuk hasil yang selalu sama.
 *
 * Kuncinya menyertakan mtime dan ukuran, sehingga berkas yang berubah saat
 * pengembangan otomatis membatalkan entri lamanya.
 */
const compressedCache = new Map();
const MAX_CACHED_BYTES = 8 * 1024 * 1024;

async function compressedVariant(file, info, encoding) {
  const key = `${file}|${info.size}|${info.mtimeMs}|${encoding}`;
  const cached = compressedCache.get(key);
  if (cached) return cached;

  const raw = await readFile(file);
  const body = await compress(raw, encoding);
  // Kompresi yang tidak menghasilkan penghematan berarti tidak layak dikirim.
  if (body.length >= raw.length) return null;

  if (body.length <= MAX_CACHED_BYTES) compressedCache.set(key, body);
  return body;
}

/**
 * Berkas yang boleh dilihat browser. Daftar-IZIN, bukan daftar-larangan.
 *
 * Ini memperbaiki kebocoran yang nyata. Sebelumnya penangan ini menyajikan APA
 * PUN yang ada di dalam folder aplikasi, dan folder aplikasi bukan hanya paket
 * statis: image produksi juga berisi `api/` dan `db/`. Artinya
 * `GET /db/schema.sql` mengembalikan seluruh skema kepada siapa pun yang
 * meminta, dan `GET /api/server.mjs` mengembalikan kode servernya — termasuk
 * susunan otorisasi per peran. Di mesin yang menyimpan `.env` di sebelah
 * aplikasi, `GET /.env` mengembalikan sandi database DAN kunci penanda tangan
 * sesi; yang terakhir itu berarti siapa pun dapat menerbitkan sesi berperan apa
 * pun untuk dirinya sendiri.
 *
 * Komentar di Dockerfile sudah menyatakan niatnya sejak awal — "hanya empat hal
 * ini yang pernah disajikan ke browser" — tetapi tidak ada satu baris kode pun
 * yang menegakkannya. Sekarang ada, dan bentuknya sengaja daftar-izin:
 * daftar-larangan mengharuskan setiap berkas rahasia baru diingat untuk
 * ditambahkan, sedangkan daftar-izin membuat berkas baru tidak terlihat sampai
 * seseorang memutuskan sebaliknya.
 */
const PUBLIC_FILES = new Set(["/index.html", "/style.css", "/favicon.ico", "/robots.txt"]);
const PUBLIC_DIRECTORIES = ["/js/", "/assets/"];

function isPublic(pathname) {
  return PUBLIC_FILES.has(pathname) || PUBLIC_DIRECTORIES.some((prefix) => pathname.startsWith(prefix));
}

export function createStaticHandler(rootDir) {
  const ROOT = resolve(rootDir);
  // Pembatas ditambahkan sekali di sini: tanpa itu, `startsWith(ROOT)` juga
  // meloloskan `/app-rahasia/...` untuk ROOT `/app`.
  const ROOT_PREFIX = ROOT.endsWith(sep) ? ROOT : ROOT + sep;

  return async function serveStatic(request, response, pathname) {
    const security = { ...SECURITY_HEADERS, ...transportHeaders(request) };

    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      // `%` yang tidak lengkap membuat decodeURIComponent melempar; permintaan
      // semacam itu tidak pernah datang dari aplikasi ini.
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8", ...security }).end("Bad request");
      return true;
    }

    // Normalisasi lebih dulu, SEBELUM dicocokkan dengan daftar izin: tanpa
    // langkah ini `/js/../db/schema.sql` lolos karena ia memang diawali "/js/".
    // Hasil normalize memakai pemisah milik sistem, jadi dikembalikan ke bentuk
    // POSIX supaya perbandingan jalurnya sama di Windows dan Linux.
    const normalized = normalize(decoded).split(sep).join("/").replace(/^(\.\.\/)+/, "/");
    const requested = normalized === "/" || normalized === "" ? "/index.html" : normalized;

    // Rute aplikasi (mis. /laporan) memang tidak ada sebagai berkas: aplikasi
    // ini satu halaman, jadi memuat ulang di jalur mana pun harus tetap
    // menghasilkan index.html. Yang tidak boleh terjadi adalah jalur semacam itu
    // menjangkau berkas server yang kebetulan tinggal di folder yang sama.
    const target = isPublic(requested) ? requested : "/index.html";
    let file = join(ROOT, target);

    if (!file.startsWith(ROOT_PREFIX)) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8", ...security }).end("Forbidden");
      return true;
    }

    let info;
    try {
      info = await stat(file);
      if (!info.isFile()) throw new Error("bukan berkas biasa");
    } catch {
      try {
        file = join(ROOT, "index.html");
        info = await stat(file);
      } catch {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...security }).end("Not found");
        return true;
      }
    }

    const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
    const wantsCompression = isCompressible(type) && info.size >= MIN_COMPRESS_BYTES;
    const encoding = wantsCompression ? negotiateEncoding(request) : null;

    // ETag dari ukuran + waktu ubah sudah cukup untuk berkas statis, dan jauh
    // lebih murah daripada membaca isinya untuk di-hash pada setiap permintaan.
    // Encoding ikut disebut supaya varian gzip tidak pernah disajikan kepada
    // klien yang meminta brotli.
    const etag = taggedEtag(`W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`, encoding);
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { etag, ...(encoding ? { vary: "Accept-Encoding" } : {}) }).end();
      return true;
    }

    const headers = {
      "content-type": type,
      "cache-control": cacheControl(target),
      etag,
      ...security,
    };

    if (encoding) {
      const body = await compressedVariant(file, info, encoding);
      if (body) {
        response.writeHead(200, {
          ...headers,
          "content-encoding": encoding,
          "content-length": body.length,
          vary: "Accept-Encoding",
        });
        response.end(request.method === "HEAD" ? undefined : body);
        return true;
      }
    }

    response.writeHead(200, {
      ...headers,
      "content-length": info.size,
      ...(wantsCompression ? { vary: "Accept-Encoding" } : {}),
    });
    if (request.method === "HEAD") {
      response.end();
      return true;
    }
    // Aliran yang gagal di tengah jalan (klien menutup tab, jaringan putus)
    // tidak boleh menjatuhkan proses lewat galat yang tidak tertangani.
    createReadStream(file).on("error", () => response.destroy()).pipe(response);
    return true;
  };
}
