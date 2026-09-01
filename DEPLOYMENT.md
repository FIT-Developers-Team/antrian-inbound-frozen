# Deployment — langkah demi langkah

Aplikasi ini adalah situs statis (tanpa langkah build) di depan satu Supabase
Edge Function. Ikuti langkah di bawah **berurutan**. Urutannya penting: fungsi
memanggil RPC yang baru ada setelah migrasi diterapkan, jadi men-deploy fungsi
lebih dulu akan membuat aplikasi mati di antara dua langkah.

Perkiraan waktu: 20–30 menit untuk deployment pertama, 5 menit untuk pembaruan
berikutnya.

---

## Prasyarat

| Kebutuhan          | Verifikasi                         |
| ------------------ | ---------------------------------- |
| Node.js 22 atau lebih baru | `node --version`           |
| Supabase CLI       | `npx supabase --version`           |
| Akses repo         | `git remote -v`                    |
| Akses dashboard Supabase | Untuk menyetel secret        |

Semua perintah dijalankan dari akar repo.

---

## Langkah 0 — Potret keadaan sekarang

Jalankan ini **sebelum** mengubah apa pun, supaya Anda tahu apa yang sudah
benar dan apa yang belum:

```bash
npm run doctor
```

Simpan keluarannya. Setelah selesai deploy, seluruh baris harus `OK`.

---

## Langkah 1 — Arahkan aplikasi ke tujuan

**Lewati langkah ini bila proyek Supabase dan domainnya tidak berubah.**

Sunting `js/deployment.js` — hanya berkas ini yang memuat URL backend:

```js
export const SUPABASE_PROJECT_REF = "qiafoaoslnbmtsbnmqou";
export const PRODUCTION_ORIGIN = "https://antrian-inbound-frozen.pages.dev";
```

`js/config.js`, `scripts/dev-server.mjs`, dan `npm run doctor` semuanya membaca
dari sini, jadi tidak ada URL kedua yang perlu dikejar.

Bila aplikasi Android ikut dipakai, samakan juga `capacitor.config.json`:

```json
"server": { "url": "https://domain-baru.example" }
```

Ketiga nilai — `PRODUCTION_ORIGIN`, `capacitor.config.json`, dan `APP_ORIGINS`
di Langkah 3 — harus sama persis. Ketiganya pernah berbeda satu sama lain, dan
akibatnya aplikasi Android gagal memuat data tanpa pesan yang berguna.

---

## Langkah 2 — Tautkan proyek Supabase

```bash
npx supabase login
npx supabase link --project-ref qiafoaoslnbmtsbnmqou
```

Ganti `--project-ref` bila pindah proyek. `supabase/config.toml` sudah memuat
`project_id` dan `verify_jwt = false` untuk ketiga fungsi, jadi tidak ada lagi
yang perlu diatur di sini.

Verifikasi:

```bash
npx supabase projects list
```

Proyek yang tertaut ditandai pada kolom `LINKED`.

---

## Langkah 3 — Setel secret sisi server

Secret dibaca fungsi saat dijalankan. **Setel sebelum men-deploy fungsi**,
supaya fungsi tidak pernah hidup dalam keadaan setengah terkonfigurasi.

### 3a. Akun aplikasi (wajib)

Akun **tidak** disimpan di database. Ia dibaca dari `INBOUND_AUTH_USERS`:

```bash
npx supabase secrets set INBOUND_AUTH_USERS='[
  {"username":"admin","password":"GANTI_INI","role":"ADMIN","display_name":"Administrator"},
  {"username":"security.pgs","password":"GANTI_INI","role":"SECURITY","display_name":"Security PGS"},
  {"username":"checker.pgs","password":"GANTI_INI","role":"CHECKER","display_name":"Checker PGS"},
  {"username":"spv.pgs","password":"GANTI_INI","role":"SPV","display_name":"Supervisor PGS"}
]'
```

