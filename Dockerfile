# =============================================================================
# ANTRIAN INBOUND FROZEN — IMAGE APLIKASI
#
# SATU kontainer: Node menyajikan berkas statis sekaligus melayani API.
#
# Susunan sebelumnya memisahkan nginx dan API menjadi dua kontainer, dan setiap
# kegagalan deployment yang terjadi bermuara pada sambungan di antara keduanya:
# proxy hidup, API tidak, lalu operator melihat 502 — atau, lebih buruk lagi,
# "username atau password salah". Menyatukannya menghapus seluruh kelas
# kegagalan itu. Bila halaman termuat, API-nya pasti ikut hidup.
#
# Aplikasi ini tidak punya langkah build: index.html, style.css, dan js/ adalah
# modul ES yang dikirim apa adanya.
# =============================================================================
FROM node:22-alpine

WORKDIR /app

# Manifest disalin lebih dulu agar layer dependensi hanya dibangun ulang ketika
# dependensinya benar-benar berubah, bukan setiap kali kode berubah.
COPY api/package.json api/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Kode server dan skema.
COPY api/ ./api/
COPY db/ ./db/

# Paket statis. Hanya empat hal ini yang pernah disajikan ke browser.
COPY index.html style.css ./
COPY js/ ./js/
COPY assets/ ./assets/

USER node

# Coolify membaca EXPOSE untuk menentukan port yang dirutekan proxy-nya.
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "api/server.mjs"]
