# Antrian Inbound Frozen — Runbook Supabase & Multi Site

## Arsitektur target

- Cloudflare Pages menyajikan `index.html`, `style.css`, `js/`, dan `assets/` saja.
  Frontend adalah modul ES tanpa langkah build: `js/app.js` merakit kerangka dan
  merutekan empat halaman (Papan Antrean, Daftar, Laporan, Pengaturan); `js/pages/`
  memuat isinya; `js/api.js` adalah satu-satunya jalur ke server.
- Supabase Postgres memiliki tiket operasional, baris PO, event, gate, master checker,
  dokumen BA, master produk, outbox Google Sheets, master gudang, dan metadata sync.
- Supabase Edge Functions memiliki seluruh request terautentikasi dan integrasi sisi server.
- Supabase Cron memanggil `sync-superset` tiap lima menit, worker Google Sheets tiap menit,
  dan pembersih outbox macet tiap lima belas menit.
- Browser tidak pernah menerima service-role key, cookie Superset, sync secret, atau secret Apps Script.
- Tidak ada Tailwind CDN dan tidak ada klien realtime. Keduanya dihapus pada
  revamp v2: yang pertama menyusun ulang CSS di browser pada setiap muat halaman,
  yang kedua selalu jatuh ke polling karena `realtime_config` mengembalikan
  `enabled: false` tetapi tetap terunduh.

## Gudang (site)

| Kode | location_id | Nama       | Status awal |
| ---- | ----------- | ---------- | ----------- |
| PGS  | 160         | Pegangsaan | Aktif       |
| SRG  | 796         | Srengseng  | Nonaktif    |
| BIT  | 983         | Bitung     | Nonaktif    |
| CSI  | 998         | Cileungsi  | Nonaktif    |

Sumber kebenaran ada di dua tempat yang saling diverifikasi oleh
`test/multi-site-contract.test.js`:

- Backend: tabel `public.site_master`.
- Frontend: `js/site_config.js`.

### Mengaktifkan gudang berikutnya

```sql
update public.site_master set active = true where site_code = 'SRG';
```

Setelah perintah itu:

1. `inbound_active_location_ids()` langsung menyertakan `796`.
2. `sync-superset` mulai menyimpan PO dengan `location_id = 796` dan menolak
   snapshot yang tidak memuat satu pun location_id gudang aktif.
3. Payload `state` mengirim katalog gudang + gate terbaru; frontend menampilkan
   pemilih gudang di header tanpa deploy ulang.
4. Nomor antrian harian dan sequence nomor BA berjalan terpisah per gudang.

Jumlah dock per gudang diatur lewat `site_master.gate_count`. Nama gate dibangkitkan
sebagai `<gate_prefix>-NN`, contoh `SRG-GATE-INB-01-04`. Nilai awal SRG/BIT/CSI adalah
6 dock; sesuaikan dengan kondisi fisik sebelum gudang diaktifkan.

### Chart Superset

`sync-superset` bekerja dua tahap agar benar-benar menarik gudang yang aktif,
bukan sekadar menyaring apa pun yang dikirim chart:

1. **Jalur utama.** Membaca `query_context` dari chart `SUPERSET_CHART_ID`
   (default `20662`), membuang filter pada kolom `SUPERSET_LOCATION_COLUMN`
   (default `location_id`), menggantinya dengan daftar `location_id` gudang
   aktif, lalu mengeksekusinya lewat `POST /api/v1/chart/data`. Dengan begitu
   permintaan ke Superset sudah spesifik ke PGS (160).
2. **Cadangan.** Bila chart tidak menyimpan `query_context` atau eksekusinya
   gagal, sync jatuh ke `GET /api/v1/chart/{id}/data/?force=true` seperti
   sebelumnya.

Respons sync menyertakan `fetch_mode` (`query_context_filtered` atau
`saved_chart`) supaya jalur mana yang terpakai selalu terlihat.

Apa pun jalurnya, hanya baris dengan `location_id` milik gudang aktif yang
disimpan, dan `inbound_finalize_superset_sync` menolak stage yang memuat
location_id di luar daftar tersebut.

