/* ============================================================================
 * SINKRONISASI MASTER PO DARI SUPERSET
 *
 * Menggantikan pasangan `pg_cron` + `pg_net` milik Supabase. Penjadwalnya kini
 * timer di dalam proses API.
 *
 * Itu bukan sekadar pemindahan: sebelumnya kegagalan sync terjadi di dalam
 * Postgres, dan satu-satunya jejaknya adalah baris di tabel `sync_runs`.
 * Sekarang kegagalan muncul di log kontainer yang sama dengan sisa aplikasi,
 * dan cookie Superset yang kedaluwarsa — penyebab tersering sync membeku —
 * terlihat pada percobaan pertama, bukan berjam-jam kemudian.
 * ========================================================================== */

const INTERVAL_MS = Number(process.env.SUPERSET_SYNC_INTERVAL_MS) || 5 * 60_000;

/**
 * Batas waktu permintaan ke Superset.
 *
 * `fetch` tanpa batas waktu menunggu selamanya. Superset yang menggantung —
 * bukan yang mati, yang menggantung — karena itu membekukan sync tanpa satu pun
 * baris di log, dan `sync_runs` menyimpan baris RUNNING yang tidak pernah
 * selesai. Setiap interval berikutnya menambah satu lagi.
 */
const FETCH_TIMEOUT_MS = Number(process.env.SUPERSET_FETCH_TIMEOUT_MS) || 45_000;

/** Baris per pernyataan insert. Lihat catatan di writeRows(). */
const BATCH_SIZE = 500;
const CHART_ID = process.env.SUPERSET_CHART_ID || "20662";
const LOCATION_COLUMN = process.env.SUPERSET_LOCATION_COLUMN || "location_id";
const BASE_URL = (process.env.SUPERSET_BASE_URL || "https://dash.astronauts.id").replace(/\/$/, "");

/**
 * Cookie sesi Superset — dari database dulu, lingkungan sebagai cadangan.
 *
 * Urutannya penting dan disengaja. Variabel lingkungan adalah tempat yang lebih
 * aman, jadi ia tetap menjadi nilai bawaan; setelan di database menimpanya
 * hanya bila benar-benar diisi.
 *
 * Alasannya operasional: cookie Superset kedaluwarsa berkala, dan menggantinya
 * lewat variabel lingkungan berarti menunggu deploy ulang selesai — beberapa
 * menit master PO membeku, pada saat yang justru paling tidak tepat, karena
 * cookie biasanya mati saat sedang dipakai.
 *
 * Dibaca ULANG pada setiap siklus, bukan sekali saat start: cookie yang baru
 * diisi lewat layar Pengaturan harus langsung berlaku tanpa menyalakan ulang
 * proses.
 */
async function resolveCookie(pool) {
  try {
    const { rows } = await pool.query(
      "select setting_value from app_settings where setting_key = 'superset_session_cookie'",
    );
    const stored = String(rows[0]?.setting_value || "").trim();
    if (stored) return stored;
  } catch (error) {
    // Tabel setelan yang belum ada bukan alasan menghentikan sinkronisasi;
    // jalur lingkungan masih berlaku.
    console.warn("[superset] setelan cookie tidak terbaca:", error.message);
  }
  return String(process.env.SUPERSET_SESSION_COOKIE || "").trim();
}

function timeoutSignal() {
  return AbortSignal.timeout(FETCH_TIMEOUT_MS);
}

function headers(cookie) {
  const value = String(cookie || "").trim();
  return {
    accept: "application/json",
    cookie: value.startsWith("session=") ? value : `session=${value}`,
    referer: `${BASE_URL}/`,
  };
}

function rowsFromPayload(payload) {
  const rows = payload?.result?.[0]?.data;
  return Array.isArray(rows) ? rows : [];
}

/**
 * Menyuntikkan filter gudang ke query_context chart.
 *
 * Filter lokasi lama menempel pada saved chart, sehingga memakainya apa adanya
 * akan terus menarik gudang yang salah. Filter pada kolom lokasi dibuang lalu
 * diganti daftar location_id gudang aktif, sehingga permintaan benar-benar
 * meminta PGS (160) ke Superset, bukan sekadar menyaring hasilnya.
 */
