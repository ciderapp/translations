#!/usr/bin/env bash
# Retry wrapper around `gh api`. Source this file; do not execute it.
#
# github_api [gh api args...]
#   Prints response body on success. Retries 429/5xx and transient failures
#   with exponential backoff. Honors GH_RETRY_MAX (default 6).

github_api() {
  local attempt=1
  local max="${GH_RETRY_MAX:-6}"
  local delay=2
  local out err errfile
  errfile="$(mktemp)"
  while true; do
    if out=$(gh api "$@" 2>"$errfile"); then
      rm -f "$errfile"
      printf '%s' "$out"
      return 0
    fi
    err="$(cat "$errfile" || true)"
    if (( attempt >= max )); then
      rm -f "$errfile"
      echo "$err" >&2
      return 1
    fi
    echo "::warning::GitHub API failed (attempt ${attempt}/${max}): ${err}" >&2
    sleep "$delay"
    delay=$(( delay * 2 + RANDOM % 3 ))
    if (( delay > 30 )); then delay=30; fi
    attempt=$(( attempt + 1 ))
  done
}
