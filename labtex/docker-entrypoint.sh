#!/bin/sh
set -e
# Fix ownership of the mounted data volume, lock it down, then drop privileges.
mkdir -p "$DATA_DIR" "$BUILD_DIR"
chown -R labtex:labtex "$DATA_DIR" "$BUILD_DIR"
chmod 700 "$DATA_DIR"
chmod 711 "$BUILD_DIR"   # TeX can enter its own project folder but cannot list others
exec setpriv --reuid=labtex --regid=labtex --init-groups "$@"
