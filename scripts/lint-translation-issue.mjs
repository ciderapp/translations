#!/usr/bin/env node
/**
 * Translation issue bot for ciderapp/translations.
 *
 * Modes (set via the MODE env var):
 *   validate: parse the issue body, check it, post a preview comment.
 *   apply:    re-parse, write to locales/<lang>.yml with provenance,
 *             post a success comment, close the issue.
 *
 * The `apply` path is gated by an actor-permission check in
 * translation-issue.yml (the labeler must have write/maintain/admin on this
 * repo); this script trusts that gate and does no extra permission checks.
 *
 * Inputs (env):
 *   GITHUB_TOKEN
 *   GITHUB_REPOSITORY    (auto-set by Actions, e.g. "ciderapp/translations")
 *   ISSUE_NUMBER
 *   ISSUE_AUTHOR
 *   ISSUE_BODY
 *   MODE
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const REPO         = process.env.GITHUB_REPOSITORY;
const TOKEN        = process.env.GITHUB_TOKEN;
const ISSUE_NUMBER = process.env.ISSUE_NUMBER;
const ISSUE_AUTHOR = process.env.ISSUE_AUTHOR;
const ISSUE_BODY   = process.env.ISSUE_BODY ?? '';
const MODE         = process.env.MODE ?? 'validate';

export const PROPER_NOUNS = [
  'Cider', 'Apple Music', 'AirPlay', 'Dolby Atmos', 'Chromecast',
  'AudioLab', 'ListenBrainz', 'Last.fm', 'Maloja', 'Discord',
];

// Strict shape gates. Everything from the issue body is untrusted input,
// so we never let it reach a filesystem path or an object index without
// passing these.
export const KEY_RE     = /^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/;
export const LANG_RE    = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?$/;
export const AUTHOR_RE  = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const MAX_BODY_BYTES      = 100_000;
export const MAX_TRANSLATIONS    = 500;
export const MAX_VALUE_LENGTH    = 2_000;

// ── Issue body parsing ───────────────────────────────────────────────────────
// GitHub renders form fields as `### <label>\n\n<value>`. Label aliases let
// the form's field labels move without breaking the parser.
const LABEL_ALIASES = {
  'language code': 'language',
  'language': 'language',
  'translations': 'translations',
  'notes (optional)': 'notes',
  'notes': 'notes',
};

export function parseIssueBody(body) {
  const sections = {};
  // Split on the newline preceding each `### ` heading. Anything before
  // the first heading (preamble) ends up in the first chunk and gets
  // skipped because its regex match fails.
  const parts = body.split(/\r?\n(?=###\s+)/);
  for (const part of parts) {
    const m = /^###\s+(.+?)\s*\r?\n+([\s\S]*)$/.exec(part);
    if (!m) continue;
    const label = m[1].trim().toLowerCase();
    const key = LABEL_ALIASES[label] ?? label;
    sections[key] = m[2].trim();
  }
  return sections;
}

export function extractLanguage(sections) {
  let raw = sections.language;
  if (!raw || raw === '_No response_') return null;
  // Defend against markdown wrapping (`es`, "es") that contributors add anyway.
  raw = raw.split('\n')[0].trim().replace(/^`|`$/g, '').replace(/^"|"$/g, '');
  return raw || null;
}

export function extractTranslations(sections) {
  let raw = sections.translations;
  if (!raw || raw === '_No response_') return { __error: 'No translations provided.' };

  // Strip ```yaml ... ``` fences that GitHub adds for render: yaml fields.
  raw = raw.replace(/^```(?:yaml|yml)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();

  if (!raw) return { __error: 'Translations field is empty.' };

  try {
    const parsed = parseYaml(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { __error: 'Translations did not parse as a YAML map.' };
    }
    return parsed;
  } catch (e) {
    return { __error: `YAML parse error: ${e.message}` };
  }
}

// ── Validation ──────────────────────────────────────────────────────────────
export function extractPlaceholders(s) {
  const found = new Set();
  // Order: {{ ... }} first (otherwise the single-brace pattern would partial-match).
  // Mustache (both spaced and tight), ${var}, single-brace {key}, and $UPPERCASE.
  for (const m of s.matchAll(/\{\{[^}]+\}\}|\$\{[^}]+\}|\{[^{}\s]+\}|\$[A-Z][A-Z0-9_]*/g)) {
    found.add(m[0]);
  }
  return found;
}

