#!/bin/sh
# Publish one release from frozen notes/assets; verify every supplied asset on retry.
set -eu
[ "$#" -ge 3 ] || { echo 'usage: publish-release.sh owner/repo version notes [assets...]' >&2; exit 2; }
repository=$1; version=$2; notes=$3; shift 3
repo=${repository##*/}
if ! gh release view "v$version" --repo "$repository" >/dev/null 2>&1; then
  gh release create "v$version" --repo "$repository" --title "$repo $version" --notes-file "$notes" "$@"
fi
if [ "$#" -gt 0 ]; then
  asset_check=$(mktemp -d)
  trap 'rm -rf -- "$asset_check"' EXIT HUP INT TERM
  for asset do
    name=${asset##*/}
    if ! gh release download "v$version" --repo "$repository" --dir "$asset_check" --pattern "$name" ||
       ! cmp -s "$asset" "$asset_check/$name"; then
      echo "$repo public release asset missing or differs: $name" >&2
      exit 1
    fi
  done
fi
