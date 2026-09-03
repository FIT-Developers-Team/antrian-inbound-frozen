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

/* ---------------------------------------------------------------------------
 * DATASET, BUKAN CHART.
 *
 * ================== PERINGATAN: DUA ANGKA 160 YANG BERBEDA ==================
 *
 *   SUPERSET_DATASET_ID = 160   id DATASET (tabel) di Superset
 *   location_id         = 160   kode gudang PEGANGSAAN di dalam data
 *
 * Keduanya kebetulan 160 dan TIDAK ada hubungannya satu sama lain. Menukar
 * keduanya menghasilkan sync yang "berhasil" dengan nol baris, atau menarik
 * dataset yang sama sekali lain — keduanya tanpa pesan galat. Kode di bawah
 * karena itu tidak pernah memakai satu konstanta untuk dua peran: id dataset
 * hanya muncul di `datasource.id`, dan location_id hanya datang dari
 * `site_master.location_id`.
 * ===========================================================================
 *
 * Chart (slice) dilewati sepenuhnya sebagai jalur utama, dan itu memperbaiki
 * satu kegagalan yang nyata: `query_context` milik chart membawa filternya
 * sendiri, dan filter itu tidak selalu hidup di `queries[].filters` — banyak
 * yang tersimpan sebagai `adhoc_filters` di dalam `form_data`. Membuang filter
 * lokasi dari `queries[].filters` lalu menambahkan milik kita karena itu tidak
 * menghapus apa pun: filter lama tetap ikut, di-AND dengan yang baru, dan PGS
 * menghasilkan nol baris pada chart yang kebetulan dipatok ke gudang lain.
 *
 * Chart juga MEMBATASI kolomnya pada apa yang dipilih pembuat chart, sementara
 * yang dibutuhkan di sini adalah seluruh kolom dataset.
 *
 * Bertanya langsung ke dataset menghilangkan keduanya: kolomnya ditemukan dari
 * metadata dataset itu sendiri, dan satu-satunya filter yang berlaku adalah
 * yang ditulis di sini.
 * ------------------------------------------------------------------------- */
const DATASET_ID = process.env.SUPERSET_DATASET_ID || "160";

/** Baris per halaman saat menarik dataset. Superset membatasi lewat SQL_MAX_ROW. */
const PAGE_SIZE = Number(process.env.SUPERSET_PAGE_SIZE) || 10_000;

/** Batas halaman; penjaga agar dataset yang tak terduga besar tidak berputar tanpa akhir. */
const MAX_PAGES = 40;

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

/* ---------------------------------------------------------------------------
 * Jalur dataset
 * ------------------------------------------------------------------------- */

/**
 * Kolom dataset beserta tipenya, dibaca dari metadata dataset itu sendiri.
 *
 * Daftar kolom TIDAK ditulis tangan. Menuliskannya berarti setiap kolom baru di
 * Superset harus diikuti perubahan kode di sini, dan setiap kolom yang berganti
 * nama membuat seluruh sync gagal dengan galat SQL yang tidak menyebut sebabnya.
 * Dibaca dari dataset, "seluruh kolom" selalu berarti seluruh kolom.
 *
 * Tipenya ikut dibaca karena filter lokasi membutuhkannya — lihat
 * `locationFilterValues()`.
 */
export function datasetColumnsFromMeta(meta) {
  const columns = meta?.result?.columns;
  if (!Array.isArray(columns) || !columns.length) return { names: [], types: new Map() };
  const names = [];
  const types = new Map();
  columns.forEach((column) => {
    const name = column?.column_name;
    if (!name) return;
    names.push(name);
    types.set(name, String(column?.type || "").toUpperCase());
  });
  return { names, types };
}

/**
 * Nilai filter lokasi, DIKETIK MENGIKUTI KOLOMNYA.
 *
 * `location_id` datang dari `site_master` sebagai teks, sedangkan kolom yang
 * sama di dataset bisa saja bertipe angka. Postgres menolak membandingkan
 * keduanya — `IN ('160')` pada kolom bigint gagal dengan "invalid input syntax
 * for integer" — dan mengirim keduanya sekaligus (`IN ('160', 160)`) hanya
 * memindahkan galat yang sama ke sisi lain.
 *
 * Tipenya karena itu dibaca dari metadata dataset, dan nilainya dicetak
 * mengikuti tipe itu.
 */
export function locationFilterValues(locationIds, columnType) {
  const numeric = /INT|SERIAL|NUMERIC|DECIMAL|DOUBLE|FLOAT|REAL/.test(String(columnType || "").toUpperCase());
  return locationIds.map((id) => (numeric ? Number(id) : String(id)));
}

