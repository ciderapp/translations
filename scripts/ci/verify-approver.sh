#!/usr/bin/env bash
# Confirm APPROVER_LOGIN has write/maintain/admin on this repo.
# Env: APPROVER_LOGIN, GITHUB_REPOSITORY, GH_TOKEN (or GITHUB_TOKEN)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=github.sh
source "$here/github.sh"

login="${APPROVER_LOGIN:?APPROVER_LOGIN must be set}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
: "${GH_TOKEN:=${GITHUB_TOKEN:?GH_TOKEN or GITHUB_TOKEN must be set}}"
export GH_TOKEN

perm="$(github_api "repos/${repo}/collaborators/${login}/permission" --jq .permission)"
case "$perm" in
  admin|maintain|write)
    echo "OK @${login} has ${perm}; proceeding."
    ;;
  *)
    echo "::error::@${login} cannot apply translations (permission: ${perm}). Only repo members with write/maintain/admin may approve."
    exit 1
    ;;
esac
