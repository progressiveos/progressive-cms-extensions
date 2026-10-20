#!/bin/sh
# Packs one package from an immutable tag:
#   ./pack.sh <name>-v<version>
# → dist/<name>-<version>.tar.gz (+ .sha256)
# The tarball contains packages/<name>/… (git archive keeps the pathspec as
# the in-archive prefix — do NOT pass --prefix, it would double it); the
# platform's compose step verifies supply + content digests before unpacking
# (ADR-0017 R2/R4).
set -eu
tag=${1:?usage: pack.sh <name>-v<version>}
name=${tag%-v*}
version=${tag##*-v}
[ -d "packages/$name" ] || { echo "no package packages/$name" >&2; exit 1; }
git rev-parse -q --verify "$tag" >/dev/null || { echo "tag $tag missing" >&2; exit 1; }
mkdir -p dist
# Public and private histories must produce the same supply from the same files.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
git archive -o "$work/source.tar" "$tag" "packages/$name"
tar -xf "$work/source.tar" -C "$work"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -C "$work" -cf "$work/package.tar" "packages/$name"
gzip -n < "$work/package.tar" > "dist/$name-$version.tar.gz"
sha256sum "dist/$name-$version.tar.gz" > "dist/$name-$version.tar.gz.sha256"
echo "packed dist/$name-$version.tar.gz"
