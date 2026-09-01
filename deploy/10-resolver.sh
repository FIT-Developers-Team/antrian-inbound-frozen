#!/bin/sh
# =============================================================================
# Menurunkan `resolver` nginx dari /etc/resolv.conf milik kontainer.
#
# `proxy_pass` di default.conf memakai variabel, dan nginx menuntut direktif
# `resolver` eksplisit untuk itu — ia tidak membaca /etc/resolv.conf sendiri
# seperti yang dilakukan curl atau wget.
#
# Menuliskan `127.0.0.11` secara tetap TIDAK cukup. DNS internal Docker hanya
# ada pada jaringan buatan pengguna; di jaringan bridge bawaan alamat itu
# menolak koneksi, dan setiap permintaan API gagal dengan 502 walaupun
# kontainernya jelas dapat menghubungi internet. Coolify memang memakai
# jaringan buatan pengguna, tetapi menurunkannya dari resolv.conf membuat image
# ini benar juga di luar Coolify.
#
# Dijalankan otomatis oleh entrypoint resmi nginx (/docker-entrypoint.d).
# =============================================================================
set -eu

NAMESERVERS="$(awk '/^nameserver/ { print $2 }' /etc/resolv.conf | tr '\n' ' ')"

# Bila resolv.conf kosong atau tidak terbaca, pakai resolver publik supaya
# proksi tetap berfungsi alih-alih gagal senyap.
if [ -z "$(printf '%s' "$NAMESERVERS" | tr -d ' ')" ]; then
  NAMESERVERS="1.1.1.1 8.8.8.8"
  echo "10-resolver: /etc/resolv.conf tidak memuat nameserver; memakai $NAMESERVERS"
fi

# ipv6=off: bila kontainer tidak punya rute IPv6, jawaban AAAA membuat nginx
# mencoba alamat yang tidak dapat dijangkau lalu menunggu sampai timeout.
cat > /etc/nginx/conf.d/00-resolver.conf <<EOF
resolver $NAMESERVERS valid=30s ipv6=off;
resolver_timeout 5s;
EOF

echo "10-resolver: resolver nginx diset ke $NAMESERVERS"
