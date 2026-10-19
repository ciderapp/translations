#!/usr/bin/env bash
# Post or update the apply-error comment on ISSUE_NUMBER. Uses gh only, so it
# still works when npm install failed and the Node bot cannot run.
# Env: ISSUE_NUMBER, GITHUB_REPOSITORY, GH_TOKEN (or GITHUB_TOKEN)
#      FAIL_COMMENT  optional extra paragraph
#      RUN_URL       optional link to the workflow run
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=github.sh
source "$here/github.sh"

n="${ISSUE_NUMBER:?ISSUE_NUMBER must be set}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
: "${GH_TOKEN:=${GITHUB_TOKEN:?GH_TOKEN or GITHUB_TOKEN must be set}}"
export GH_TOKEN

marker='<!-- cider-i18n-bot:apply-error -->'
details="${FAIL_COMMENT:-The apply job failed before the translation landed on main.}"
run_line=""
if [ -n "${RUN_URL:-}" ]; then
  run_line=$'\n'"See the run log: ${RUN_URL}"
fi

body="${marker}
### Apply failed

${details}${run_line}

If the \`approved\` label is still present, the sweep workflow will retry. A maintainer can also re-add \`approved\` to retry now."

id="$(github_api "repos/${repo}/issues/${n}/comments?per_page=100" \
  --jq '[.[] | select(.body != null and (.body | startswith("<!-- cider-i18n-bot:apply-error -->")))] | last | .id // empty' \
  || true)"

if [ -n "$id" ]; then
  github_api --method PATCH "repos/${repo}/issues/comments/${id}" -f body="$body" >/dev/null
  echo "Updated apply-error comment ${id} on #${n}"
else
  github_api --method POST "repos/${repo}/issues/${n}/comments" -f body="$body" >/dev/null
  echo "Posted apply-error comment on #${n}"
fi
