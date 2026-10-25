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

# --exit-code returns 2 for a missing ref; all other errors must stop publication.
if git -c http.extraheader="Authorization: Basic $auth_header" ls-remote --exit-code --heads "$url" main >/dev/null 2>&1; then
  git -c http.extraheader="Authorization: Basic $auth_header" clone --quiet --branch main --single-branch "$url" "$work/repo"
else
  result=$?
  [ "$result" -eq 2 ] || { echo "unable to inspect main in $repo" >&2; exit 1; }
  git init -q -b main "$work/repo"
  git -C "$work/repo" remote add origin "$url"
fi
find "$work/repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a "$source_dir"/. "$work/repo"/
git -C "$work/repo" add -A
candidate_tree=$(git -C "$work/repo" write-tree)

# Compare content, not commit identity: an immutable release may be rerun after
# main has moved on, without rolling main back or changing the existing tag.
if git -c http.extraheader="Authorization: Basic $auth_header" ls-remote --exit-code --refs --tags "$url" "refs/tags/v$version" >/dev/null 2>&1; then
  git -C "$work/repo" -c http.extraheader="Authorization: Basic $auth_header" fetch --quiet origin "refs/tags/v$version"
  tagged_tree=$(git -C "$work/repo" rev-parse 'FETCH_HEAD^{tree}')
  [ "$tagged_tree" = "$candidate_tree" ] || { echo "immutable tag v$version already points elsewhere in $repo" >&2; exit 1; }
  commit=$(git -C "$work/repo" rev-parse 'FETCH_HEAD^{commit}')
  printf '%s\n' "$commit"
  exit 0
else
  result=$?
  [ "$result" -eq 2 ] || { echo "unable to inspect tag v$version in $repo" >&2; exit 1; }
fi

git -C "$work/repo" config user.name 'goblinking-publication[bot]'
git -C "$work/repo" config user.email 'actions@users.noreply.github.com'
if git -C "$work/repo" diff --cached --quiet; then
  commit=$(git -C "$work/repo" rev-parse HEAD)
else
  git -C "$work/repo" commit -q -m "$message"
  commit=$(git -C "$work/repo" rev-parse HEAD)
  git -C "$work/repo" -c http.extraheader="Authorization: Basic $auth_header" push --quiet origin HEAD:main
fi
git -C "$work/repo" tag "v$version" "$commit"
git -C "$work/repo" -c http.extraheader="Authorization: Basic $auth_header" push --quiet origin "v$version"
printf '%s\n' "$commit"