function withSiteFilter(queryContext, locationIds) {
  const queries = Array.isArray(queryContext.queries) ? queryContext.queries : [];
  return {
    ...queryContext,
    force: true,
    result_format: "json",
    result_type: "full",
    queries: queries.map((query) => {
      const filters = (query.filters || []).filter((filter) => filter.col !== LOCATION_COLUMN);
      return { ...query, filters: [...filters, { col: LOCATION_COLUMN, op: "IN", val: locationIds }] };
    }),
  };
}

/**
 * Cookie Superset yang kedaluwarsa adalah kegagalan tersering di sini, dan
 * selama ini ia menyamar sebagai galat HTTP biasa.
 *
 * Superset menjawab 401 atau 403 ketika sesinya mati, dan pesan yang tercatat
 * hanyalah "Superset menjawab HTTP 401" — kalimat yang benar tetapi tidak
 * memberi tahu siapa pun apa yang harus dilakukan. Cookie itu berumur terbatas
 * dan HARUS diperbarui manual; membedakannya dari gangguan jaringan berarti
 * membedakan "tunggu sebentar" dari "ada yang harus login ke Superset dan
 * menyalin cookie baru".
 */
export class SupersetAuthError extends Error {
  constructor(status) {
    super(
      `Cookie Superset sudah kedaluwarsa (HTTP ${status}). ` +
        "Masuk ke Superset, salin nilai cookie `session` yang baru ke SUPERSET_SESSION_COOKIE, lalu deploy ulang.",
    );
    this.name = "SupersetAuthError";
    this.status = status;
    this.kind = "COOKIE_EXPIRED";
  }
}

function assertAuthorized(response) {
  if (response.status === 401 || response.status === 403) throw new SupersetAuthError(response.status);
}

async function fetchRows(locationIds, cookie) {
  // Jalur utama: jalankan query_context milik chart dengan filter gudang aktif.
  try {
    const chart = await fetch(`${BASE_URL}/api/v1/chart/${CHART_ID}`, {
      headers: headers(cookie),
      signal: timeoutSignal(),
    });
    // Cookie mati tidak boleh jatuh ke jalur cadangan: cadangannya memakai
    // cookie yang sama dan pasti gagal juga, sehingga pesan yang tercatat
    // kehilangan sebab aslinya.
    assertAuthorized(chart);
    const meta = await chart.json();
    const raw = meta?.result?.query_context;
    if (raw) {
      const context = withSiteFilter(typeof raw === "string" ? JSON.parse(raw) : raw, locationIds);
      const response = await fetch(`${BASE_URL}/api/v1/chart/data`, {
        method: "POST",
        headers: { ...headers(cookie), "content-type": "application/json" },
        body: JSON.stringify(context),
        signal: timeoutSignal(),
      });
      if (response.ok) return { rows: rowsFromPayload(await response.json()), mode: "query_context_filtered" };
    }
  } catch (error) {
    if (error instanceof SupersetAuthError) throw error;
    console.warn("[superset] query_context gagal, memakai saved chart:", error.message);
  }

  // Cadangan: chart tanpa query_context tersimpan.
  const response = await fetch(`${BASE_URL}/api/v1/chart/${CHART_ID}/data/?force=true`, {
    headers: headers(cookie),
    signal: timeoutSignal(),
  });
  assertAuthorized(response);
  if (!response.ok) throw new Error(`Superset menjawab HTTP ${response.status}`);
  return { rows: rowsFromPayload(await response.json()), mode: "saved_chart" };
}

const text = (value) => (value === null || value === undefined ? null : String(value));
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

const COLUMNS = [
  "source_row_key", "po_number", "vendor_name", "location_id", "location_name", "site_code",
  "request_shipping_date", "fulfillment_arrived_start_at", "schedule_type", "po_status",
  "fulfillment_receiving_start_at", "fulfillment_completed_at",
  "request_quantity", "actual_quantity", "count_sku",
];

