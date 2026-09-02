# Deployment — langkah demi langkah

Seluruh sistem berjalan di server Coolify Anda sendiri: Postgres dan satu
proses Node dalam satu `docker-compose.yml`. Tidak ada layanan terkelola, tidak
ada tier percobaan, dan tidak ada proyek yang ditangguhkan setelah tujuh hari
sepi.

Perkiraan waktu: 10–15 menit untuk deployment pertama, satu tekan Deploy untuk
pembaruan berikutnya.

---

## Prasyarat

| Kebutuhan             | Di mana                 | Verifikasi         |
| --------------------- | ----------------------- | ------------------ |
| Server Coolify        | Server Anda             | Sudah terpasang    |
| Docker + Compose      | Server Anda             | Disediakan Coolify |
| Node 22+              | Mesin Anda              | `node --version`   |
| Git                   | Mesin Anda              | `git --version`    |

**Docker Desktop TIDAK diperlukan di mesin Anda.** Coolify menarik kode dari
GitHub lalu membangun image di servernya sendiri; mesin Anda hanya perlu
mendorong commit. Yang dibutuhkan secara lokal hanyalah Node — dan itu pun hanya
untuk menjalankan `npm test` serta `npm run doctor`, yang keduanya berbicara
lewat HTTP biasa.

Docker di mesin Anda hanya relevan bila ingin menjalankan seluruh tumpukan
secara lokal (`npm run stack:up`). Itu opsional, dan bukan bagian dari alur
deploy.

Tidak ada layanan berbayar dan tidak ada tier percobaan. Postgres dan Node
berjalan di server Anda sendiri.

---

## Arsitektur

Dua kontainer dari satu `docker-compose.yml`:

| Layanan | Isi         | Tugas                                                  |
| ------- | ----------- | ------------------------------------------------------ |
| `db`    | Postgres 17 | Data operasional                                       |
| `app`   | Node 22     | Berkas statis, API, dan penjadwal sync — satu proses    |

Satu proses menyajikan halaman DAN melayani API. Susunan sebelumnya memisahkan
nginx dan API menjadi dua kontainer, dan setiap kegagalan deployment bermuara
pada sambungan di antara keduanya: proxy hidup, API tidak, lalu layar
menampilkan 502 — atau, lebih menyesatkan lagi, "username atau password salah".
Sekarang bila halaman termuat, API-nya pasti ikut hidup.

Postgres berada di host yang sama dengan API, jadi setiap kueri adalah
panggilan lokal. Tidak ada cold start, dan tidak ada proyek yang ditangguhkan
setelah tujuh hari sepi.

---

## Langkah 1 — Buat aplikasi di Coolify

**Pilihan A — Docker Compose** (disarankan; Postgres ikut terpasang)

| Pengaturan               | Nilai                |
| ------------------------ | -------------------- |
| Build Pack               | **Docker Compose**   |
| Docker Compose Location  | `/docker-compose.yml`|
| Branch                   | `main`               |

**Pilihan B — Dockerfile** (bila Postgres disediakan terpisah sebagai resource
Coolify)

| Pengaturan          | Nilai           |
| ------------------- | --------------- |
| Build Pack          | **Dockerfile**  |
| Dockerfile Location | `/Dockerfile`   |
| Port                | `3000`          |
| Health Check Path   | `/healthz`      |

Pada Pilihan B, tambahkan `DATABASE_URL` yang menunjuk ke Postgres itu.

---

## Langkah 2 — Isi environment

Di Coolify → Environment Variables:

```
POSTGRES_PASSWORD=<sandi panjang dan acak>
INBOUND_AUTH_SECRET=<acak, minimal 32 karakter>
INBOUND_AUTH_USERS=[{"username":"admin","password":"GANTI","role":"ADMIN","display_name":"Administrator"},{"username":"security.pgs","password":"GANTI","role":"SECURITY","display_name":"Security PGS"},{"username":"checker.pgs","password":"GANTI","role":"CHECKER","display_name":"Checker PGS"},{"username":"spv.pgs","password":"GANTI","role":"SPV","display_name":"Supervisor PGS"}]
```

