# Security Policy

## Reporting a vulnerability

Found something in this repository that could leak secrets, escalate write access, or undermine the integrity of translations Cider ships? Please report it privately rather than opening a public issue.

Preferred path: use [**GitHub's private vulnerability reporting**](../../security/advisories/new) on this repo. It routes the report straight to maintainers and supports a private back-and-forth before public disclosure.

If you don't have a GitHub account, the Cider team is reachable via the project Discord; ask there for the current security contact.

Please include:

- A clear description of the issue
- Steps to reproduce, or a proof-of-concept
- The impact you believe it has (token leak, write-access escalation, etc.)
- Whether you've notified anyone else

We aim to acknowledge within a week and coordinate the fix and disclosure window with you.

## Scope

### In scope

- The translation issue bot (`scripts/lint-translation-issue.mjs`)
- The AI fill script (`scripts/i18n-translate.mjs`)
- GitHub Actions workflows (`.github/workflows/*.yml`)
- The issue template (`.github/ISSUE_TEMPLATE/translation.yml`)
- The locale file format and any path that processes user-submitted translation data

### Out of scope

- The Cider desktop client itself. This repo only hosts translation data; the client lives in a separate, closed-source repo.
- Third-party services (Google Gemini, GitHub Actions infrastructure).
- Social-engineering attacks against maintainers.
- Denial of service via flooding (GitHub rate limits and maintainer triage are the mitigation).

## What we'd particularly like to know

- Anything that could leak a repository secret (`GEMINI_API_KEY`, the GitHub App's `CIDER_I18N_BOT_PRIVATE_KEY`, or `GITHUB_TOKEN`).
- Token-leak paths via workflow logs, error messages, or bot-posted comments.
- Bypasses of the `author_association` gate on the `apply` job (e.g. a way for a non-maintainer to get the bot to commit on their behalf).
- Code execution in any workflow triggered by `pull_request` from a fork.
- Path-traversal or prototype-pollution paths the existing regex gates don't cover.

Thanks for keeping the project safe.
