/* ==========================================================================
 * KONFIGURASI DEPLOYMENT
 *
 * SATU-SATUNYA berkas yang perlu disunting ketika aplikasi ini dipindahkan ke
 * domain, hosting, atau proyek Supabase yang berbeda.
 *
 * Nilai-nilai ini sebelumnya tersebar di js/config.js, scripts/dev-server.mjs,
 * dan capacitor.config.json, sehingga memindahkan deployment berarti berburu
 * URL yang sama di tiga tempat dan melewatkan salah satunya.
 *
 * Setelah mengubah berkas ini, baca DEPLOYMENT.md — ada satu langkah sisi
 * server (APP_ORIGINS) yang tidak dapat diatur dari sini.
 * ========================================================================== */

/** Project ref Supabase, bagian pertama dari URL proyek. */
export const SUPABASE_PROJECT_REF = "qiafoaoslnbmtsbnmqou";

/** Edge Function yang melayani seluruh permintaan aplikasi. */
export const SUPABASE_FUNCTION_URL =
  `https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/inbound-api`;

/**
 * Origin produksi tempat aplikasi ini disajikan.
 *
 * Nilai ini TIDAK menegakkan apa pun dari sisi browser — ia hanya dipakai oleh
 * DEPLOYMENT.md dan `npm run doctor` untuk mengingatkan bahwa `APP_ORIGINS` di
 * Supabase Secrets harus memuat origin yang sama. CORS ditegakkan server, dan
 * origin yang tidak terdaftar akan ditolak browser sebelum permintaan terkirim.
 */
export const PRODUCTION_ORIGIN = "https://antrian-inbound-frozen.pages.dev";
