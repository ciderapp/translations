#!/usr/bin/env bash
# Commit the given paths and push them to main, re-merging instead of
# rebasing when the push loses a race.
#
#   scripts/ci/push-with-remerge.sh "<commit message>" <path>...
#
# Env:
#   REMOTE          authenticated push URL (required)
#   COMMIT_AUTHOR   optional --author for the commit (issue applies credit the contributor)
#
# The fill's matrix jobs and the issue apply push to the same branch at the
# same time. On a rejected push this fetches main, merges the locale and
# fill-state maps key by key (scripts/i18n-remerge.mjs), regenerates README
# and badges, and tries again. Nothing replays a textual diff, so two writers
# on neighbouring lines of a sorted locale file can't conflict.
set -euo pipefail

msg="$1"; shift
paths=("$@")
: "${REMOTE:?REMOTE must be set}"

commit() {
  if [ -n "${COMMIT_AUTHOR:-}" ]; then git commit -q --author="$COMMIT_AUTHOR" -m "$msg"
  else git commit -q -m "$msg"; fi
}

git add -A -- "${paths[@]}"
if git diff --cached --quiet; then
  echo "Nothing to commit."
  exit 0
fi
base=$(git rev-parse HEAD)
commit

for attempt in $(seq 1 10); do
  if git push -q "$REMOTE" HEAD:main; then
    echo "push succeeded (attempt $attempt)"
    exit 0
  fi
  echo "::warning::push attempt $attempt rejected; re-merging onto the new main"
  git fetch -q "$REMOTE" main
  theirs=$(git rev-parse FETCH_HEAD)
  out=$(mktemp -d)
  node scripts/i18n-remerge.mjs --base "$base" --ours HEAD --theirs "$theirs" --out "$out"
  git reset -q --hard "$theirs"
  cp -R "$out"/. .
  rm -rf "$out"
  node scripts/update-credits.mjs > /dev/null
  base="$theirs"
  git add -A -- "${paths[@]}"
  if git diff --cached --quiet; then
    echo "Nothing left to push after the re-merge (main already has it)."
    exit 0
  fi
  commit
  sleep $((attempt + RANDOM % 5))
done

echo "::error::push failed after 10 attempts; main keeps moving. The run's files are in its artifacts."
exit 1
