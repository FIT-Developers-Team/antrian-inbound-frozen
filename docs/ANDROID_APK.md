# APK Android Antrian Inbound Frozen

Project ini memakai Capacitor untuk membungkus aplikasi web sebagai APK Android.

- App ID: `id.astronauts.inboundcbt`
- Nama tampilan: `Inbound Frozen`
- Source aplikasi: `https://antrian-inbound-frozen.pages.dev`
- APK memuat URL produksi tersebut, sehingga perubahan web yang sudah dideploy
  langsung terbaca saat APK dibuka.

## Kenapa App ID tidak ikut diganti

Mengganti `applicationId` membuat Android memperlakukan build baru sebagai aplikasi
yang berbeda: pengguna harus meng-uninstall versi lama dan kehilangan data aplikasi,
serta tidak dapat menerima update di atas instalasi yang ada. Karena itu hanya nama
tampilan yang diubah. Ganti `applicationId` hanya bila memang diinginkan rilis sebagai
aplikasi terpisah, dan siapkan komunikasi uninstall/install ulang ke pengguna.

## Sebelum build

`server.url` di `capacitor.config.json` menunjuk `antrian-inbound-frozen.pages.dev`.
Pastikan project Cloudflare Pages sudah di-rename ke nama tersebut, atau sesuaikan
`server.url` dan `server.allowNavigation` dengan domain yang benar-benar aktif.
APK yang menunjuk domain mati hanya menampilkan layar kosong.

## Build ulang di Windows

1. Install dependency: `npm.cmd install`
2. Sinkronkan native project: `npm.cmd run android:sync`
3. Pastikan Java 21 dan Android SDK API 36 tersedia, lalu jalankan `npm.cmd run android:build:debug`.
4. Hasil APK: `android/app/build/outputs/apk/debug/app-debug.apk`.

APK debug dapat di-install langsung dari Android setelah mengizinkan instalasi dari
sumber tersebut. Untuk rilis internal permanen, buat keystore release dan sign APK
memakai keystore yang sama untuk setiap update.