/** Kolom sumber yang memang sengaja tidak disimpan. */
const IGNORED_SOURCE_COLUMNS = new Set([LOCATION_COLUMN, "po", "PO"]);

/**
 * Melaporkan kolom yang DIKIRIM chart tetapi tidak disimpan tabel mana pun.
 *
 * `rowValues()` memetakan sekumpulan nama kolom tetap; apa pun yang dikirim
 * Superset di luar daftar itu jatuh diam-diam. Selama daftarnya memang sepadan
 * dengan chart-nya itu tidak jadi soal — tetapi chart di Superset dapat
 * disunting siapa saja yang punya aksesnya, dan kolom yang ditambahkan di sana
 * tidak akan pernah muncul di sini maupun memberi kabar bahwa ia ada.
 *
 * Ini yang menjawab pertanyaan "apakah sumbernya sudah membawa `sku_number`,
 * `product_name`, `l1_category_name`, atau `company_name`" tanpa perlu menebak:
 * bila kolomnya dikirim, namanya muncul di catatan sync dan di layar
 * Pengaturan; bila tidak, ia memang belum ada di chart itu.
 */
export function unmappedColumns(rows) {
  const first = rows.find((row) => row && typeof row === "object");
  if (!first) return [];
  const known = new Set(COLUMNS);
  return Object.keys(first)
    .filter((key) => !known.has(key) && !IGNORED_SOURCE_COLUMNS.has(key))
    .sort();
}

const UPSERT_ASSIGNMENTS = COLUMNS.filter((column) => column !== "source_row_key")
  .map((column) => `${column}=excluded.${column}`)
  .join(", ");

function rowValues(row, byLocation) {
  const locationId = String(row[LOCATION_COLUMN]);
  const poNumber = text(row.po_number ?? row.po ?? row.PO);
  if (!poNumber) return null;
  return [
    `${locationId}|${poNumber}`, poNumber, text(row.vendor_name), locationId,
    text(row.location_name), byLocation.get(locationId), text(row.request_shipping_date),
    text(row.fulfillment_arrived_start_at), text(row.schedule_type), text(row.po_status),
    text(row.fulfillment_receiving_start_at), text(row.fulfillment_completed_at),
    number(row.request_quantity), number(row.actual_quantity), number(row.count_sku),
  ];
}

/**
 * Menulis master PO dalam kelompok, bukan satu baris satu pernyataan.
 *
 * Bentuk sebelumnya mengirim satu INSERT per PO di dalam satu transaksi. Master
 * PGS berisi puluhan ribu baris, jadi itu puluhan ribu perjalanan pulang-pergi
 * ke Postgres pada setiap siklus lima menit — masing-masing hanya sepersekian
 * milidetik, tetapi dikalikan puluhan ribu menjadi menit-menit dengan transaksi
 * yang menahan kunci selama itu, dan autovacuum tertahan di belakangnya.
 *
 * Lima ratus baris per pernyataan menjaga jumlah parameter (7.500) jauh di
 * bawah batas 65.535 milik protokol wire Postgres, sambil memangkas jumlah
 * perjalanan menjadi seperlima ratusnya.
 */
/**
 * Memeriksa apakah chart benar-benar mengirim SATU baris per PO.
 *
 * `source_row_key` adalah `location_id|po_number`, jadi beberapa baris untuk PO
 * yang sama saling menimpa lewat `on conflict do update` — diam-diam, dan yang
 * tersimpan adalah baris yang kebetulan terakhir. Selama chart-nya memang
 * teragregasi per PO itu tidak pernah terjadi; bila kelak ia diubah menjadi
 * per-SKU, atau sebuah join menggandakan barisnya, master PO mulai menyimpan
 * angka SATU baris sebagai TOTAL sebuah PO tanpa satu pun tanda di layar.
 *
 * Yang dibedakan di sini adalah dua hal yang tampak sama:
 *
 *   duplikat   Beberapa baris, angkanya identik. Chart tidak ter-dedup, tetapi
 *              nilai yang tersimpan tetap benar.
 *   konflik    Beberapa baris, angkanya BERBEDA. Nilai yang tersimpan pasti
 *              bukan total PO itu, dan `request_quantity` serta `count_sku` —
 *              yang ikut menentukan target SLA — menjadi tidak dapat dipercaya.
 *
 * Sengaja hanya melaporkan, tidak menjumlahkan sendiri. Menjumlahkan menuntut
 * pengetahuan tentang bentuk chart yang tidak dimiliki kode ini: bila
 * `count_sku` ternyata total PO yang diulang pada tiap baris, menjumlahkannya
 * melipatgandakannya dan menggeser target SLA dari dua jam ke empat.
 */
