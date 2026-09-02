/* ============================================================================
 * HEADER KEAMANAN
 *
 * Satu definisi, dipakai oleh respons berkas statis maupun respons API.
 *
 * Pemisahannya dulu bukan keputusan, melainkan kelalaian: header ini hanya
 * menempel pada berkas statis, sehingga justru respons API — satu-satunya yang
 * membawa data operasional dan token sesi — berangkat tanpa satu pun di
 * antaranya.
 * ========================================================================== */

/**
 * Kebijakan konten.
 *
 * Ketat karena memang bisa: aplikasi ini tidak memuat skrip pihak ketiga sama
 * sekali. Dua pelonggaran yang tersisa punya alasannya masing-masing:
 *
 *   script-src 'unsafe-inline'  index.html memasang tema sebelum paint pertama
 *                               lewat skrip sebaris; memindahkannya ke berkas
 *                               terpisah mengembalikan kedipan putih yang
 *                               justru ingin dihilangkan.
 *   style-src  'unsafe-inline'  primitif UI menulis `style="--metric-tone:…"`
 *                               langsung pada elemen.
 *
 * `connect-src 'self'` adalah yang paling berarti di sini: sekalipun ada nilai
 * dari master PO yang lolos escape dan berhasil menjalankan skrip, ia tidak
 * dapat mengirim apa pun keluar dari origin ini.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": CONTENT_SECURITY_POLICY,
};

/**
 * HSTS dipasang hanya saat permintaan benar-benar tiba lewat HTTPS.
 *
 * Memasangnya tanpa syarat akan mengunci pengembangan lokal di http://localhost
 * ke https selama satu tahun di browser yang sama — dan itu sangat tidak
 * menyenangkan untuk dibatalkan. Proxy Coolify menandai skema aslinya pada
 * `x-forwarded-proto`.
 */
export function transportHeaders(request) {
  const proto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (proto !== "https") return {};
  return { "strict-transport-security": "max-age=31536000; includeSubDomains" };
}