Role yang sah hanya: `SECURITY`, `CHECKER`, `SPV`, `ADMIN`, `DEVELOPER`.
Role di luar daftar ini ditolak saat login dengan pesan yang menyebut namanya —
sebelumnya akun seperti itu berhasil masuk lalu ditolak oleh setiap aksi, yang
di layar tampak seperti aplikasi rusak.

### 3b. Kunci penanda tangan sesi (wajib)

```bash
npx supabase secrets set INBOUND_AUTH_SECRET="$(openssl rand -base64 48)"
```

Tanpa ini, login gagal dengan HTTP 503 karena token sesi tidak dapat
ditandatangani.

### 3c. Origin yang diizinkan (wajib)

```bash
npx supabase secrets set APP_ORIGINS="https://antrian-inbound-frozen.pages.dev"
```

Pisahkan beberapa origin dengan koma, **tanpa spasi dan tanpa garis miring di
akhir**. Sertakan setiap domain yang benar-benar dipakai, termasuk domain lama
selama masa transisi.

Ini langkah yang paling sering terlewat, dan gejalanya menyesatkan: aplikasi
memuat sempurna, lalu setiap permintaan gagal dan layar login menolak
kredensial yang benar. Penyebabnya CORS, bukan sandi.

### 3d. Sisanya

```bash
npx supabase secrets set \
  SYNC_SECRET="$(openssl rand -base64 32)" \
  SUPERSET_BASE_URL="https://dash.astronauts.id" \
  SUPERSET_SESSION_COOKIE="session=..." \
  GSHEET_SYNC_URL="https://script.google.com/macros/s/..." \
  GSHEET_SYNC_SECRET="..." \
  GSHEET_SYNC_ENABLED="true"
```

Daftar lengkap:

| Secret                    | Wajib | Keterangan                                            |
| ------------------------- | ----- | ----------------------------------------------------- |
| `INBOUND_AUTH_USERS`      | Ya    | Array JSON berisi akun aplikasi                       |
| `INBOUND_AUTH_SECRET`     | Ya    | Kunci HMAC penanda tangan sesi                        |
| `APP_ORIGINS`             | Ya    | Origin yang dipantulkan CORS                          |
| `SYNC_SECRET`             | Ya    | Otorisasi cron ke Edge Function                       |
| `SUPERSET_BASE_URL`       | Ya    | Sumber master PO                                      |
| `SUPERSET_SESSION_COOKIE` | Ya    | **Kedaluwarsa berkala** — penyebab tersering sync beku |
| `SUPERSET_CHART_ID`       | Tidak | Default `20662`                                       |
| `SUPERSET_LOCATION_COLUMN`| Tidak | Default `location_id`                                 |
| `GSHEET_SYNC_URL`         | Tidak | Endpoint Apps Script                                  |
| `GSHEET_SYNC_SECRET`      | Tidak | Otorisasi Apps Script                                 |
| `GSHEET_SYNC_ENABLED`     | Tidak | `false` untuk mematikan sinkronisasi sheet            |
| `INBOUND_BOARD_DAYS_BACK` | Tidak | Jendela papan, default 2 hari                         |

`SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` disuntikkan Supabase sendiri.
Keduanya tidak boleh muncul di kode browser atau di repo.

Verifikasi (menampilkan nama saja, bukan nilainya):

```bash
npx supabase secrets list
```

---

## Langkah 4 — Terapkan migrasi database

```bash
npx supabase db push
```

Ini menerapkan sembilan berkas di `supabase/migrations/` sesuai urutan nama:

| Berkas                                   | Isi                                        |
| ---------------------------------------- | ------------------------------------------ |
| `20260824010000_inbound_core`            | Tabel, view, RLS                           |
| `20260824011000_inbound_admin_and_ba`    | Fungsi admin                               |
| `20260824012000_inbound_cron`            | Penjadwal + Vault                          |
| `20260831010000_inbound_multi_site`      | `site_master`, scoping per gudang          |
| `20260831011000_inbound_performance`     | Snapshot ber-fingerprint, index            |
| `20260831012000_inbound_cron_hardening`  | Cron dengan otorisasi Vault                |
| `20260901010000_inbound_sla_and_arrival` | Aturan SLA, kedatangan, mulai bongkar      |
| `20260901020000_inbound_board_core`      | `inbound_board`, riwayat, aksi tiket       |
| `20260901030000_inbound_live_sync`       | Kesegaran sumber PGS 160                   |