/**
 * Badan permintaan untuk satu halaman baris mentah dari sebuah dataset.
 *
 * `metrics: []` bersama `columns` yang terisi adalah cara Superset diminta
 * mengembalikan BARIS MENTAH alih-alih agregat. Tanpa itu ia mengelompokkan
 * hasilnya, dan satu baris per PO x SKU berubah menjadi satu baris per PO —
 * persis informasi yang sedang dicari di sini.
 */
export function datasetQueryContext({ datasetId, columns, filterValues, limit, offset }) {
  return {
    datasource: { id: Number(datasetId), type: "table" },
    force: true,
    result_format: "json",
    result_type: "results",
    queries: [
      {
        columns,
        metrics: [],
        orderby: [],
        filters: [{ col: LOCATION_COLUMN, op: "IN", val: filterValues }],
        extras: { having: "", where: "" },
        row_limit: limit,
        row_offset: offset,
      },
    ],
  };
}

async function postQuery(context, cookie) {
  const response = await fetch(`${BASE_URL}/api/v1/chart/data`, {
    method: "POST",
    headers: { ...headers(cookie), "content-type": "application/json" },
    body: JSON.stringify(context),
    signal: timeoutSignal(),
  });
  assertAuthorized(response);
  if (!response.ok) {
    // Badan galat Superset menyebut kolom atau tipe yang bermasalah; tanpa itu
    // yang tercatat hanya "HTTP 400", yang tidak menuntun ke mana pun.
    const detail = await response.text().catch(() => "");
    throw new Error(`Superset menjawab HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
  return rowsFromPayload(await response.json());
}

/**
 * Menarik seluruh baris dataset untuk gudang aktif, satu halaman pada satu waktu.
 *
 * Halaman diperlukan karena Superset membatasi tiap kueri lewat `SQL_MAX_ROW`.
 * Tanpa paging, master yang melewati batas itu terpotong DIAM-DIAM: sync tetap
 * "berhasil", dan PO yang hilang hanya ketahuan ketika seseorang mendaftarkannya
 * di pos masuk dan ditolak sebagai tidak ada di master.
 */
async function fetchDatasetRows(locationIds, cookie) {
  const meta = await fetch(`${BASE_URL}/api/v1/dataset/${DATASET_ID}`, {
    headers: headers(cookie),
    signal: timeoutSignal(),
  });
  assertAuthorized(meta);
  if (!meta.ok) throw new Error(`Metadata dataset ${DATASET_ID} tidak terbaca (HTTP ${meta.status}).`);

  const { names, types } = datasetColumnsFromMeta(await meta.json());
  if (!names.length) throw new Error(`Dataset ${DATASET_ID} tidak melaporkan satu kolom pun.`);
  if (!names.includes(LOCATION_COLUMN)) {
    throw new Error(
      `Dataset ${DATASET_ID} tidak punya kolom ${LOCATION_COLUMN}. ` +
        `Kolom yang ada: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""}.`,
    );
  }

  const filterValues = locationFilterValues(locationIds, types.get(LOCATION_COLUMN));
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await postQuery(
      datasetQueryContext({
        datasetId: DATASET_ID,
        columns: names,
        filterValues,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
      cookie,
    );
    rows.push(...batch);
    // Halaman yang tidak penuh berarti dataset sudah habis.
    if (batch.length < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

async function fetchRows(locationIds, cookie) {
  /* Jalur utama: DATASET, tanpa melewati chart sama sekali.
   *
   * Chart membawa filter dan pilihan kolomnya sendiri, dan keduanya bekerja
   * melawan apa yang dibutuhkan di sini — lihat catatan panjang di dekat
   * DATASET_ID. Jalur chart di bawah dipertahankan HANYA sebagai cadangan,
   * untuk lingkungan yang datasetnya tidak dapat dikueri langsung. */
  try {
    const { rows, truncated } = await fetchDatasetRows(locationIds, cookie);
    return { rows, mode: "dataset", truncated };
  } catch (error) {
    if (error instanceof SupersetAuthError) throw error;
    console.warn(`[superset] jalur dataset gagal, mundur ke chart ${CHART_ID}:`, error.message);
  }

  // Cadangan 1: query_context milik chart dengan filter gudang aktif.
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

  // Cadangan 2: chart tanpa query_context tersimpan.
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
  "company_name", "source_count_sku",
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
  // Kedua tabel dihitung: kolom yang mendarat di baris SKU bukan kolom yang
  // terbuang. `source_count_sku` diturunkan, bukan nama kolom sumber.
  const known = new Set([...COLUMNS, ...SKU_COLUMNS]);
  return Object.keys(first)
    .filter((key) => !known.has(key) && !IGNORED_SOURCE_COLUMNS.has(key))
    .sort();
}

const SKU_COLUMNS = [
  "source_row_key", "po_number", "location_id", "site_code", "sku_number",
  "product_name", "l1_category_name", "company_name", "vendor_name",
  "request_quantity", "actual_quantity",
];

const assignments = (columns) =>
  columns.filter((column) => column !== "source_row_key")
    .map((column) => `${column}=excluded.${column}`)
    .join(", ");

const UPSERT_ASSIGNMENTS = assignments(COLUMNS);
const SKU_UPSERT_ASSIGNMENTS = assignments(SKU_COLUMNS);

const poNumberOf = (row) => text(row.po_number ?? row.po ?? row.PO);

/**
 * Mengelompokkan baris sumber menurut PO.
 *
 * Chart mengirim satu baris per PO x SKU, sedangkan `superset_po_master`
 * menyimpan satu baris per PO. Kunci `location_id|po_number` karena itu dipakai
 * beberapa baris sekaligus, dan `on conflict do update` membuat yang terakhir
 * menang — sehingga yang tersimpan sebagai "total PO" sebenarnya angka satu SKU.
 *
 * Kelompok ini yang memperbaikinya: totalnya DITURUNKAN dari barisnya.
 *
 * ASUMSI YANG PERLU DISADARI. `request_quantity` diperlakukan sebagai jumlah
 * PER SKU, jadi total PO adalah jumlahnya. Itu benar bila chart-nya memang
 * per-baris SKU; bila kelak ia justru mengulang total PO pada tiap barisnya,
 * penjumlahan ini melipatgandakannya. Karena itu `count_sku` bawaan chart tetap
 * disimpan apa adanya sebagai `source_count_sku`, dan setiap kali ia berbeda
 * dari jumlah SKU yang dihitung sendiri, selisihnya dilaporkan sebagai catatan
 * sync — di situlah asumsi ini terbukti atau terbantah, dengan angka.
 */
export function groupByPo(rows, byLocation) {
  const groups = new Map();
  rows.forEach((row) => {
    const poNumber = poNumberOf(row);
    if (!poNumber) return;
    const locationId = String(row[LOCATION_COLUMN]);
    const key = `${locationId}|${poNumber}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, locationId, poNumber, head: row, skus: new Map() };
      groups.set(key, group);
    }
    const skuNumber = text(row.sku_number);
    // Baris SKU yang sama muncul dua kali tidak dihitung dua kali.
    if (skuNumber && !group.skus.has(skuNumber)) group.skus.set(skuNumber, row);
  });
  return [...groups.values()].map((group) => ({
    ...group,
    siteCode: byLocation.get(group.locationId),
  }));
}

