/* ============================================================================
 * SALURAN PERUBAHAN LANGSUNG (SERVER-SENT EVENTS)
 *
 * Papan antrean dulu hanya tahu ada perubahan dengan bertanya tiap lima belas
 * detik. Di pos masuk, lima belas detik adalah selisih antara "driver sudah
 * dipanggil" dan "driver masih menunggu di luar sambil bertanya-tanya" — dan
 * itu selisih yang benar-benar terdengar sebagai keluhan.
 *
 * Susunannya tiga lapis, dan tiap lapis punya alasannya:
 *
 *   Postgres   Trigger mengirim NOTIFY pada setiap perubahan tiket. Ia hanya
 *              terkirim setelah transaksi commit, jadi tidak ada browser yang
 *              pernah menarik data yang kemudian di-rollback.
 *
 *   API        SATU koneksi khusus mendengarkan, lalu menyebarkan ke setiap
 *              browser yang terhubung. Biayanya tidak bertambah seiring jumlah
 *              tablet — dua puluh tablet tetap satu koneksi ke database, bukan
 *              dua puluh polling.
 *
 *   Browser    Menerima sinyal, lalu menarik snapshot ber-ETag seperti biasa.
 *              Yang dikirim lewat saluran ini hanyalah "ada yang berubah",
 *              bukan datanya. Itu membuat saluran ini tidak pernah menjadi
 *              sumber kebenaran kedua yang bisa menyimpang dari yang pertama.
 *
 * Polling TIDAK dihapus. Ia turun dari lima belas detik menjadi jaring pengaman
 * yang jarang: proxy memutus koneksi panjang, jaringan gudang putus-nyambung,
 * dan saluran yang diam tidak boleh berarti papan yang diam-diam basi.
 * ========================================================================== */

const CHANNEL = "inbound_changed";

/**
 * Denyut nadi.
 *
 * Proxy dan load balancer menutup koneksi yang diam. Baris komentar SSE (diawali
 * titik dua) tidak terlihat oleh pemakai EventSource mana pun, tetapi ia cukup
 * untuk menjaga koneksi tetap dianggap hidup. Dua puluh detik aman di bawah
 * batas enam puluh detik yang lazim dipakai proxy.
 */
const HEARTBEAT_MS = 20_000;

/**
 * Batas jumlah pendengar.
 *
 * Setiap koneksi menahan satu socket. Gudang ini punya belasan tablet, jadi
 * angka ini longgar — ia bukan untuk penggunaan wajar, melainkan supaya klien
 * yang salah tulis dan menyambung ulang tanpa henti tidak menghabiskan deskriptor
 * berkas milik proses.
 */
const MAX_CLIENTS = 200;

export function createLiveChannel(pool) {
  /** @type {Set<{ response: import("node:http").ServerResponse, site: string|null }>} */
  const clients = new Set();
  let listener = null;
  let reconnectTimer = null;
  let closed = false;

  function broadcast(site) {
    const payload = JSON.stringify({ site: site || "ALL", at: new Date().toISOString() });
    for (const client of clients) {
      // Pendengar yang meminta satu gudang tidak dibangunkan oleh perubahan di
      // gudang lain. "ALL" berarti pemberitahuan tingkat tabel yang tidak tahu
      // gudangnya, dan itu selalu diteruskan.
      if (client.site && site && site !== "ALL" && client.site !== site) continue;
      try {
        client.response.write(`event: changed\ndata: ${payload}\n\n`);
      } catch {
        drop(client);
      }
    }
  }

  function drop(client) {
    clients.delete(client);
    clearInterval(client.heartbeat);
    try {
      client.response.end();
    } catch {
      /* koneksi sudah tertutup */
    }
  }

  /**
   * Koneksi pendengar berdiri sendiri, di luar kolam.
   *
   * Koneksi yang sedang LISTEN tidak boleh dikembalikan ke kolam dan dipakai
   * ulang untuk kueri lain: ia harus tetap terbuka selama proses hidup. Karena
   * itu ia diambil langsung dari pool dan tidak pernah di-release.
   */
  async function connect() {
    if (closed) return;
    try {
      const client = await pool.connect();
      listener = client;

      client.on("notification", (message) => {
        if (message.channel === CHANNEL) broadcast(message.payload);
      });

      client.on("error", (error) => {
        console.warn("[live] koneksi pendengar terputus:", error.message);
        reconnect();
      });

      await client.query(`listen ${CHANNEL}`);
      console.log("[live] mendengarkan perubahan dari Postgres.");
    } catch (error) {
      console.warn("[live] gagal memasang pendengar:", error.message);
      reconnect();
    }
  }

  /**
   * Menyambung ulang setelah jeda.
   *
   * Database yang restart tidak boleh membuat papan diam selamanya. Selama
   * saluran ini putus, klien tetap aman: polling cadangan di browser terus
   * berjalan, hanya lebih lambat.
   */
  function reconnect() {
    if (closed || reconnectTimer) return;
    releaseListener();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 5_000);
    reconnectTimer.unref?.();
  }

  function releaseListener() {
    if (!listener) return;
    const client = listener;
    listener = null;
    client.removeAllListeners("notification");
    try {
      client.release(true);
    } catch {
      /* sudah terlepas */
    }
  }

  connect();

  return {
    /** Jumlah browser yang sedang terhubung — dilaporkan diagnostik. */
    get clientCount() {
      return clients.size;
    },

    get listening() {
      return Boolean(listener);
    },

    /**
     * Menyambungkan satu permintaan sebagai aliran SSE.
     * @param {string|null} site Gudang yang diminati pendengar ini.
     */
    subscribe(request, response, site, headers = {}) {
      if (clients.size >= MAX_CLIENTS) {
        response.writeHead(503, { "content-type": "text/plain; charset=utf-8", ...headers });
        response.end("Terlalu banyak pendengar.");
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        // `no-transform` penting: proxy yang mem-buffer atau mengompresi aliran
        // ini akan menahan setiap pesan sampai buffernya penuh, dan "realtime"
        // berubah menjadi "beberapa menit sekali, sekaligus".
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        ...headers,
      });

      const client = { response, site: site || null, heartbeat: null };
      client.heartbeat = setInterval(() => {
        try {
          response.write(": ping\n\n");
        } catch {
          drop(client);
        }
      }, HEARTBEAT_MS);
      client.heartbeat.unref?.();

      clients.add(client);

      // Batas waktu permintaan milik server berlaku untuk permintaan biasa;
      // aliran ini memang dimaksudkan untuk hidup berjam-jam.
      request.setTimeout?.(0);
      response.setTimeout?.(0);

      // Sapaan pembuka sekaligus memaksa header terkirim, sehingga klien tahu
      // saluran benar-benar terbuka alih-alih menunggu perubahan pertama.
      response.write(`retry: 5000\nevent: ready\ndata: ${JSON.stringify({ site: site || "ALL" })}\n\n`);

      request.on("close", () => drop(client));
      request.on("error", () => drop(client));
    },

    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      for (const client of [...clients]) drop(client);
      releaseListener();
    },
  };
}
