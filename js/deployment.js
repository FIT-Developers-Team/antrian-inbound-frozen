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
 * Nilai ini TIDAK menegakkan apa pun dari sisi browser — ia hanya dipakai
 * dokumentasi dan `npm run doctor` sebagai pengingat. Isi dengan domain
 * Coolify setelah domainnya ditetapkan.
 */
export const PRODUCTION_ORIGIN = "https://antrian-inbound-frozen.pages.dev";

/**
 * Apakah permintaan API melewati proksi di origin yang sama?
 *
 * `true` (bawaan, dipakai Coolify) — browser memanggil `/api/inbound`, dan
 * nginx di dalam kontainer meneruskannya ke Supabase. Permintaan tidak pernah
 * menjadi lintas asal, sehingga `APP_ORIGINS` tidak lagi menentukan hidup-
 * matinya aplikasi. Salah ketik satu huruf di sana dulu membuat aplikasi
 * memuat sempurna lalu menolak setiap permintaan dengan galat yang tampak
 * seperti salah sandi.
 *
 * `false` — browser memanggil Supabase langsung. Diperlukan pada hosting
 * statis murni yang tidak dapat memproksikan apa pun, seperti Cloudflare
 * Pages atau GitHub Pages. Dalam mode ini `APP_ORIGINS` WAJIB memuat origin
 * produksi secara persis.
 *
 * Localhost selalu memakai proksi `npm run dev`, apa pun nilai ini.
 */
export const USE_API_PROXY = true;

/** Jalur proksi. Harus cocok dengan blok `location` di deploy/nginx.conf.template. */
export const API_PROXY_PATH = "/api/inbound";