Migrasi bersifat idempoten (`create or replace`, `create if not exists`), jadi
aman dijalankan ulang.

Verifikasi:

```bash
npx supabase migration list
```

Kolom `REMOTE` harus terisi untuk kesembilan berkas.

---

## Langkah 5 — Seed data referensi

Hanya perlu sekali per proyek, atau ketika master produk/checker berubah.

Buat `.env.supabase.local` di akar repo (sudah tercakup `.gitignore`):

```
SUPABASE_URL=https://qiafoaoslnbmtsbnmqou.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

Lalu:

```bash
npm run seed:supabase
```

Sumber datanya `data/product_master.csv` dan `data/checker_master.csv`.

> Service-role key memiliki akses penuh ke database. Ia hanya boleh ada di
> berkas lokal ini dan tidak pernah masuk repo atau kode browser.

---

## Langkah 6 — Deploy Edge Functions

```bash
npx supabase functions deploy inbound-api
npx supabase functions deploy sync-superset
npx supabase functions deploy sync-gsheet
```

`verify_jwt = false` sudah dideklarasikan di `supabase/config.toml` untuk
ketiganya, jadi tidak perlu flag tambahan. Ini disengaja: fungsi menegakkan
sesi bertanda tangan HMAC miliknya sendiri, bukan JWT Supabase.

Verifikasi:

```bash
npm run doctor
```

Baris berikut harus berubah menjadi `OK`:

- `Edge Function menerima If-None-Match` — menandakan versi terbaru sudah tayang
- `N akun terdaftar dengan role: ...` — menandakan `INBOUND_AUTH_USERS` terbaca

---

## Langkah 7 — Pasang penjadwal

Sekali saja per proyek, dan ulangi bila `SYNC_SECRET` dirotasi:

```bash
curl -X POST \
  -H "Authorization: Bearer $SYNC_SECRET" \
  "https://qiafoaoslnbmtsbnmqou.supabase.co/functions/v1/sync-superset?action=configure-cron"
```

Ini memasang tiga jadwal dan menyimpan otorisasinya di Vault:

| Job                        | Jadwal        | Tugas                          |
| -------------------------- | ------------- | ------------------------------ |
| `inbound-sync-superset-5m` | `*/5 * * * *` | Tarik master PO dari Superset  |
| `inbound-sync-gsheet-1m`   | `* * * * *`   | Kirim baris ke Google Sheet    |
| `inbound-reap-gsheet-15m`  | `*/15 * * * *`| Coba ulang outbox yang macet   |

Verifikasi lewat SQL editor Supabase:

```sql
select jobname, schedule, active from cron.job order by jobname;
```

---

## Langkah 8 — Sinkronisasi Superset pertama

```bash
curl -X POST \
  -H "Authorization: Bearer $SYNC_SECRET" \
  "https://qiafoaoslnbmtsbnmqou.supabase.co/functions/v1/sync-superset"
