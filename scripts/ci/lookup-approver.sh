#!/usr/bin/env bash
# Print the login of whoever last added the `approved` label on ISSUE_NUMBER.
# Fails loudly if that event cannot be found.
# Env: ISSUE_NUMBER, GITHUB_REPOSITORY, GH_TOKEN (or GITHUB_TOKEN)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=github.sh
source "$here/github.sh"

n="${ISSUE_NUMBER:?ISSUE_NUMBER must be set}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
: "${GH_TOKEN:=${GITHUB_TOKEN:?GH_TOKEN or GITHUB_TOKEN must be set}}"
export GH_TOKEN

login="$(github_api "repos/${repo}/issues/${n}/events?per_page=100" \
  --jq '[.[] | select(.event=="labeled" and .label.name=="approved")] | last | .actor.login // empty')"

if [ -z "$login" ]; then
  echo "::error::Could not find who added the approved label on #${n}. Sweep will not apply this issue until that event is readable."
  exit 1
fi
printf '%s' "$login"
