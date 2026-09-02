/* ==========================================================================
 * KONFIGURASI DEPLOYMENT
 *
 * Frontend berbicara ke API lewat origin yang sama — dan sejak nginx dihapus,
 * "origin yang sama" berarti proses yang sama persis. Satu kontainer Node
 * menyajikan index.html dan melayani /api/inbound sekaligus.
 *
 * Konsekuensinya bukan sekadar kerapian: tidak ada URL backend yang perlu
 * ditanam di kode browser, permintaan API tidak pernah menjadi lintas asal
 * sehingga CORS berhenti menjadi sumber kegagalan, dan tidak ada lagi proxy
 * yang bisa hidup sementara backend di belakangnya mati. Bila halaman ini
 * termuat, API-nya pasti ikut hidup.
 * ========================================================================== */

/** Jalur API. Dilayani oleh proses yang sama yang menyajikan halaman ini. */
export const API_PROXY_PATH = "/api/inbound";

/**
 * Origin produksi. Tidak menegakkan apa pun — hanya dipakai dokumentasi dan
 * `npm run doctor` sebagai nilai bawaan saat memeriksa deployment.
 */
export const PRODUCTION_ORIGIN = "https://antrian.inbound-frozen.astrofit.web.id";
