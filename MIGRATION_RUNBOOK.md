# Antrian Inbound Frozen — Runbook Supabase & Multi Site

## Arsitektur target

- Cloudflare Pages menyajikan `index.html`, `style.css`, `js/`, dan `assets/` saja.
- Supabase Postgres memiliki tiket operasional, baris PO, event, gate, master checker,
  dokumen BA, master produk, outbox Google Sheets, master gudang, dan metadata sync.
- Supabase Edge Functions memiliki seluruh request terautentikasi dan integrasi sisi server.
- Supabase Cron memanggil `sync-superset` tiap lima menit, worker Google Sheets tiap menit,
  dan pembersih outbox macet tiap lima belas menit.
- Browser tidak pernah menerima service-role key, cookie Superset, sync secret, atau secret Apps Script.

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

`SUPERSET_CHART_ID` (default `20662`) menentukan saved chart yang dibaca. Chart
lama difilter ke CBT (819) di sisi Superset, jadi arahkan variabel ini ke chart
yang memuat gudang aktif. Berapa pun isi chart, `sync-superset` hanya menyimpan
baris dengan `location_id` milik gudang aktif, dan `inbound_finalize_superset_sync`
menolak stage yang memuat location_id di luar daftar tersebut.

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
- `SUPERSET_SESSION_COOKIE`
- `GSHEET_SYNC_URL`
- `GSHEET_SYNC_SECRET`
- `GSHEET_SYNC_ENABLED`
- `APP_ORIGINS`
- `INBOUND_SNAPSHOT_DAYS_BACK` (opsional, default `7`)

Supabase menyuntikkan `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` ke Edge Function.
Keduanya tidak boleh disalin ke kode browser.

`APP_ORIGINS` wajib berisi origin produksi. Bila kosong, CORS jatuh ke `*`; bila diisi,
origin di luar daftar tidak pernah dipantulkan balik.

## Kontrak performa

| Action        | Isi                                       | Frekuensi        | Cache   |
| ------------- | ----------------------------------------- | ---------------- | ------- |
| `state`       | Baris operasional + checker + katalog site | Polling 10 detik | ETag    |
| `state_delta` | Hanya baris yang berubah + id yang hidup   | Polling 10 detik | —       |
| `po_master`   | Master PO Superset gudang aktif            | Saat buka Daftar | ETag    |
| `export_rows` | Seluruh riwayat, berpaginasi               | Manual           | —       |

`state` **tidak lagi** membawa master PO. Sebelumnya setiap polling menarik seluruh
`superset_po_master`, termasuk untuk layar yang tidak memerlukannya. Jendela hari
operasional dibatasi `INBOUND_SNAPSHOT_DAYS_BACK` (default 7 hari, maksimum 90).

Respons ber-fingerprint mengirim `ETag`; klien mengirim `If-None-Match` dan menerima
`304` tanpa body ketika data tidak berubah. Agar ini bekerja lintas asal,
`access-control-expose-headers` wajib memuat `etag`.

## Verifikasi cutover

- `GET inbound-api?action=health` mengembalikan HTTP 200 dengan `backend=supabase`
  dan daftar `active_sites`.
- Pengguna terkonfigurasi dapat login dan membaca `state`.
- Tiket manual sekali pakai dapat dibuat, dibaca ulang, dan dihapus tanpa sisa baris.
- Jumlah produk dan checker cocok dengan seed sumber.
- Sync Superset mengembalikan jumlah baris dan checksum bukan nol, serta laporan
  `per_site` yang memuat setiap gudang aktif.
- `inbound_superset_freshness()` melaporkan run sukses tidak lebih lama dari sepuluh menit.
- Ketiga baris di `cron.job` aktif.
- Setiap menu UI terbuka tanpa 404 atau error server.
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