## Urutan deployment

1. Terapkan file SQL di `supabase/migrations` sesuai urutan nama file.
2. Deploy `inbound-api`, `sync-superset`, dan `sync-gsheet` dengan verifikasi JWT
   dimatikan; ketiganya menegakkan session bertanda tangan atau sync secret sendiri.
3. Konfigurasikan Edge Function secrets. Jangan pernah menaruh nilai secret di Git
   atau di Cloudflare Pages.
4. Seed `product_master` dan `checker_master` dengan `npm run seed:supabase`.
   Sumber datanya `data/product_master.csv` dan `data/checker_master.csv`.
5. Panggil sekali action terproteksi `sync-superset?action=configure-cron` untuk
   memasang/merotasi otorisasi cron berbasis Vault.
6. Jalankan sync Superset manual dan verifikasi jumlah baris, checksum, dan
   kesegaran data sebelum cutover frontend.
7. Bangun paket statis berisi `index.html`, `style.css`, `js/`, dan `assets/` saja,
   lalu deploy ke Cloudflare Pages.

## Secret sisi server

- `INBOUND_AUTH_USERS`
- `INBOUND_COMMERCIAL_USER` (akun read-only terpisah agar rotasi tidak menimpa akun operasional)
- `INBOUND_AUTH_SECRET`
- `SYNC_SECRET`
- `SUPERSET_BASE_URL`
- `SUPERSET_CHART_ID` (opsional, default `20662`)
- `SUPERSET_LOCATION_COLUMN` (opsional, default `location_id`)
- `SUPERSET_SESSION_COOKIE`
- `GSHEET_SYNC_URL`
- `GSHEET_SYNC_SECRET`
- `GSHEET_SYNC_ENABLED`
- `APP_ORIGINS`
- `INBOUND_BOARD_DAYS_BACK` (opsional, default `2`)

Supabase menyuntikkan `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` ke Edge Function.
Keduanya tidak boleh disalin ke kode browser.

`APP_ORIGINS` wajib berisi origin produksi. Bila kosong, CORS jatuh ke `*`; bila diisi,
origin di luar daftar tidak pernah dipantulkan balik.

## SLA, kedatangan, dan mulai bongkar

### Satu sumber kebenaran SLA

Target SLA sekarang dihitung `public.inbound_sla_target_hours(fleet, sku)` di
database dan dibawa view `inbound_board` sebagai `sla_target_hours`,
`sla_deadline_at`, `sla_started_at`, dan `sla_stopped_at`.

Sebelumnya aturan yang sama ditulis ulang di tiga tempat dengan hasil berbeda:

| Armada             | js/app.js   | sync-gsheet lama |
| ------------------ | ----------- | ---------------- |
| TRONTON/FUSO, WING | 4 jam       | 4 jam            |
| CDD/CDDL/CDE/CDEL  | >40 SKU 4j  | >40 SKU 4j       |
| VAN/PICKUP/MOBIL   | 2 jam       | **1 jam**        |
| RODA 2             | 1 jam       | **tanpa SLA**    |
| DROP-OFF           | 23 jam      | **tanpa SLA**    |

Angka di Google Sheet karena itu tidak pernah cocok dengan angka yang dilihat
operator. Aturan database memakai versi operasional (kolom kiri), dan
`sync-gsheet` kini membaca `row.sla_target_hours` alih-alih menghitung sendiri.

### Hitung mundur

Browser tidak menghitung target sendiri; ia hanya mengurangkan waktu sekarang
terhadap `sla_deadline_at`. Nada warnanya: abu-abu belum mulai, hijau masih
longgar, kuning 30 menit terakhir, merah lewat target.

Sebelum perbaikan ini hitung mundur **mati total** — `getInboundSlaInfoV15`
memanggil `getSlaHours()` yang tidak pernah didefinisikan, sehingga target
selalu 0 dan setiap tiket melaporkan "Belum mulai".

### Jam kedatangan

`tickets.arrived_at` ada sejak awal tetapi tidak pernah dapat diisi. Sekarang:

- Form Security punya field **Jam Kedatangan** (default jam sekarang, tidak
  boleh masa depan).