export function auditRowKeys(values) {
  const seen = new Map();
  let duplicates = 0;
  let conflicts = 0;
  const conflicting = [];

  values.forEach((value) => {
    const [key, poNumber] = value;
    const facts = JSON.stringify(value.slice(-3)); // request_quantity, actual_quantity, count_sku
    const previous = seen.get(key);
    if (!previous) {
      seen.set(key, { facts, poNumber });
      return;
    }
    duplicates += 1;
    if (previous.facts !== facts) {
      conflicts += 1;
      if (conflicting.length < 5) conflicting.push(poNumber);
    }
  });

  return { unique: seen.size, duplicates, conflicts, conflicting };
}

async function writeRows(pool, rows, byLocation) {
  const values = rows.map((row) => rowValues(row, byLocation)).filter(Boolean);
  if (!values.length) return 0;

  const client = await pool.connect();
  try {
    await client.query("begin");
    for (let offset = 0; offset < values.length; offset += BATCH_SIZE) {
      const batch = values.slice(offset, offset + BATCH_SIZE);
      const placeholders = batch
        .map(
          (_, rowIndex) =>
            `(${COLUMNS.map((_, columnIndex) => `$${rowIndex * COLUMNS.length + columnIndex + 1}`).join(",")}, now())`,
        )
        .join(",");
      await client.query(
        `insert into superset_po_master(${COLUMNS.join(", ")}, synced_at)
         values ${placeholders}
         on conflict (source_row_key) do update set ${UPSERT_ASSIGNMENTS}, synced_at=now()`,
        batch.flat(),
      );
    }
    await client.query("commit");
    return { written: values.length, audit: auditRowKeys(values) };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Penjaga tumpang-tindih.
 *
 * Master PGS besar dan Superset kadang lambat. Bila satu siklus berjalan lebih
 * lama dari intervalnya, timer berikutnya tetap menyala — dan dua sync yang
 * menulis tabel yang sama saling menunggu kunci, sehingga siklus ketiga menyusul
 * di belakang keduanya. Yang tampak di log adalah sync yang makin lama makin
 * lambat tanpa sebab; yang sebenarnya terjadi adalah antrean yang menumpuk.
 */
let running = false;

export async function runSupersetSync(pool) {
  const cookie = await resolveCookie(pool);
  if (!cookie) {
    console.warn("[superset] cookie sesi belum diisi; sync dilewati.");
    return { skipped: true, reason: "no_cookie" };
  }
  if (running) {
    console.warn("[superset] siklus sebelumnya masih berjalan; siklus ini dilewati.");
    return { skipped: true, reason: "overlap" };
  }
  running = true;

  const started = await pool.query(
    "insert into sync_runs(sync_name, status) values('superset','RUNNING') returning run_id",
  );
  const runId = started.rows[0].run_id;

  try {
    const { rows: siteRows } = await pool.query(
      "select site_code, location_id from site_master where active order by sort_order",
    );
    if (!siteRows.length) throw new Error("Tidak ada gudang aktif di site_master.");

    const byLocation = new Map(siteRows.map((row) => [String(row.location_id), row.site_code]));
    const { rows, mode } = await fetchRows(siteRows.map((row) => String(row.location_id)), cookie);

    // Hanya baris milik gudang aktif yang disimpan, apa pun yang dikirim chart.
    const scoped = rows.filter((row) => byLocation.has(String(row[LOCATION_COLUMN] ?? "")));

    const { written, audit } = await writeRows(pool, scoped, byLocation);

    // Konflik dicatat sebagai CATATAN, bukan kegagalan: barisnya tetap tersimpan
    // dan papan tetap berjalan. Yang tidak boleh terjadi adalah ia berlalu tanpa
    // seorang pun tahu bahwa angka PO yang dipakai menghitung SLA berasal dari
    // satu baris di antara beberapa yang saling bertentangan.
    const unmapped = unmappedColumns(scoped);
    const notes = [
      audit.conflicts
        ? `${audit.conflicts} baris konflik untuk PO yang sama (mis. ${audit.conflicting.join(", ")}). ` +
          "Chart Superset mengirim lebih dari satu baris per PO dengan angka berbeda, " +
          "sehingga request_quantity dan count_sku yang tersimpan bukan total PO."
        : audit.duplicates
          ? `${audit.duplicates} baris duplikat per PO, angkanya identik; nilai tersimpan tetap benar.`
          : null,
      unmapped.length ? `Kolom sumber yang belum disimpan: ${unmapped.join(", ")}.` : null,
    ].filter(Boolean);
    const note = notes.length ? notes.join(" ") : null;

    await pool.query(
      "update sync_runs set status='SUCCESS', fetched_count=$2, written_count=$3, notes=$4, finished_at=now() where run_id=$1",
      [runId, rows.length, written, note],
    );
    if (audit.conflicts) console.error(`[superset] ${notes[0]}`);
    else if (audit.duplicates) console.warn(`[superset] ${notes[0]}`);
    if (unmapped.length) console.warn(`[superset] kolom sumber belum disimpan: ${unmapped.join(", ")}`);
    console.log(`[superset] ${written} PO tersimpan (${mode}).`);
    return { fetched: rows.length, written, mode, unique: audit.unique, unmapped, note };
  } catch (error) {
    // Pencatatan kegagalan tidak boleh melempar galat kedua: bila database
    // sendiri yang bermasalah, update ini ikut gagal, dan galat itulah yang
    // muncul di log — menyembunyikan penyebab aslinya.
    await pool
      .query(
        "update sync_runs set status=$2, error_message=$3, finished_at=now() where run_id=$1",
        // Status dibedakan supaya layar Pengaturan dapat menunjukkan tindakan
        // yang benar: cookie kedaluwarsa perlu orang, gangguan jaringan tidak.
        [runId, error?.kind === "COOKIE_EXPIRED" ? "COOKIE_EXPIRED" : "FAILED", String(error.message).slice(0, 500)],
      )
      .catch((secondary) => console.error("[superset] status gagal dicatat:", secondary.message));
    console.error("[superset] sync gagal:", error.message);
    return { error: error.message, kind: error?.kind || "FAILED" };
  } finally {
    running = false;
  }
}

export function startSupersetSync(pool) {
  // Timer SELALU dinyalakan, bahkan ketika cookie belum ada.
  //
  // Sebelumnya fungsi ini keluar lebih awal bila cookie kosong, sehingga cookie
  // yang kemudian diisi lewat layar Pengaturan tidak pernah berlaku sampai
  // proses dinyalakan ulang — persis kebalikan dari alasan setelan itu dibuat.
  // Setiap siklus kini memutuskan sendiri; yang tanpa cookie hanya melewatinya
  // dengan murah.
  //
  // Sekali saat start supaya master PO terisi tanpa menunggu satu interval
  // penuh setelah deployment.
  runSupersetSync(pool).catch((error) => console.error("[superset]", error.message));
  const timer = setInterval(
    () => runSupersetSync(pool).catch((error) => console.error("[superset]", error.message)),
    INTERVAL_MS,
  );
  // Timer tidak boleh menahan proses tetap hidup saat shutdown.
  timer.unref?.();
  console.log(`[superset] sync tiap ${Math.round(INTERVAL_MS / 60_000)} menit.`);
}
