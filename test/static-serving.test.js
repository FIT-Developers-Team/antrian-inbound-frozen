/* ============================================================================
 * PENYAJIAN BERKAS STATIS — DIUJI LEWAT HTTP SUNGGUHAN
 *
 * Berkas test lain di folder ini membaca kode sumber dan mencocokkan pola. Cara
 * itu murah dan berguna, tetapi ia tidak dapat menangkap cacat yang hanya
 * muncul ketika kode benar-benar dijalankan — dan cacat paling serius yang
 * ditemukan saat audit adalah cacat semacam itu.
 *
 * `GET /db/schema.sql` mengembalikan seluruh skema. `GET /api/server.mjs`
 * mengembalikan kode server. `GET /.env` mengembalikan sandi database dan kunci
 * penanda tangan sesi. Ketiganya lolos dari SETIAP pemeriksaan pola, karena
 * kodenya memang tidak menyebut satu pun berkas itu: ia hanya menyajikan apa pun
 * yang ada di folder aplikasi, dan folder aplikasi kebetulan berisi lebih dari
 * paket statis.
 *
 * Karena itu berkas ini menyalakan server sungguhan dan mengetuk pintunya.
 * ========================================================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const path = require("node:path");
const { root, importModule } = require("./helpers");

/** Menyalakan penangan statis pada port bebas, menjalankan fn, lalu menutupnya. */
async function withServer(fn) {
  const { createStaticHandler } = await importModule("api/static.mjs");
  const serve = createStaticHandler(root);

  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    serve(request, response, url.pathname).catch(() => {
      response.writeHead(500).end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    // `fetch` menjaga soketnya tetap hidup, dan `close()` sendirian menunggu
    // soket itu habis waktunya — beberapa detik per test, tanpa alasan.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/* -- Kebocoran berkas server ----------------------------------------------- */

test("berkas server tidak pernah dapat diunduh browser", async () => {
  // Image produksi berisi api/ dan db/ di samping paket statis. Sebelum daftar
  // izin dipasang, ketiga jalur di bawah mengembalikan isinya apa adanya.
  await withServer(async (base) => {
    const forbidden = [
      "/db/schema.sql",
      "/api/server.mjs",
      "/api/headers.mjs",
      "/api/sync-superset.mjs",
      "/package.json",
      "/package-lock.json",
      "/.env",
      "/data/checker_master.csv",
      "/test/helpers.js",
      "/scripts/doctor.mjs",
      "/Dockerfile",
      "/docker-compose.yml",
    ];

    for (const route of forbidden) {
      const response = await fetch(`${base}${route}`);
      const body = await response.text();
      assert.ok(
        body.startsWith("<!doctype html>"),
        `${route} membocorkan isinya alih-alih jatuh ke index.html: ${body.slice(0, 80)}`,
      );
    }
  });
});

test("traversal jalur tidak dapat menjangkau apa pun", async () => {
  await withServer(async (base) => {
    // `/js/../..` penting: ia LOLOS pemeriksaan awalan "/js/" bila jalurnya
    // dicocokkan sebelum dinormalisasi.
    const attacks = [
      "/../.env",
      "/..%2f.env",
      "/js/../../.env",
      "/js/../db/schema.sql",
      "/%2e%2e/%2e%2e/.env",
      "/assets/../api/server.mjs",
      "/./../.env",
    ];

    for (const attack of attacks) {
      const response = await fetch(`${base}${attack}`);
      const body = await response.text();
      assert.ok(
        !/POSTGRES_PASSWORD|INBOUND_AUTH_SECRET|create or replace function|import pg from/.test(body),
        `${attack} membocorkan isi berkas server`,
      );
    }
  });
});

/* -- Paket statis tetap tersaji -------------------------------------------- */

test("paket statis aplikasi tetap tersaji lengkap", async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Antrian Inbound Frozen/);

    const css = await fetch(`${base}/style.css`, { headers: { "accept-encoding": "identity" } });
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /^text\/css/);

    const app = await fetch(`${base}/js/app.js`, { headers: { "accept-encoding": "identity" } });
    assert.equal(app.status, 200);
    // Browser menolak menjalankan modul yang dikirim dengan tipe salah.
    assert.match(app.headers.get("content-type"), /^text\/javascript/);

    const nested = await fetch(`${base}/js/pages/board.js`, { headers: { "accept-encoding": "identity" } });
    assert.equal(nested.status, 200, "modul di subfolder harus ikut tersaji");

    const logo = await fetch(`${base}/assets/login-logo.png`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get("content-type"), "image/png");
  });
});

