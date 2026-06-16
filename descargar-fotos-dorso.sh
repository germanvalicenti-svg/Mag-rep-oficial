#!/bin/bash
# ─────────────────────────────────────────────────────────
# MAG Suplementos — Descarga fotos de etiqueta posterior
# Ejecutar UNA SOLA VEZ desde la carpeta MAG-DEPLOY:
#   chmod +x descargar-fotos-dorso.sh && ./descargar-fotos-dorso.sh
# ─────────────────────────────────────────────────────────

DEST="assets/productos"
mkdir -p "$DEST"

download() {
  local name="$1"
  local id="$2"
  local out="$DEST/$name"
  echo -n "Descargando $name ... "
  curl -L -s \
    "https://drive.google.com/thumbnail?id=${id}&sz=w1200" \
    -o "$out"
  if [ -s "$out" ]; then
    echo "✓ $(du -h "$out" | cut -f1)"
  else
    echo "✗ Error — revisá que el archivo en Drive sea compartido como 'Cualquiera con el enlace'"
    rm -f "$out"
  fi
}

echo ""
echo "=== Descargando fotos de etiqueta posterior ==="
echo ""

download "protein-w80-back.jpg"          "1USaV0fM2pAghGF34nnwuR7I-zQBSWczO"
download "protein-hidrolizada-back.jpg"  "1Y2YRJaoM7hb3Fxvj3pCU6CUcpqe7t-Jy"
download "bisglicinato-magnesio-back.jpg" "1Q6MGwMCNcLKDKxPcI3GBPwvvOfVhk9Sy"
download "curcuma-back.jpg"              "1n18ueF8yOmbH8BBMiPsWvWhgP3Trmodq"
download "metabolix-advance-back.jpg"    "1PTyz1YFJy_6t5k3GZZcDqKF24p1-uaKO"
download "sleep-back.jpg"               "1soJ5YCdv5ihUg9EdrzEQISh2sb-cAfKo"

echo ""
echo "=== Listo ==="
echo "Ahora podés subir la carpeta MAG-DEPLOY a Netlify sin depender de Google Drive."
echo ""