```

Responsnya harus memuat jumlah baris bukan nol dan `fetch_mode`
(`query_context_filtered` atau `saved_chart`).

Verifikasi lewat SQL editor:

```sql
select location_id, count(*), max(synced_at)
from public.superset_po_master group by location_id;
```

Harus muncul `location_id = 160` (PGS) dengan `synced_at` beberapa detik lalu.

---

## Langkah 9 — Deploy frontend

Paket statis hanya berisi `index.html`, `style.css`, `js/`, dan `assets/`.
`.vercelignore` mengecualikan sisanya — termasuk `scripts/`, sehingga server
pengembangan dan doctor tidak pernah ikut ter-deploy.

### Coolify (cara yang dipakai sekarang)

Coolify membangun dari `Dockerfile` di akar repo. Image-nya hanya nginx berisi
berkas statis — tanpa Node, tanpa `node_modules`.

| Pengaturan Coolify   | Nilai                     |
| -------------------- | ------------------------- |
| Build Pack           | **Dockerfile**            |
| Branch               | `main`                    |
| Dockerfile Location  | `/Dockerfile`             |
| Port                 | `80`                      |
| Health Check Path    | `/healthz`                |

Variabel lingkungan (opsional, hanya bila pindah proyek Supabase):

```
SUPABASE_PROJECT_REF=qiafoaoslnbmtsbnmqou
```

**`APP_ORIGINS` tidak diperlukan untuk mode ini.** nginx di dalam kontainer
memproksikan `/api/inbound` ke Supabase, sehingga permintaan API berada di
origin yang sama dengan aplikasinya dan tidak pernah menjadi lintas asal. Inilah
alasan proksi itu ada: CORS adalah satu-satunya bagian deployment ini yang
berulang kali gagal, dan gejalanya selalu menyesatkan — aplikasi memuat
sempurna, lalu layar login menolak kredensial yang benar.

Uji image-nya secara lokal sebelum mendorong ke Coolify:

```bash
docker build -t inbound-frozen .
docker run --rm -p 8099:80 inbound-frozen
curl http://localhost:8099/healthz
curl "http://localhost:8099/api/inbound?action=health"
```

Perintah terakhir harus menjawab JSON dari Supabase. Bila ia menjawab **502**,
proksi gagal menyelesaikan DNS — periksa keluaran `10-resolver` di log
kontainer.

### Hosting statis murni (Cloudflare Pages, GitHub Pages)

Hosting yang tidak dapat memproksikan apa pun harus memanggil Supabase langsung:

1. Setel `USE_API_PROXY = false` di `js/deployment.js`.
2. `APP_ORIGINS` **wajib** memuat origin produksi secara persis.

Cloudflare Pages: production branch `main`, build command kosong, output `/`.

---

## Langkah 10 — Verifikasi menyeluruh

```bash
npm run doctor
```

Seluruh baris harus `OK`. Lalu buka aplikasi dan periksa:

- [ ] Layar login muncul, dan akun `admin` berhasil masuk
- [ ] Papan Antrean memuat tiket
- [ ] Pil topbar menampilkan **Tersambung**, bukan **Sumber 160 basi**
- [ ] Pengaturan → Sumber data menunjukkan lencana **Segar** dan `location_id` 160
- [ ] Daftar → pencarian PO mengembalikan hasil dari master
- [ ] Hitung mundur SLA berdetak pada tiket yang sedang bongkar
- [ ] Tidak ada error CORS di konsol browser

Uji satu siklus penuh dengan tiket sekali pakai: daftar → panggil → mulai
bongkar → selesai. Pastikan hitung mundur SLA berjalan lalu berhenti.

---

## Pembaruan berikutnya

Setelah deployment pertama, siklusnya jauh lebih pendek:

```bash
npm run push            # cek sintaks, test, commit, push ke main
npx supabase db push    # hanya bila ada migrasi baru
npx supabase functions deploy inbound-api   # hanya bila fungsi berubah
```

Frontend ter-deploy sendiri dari `main` bila Cloudflare Pages tertaut ke repo.

Naikkan `?v=` pada `index.html` setiap kali `style.css` atau `js/` berubah,
jika tidak browser akan tetap menyajikan aset lama dari cache.

---

## Rollback

**Frontend:** kembalikan ke deployment sebelumnya dari dashboard Cloudflare
Pages. Efeknya seketika.

**Edge Function:** deploy ulang dari commit sebelumnya.

```bash
git checkout <commit-lama> -- supabase/functions/inbound-api
npx supabase functions deploy inbound-api
git checkout HEAD -- supabase/functions/inbound-api
```

**Database:** migrasi di sini bersifat aditif — ia menambah view dan fungsi,
tidak menghapus kolom. Fungsi versi lama tetap berjalan di atas skema baru,
jadi rollback fungsi saja hampir selalu cukup. Jangan menurunkan skema kecuali
benar-benar terpaksa.

---

## Ketika login gagal

`npm run doctor` membedakan penyebab yang dari layar login terlihat sama:

| Keluaran doctor                             | Penyebab                                      | Perbaikan          |
| ------------------------------------------- | --------------------------------------------- | ------------------ |
| `INBOUND_AUTH_USERS belum diset`            | Tidak ada akun sama sekali                    | Langkah 3a         |
| `INBOUND_AUTH_USERS tidak dapat dibaca`     | JSON rusak — sering karena kutip yang hilang  | Langkah 3a         |
| `Role tidak dikenal`                        | Salah ketik pada `role`                       | Langkah 3a         |
| `INBOUND_AUTH_SECRET belum diset`           | Sesi tidak dapat ditandatangani               | Langkah 3b         |
| `Edge Function yang ter-deploy sudah usang` | Fungsi lama tidak mengenal aksi baru          | Langkah 6          |
| Semua `OK` tetapi login tetap ditolak       | Sandinya memang berbeda dari yang di secret   | Langkah 3a         |

Backend membedakan keduanya di tingkat HTTP: **401** berarti kredensial salah,
**503** berarti konfigurasi server bermasalah. Sebelumnya keduanya 401, sehingga
secret yang belum diset tidak dapat dibedakan dari salah ketik sandi.

## Ketika data berhenti mengalir

Dua rantai berbeda, dan keduanya sering tertukar:

| Rantai                 | Irama      | Indikator                            |
| ---------------------- | ---------- | ------------------------------------ |
| Supabase → browser     | 15 detik   | Pil topbar: **Tersambung**           |
| Superset → Supabase    | 5 menit    | Pil topbar: **Sumber 160 basi**      |

Papan yang tampak "live" sama sekali tidak menjamin master PO masih mengalir.
Bila pil menampilkan **Sumber 160 basi**, periksa berurutan:

1. `select * from cron.job where jobname like 'inbound-%';` — jadwal masih aktif?
2. `select * from public.sync_runs where sync_name = 'superset' order by started_at desc limit 5;` — apa pesan galatnya?
3. `SUPERSET_SESSION_COOKIE` kedaluwarsa — ini penyebab yang paling sering. Perbarui secret, lalu deploy ulang `sync-superset`.

## Menguji migrasi sebelum menyentuh produksi

Repo ini tidak punya CI, jadi `db push` ke produksi adalah tempat pertama
kesalahan SQL terlihat — di tengah jalan, setelah sebagian migrasi terlanjur
tercatat. Uji dulu secara lokal.

**Docker Desktop harus berjalan, bukan sekadar terpasang.** Buka aplikasinya
dan tunggu sampai statusnya hijau; `docker ps` yang berhasil menandakan mesinnya
siap.

```bash
npx supabase start          # WAJIB lebih dulu; db reset menolak tanpa ini
npx supabase db reset       # terapkan sembilan migrasi ke Postgres bersih
npx supabase stop --no-backup
```

`supabase start` menarik seluruh stack (~beberapa GB pada kali pertama) dan
kadang gagal di tengah bila koneksi terputus; ulangi saja.

Bila hanya ingin memvalidasi SQL tanpa menunggu seluruh stack, cukup pakai
kontainer database-nya:

```bash
for f in supabase/migrations/*.sql; do
  docker exec -i supabase_db_<project-ref> psql -U postgres -d postgres \
    -v ON_ERROR_STOP=1 -q < "$f" && echo "OK $f" || echo "FAIL $f"
done
```

Kesembilan berkas harus `OK`. Migrasi bersifat idempoten, jadi dapat diulang.

## Pengembangan lokal

```bash
npm run dev     # http://localhost:4173
```

Server ini memproksikan `/api/inbound` ke Supabase. Proksi itu wajib:
`localhost` tidak ada di `APP_ORIGINS`, sehingga memanggil Edge Function
langsung dari browser lokal selalu ditolak CORS. CORS adalah aturan browser,
bukan aturan server, jadi permintaan yang diteruskan dari proses Node lolos
tanpa perlu menyentuh secret produksi.