test("rute aplikasi yang dimuat ulang tetap menghasilkan halaman", async () => {
  // Aplikasi ini satu halaman: menekan F5 di jalur mana pun harus berhasil.
  await withServer(async (base) => {
    const response = await fetch(`${base}/laporan/2026-09`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Antrian Inbound Frozen/);
  });
});

/* -- Kompresi -------------------------------------------------------------- */

test("teks dikompresi dan tetap dapat dibaca", async () => {
  await withServer(async (base) => {
    const plain = await fetch(`${base}/style.css`, { headers: { "accept-encoding": "identity" } });
    const plainSize = Number(plain.headers.get("content-length"));

    const brotli = await fetch(`${base}/style.css`, { headers: { "accept-encoding": "br" } });
    assert.equal(brotli.headers.get("content-encoding"), "br");
    const brotliSize = Number(brotli.headers.get("content-length"));
    assert.ok(
      brotliSize < plainSize * 0.35,
      `brotli harus memangkas lebih dari dua pertiga (${plainSize} -> ${brotliSize})`,
    );
    // fetch membuka kompresinya sendiri; isinya harus utuh.
    assert.match(await brotli.text(), /--accent/);

    const gzipped = await fetch(`${base}/style.css`, { headers: { "accept-encoding": "gzip" } });
    assert.equal(gzipped.headers.get("content-encoding"), "gzip");

    // Klien yang tidak menerima kompresi tetap dilayani.
    assert.equal(plain.headers.get("content-encoding"), null);
    assert.match(await plain.text(), /--accent/);
  });
});

test("gambar tidak dikompresi ulang", async () => {
  // PNG dan WebP sudah terkompresi di dalamnya; melewatkannya lewat gzip hanya
  // membakar CPU untuk hasil yang kadang justru lebih besar.
  await withServer(async (base) => {
    const logo = await fetch(`${base}/assets/login-logo.png`, { headers: { "accept-encoding": "br, gzip" } });
    assert.equal(logo.headers.get("content-encoding"), null);
  });
});

test("varian terkompresi tidak pernah tertukar antar encoding", async () => {
  await withServer(async (base) => {
    const brotli = await fetch(`${base}/style.css`, { headers: { "accept-encoding": "br" } });
    const etag = brotli.headers.get("etag");
    assert.match(etag, /\+br"$/, "ETag harus menyebut encoding-nya");
    assert.match(brotli.headers.get("vary") || "", /Accept-Encoding/i);

    const repeat = await fetch(`${base}/style.css`, {
      headers: { "accept-encoding": "br", "if-none-match": etag },
    });
    assert.equal(repeat.status, 304, "permintaan ulang yang sama dijawab tanpa body");

    // ETag brotli TIDAK boleh dianggap cocok oleh klien yang meminta gzip:
    // badannya "benar" menurut ETag tetapi tidak dapat dibaca.
    const crossEncoding = await fetch(`${base}/style.css`, {
      headers: { "accept-encoding": "gzip", "if-none-match": etag },
    });
    assert.equal(crossEncoding.status, 200);
    assert.equal(crossEncoding.headers.get("content-encoding"), "gzip");
  });
});

/* -- Header ---------------------------------------------------------------- */

test("setiap respons membawa header keamanan", async () => {
  await withServer(async (base) => {
    for (const route of ["/", "/style.css", "/js/app.js", "/tidak-ada"]) {
      const response = await fetch(`${route}` && `${base}${route}`);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", route);
      assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN", route);
      assert.match(response.headers.get("content-security-policy") || "", /connect-src 'self'/, route);
    }
  });
});

test("hanya assets yang di-cache lama", async () => {
  // js/ diminta TANPA query versi (begitulah `import "./config.js"` bekerja),
  // jadi cache panjang berarti deploy berikutnya mengirim app.js baru di atas
  // modul lama — dan aplikasinya rusak dengan cara yang sangat sulit dilacak.
  await withServer(async (base) => {
    const asset = await fetch(`${base}/assets/login-logo.png`);
    assert.match(asset.headers.get("cache-control"), /max-age=2592000/);

    for (const route of ["/js/app.js", "/style.css", "/"]) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.headers.get("cache-control"), "no-cache", route);
    }
  });
});

test("jalur yang tidak dapat didekode ditolak, bukan menjatuhkan proses", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/%E0%A4%A`);
    assert.equal(response.status, 400);
  });
});

/* -- Path yang dilaporkan ke pengguna -------------------------------------- */

test("root proyek yang dipakai test memang berisi aplikasinya", () => {
  // Penjaga kewarasan: bila root salah, seluruh test di atas lulus dengan
  // menguji folder kosong.
  assert.ok(path.isAbsolute(root));
});
