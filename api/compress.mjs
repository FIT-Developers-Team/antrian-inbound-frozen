/* ============================================================================
 * KOMPRESI RESPONS
 *
 * Paket statis aplikasi ini kecil menurut ukuran web modern — sekitar 150 KB
 * teks — tetapi jaringan gudang bukan jaringan modern. Tablet di pos masuk
 * menempel pada Wi-Fi yang dibagi bersama forklift dan pemindai barcode, dan
 * setiap kilobyte yang tidak jadi dikirim adalah kilobyte yang tidak perlu
 * diperebutkan.
 *
 * Teks HTML, CSS, JS, dan JSON menyusut 70-80% dengan gzip. Snapshot papan
 * yang berisi seratus tiket menyusut dari ~120 KB menjadi ~15 KB, dan itu
 * terjadi pada SETIAP siklus polling yang benar-benar membawa perubahan.
 *
 * Brotli dipakai bila browser menerimanya karena hasilnya lebih kecil pada
 * biaya CPU yang sebanding; gzip menjadi cadangan. Keduanya dijalankan pada
 * tingkat rendah: pada payload sekecil ini, selisih ukuran antara tingkat 4
 * dan tingkat 11 tidak sepadan dengan puluhan milidetik CPU per permintaan.
 * ========================================================================== */

import { promisify } from "node:util";
import zlib from "node:zlib";

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

/**
 * Di bawah ambang ini kompresi justru merugikan: overhead header gzip sekitar
 * 20 byte, dan paket TCP pertama tetap muat tanpa dikompresi.
 */
export const MIN_COMPRESS_BYTES = 1024;

const BROTLI_OPTIONS = {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
  },
};

/** Tipe yang layak dikompresi. Gambar dan font sudah terkompresi di dalamnya. */
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml)|image\/svg)/;

export function isCompressible(contentType) {
  return COMPRESSIBLE.test(String(contentType || ""));
}

/**
 * Encoding terbaik yang diterima klien.
 *
 * Sengaja tidak mengurai bobot `q=`: satu-satunya nilai yang benar-benar
 * dipakai browser adalah `br` dan `gzip`, dan keduanya tidak pernah dikirim
 * dengan bobot yang membuat urutan pilihannya berbeda.
 */
export function negotiateEncoding(request) {
  const accepted = String(request.headers["accept-encoding"] || "").toLowerCase();
  if (accepted.includes("br")) return "br";
  if (accepted.includes("gzip")) return "gzip";
  return null;
}

export async function compress(buffer, encoding) {
  if (encoding === "br") return brotli(buffer, BROTLI_OPTIONS);
  if (encoding === "gzip") return gzip(buffer);
  return buffer;
}

/**
 * ETag wajib ikut menyebut encoding-nya.
 *
 * Tanpa itu, proxy atau browser yang menyimpan varian gzip dapat menyajikannya
 * kembali kepada klien yang meminta brotli — badan respons benar menurut ETag,
 * tetapi tidak dapat dibaca. `Vary: Accept-Encoding` saja tidak cukup karena ia
 * tidak mengubah ETag-nya.
 */
export function taggedEtag(etag, encoding) {
  if (!etag || !encoding) return etag;
  return etag.endsWith('"') ? `${etag.slice(0, -1)}+${encoding}"` : `${etag}+${encoding}`;
}