- `POST inbound-api?action=set_arrival` mengoreksi kedatangan tiket yang sudah
  berjalan. Security, Checker, dan SPV boleh memakainya.
- Waktu tunggu driver dihitung dari `arrived_at` sampai `start_unloading_at`,
  bukan dari jam pengisian form.

### Mulai bongkar

`POST inbound-api?action=start_unloading` memulai bongkar untuk seluruh PO yang
masih `PENDING` dalam satu aksi, mengisi `arrived_at` dan `called_at` bila masih
kosong, dan bersifat idempoten — menekan dua kali tidak menggeser jam mulai,
karena itu akan memundurkan deadline SLA secara diam-diam.

## Kontrak performa

| Action         | Isi                                                | Frekuensi        | Cache |
| -------------- | -------------------------------------------------- | ---------------- | ----- |
| `board`        | Satu baris per tiket + gate + katalog site          | 15 detik         | ETag  |
| `po_master`    | Master PO Superset gudang aktif                     | Saat buka Daftar | ETag  |
| `history`      | Riwayat pada rentang tanggal, dibatasi 5000 baris   | Manual           | —     |

### Satu baris per tiket

`board` memakai view `public.inbound_board`, yang mengagregasi PO menjadi
`po_numbers`, `po_count`, `total_qty`, dan `total_sku`.

Sebelumnya `state` mengirim `inbound_operational_rows`, yaitu hasil join
`tickets × ticket_pos`. Tiket dengan delapan PO menghasilkan delapan baris yang
masing-masing membawa payload tiket lengkap, dan browser menyusunnya kembali
menjadi satu kartu. Papan hanya butuh satu baris, jadi agregasinya dipindahkan
ke Postgres.

### ETag

Respons ber-fingerprint mengirim `ETag`; klien mengirim `If-None-Match` dan
menerima `304` tanpa body ketika data tidak berubah. Agar bekerja lintas asal,
`access-control-expose-headers` wajib memuat `etag`.

Setiap aksi tulis mengosongkan cache ETag di klien. Tanpa itu, polling
berikutnya bisa dijawab `304` dan papan tampak tidak berubah sesaat setelah
operator menekan tombol.

### Riwayat dibatasi di server

`history` menerima `from` dan `to`, dan menyaringnya di Postgres. Sebelumnya
laporan memanggil `export_rows` yang menarik seluruh tabel berpaginasi lalu
menyaringnya di browser.

### Satu ticker untuk elemen live

Seluruh hitung mundur melewati satu ticker satu detik di `js/sla.js` yang
berhenti pada `visibilitychange`. Setiap elemen membawa tenggatnya sendiri di
atribut `data-sla-*`, sehingga ticker hanya menulis ulang teks dan tidak pernah
me-render ulang kartu atau tabel.

Sebelumnya ada tiga interval satu detik yang berjalan bersamaan
(`liveWaitingTimer`, `__wmLiveSlaTimer`, `driverTrackTimer`) dan tidak satu pun
berhenti saat tab disembunyikan.

### Yang dihapus pada revamp v2

| Dihapus                                   | Alasan                                                        |
| ----------------------------------------- | ------------------------------------------------------------- |
| `api/inbound.js`, `api/sync-superset.js`  | Backend Vercel duplikat; `.vercelignore` mengecualikan `api/` dan tidak ada `vercel.json`, jadi tidak pernah ter-deploy |
| `js/api_v2.js` (6.439 baris)              | Digantikan `js/api.js` + `js/store.js`                        |
| `js/realtime_client*.js`                  | Selalu jatuh ke polling; ~50 KB terunduh tanpa pernah dipakai |
| Tailwind CDN                              | Compiler runtime, bukan untuk produksi                         |
| Halaman BA Reject, COMERCIAL, Panggil/TV, Debug, Drop-Off | Di luar empat kebutuhan inti; aksi backend-nya ikut dihapus |
| Sintesis suara, mode TV, QR driver tracking | Tidak dipakai alur pos masuk                                  |

