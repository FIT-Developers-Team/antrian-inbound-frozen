# Deployment

Aplikasi ini adalah situs statis (tanpa langkah build) di depan satu Supabase
Edge Function. Memindahkannya ke domain atau hosting lain memerlukan dua
perubahan: satu di repo, satu di Supabase Secrets.

Melewatkan yang kedua adalah kesalahan yang paling sering terjadi. Gejalanya
menyesatkan: aplikasi memuat dengan sempurna, lalu setiap permintaan gagal dan
layar login menolak kredensial yang benar. Penyebabnya CORS, bukan sandi.

## 1. Repo — arahkan aplikasi ke proyek Supabase

Sunting `js/deployment.js`. Hanya berkas ini yang memuat URL backend:

```js
export const SUPABASE_PROJECT_REF = "qiafoaoslnbmtsbnmqou";
export const PRODUCTION_ORIGIN = "https://antrian-inbound-frozen.pages.dev";
```

`js/config.js`, `scripts/dev-server.mjs`, dan `npm run doctor` semuanya membaca
dari sini, jadi tidak ada URL kedua yang perlu dikejar.

## 2. Supabase — izinkan origin yang baru

`APP_ORIGINS` menentukan origin mana yang dipantulkan balik pada header CORS.
Origin di luar daftar ini ditolak browser sebelum permintaan terkirim.

```bash
supabase secrets set APP_ORIGINS="https://domain-baru.example,https://antrian-inbound-frozen.pages.dev"
```

Pisahkan dengan koma, tanpa spasi, tanpa garis miring di akhir. Sertakan setiap
domain yang benar-benar dipakai — termasuk domain lama selama masa transisi.

Verifikasi:

```bash
npm run doctor
```

Baris `Origin yang diizinkan` harus memuat domain baru.

## 3. Deploy backend

Frontend baru memanggil aksi (`board`, `history`, `auth_status`,
`source_freshness`) yang belum ada di Edge Function versi lama.

```bash
supabase db push
supabase functions deploy inbound-api --no-verify-jwt
```

`--no-verify-jwt` disengaja: fungsi ini menegakkan sesi bertanda tangan HMAC
miliknya sendiri, bukan JWT Supabase.

## 4. Deploy frontend

Paket statis hanya berisi `index.html`, `style.css`, `js/`, dan `assets/`.
`.vercelignore` mengecualikan sisanya — termasuk `scripts/`, sehingga server
pengembangan dan doctor tidak pernah ikut ter-deploy.

Cloudflare Pages:

- Build command: _(kosong)_
- Output directory: `/`

## Aplikasi Android

`capacitor.config.json` memuat origin produksi sendiri karena shell Android
hanya membuka aplikasi web yang sudah ter-deploy:

```json
"server": { "url": "https://antrian-inbound-frozen.pages.dev" }
```

Nilai ini harus cocok dengan `PRODUCTION_ORIGIN` dan harus ada di `APP_ORIGINS`.
Ketiganya pernah berbeda satu sama lain, dan akibatnya aplikasi Android gagal
memuat data tanpa pesan kesalahan yang berguna.

## Secret sisi server

| Secret                     | Wajib | Keterangan                                             |
| -------------------------- | ----- | ------------------------------------------------------ |
| `INBOUND_AUTH_USERS`       | Ya    | Array JSON berisi akun aplikasi                        |
| `INBOUND_AUTH_SECRET`      | Ya    | Kunci HMAC penanda tangan sesi                         |
| `APP_ORIGINS`              | Ya    | Origin yang diizinkan CORS                             |
| `SUPERSET_BASE_URL`        | Ya    | Sumber master PO                                       |
| `SUPERSET_SESSION_COOKIE`  | Ya    | Kedaluwarsa berkala; penyebab tersering sync membeku   |
| `SYNC_SECRET`              | Ya    | Otorisasi cron ke Edge Function                        |
| `GSHEET_SYNC_URL`          | Tidak | Endpoint Apps Script                                   |
| `GSHEET_SYNC_SECRET`       | Tidak | Otorisasi Apps Script                                  |
| `INBOUND_BOARD_DAYS_BACK`  | Tidak | Jendela papan, default 2 hari                          |

Supabase menyuntikkan `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` sendiri.
Keduanya tidak boleh muncul di kode browser.

## Akun aplikasi

Akun tidak disimpan di database. Ia dibaca dari `INBOUND_AUTH_USERS`:

```bash
supabase secrets set INBOUND_AUTH_USERS='[
  {"username":"admin","password":"GANTI_INI","role":"ADMIN","display_name":"Administrator"},
  {"username":"security.pgs","password":"GANTI_INI","role":"SECURITY","display_name":"Security PGS"},
  {"username":"checker.pgs","password":"GANTI_INI","role":"CHECKER","display_name":"Checker PGS"},
  {"username":"spv.pgs","password":"GANTI_INI","role":"SPV","display_name":"Supervisor PGS"}
]'
```

Role yang sah: `SECURITY`, `CHECKER`, `SPV`, `ADMIN`, `DEVELOPER`. Role di luar
daftar ini ditolak saat login dengan pesan yang menyebut namanya — sebelumnya
akun seperti itu berhasil masuk lalu ditolak oleh setiap aksi, yang di layar
tampak seperti aplikasi rusak.

Setelah mengubahnya, deploy ulang fungsi agar secret yang baru terbaca:

```bash
supabase functions deploy inbound-api --no-verify-jwt
```

## Ketika login gagal

`npm run doctor` membedakan penyebab yang dari layar login terlihat sama:

| Keluaran doctor                              | Penyebab                                       |
| -------------------------------------------- | ---------------------------------------------- |
| `INBOUND_AUTH_USERS belum diset`             | Tidak ada akun sama sekali                     |
| `INBOUND_AUTH_USERS tidak dapat dibaca`      | JSON rusak — sering karena kutip yang hilang   |
| `Role tidak dikenal`                         | Salah ketik pada `role`                        |
| `INBOUND_AUTH_SECRET belum diset`            | Sesi tidak dapat ditandatangani                |
| `Edge Function yang ter-deploy sudah usang`  | Fungsi lama tidak mengenal aksi yang baru      |
| Semua OK tetapi login tetap ditolak          | Sandinya memang berbeda dari yang di secret    |

Backend kini membedakan keduanya di tingkat HTTP: **401** berarti kredensial
salah, **503** berarti konfigurasi server bermasalah. Sebelumnya keduanya 401,
sehingga secret yang belum diset tidak dapat dibedakan dari salah ketik sandi.