/**
 * Satu baris `superset_po_master` untuk satu PO.
 *
 * Ketika barisnya membawa `sku_number`, jumlah dan cacah SKU diturunkan dari
 * baris-baris itu. Ketika tidak — chart yang memang sudah teragregasi per PO —
 * angkanya diambil apa adanya dari barisnya sendiri, persis seperti sebelumnya.
 * Bentuk chart karena itu tidak perlu ditebak di muka.
 */
export function poRowValues(group) {
  const { head, skus, locationId, poNumber, siteCode } = group;
  const lines = [...skus.values()];
  const derived = lines.length > 0;
  return [
    group.key, poNumber, text(head.vendor_name), locationId,
    text(head.location_name), siteCode, text(head.request_shipping_date),
    text(head.fulfillment_arrived_start_at), text(head.schedule_type), text(head.po_status),
    text(head.fulfillment_receiving_start_at), text(head.fulfillment_completed_at),
    derived ? lines.reduce((sum, line) => sum + number(line.request_quantity), 0) : number(head.request_quantity),
    derived ? lines.reduce((sum, line) => sum + number(line.actual_quantity), 0) : number(head.actual_quantity),
    derived ? lines.length : number(head.count_sku),
    text(head.company_name),
    // Cacah SKU bawaan chart, disimpan berdampingan untuk dibandingkan.
    head.count_sku === undefined || head.count_sku === null ? null : number(head.count_sku),
  ];
}

