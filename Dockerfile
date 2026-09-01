# =============================================================================
# ANTRIAN INBOUND FROZEN — IMAGE PRODUKSI
#
# Aplikasi ini tidak punya langkah build: index.html, style.css, js/, dan
# assets/ dikirim apa adanya sebagai modul ES. Karena itu image-nya hanya nginx
# plus berkas statis — tidak ada Node, npm, maupun node_modules di dalamnya.
#
# Satu tahap saja sudah cukup. Multi-stage build hanya bermanfaat bila ada
# artefak yang perlu dikompilasi, dan di sini tidak ada.
# =============================================================================
FROM nginx:1.27-alpine

# Konfigurasi ditulis sebagai template supaya `envsubst` milik entrypoint resmi
# nginx dapat menyisipkan project ref Supabase saat kontainer dijalankan. Dengan
# begitu image yang sama dapat dipakai untuk proyek Supabase mana pun tanpa
# di-build ulang.
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template

# Dijalankan entrypoint resmi nginx sebelum server menyala; menurunkan direktif
# `resolver` dari /etc/resolv.conf kontainer.
COPY deploy/10-resolver.sh /docker-entrypoint.d/10-resolver.sh
RUN chmod +x /docker-entrypoint.d/10-resolver.sh

# Hanya paket statis yang masuk. Semua hal lain — supabase/, test/, scripts/,
# android/, data/ — dikecualikan lewat .dockerignore, bukan dihapus di sini.
WORKDIR /usr/share/nginx/html
COPY index.html style.css ./
COPY js/ ./js/
COPY assets/ ./assets/

# Project ref default; timpa lewat variabel lingkungan di Coolify bila pindah
# proyek Supabase. Ini BUKAN rahasia — ia sudah tampak di URL publik.
ENV SUPABASE_PROJECT_REF=qiafoaoslnbmtsbnmqou

# Port yang didengarkan nginx. Samakan dengan setelan port aplikasi di platform
# bila platform tersebut tidak membaca EXPOSE di bawah.
ENV NGINX_PORT=80

EXPOSE 80

# Health check dijawab nginx sendiri di /healthz, tanpa menyentuh Supabase,
# supaya backend yang sedang bermasalah tidak membuat Coolify mengira
# kontainernya mati dan menggulung deployment yang sebenarnya sehat.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider "http://localhost:${NGINX_PORT}/healthz" || exit 1
