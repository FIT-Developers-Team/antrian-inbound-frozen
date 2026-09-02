/* ============================================================================
 * PEMBATAS LAJU
 *
 * Layar masuk aplikasi ini memeriksa sandi teks biasa dari INBOUND_AUTH_USERS.
 * Tanpa pembatas, tidak ada apa pun yang menghalangi skrip menebak sandi
 * sebanyak yang sanggup dikirim jaringan — dan sandi gudang cenderung pendek,
 * karena diketik dengan sarung tangan di layar sentuh.
 *
 * Jendela geser sederhana di dalam proses sudah memadai di sini: hanya ada satu
 * kontainer aplikasi, jadi tidak ada yang perlu dibagi antar-instans. Bila
 * kelak dijalankan lebih dari satu replika, pembatas ini menjadi per-replika —
 * masih memperlambat penebakan, hanya tidak seketat angkanya.
 * ========================================================================== */

/**
 * @param {number} limit    Jumlah percobaan yang diizinkan dalam satu jendela.
 * @param {number} windowMs Panjang jendela.
 */
export function createRateLimiter({ limit, windowMs }) {
  /** @type {Map<string, number[]>} kunci -> stempel waktu percobaan */
  const hits = new Map();

  /**
   * Entri yang jendelanya sudah lewat dibuang saat dilewati, bukan lewat timer
   * tersendiri: peta ini hanya tumbuh sebesar jumlah penyerang yang aktif, dan
   * membersihkannya sambil jalan menghindari timer yang menahan proses hidup.
   */
  function sweep(now) {
    for (const [key, stamps] of hits) {
      const kept = stamps.filter((stamp) => now - stamp < windowMs);
      if (kept.length) hits.set(key, kept);
      else hits.delete(key);
    }
  }

  let lastSweep = 0;

  return {
    /**
     * Mencatat satu percobaan dan melaporkan apakah ia melampaui batas.
     * @returns {{ allowed: boolean, retryAfterSeconds: number }}
     */
    check(key) {
      const now = Date.now();
      if (now - lastSweep > windowMs) {
        sweep(now);
        lastSweep = now;
      }

      const stamps = (hits.get(key) || []).filter((stamp) => now - stamp < windowMs);
      stamps.push(now);
      hits.set(key, stamps);

      if (stamps.length <= limit) return { allowed: true, retryAfterSeconds: 0 };
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - stamps[0])) / 1000)),
      };
    },

    /** Login yang berhasil menghapus riwayat gagal; operator tidak dihukum. */
    reset(key) {
      hits.delete(key);
    },

    get size() {
      return hits.size;
    },
  };
}

/**
 * Alamat klien di belakang proxy platform.
 *
 * Coolify (dan proxy mana pun di depannya) menaruh alamat asli di
 * `x-forwarded-for`; `socket.remoteAddress` di sana selalu alamat proxy, yang
 * berarti SELURUH pengguna berbagi satu kuota. Entri pertama dalam daftar
 * adalah klien.
 */
export function clientKey(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || request.socket?.remoteAddress || "unknown";
}
