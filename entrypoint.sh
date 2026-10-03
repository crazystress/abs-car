#!/bin/sh
# Arranca como root solo para dejar la carpeta de datos en manos del usuario «node» (Docker crea las
# carpetas de los volúmenes como root) y después ejecuta la app sin privilegios.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %u "$DATA_DIR")" != "$(id -u node)" ] || [ -n "$(find "$DATA_DIR" ! -user node -print -quit)" ]; then
    chown -R node:node "$DATA_DIR"
  fi
  exec su-exec node "$@"
fi
exec "$@"