Role yang sah hanya `SECURITY`, `CHECKER`, `SPV`, `ADMIN`, `DEVELOPER`. Role di
luar daftar ditolak saat login dengan pesan yang menyebut namanya — sebelumnya
akun seperti itu berhasil masuk lalu ditolak oleh setiap aksi, yang di layar
tampak seperti aplikasi rusak.

Opsional, untuk menyalakan sync master PO dari Superset:

```
SUPERSET_SESSION_COOKIE=<cookie session Superset>
SUPERSET_BASE_URL=https://dash.astronauts.id
SUPERSET_CHART_ID=20662
```

Tanpa cookie, aplikasi tetap berjalan penuh; pendaftaran hanya perlu memakai
opsi **PO manual**.

Menghasilkan nilai acak:

```bash
openssl rand -base64 48
```

---

## Langkah 3 — Deploy

Tekan Deploy. Coolify membangun ketiga image lalu menjalankannya.

Skema database diterapkan otomatis oleh `api` pada setiap start —
`db/schema.sql` seluruhnya idempoten, jadi tidak ada langkah migrasi manual
yang dapat terlupakan di antara deploy dan kode.

---

## Langkah 4 — Verifikasi

```bash
INBOUND_URL=https://antrian.inbound-frozen.astrofit.web.id npm run doctor
```

Seluruh baris harus `OK`. Lalu buka aplikasinya dan periksa:

- [ ] Layar login muncul, dan akun `admin` berhasil masuk
- [ ] Papan Antrean memuat tanpa spanduk galat
- [ ] Daftar → satu tiket uji dapat dibuat dengan PO manual
- [ ] Mulai bongkar menyalakan hitung mundur SLA
- [ ] Selesai bongkar menghentikannya
- [ ] Tidak ada error di konsol browser

---

## Pengembangan lokal

```bash
npm run stack:up      # docker compose up -d --build
npm run doctor        # memeriksa http://localhost:8090
npm run stack:logs    # log API
npm run stack:down
```

Buat `.env` di akar repo (sudah tercakup `.gitignore`):

```
POSTGRES_PASSWORD=local_dev_password
INBOUND_AUTH_SECRET=local_dev_secret_minimal_32_karakter_panjang
INBOUND_AUTH_USERS=[{"username":"admin","password":"local-dev","role":"ADMIN","display_name":"Admin"}]
WEB_PORT=8090
```

Untuk menyunting frontend tanpa membangun ulang image, jalankan `db` dan `api`
lewat compose lalu `npm run dev` — server pengembangan menyajikan berkas dari
disk dan memproksikan `/api/inbound` ke API yang sama.

---

## Cadangan

Data ada di volume Docker `inbound-db`. Coolify dapat menjadwalkan cadangan
untuk layanan Postgres; nyalakan itu sebelum gudang mulai memakainya. Cadangan
manual:

```bash
docker compose exec db pg_dump -U inbound inbound > cadangan.sql
```

---

## Ketika login gagal

`npm run doctor` membedakan penyebab yang dari layar login terlihat sama:

| Keluaran doctor                          | Penyebab                                     |
| ---------------------------------------- | -------------------------------------------- |
| `INBOUND_AUTH_USERS belum diset`         | Tidak ada akun sama sekali                   |
| `INBOUND_AUTH_USERS tidak dapat dibaca`  | JSON rusak — sering karena kutip yang hilang |
| `Role tidak dikenal`                     | Salah ketik pada `role`                      |
| `INBOUND_AUTH_SECRET belum diset`        | Sesi tidak dapat ditandatangani              |
| Semua OK tetapi login tetap ditolak      | Sandinya memang berbeda                      |
| `429 Terlalu banyak percobaan masuk`     | Batas laju — tunggu sesuai `Retry-After`     |