export function skuRowValues(group) {
  const { locationId, poNumber, siteCode, skus } = group;
  return [...skus.entries()].map(([skuNumber, row]) => [
    `${locationId}|${poNumber}|${skuNumber}`, poNumber, locationId, siteCode, skuNumber,
    text(row.product_name), text(row.l1_category_name), text(row.company_name),
    text(row.vendor_name), number(row.request_quantity), number(row.actual_quantity),
  ]);
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

async function upsert(client, table, columns, assignmentList, values) {
  for (let offset = 0; offset < values.length; offset += BATCH_SIZE) {
    const batch = values.slice(offset, offset + BATCH_SIZE);
    const placeholders = batch
      .map(
        (_, rowIndex) =>
          `(${columns.map((_, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`).join(",")}, now())`,
      )
      .join(",");
    await client.query(
      `insert into ${table}(${columns.join(", ")}, synced_at)
       values ${placeholders}
       on conflict (source_row_key) do update set ${assignmentList}, synced_at=now()`,
      batch.flat(),
    );
  }
}

async function writeRows(pool, rows, byLocation) {
  const groups = groupByPo(rows, byLocation);
  if (!groups.length) return { written: 0, skuWritten: 0, audit: auditRowKeys([]), mismatched: [] };

  const poValues = groups.map(poRowValues);
  const skuValues = groups.flatMap(skuRowValues);

  // Cacah SKU yang dihitung sendiri vs yang dikirim chart. Selisihnya adalah
  // satu-satunya tempat asumsi "satu baris = satu SKU" dapat terbantah dengan
  // angka, bukan dengan dugaan.
  const mismatched = groups
    .filter((group) => {
      const source = group.head.count_sku;
      if (source === undefined || source === null || group.skus.size === 0) return false;
      return Number(source) !== group.skus.size;
    })
    .map((group) => `${group.poNumber} (chart ${group.head.count_sku}, baris ${group.skus.size})`)
    .slice(0, 5);

  const client = await pool.connect();
  try {
    await client.query("begin");
    await upsert(client, "superset_po_master", COLUMNS, UPSERT_ASSIGNMENTS, poValues);
    if (skuValues.length) {
      await upsert(client, "superset_po_sku", SKU_COLUMNS, SKU_UPSERT_ASSIGNMENTS, skuValues);

      // SKU yang HILANG dari sebuah PO harus ikut hilang di sini.
      //
      // Upsert saja tidak pernah menghapus, jadi SKU yang dicabut dari sebuah PO
      // akan menetap selamanya dan terus ikut dihitung sebagai jumlah SKU —
      // yang lalu menggeser target SLA-nya. Penghapusan dibatasi pada PO yang
      // BENAR-BENAR baru saja terlihat pada siklus ini: PO yang hilang seluruhnya
      // dari feed dibiarkan utuh, karena feed yang tiba-tiba kosong hampir selalu
      // gangguan sumber, bukan PO yang benar-benar dibatalkan.
      await client.query(
        `delete from superset_po_sku
          where (location_id || '|' || po_number) = any($1::text[])
            and source_row_key <> all($2::text[])`,
        [groups.filter((group) => group.skus.size).map((group) => group.key), skuValues.map((value) => value[0])],
      );
    }
    await client.query("commit");
    return {
      written: poValues.length,
      skuWritten: skuValues.length,
      audit: auditRowKeys(poValues),
      mismatched,
    };
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
    const { rows, mode, truncated } = await fetchRows(siteRows.map((row) => String(row.location_id)), cookie);

    // Hanya baris milik gudang aktif yang disimpan, apa pun yang dikirim chart.
    const scoped = rows.filter((row) => byLocation.has(String(row[LOCATION_COLUMN] ?? "")));

    const { written, skuWritten, audit, mismatched } = await writeRows(pool, scoped, byLocation);

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
      truncated
        ? `Dataset terpotong pada batas ${MAX_PAGES * PAGE_SIZE} baris; sebagian PO kemungkinan belum tersimpan.`
        : null,
      mode !== "dataset"
        ? `Jalur dataset tidak dapat dipakai; data ditarik lewat chart ${CHART_ID} (${mode}), ` +
          "yang membawa filter dan pilihan kolomnya sendiri."
        : null,
      mismatched.length
        ? `Cacah SKU chart berbeda dari jumlah barisnya pada ${mismatched.length} PO ` +
          `(${mismatched.join("; ")}). Satu baris tampaknya BUKAN satu SKU, jadi total ` +
          "request_quantity yang dijumlahkan dari baris kemungkinan terlalu besar."
        : null,
    ].filter(Boolean);
    const note = notes.length ? notes.join(" ") : null;

    await pool.query(
      "update sync_runs set status='SUCCESS', fetched_count=$2, written_count=$3, notes=$4, finished_at=now() where run_id=$1",
      [runId, rows.length, written, note],
    );
    if (audit.conflicts) console.error(`[superset] ${notes[0]}`);
    else if (audit.duplicates) console.warn(`[superset] ${notes[0]}`);
    if (unmapped.length) console.warn(`[superset] kolom sumber belum disimpan: ${unmapped.join(", ")}`);
    if (mismatched.length) console.error(`[superset] cacah SKU tidak cocok: ${mismatched.join("; ")}`);
    console.log(`[superset] ${written} PO tersimpan${skuWritten ? `, ${skuWritten} baris SKU` : ""} (${mode}).`);
    return { fetched: rows.length, written, sku_written: skuWritten, mode, unique: audit.unique, unmapped, note };
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
