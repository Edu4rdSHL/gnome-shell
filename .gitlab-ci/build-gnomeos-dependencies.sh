#!/bin/bash

set -e

SCRIPT_DIR="$(dirname $0)"
DEST_DIR=$PWD/extension
MESON_OPTIONS="--prefix=/usr --libdir=/usr/lib/$(gcc -print-multiarch)"

mkdir -p $DEST_DIR
$SCRIPT_DIR/checkout-mutter.sh

# FIXME move mutter requirements to a mutter/.gitlab-ci/build-gnomeos-dependencies.sh
git clone --branch 1.23.0 --single-branch https://gitlab.freedesktop.org/wayland/wayland.git
meson setup      wayland/build wayland $MESON_OPTIONS
meson compile -C wayland/build
meson install -C wayland/build --destdir $DEST_DIR
sudo meson install -C wayland/build

meson setup      mutter/build mutter $MESON_OPTIONS
meson compile -C mutter/build
meson install -C mutter/build --destdir $DEST_DIR
sudo meson install -C mutter/build

echo "Successfully prepared $DEST_DIR"