export function validateTranslations(translations, sourceStrings) {
  const errors = [];
  const warnings = [];

  const ownKeys = Object.keys(translations);
  if (ownKeys.length === 0) {
    errors.push('No translations provided.');
    return { errors, warnings };
  }
  if (ownKeys.length > MAX_TRANSLATIONS) {
    errors.push(`Too many translations in one issue (${ownKeys.length} > ${MAX_TRANSLATIONS}). Split across multiple issues.`);
    return { errors, warnings };
  }

  for (const key of ownKeys) {
    // Reject anything that doesn't match the project's key shape. This also
    // filters out __proto__, constructor, prototype, and other unsafe names
    // since none of them match KEY_RE.
    if (!KEY_RE.test(key)) {
      errors.push(`\`${key}\`: not a valid key shape (expected lowerCamelCase segments joined by dots, e.g. \`action.apply\`).`);
      continue;
    }

    const value = translations[key];
    if (typeof value !== 'string') {
      errors.push(`\`${key}\`: value must be a string (got ${typeof value}).`);
      continue;
    }
    if (!value.trim()) {
      errors.push(`\`${key}\`: translation is empty.`);
      continue;
    }
    if (value.length > MAX_VALUE_LENGTH) {
      errors.push(`\`${key}\`: translation too long (${value.length} > ${MAX_VALUE_LENGTH} chars).`);
      continue;
    }
    if (!Object.hasOwn(sourceStrings, key)) {
      errors.push(`\`${key}\`: not a known key in \`locales/en-US.yml\`.`);
      continue;
    }

    const english = sourceStrings[key];
    const expected = extractPlaceholders(english);
    const actual = extractPlaceholders(value);
    for (const ph of expected) {
      if (!actual.has(ph)) {
        errors.push(`\`${key}\`: missing placeholder \`${ph}\`. English: "${english}"`);
      }
    }

    for (const noun of PROPER_NOUNS) {
      if (english.includes(noun) && !value.includes(noun)) {
        warnings.push(`\`${key}\`: English contains "${noun}", which is usually kept untranslated.`);
      }
    }
  }

  return { errors, warnings };
}

// ── GitHub API ──────────────────────────────────────────────────────────────
async function ghApi(path, init = {}) {
  if (!TOKEN) throw new Error('GITHUB_TOKEN is not set.');
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

const postComment = (body) =>
  ghApi(`/repos/${REPO}/issues/${ISSUE_NUMBER}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });

const closeIssue = () =>
  ghApi(`/repos/${REPO}/issues/${ISSUE_NUMBER}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
  });

// ── File I/O ────────────────────────────────────────────────────────────────
// Both helpers assume `lang` has already passed LANG_RE. Without that check
// `locales/${lang}.yml` would be a path-traversal vector.
function loadLocale(lang) {
  if (!LANG_RE.test(lang)) throw new Error(`refused to load suspicious lang code: ${lang}`);
  const p = `locales/${lang}.yml`;
  if (!existsSync(p)) return {};
  return parseYaml(readFileSync(p, 'utf8')) ?? {};
}

function saveLocale(lang, entries) {
  if (!LANG_RE.test(lang)) throw new Error(`refused to write suspicious lang code: ${lang}`);
  const sortedKeys = Object.keys(entries).sort((a, b) => a.localeCompare(b));
  const sorted = {};
  for (const k of sortedKeys) sorted[k] = entries[k];
  writeFileSync(
    `locales/${lang}.yml`,
    stringifyYaml(sorted, { lineWidth: 0, defaultStringType: 'PLAIN' }),
    'utf8',
  );
}

// ── Comment templates ──────────────────────────────────────────────────────
function previewComment(language, languageName, translations, warnings) {
  const count = Object.keys(translations).length;
  const items = Object.entries(translations).slice(0, 15).map(
    ([k, v]) => `- \`${k}\`: ${v}`,
  );
  const more = count > 15 ? `\n\n…and ${count - 15} more.` : '';
  const warn = warnings.length
    ? `\n\n#### Heads-up (not blockers)\n\n${warnings.map(w => `- ${w}`).join('\n')}`
    : '';

  return [
    `### 🌐 Thanks for the translation, @${ISSUE_AUTHOR}!`,
    ``,
    `Your **${count}** entr${count === 1 ? 'y' : 'ies'} for **${languageName}** (\`${language}\`) parsed cleanly. Here's a quick preview:`,
    ``,
    items.join('\n') + more,
    warn,
    ``,
    `A Cider maintainer will give this a quick look and add the \`approved\` label to merge it. You'll be credited inside the file (\`source: human, by: @${ISSUE_AUTHOR}, issue: ${ISSUE_NUMBER}\`) and your work will ship in the next OTA build. Appreciate you helping make Cider feel native to more people!`,
  ].join('\n');
}

