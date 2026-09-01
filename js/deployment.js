/* ==========================================================================
 * KONFIGURASI DEPLOYMENT
 *
 * Frontend berbicara ke API lewat origin yang sama. nginx di kontainer `web`
 * memproksikan jalur ini ke layanan `api`, jadi tidak ada URL backend yang
 * perlu ditanam di kode browser — dan permintaan API tidak pernah menjadi
 * lintas asal, sehingga CORS berhenti menjadi sumber kegagalan.
 *
 * Alamat backend yang sebenarnya diatur di docker-compose.yml lewat
 * `API_UPSTREAM`, bukan di sini.
 * ========================================================================== */

/** Jalur proksi. Harus cocok dengan blok `location` di deploy/nginx.conf.template. */
export const API_PROXY_PATH = "/api/inbound";

/**
 * Origin produksi. Tidak menegakkan apa pun — hanya dipakai dokumentasi dan
 * `npm run doctor` sebagai nilai bawaan saat memeriksa deployment.
 */
export const PRODUCTION_ORIGIN = "https://antrian.inbound-frozen.astrofit.web.id";
