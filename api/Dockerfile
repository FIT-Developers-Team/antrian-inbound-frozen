# =============================================================================
# API — Node + Postgres
#
# Hanya satu dependensi runtime (`pg`), jadi image-nya tetap kecil dan
# permukaan pembaruannya sempit.
# =============================================================================
FROM node:22-alpine

WORKDIR /app

# Manifest disalin lebih dulu agar layer npm ci hanya dibangun ulang ketika
# dependensinya benar-benar berubah, bukan setiap kali kode berubah.
COPY api/package.json api/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY api/ ./api/
COPY db/ ./db/

# Berjalan sebagai pengguna tak berhak; image node menyediakannya.
USER node

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "api/server.mjs"]