function errorComment(errors) {
  return [
    `### Hey @${ISSUE_AUTHOR}, a couple of things to fix first`,
    ``,
    `Thanks for taking the time to submit! Before a maintainer can merge this, a few items need a tweak:`,
    ``,
    errors.map(e => `- ${e}`).join('\n'),
    ``,
    `Edit the issue body and the bot will re-check automatically. If anything is unclear, drop a comment and we'll help out.`,
  ].join('\n');
}

function appliedComment(language, languageName, count) {
  return [
    `### 🎉 Merged, thanks @${ISSUE_AUTHOR}!`,
    ``,
    `Your ${count} translation${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} now live in \`locales/${language}.yml\` (${languageName}), with credit attached. It will ship to users in the next OTA build.`,
    ``,
    `Closing this one out. Come back any time you spot something that could be improved, and feel free to reach out on the Cider Discord if you'd like to chat with the team. Thanks again for making Cider better!`,
  ].join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  // Hard caps on untrusted input before we touch anything else.
  if (Buffer.byteLength(ISSUE_BODY, 'utf8') > MAX_BODY_BYTES) {
    await postComment(`### ❌ Issue body exceeds ${MAX_BODY_BYTES.toLocaleString()} bytes. Trim it down and the bot will re-check.`);
    return;
  }
  if (ISSUE_AUTHOR && !AUTHOR_RE.test(ISSUE_AUTHOR)) {
    // GitHub usernames always match AUTHOR_RE in practice; if this ever
    // fails, something is wrong upstream and we should not write the value
    // into a YAML file as-is.
    throw new Error(`refusing to credit suspicious author: ${ISSUE_AUTHOR}`);
  }

  const sections = parseIssueBody(ISSUE_BODY);
  const language = extractLanguage(sections);
  const translations = extractTranslations(sections);

  const languages = parseYaml(readFileSync('locales/languages.yml', 'utf8'))?.languages ?? {};
  const sourceStrings = parseYaml(readFileSync('locales/en-US.yml', 'utf8')) ?? {};

  const errors = [];
  if (!language) {
    errors.push('Language code missing. Fill in the form.');
  } else if (!LANG_RE.test(language)) {
    errors.push(`Language code \`${language}\` is not a valid locale shape (expected e.g. \`es\`, \`pt-BR\`).`);
  } else if (!Object.hasOwn(languages, language)) {
    const codes = Object.keys(languages).filter(c => c !== 'en-US').sort().join(', ');
    errors.push(`Language code \`${language}\` is not in \`locales/languages.yml\`. Supported: ${codes}.`);
  }

  if (translations.__error) {
    errors.push(translations.__error);
  }

  let warnings = [];
  if (!errors.length && language && !translations.__error) {
    const result = validateTranslations(translations, sourceStrings);
    errors.push(...result.errors);
    warnings = result.warnings;
  }

  if (MODE === 'validate') {
    if (errors.length) {
      await postComment(errorComment(errors));
      process.exit(0);
    }
    await postComment(previewComment(
      language,
      languages[language].name,
      translations,
      warnings,
    ));
    return;
  }

  // MODE === 'apply'. Guard against any new validation failures at apply time
  // (the issue body could have been edited after the approved label was set).
  if (errors.length) {
    await postComment([
      `### Couldn't apply this: the issue body changed after approval`,
      ``,
      `Looks like the issue body was edited after the \`approved\` label was set, and the new content doesn't validate:`,
      ``,
      errors.map(e => `- ${e}`).join('\n'),
      ``,
      `Once @${ISSUE_AUTHOR} fixes the issue, a maintainer can re-apply the \`approved\` label to try again.`,
    ].join('\n'));
    process.exit(1);
  }

  const existing = loadLocale(language);
  const updated = { ...existing };
  for (const key of Object.keys(translations)) {
    // KEY_RE was checked in validateTranslations; double-check here so a
    // logic refactor can't accidentally bypass it.
    if (!KEY_RE.test(key)) continue;
    updated[key] = {
      value: translations[key],
      source: 'human',
      by: `@${ISSUE_AUTHOR}`,
      issue: parseInt(ISSUE_NUMBER, 10),
    };
  }
  saveLocale(language, updated);

  await postComment(appliedComment(
    language,
    languages[language].name,
    Object.keys(translations).length,
  ));
  await closeIssue();
}

// Only run main() when invoked directly as a script. When this file is
// imported (e.g. by the test suite), the runtime side stays dormant.
const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch(err => {
    console.error(err);
    // Best-effort error report. Don't leak stack traces; just the message.
    postComment(`### 💥 Bot hit an error\n\n\`\`\`\n${String(err.message).slice(0, 1500)}\n\`\`\`\n\nNot your fault, @${ISSUE_AUTHOR}. A Cider maintainer will take a look. Sorry for the friction.`)
      .catch(() => {})
      .finally(() => process.exit(1));
  });
}