Tiga belas fungsi di `js/app.js` lama terdefinisi dua kali (`pageDaftar`,
`pageChecker`, `checkerTicketCard`, `validateSecurityForm`, dan lainnya).
Definisi terakhir yang menang, sementara ribuan baris sebelumnya tetap dikirim
ke setiap browser. `test/architecture.test.js` sekarang menolak definisi ganda.

## Verifikasi cutover

- `GET inbound-api?action=health` mengembalikan HTTP 200 dengan `backend=supabase`
  dan daftar `active_sites`.
- Pengguna terkonfigurasi dapat login dan membaca `board`.
- Tiket manual sekali pakai dapat dibuat, dibaca ulang, dan dihapus tanpa sisa baris.
- Jumlah produk dan checker cocok dengan seed sumber.
- Sync Superset mengembalikan jumlah baris dan checksum bukan nol, serta laporan
  `per_site` yang memuat setiap gudang aktif.
- `inbound_superset_freshness()` melaporkan run sukses tidak lebih lama dari sepuluh menit.
- Ketiga baris di `cron.job` aktif.
- Keempat menu UI terbuka tanpa 404 atau error server.
- Hitung mundur SLA berdetak pada tiket yang sedang bongkar, dan berhenti pada
  tiket yang sudah selesai.
- `npm test` hijau (81 test) dan `npm run check:functions` berhasil.
- Deployment Cloudflare Pages tidak memuat `api/`, `supabase/`, `.env*`, `.claude/`,
  atau file backend/runtime.
- Polling kedua terhadap `state` tanpa perubahan data mengembalikan HTTP 304.

## Dampak rebrand pada klien lama

Kunci penyimpanan lokal ikut berganti dari `inbound_cbt_*` ke `inbound_frozen_*`.
Konsekuensinya, seluruh sesi lama berakhir dan operator perlu login ulang satu kali.
Ini disengaja: cache tiket, filter, dan baris cetak milik CBT tidak boleh muncul di
tampilan PGS.

`applicationId` Android tetap `id.astronauts.inboundcbt` supaya APK terpasang dapat
di-update, bukan terinstal sebagai aplikasi kedua. Hanya nama tampilan yang berubah.

## Snapshot terakhir yang valid dan retensi

Baris Superset mendarat di `superset_po_stage` per chunk. `inbound_finalize_superset_sync`
menukar snapshot publik hanya setelah jumlah baris dan checksum tervalidasi, dan hanya
menghapus baris milik gudang aktif — snapshot gudang non-aktif tidak boleh terhapus oleh
sync gudang lain. Response kosong atau gagal membiarkan snapshot sukses terakhir utuh,
dan stage run yang gagal dibersihkan. Metadata sync lebih tua dari 30 hari dihapus
setelah sync sukses.

## Rollback

- Pertahankan deployment produksi Cloudflare Pages sebelumnya sampai kesegaran data
  Supabase dan pemeriksaan UI lulus.
- Bila validasi Supabase gagal, jangan promosikan deployment statis.
- Bila frontend yang sudah dipromosikan gagal, kembalikan ke deployment immutable
  Cloudflare Pages sebelumnya; backend tetap di Supabase.
- Jangan menghapus konfigurasi Vercel lama atau mematikan scheduler yang masih bekerja
  sebelum penggantinya terbukti segar.

## Blocker eksternal yang masih terbuka

- Hosting Vercel lama dihentikan dan tidak lagi melayani produksi.
- Nilai sensitif Vercel tidak dapat ditampilkan lagi setelah dibuat. Cookie `session`
  Superset yang baru harus disalin langsung dari sesi browser AstroDash yang sudah login
  ke secret Supabase `SUPERSET_SESSION_COOKIE`.
- URL Google Apps Script lama mengembalikan HTTP 404. Pertahankan `GSHEET_SYNC_ENABLED=false`
  sampai URL deployment dan Script Property-nya diperbaiki dan diverifikasi.
- Nama project Cloudflare Pages dan domain masih `antrian-inbound-cbt`. `capacitor.config.json`
  sudah menunjuk `antrian-inbound-frozen.pages.dev`; rename project Pages perlu dilakukan
  di dashboard Cloudflare sebelum APK baru dibangun.
