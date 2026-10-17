#!/bin/sh
set -eu

repo=$1
source_dir=$2
version=$3
message=$4
: "${PUBLIC_GITHUB_TOKEN:?PUBLIC_GITHUB_TOKEN is required}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
url="https://github.com/GoblinKing-Burrow/$repo.git"
auth_header=$(printf 'x-access-token:%s' "$PUBLIC_GITHUB_TOKEN" | base64 | tr -d '\n')

if git -c http.extraheader="Authorization: Basic $auth_header" ls-remote --exit-code --heads "$url" main >/dev/null 2>&1; then
  git -c http.extraheader="Authorization: Basic $auth_header" clone --quiet --branch main --single-branch "$url" "$work/repo"
else
  git init -q -b main "$work/repo"
  git -C "$work/repo" remote add origin "$url"
fi
find "$work/repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a "$source_dir"/. "$work/repo"/
git -C "$work/repo" add -A
git -C "$work/repo" config user.name 'goblinking-publication[bot]'
git -C "$work/repo" config user.email 'actions@users.noreply.github.com'
if git -C "$work/repo" diff --cached --quiet; then
  commit=$(git -C "$work/repo" rev-parse HEAD)
else
  git -C "$work/repo" commit -q -m "$message"
  commit=$(git -C "$work/repo" rev-parse HEAD)
  git -C "$work/repo" -c http.extraheader="Authorization: Basic $auth_header" push --quiet origin HEAD:main
fi
if git -c http.extraheader="Authorization: Basic $auth_header" ls-remote --exit-code --tags "$url" "refs/tags/v$version" >/dev/null 2>&1; then
  remote_tag=$(git -c http.extraheader="Authorization: Basic $auth_header" ls-remote --tags "$url" "refs/tags/v$version" | awk '{print $1}')
  [ "$remote_tag" = "$commit" ] || { echo "immutable tag v$version already points elsewhere in $repo" >&2; exit 1; }
else
  git -C "$work/repo" tag "v$version" "$commit"
  git -C "$work/repo" -c http.extraheader="Authorization: Basic $auth_header" push --quiet origin "v$version"
fi
printf '%s\n' "$commit"