API membedakan keduanya di tingkat HTTP: **401** berarti kredensial salah,
**503** berarti konfigurasi server bermasalah, **429** berarti terlalu banyak
percobaan dari alamat atau akun yang sama.

### Kunci sesi belum diisi

Bila `INBOUND_AUTH_SECRET` kosong atau lebih pendek dari 16 karakter, aplikasi
**tetap menyala** — halaman termuat seperti biasa — tetapi setiap login ditolak
dengan pesan yang menyebutkan persis hal itu, dan tidak ada satu pun token sesi
yang dapat diterima.

Yang terakhir itu penting. `createHmac("sha256", "")` adalah HMAC yang sah
dengan kunci kosong, jadi tanpa penjaga khusus aplikasi tanpa kunci akan
menerima token yang disusun siapa pun, berperan apa pun. Penjaganya ada di jalur
pemeriksaan sesi: tanpa kunci yang sah, **semua** token ditolak. Aplikasi menyala,
menjelaskan masalahnya, dan tetap tidak dapat dimasuki.

Buat kuncinya dengan:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Ketika Coolify bilang "no available server"

Pesan itu datang dari proxy Coolify, bukan dari aplikasi. Artinya selalu sama:
**proxy hidup, tetapi tidak ada kontainer aplikasi yang dapat dirutekan.**

Aplikasi ini dirancang agar hal itu tidak terjadi karena salah konfigurasi.
DATABASE_URL yang kosong, kunci sesi yang belum diisi, atau skema yang gagal
diterapkan tidak lagi mematikan kontainer: ia tetap menyala, menyajikan halaman,
dan melaporkan masalahnya. Jadi bila pesan ini muncul, penyebabnya ada di luar
daftar itu.

Periksa berurutan:

| Kemungkinan                              | Cara memastikan                                            |
| ---------------------------------------- | ---------------------------------------------------------- |
| Build gagal, tidak ada image baru        | Tab **Deployments** di Coolify — cari langkah yang merah   |
| Kontainer keluar berulang                | Tab **Logs** — baris `[db]` atau `[auth]` menyebut sebabnya |
| Port salah                               | Coolify harus merutekan ke **3000** (sesuai `EXPOSE`)      |
| Domain belum menunjuk ke aplikasi ini    | Setelan domain aplikasi di Coolify                          |
| Deployment masih berjalan                | Tunggu sampai selesai, lalu muat ulang                      |

Lalu jalankan diagnostik dari mesin Anda — tanpa Docker, hanya HTTP:

```bash
INBOUND_URL=https://antrian.inbound-frozen.astrofit.web.id npm run doctor
```

`doctor` mengenali pesan ini dan menyebutkan langkah berikutnya. Bila aplikasinya
hidup tetapi ada yang salah, ia mencetak masalah yang dilaporkan aplikasi
tentang dirinya sendiri — lengkap dengan tindakan yang harus diambil.

---

## Ketika data berhenti mengalir

Dua rantai berbeda, dan keduanya sering tertukar:

| Rantai                | Irama    | Indikator                       |
| --------------------- | -------- | ------------------------------- |
| API → browser         | 15 detik | Pil topbar: **Tersambung**      |
| Superset → Postgres   | 5 menit  | Pil topbar: **Sumber 160 basi** |

Papan yang tampak "live" tidak menjamin master PO masih mengalir. Bila pil
menampilkan **Sumber 160 basi**:

```bash
docker compose logs api | grep superset
```

`SUPERSET_SESSION_COOKIE` yang kedaluwarsa adalah penyebab tersering. Perbarui
nilainya di Coolify lalu redeploy.

---

## Rollback

Coolify menyimpan deployment sebelumnya; kembalikan dari dashboard. Skema
bersifat aditif — ia menambah objek, tidak menghapus kolom — sehingga image
versi lama tetap berjalan di atas database yang sudah diperbarui.
