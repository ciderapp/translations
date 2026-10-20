#!/usr/bin/env node
/**
 * Translation issue bot for ciderapp/translations.
 *
 * Modes (set via the MODE env var):
 *   validate: parse the issue body, check it, post a preview comment.
 *   apply:    re-parse and write to locales/<lang>.yml with provenance.
 *             Does not comment or close; the workflow pushes first, then
 *             runs `announce` so a failed push cannot close the issue.
 *   announce: post the success comment (unless one already exists) and
 *             close the issue. Idempotent; the sweep uses this when the
 *             files are already on main.
 *   fail-comment: upsert the apply-error comment (workflow-level failures).
 *
 * The `apply` path is gated by an actor-permission check in
 * translation-issue.yml (the labeler must have write/maintain/admin on this
 * repo). Creating a locale that is not yet in languages.yml additionally
 * requires ALLOW_NEW_LOCALE=1, which only the apply / add-locale / sweep
 * jobs set after that check. Validate never writes files.
 *
 * Inputs (env):
 *   GITHUB_TOKEN
 *   GITHUB_REPOSITORY    (auto-set by Actions, e.g. "ciderapp/translations")
 *   ISSUE_NUMBER
 *   ISSUE_AUTHOR
 *   ISSUE_BODY
 *   ISSUE_TITLE
 *   MODE
 *   ALLOW_NEW_LOCALE     "1" to register an unknown BCP 47 code on apply
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadOwners, loadConsumers } from './lib/owners.mjs';
import { compareIcu, makeIcuCheck } from './lib/icu.mjs';
import {
  englishHash, loadState, saveState, seedState, englishAtLastFill, englishAt,
} from './lib/fill-state.mjs';
import { githubRequest } from './lib/github.mjs';
import {
  LANG_RE, isValidBcp47, isReservedLocale, resolveLanguageNames, languageNameFromTitle,
} from './lib/bcp47.mjs';
import { registerLanguageOnDisk } from './lib/locale-registry.mjs';
import {
  loadIssueAttachmentTranslations, translationsNeedAttachment,
} from './lib/issue-attachments.mjs';
export { LANG_RE, translationsNeedAttachment };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const REPO         = process.env.GITHUB_REPOSITORY;
const TOKEN        = process.env.GITHUB_TOKEN;
const MODE         = process.env.MODE ?? 'validate';
// Mutated by hydrateIssue() when FETCH_ISSUE=1 or the env payload is incomplete
// (the sweep only passes ISSUE_NUMBER).
let ISSUE_NUMBER = process.env.ISSUE_NUMBER;
let ISSUE_AUTHOR = process.env.ISSUE_AUTHOR;
let ISSUE_BODY   = process.env.ISSUE_BODY ?? '';
let ISSUE_TITLE  = process.env.ISSUE_TITLE ?? '';
// 'opened' on the first submission, 'edited' on later body changes, 'labeled'
// in the apply path. Drives both the comment wording and the upsert behaviour.
const ISSUE_ACTION = process.env.ISSUE_ACTION ?? 'opened';
const ALLOW_NEW_LOCALE = process.env.ALLOW_NEW_LOCALE === '1';
// When the issue was opened (github.event.issue.created_at): the English the
// contributor was translating is en-US.yml as of then.
let ISSUE_CREATED_AT = process.env.ISSUE_CREATED_AT ?? '';
const STATE_DIR = join(ROOT, 'i18n/fill-state');

/**
 * The fill state after an apply (see scripts/lib/fill-state.mjs).
 *
 * A locale with no state yet is seeded first, the way the fill seeds it.
 * Otherwise the fill would find every other key unstamped and re-translate
 * the whole locale.
 *
 * Applied keys are stamped with their English as of the issue's creation,
 * which is what the contributor translated. If the English has moved since,
 * the next fill re-translates the key (keeping the credit) instead of leaving
 * a translation of old text in place. If it hasn't, the fill leaves the
 * human translation alone however other locales fare.
 */
export function stampApplied({
  state, existingLocale, keys, sourceStrings,
  seedSource = () => englishAtLastFill(ROOT) ?? sourceStrings,
  englishThen = () => englishAt(ROOT, ISSUE_CREATED_AT) ?? sourceStrings,
}) {
  const next = state ? { ...state } : seedState(existingLocale, seedSource());
  const then = englishThen();
  for (const key of keys) {
    next[key] = englishHash(Object.hasOwn(then, key) ? then[key] : sourceStrings[key]);
  }
  return next;
}

export const PROPER_NOUNS = [
  'Cider', 'Apple Music', 'AirPlay', 'Dolby Atmos', 'Chromecast',
  'AudioLab', 'ListenBrainz', 'Last.fm', 'Maloja', 'Discord',
];

// Strict shape gates. Everything from the issue body is untrusted input,
// so we never let it reach a filesystem path or an object index without
// passing these.
// KEY_RE: dot-separated segments. Each segment must start with a letter so
// reserved names like __proto__, _proto_, and bare identifiers like
// `constructor` (no dot) can't pass; segment bodies can carry letters,
// digits, hyphens, and underscores because legacy en-US.yml keys use them
// (e.g. `settings.notyf.updateCider.update-downloaded`,
// `settings.option.audio...atmosphereRealizerMode.NATURAL_PLUS`).
export const KEY_RE     = /^[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z][a-zA-Z0-9_-]*)+$/;
export const AUTHOR_RE  = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const MAX_BODY_BYTES      = 100_000;
export const MAX_TRANSLATIONS    = 500;
export const MAX_VALUE_LENGTH    = 2_000;
// How many translations to render in the diff preview before truncating.
// Each entry is two diff lines (- old, + new), so 12 keeps the comment to
// roughly 24 visible lines.
export const PREVIEW_LIMIT       = 12;
// Hidden marker so the bot can find its own previous validation comment and
// edit it in place when the issue body is re-submitted. GitHub strips HTML
// comments from the rendered Markdown, so contributors never see this.
const MARKER_VALIDATION = '<!-- cider-i18n-bot:validation -->';
export const MARKER_APPLIED = '<!-- cider-i18n-bot:applied -->';
export const MARKER_APPLY_ERROR = '<!-- cider-i18n-bot:apply-error -->';

// ── Issue body parsing ───────────────────────────────────────────────────────
// GitHub renders form fields as `### <label>\n\n<value>`. Label aliases let
// the form's field labels move without breaking the parser.
const LABEL_ALIASES = {
  'language code': 'language',
  'language': 'language',
  'language name': 'language_name',
  'native name': 'native_name',
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { __error: 'Translations did not parse as a YAML map.' };
    }
    return parsed;
  } catch (e) {
    return { __error: `YAML parse error: ${e.message}` };
  }
}

/**
 * Body first; if that is not a YAML map, a .yml attached to this issue.
 * A new locale with neither is allowed (empty file, English fallback).
 */
export async function resolveSubmittedTranslations(sections, {
  body,
  comments = [],
  language,
  isNewLocale = false,
  fetchImpl,
} = {}) {
  const fromBody = extractTranslations(sections);
  if (!translationsNeedAttachment(fromBody)) {
    return { translations: fromBody, source: 'body' };
  }
  const loaded = await loadIssueAttachmentTranslations({
    body,
    comments,
    language,
    fetchImpl,
  });
  if (loaded.translations) {
    return { translations: loaded.translations, source: 'attachment', url: loaded.url };
  }
  if (isNewLocale) {
    return {
      translations: {},
      source: 'empty',
      warning: 'No translations in the issue body or a YAML attachment. The locale will be registered and missing keys will fall back to English until the AI fill or a later issue lands them.',
    };
  }
  const parts = [fromBody.__error, loaded.error].filter(Boolean);
  return { translations: { __error: parts.join(' ') }, source: 'body' };
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

// Keys Cider for Android formats with ICU MessageFormat (its own `mobile.*`
// keys, and desktop keys it borrows). A translation there has to parse, or the
// phone shows the raw pattern or throws; the regex placeholder check below
// can't tell.
function validateIcu(key, english, value, errors, warnings) {
  const r = compareIcu(english, value);
  if (r.error) {
    errors.push(`\`${key}\`: not valid ICU MessageFormat (${r.error}). Keep the braces and plural/select structure of the English: \`${english}\`.`);
    return;
  }
  if (r.unknown.length) {
    errors.push(`\`${key}\`: uses ${r.unknown.map(a => `\`{${a}}\``).join(', ')}, which the English doesn't have. Argument names must stay exactly as in \`${english}\`.`);
  }
  for (const a of r.dropped) {
    const quoted = new RegExp(`'\\{${a}\\b|\\b${a}\\}'`).test(value);
    if (quoted) {
      errors.push(`\`${key}\`: a straight apostrophe next to \`{${a}}\` makes the app print it literally. Use the typographic apostrophe (’) instead, e.g. \`l’{${a}}\`.`);
    } else {
      warnings.push(`\`${key}\`: translation drops the \`{${a}}\` placeholder from the English source (\`${english}\`). Fine if intentional (rephrased), worth a double-check otherwise.`);
    }
  }
}

export function dropUnknownKeys(translations, sourceStrings) {
  const dropped = [];
  const kept = {};
  for (const [key, value] of Object.entries(translations ?? {})) {
    if (key.startsWith('__')) continue;
    if (!Object.hasOwn(sourceStrings, key)) dropped.push(key);
    else kept[key] = value;
  }
  return { kept, dropped };
}

export function validateTranslations(translations, sourceStrings, {
  isIcuKey = () => false,
  maxTranslations = MAX_TRANSLATIONS,
  allowEmpty = false,
} = {}) {
  const errors = [];
  const warnings = [];

  const ownKeys = Object.keys(translations);
  if (ownKeys.length === 0) {
    if (!allowEmpty) errors.push('No translations provided.');
    return { errors, warnings };
  }
  if (ownKeys.length > maxTranslations) {
    errors.push(`Too many translations in one issue (${ownKeys.length} > ${maxTranslations}). Split across multiple issues or attach a YAML file.`);
    return { errors, warnings };
  }

  for (const key of ownKeys) {
    // Reject anything that doesn't match the project's key shape. This also
    // filters out __proto__, constructor, prototype, and other unsafe names
    // since none of them match KEY_RE.
    if (!KEY_RE.test(key)) {
      errors.push(`\`${key}\`: not a valid key shape (dot-separated segments, each starting with a letter; letters, digits, hyphens, and underscores allowed inside a segment, e.g. \`action.apply\`).`);
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
    if (isIcuKey(key)) {
      validateIcu(key, english, value, errors, warnings);
    } else {
      const expected = extractPlaceholders(english);
      const actual = extractPlaceholders(value);
      for (const ph of expected) {
        if (!actual.has(ph)) {
          // Heads-up, not an error. Translators legitimately drop placeholders
          // when rephrasing (e.g. Chinese "這首歌" / "this song" replacing
          // `{songName}`). Hard-failing on this blocks valid contributions, so
          // surface it for the maintainer to eyeball instead.
          warnings.push(`\`${key}\`: translation drops the \`${ph}\` placeholder from the English source (\`${english}\`). Fine if intentional (rephrased), worth a double-check otherwise.`);
        }
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

/**
 * True when every submitted key is already a human entry on disk for this
 * issue, so a sweep or a retried apply can skip the write.
 */
export function alreadyApplied(existingLocale, translations, issueNumber) {
  const n = parseInt(issueNumber, 10);
  const keys = Object.keys(translations ?? {}).filter((k) => KEY_RE.test(k));
  if (!keys.length || !Number.isFinite(n)) return false;
  return keys.every((key) => {
    const e = existingLocale?.[key];
    return Boolean(
      e && typeof e === 'object'
      && e.value === translations[key]
      && e.source === 'human'
      && Number(e.issue) === n,
    );
  });
}

export function hasAppliedComment(comments) {
  if (!Array.isArray(comments)) return false;
  return comments.some((c) => {
    const body = c?.body;
    return typeof body === 'string' && (
      body.startsWith(MARKER_APPLIED) || body.includes('### 🎉 Merged')
    );
  });
}

// ── GitHub API ──────────────────────────────────────────────────────────────
const ghApi = (path, { method = 'GET', json } = {}) =>
  githubRequest(path, { token: TOKEN, method, body: json });

const postComment = (body) =>
  ghApi(`/repos/${REPO}/issues/${ISSUE_NUMBER}/comments`, {
    method: 'POST',
    json: { body },
  });

async function listComments() {
  const comments = await ghApi(`/repos/${REPO}/issues/${ISSUE_NUMBER}/comments?per_page=100`);
  return Array.isArray(comments) ? comments : [];
}

// Edit the bot's previous tagged comment in place. Falls back to posting
// fresh if no prior comment is found. Better a duplicate than silence.
async function upsertTaggedComment(marker, body) {
  const tagged = body.startsWith(marker) ? body : `${marker}\n${body}`;
  try {
    const comments = await listComments();
    const previous = [...comments].reverse().find(
      (c) => typeof c?.body === 'string' && c.body.startsWith(marker),
    );
    if (previous?.id) {
      return await ghApi(`/repos/${REPO}/issues/comments/${previous.id}`, {
        method: 'PATCH',
        json: { body: tagged },
      });
    }
  } catch (e) {
    console.warn(`[upsert] falling back to POST: ${e.message}`);
  }
  return postComment(tagged);
}

const upsertValidationComment = (body) => upsertTaggedComment(MARKER_VALIDATION, body);

const closeIssue = () =>
  ghApi(`/repos/${REPO}/issues/${ISSUE_NUMBER}`, {
    method: 'PATCH',
    json: { state: 'closed', state_reason: 'completed' },
  });

const removeApprovedLabel = () =>
  ghApi(`/repos/${REPO}/issues/${ISSUE_NUMBER}/labels/approved`, {
    method: 'DELETE',
  });

async function hydrateIssue() {
  if (!ISSUE_NUMBER) throw new Error('ISSUE_NUMBER is not set.');
  const needFetch = process.env.FETCH_ISSUE === '1' || !ISSUE_BODY || !ISSUE_AUTHOR;
  if (!needFetch) return;
  const issue = await ghApi(`/repos/${REPO}/issues/${ISSUE_NUMBER}`);
  if (!issue || typeof issue !== 'object') {
    throw new Error(`Could not load issue #${ISSUE_NUMBER}`);
  }
  if (process.env.FETCH_ISSUE === '1') {
    ISSUE_AUTHOR = issue.user?.login || ISSUE_AUTHOR;
    ISSUE_BODY = issue.body || '';
    ISSUE_TITLE = issue.title || ISSUE_TITLE;
    ISSUE_CREATED_AT = issue.created_at || ISSUE_CREATED_AT;
  } else {
    ISSUE_AUTHOR = ISSUE_AUTHOR || issue.user?.login;
    ISSUE_BODY = ISSUE_BODY || issue.body || '';
    ISSUE_TITLE = ISSUE_TITLE || issue.title || '';
    ISSUE_CREATED_AT = ISSUE_CREATED_AT || issue.created_at || '';
  }
  if (issue.user?.id) {
    process.env.ISSUE_AUTHOR_ID = String(issue.user.id);
  }
  if (process.env.GITHUB_ENV) {
    const lines = [];
    if (ISSUE_AUTHOR) lines.push(`ISSUE_AUTHOR=${ISSUE_AUTHOR}`);
    if (process.env.ISSUE_AUTHOR_ID) lines.push(`ISSUE_AUTHOR_ID=${process.env.ISSUE_AUTHOR_ID}`);
    if (ISSUE_CREATED_AT) lines.push(`ISSUE_CREATED_AT=${ISSUE_CREATED_AT}`);
    if (lines.length) appendFileSync(process.env.GITHUB_ENV, `${lines.join('\n')}\n`);
  }
}

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
// Locale entries are either a scalar string (AI-generated) or a map with a
// `.value` field (human-contributed provenance shape — see ai-fill design).
const entryValue = (e) =>
  typeof e === 'string' ? e :
  (e && typeof e === 'object' && typeof e.value === 'string' ? e.value : undefined);

// Newlines and very long values would break the single-line +/- diff format.
// Collapse newlines to a visible arrow and trim past 140 chars so the diff
// stays scannable.
function displayValue(v) {
  const s = String(v ?? '').replace(/\r?\n/g, ' ↵ ');
  return s.length > 140 ? s.slice(0, 137) + '…' : s;
}

// Build a ```diff fenced block: for each submitted key, show the prior state
// on the `-` line and the proposed state on the `+` line. "Prior" is the
// existing translation if one is on file (the normal "fix Turkish variables"
// case), otherwise the en-US source (first-time translation), tagged in a
// trailing `# en-US` comment so the reviewer knows which baseline they are
// comparing against. Identical entries collapse to a single dim line.
function buildDiffBlock(translations, existingLocale, sourceStrings) {
  const entries = Object.entries(translations);
  const shown = entries.slice(0, PREVIEW_LIMIT);
  const lines = [];
  for (const [k, v] of shown) {
    const existing = entryValue(existingLocale?.[k]);
    if (existing !== undefined && existing === v) {
      lines.push(`  ${k}: ${displayValue(v)}   # unchanged`);
      continue;
    }
    const hasExisting = existing !== undefined;
    const baseline = hasExisting ? existing : sourceStrings[k];
    const baselineTag = hasExisting ? '' : '   # en-US';
    lines.push(`- ${k}: ${displayValue(baseline)}${baselineTag}`);
    lines.push(`+ ${k}: ${displayValue(v)}`);
  }
  if (entries.length > PREVIEW_LIMIT) {
    lines.push(`# …and ${entries.length - PREVIEW_LIMIT} more (truncated for the preview).`);
  }
  return '```diff\n' + lines.join('\n') + '\n```';
}

// Compact, single-section note about entries that were dropped because they
// were empty. Two buckets:
//   - sourceEmpty: source en-US text is also blank (legacy keys never wired
//     up). Silent informational note; nothing to translate, nothing wrong.
//   - submissionOnly: source has text but the submission left it blank. The
//     contributor probably meant to translate this and missed it; surface
//     it more prominently so they can fix on edit.
function buildSkipNote(sourceEmpty, submissionOnly) {
  if (!sourceEmpty.length && !submissionOnly.length) return '';
  const fmt = (keys, limit = 8) => {
    const head = keys.slice(0, limit).map(k => `\`${k}\``).join(', ');
    return keys.length > limit ? `${head}, +${keys.length - limit} more` : head;
  };
  const parts = [];
  if (sourceEmpty.length) {
    parts.push(
      `_${sourceEmpty.length} entr${sourceEmpty.length === 1 ? 'y' : 'ies'} skipped: the English source in \`en-US.yml\` is empty for ${sourceEmpty.length === 1 ? 'this key' : 'these keys'} (legacy entries not yet wired up), so there's nothing to translate — ${fmt(sourceEmpty)}._`,
    );
  }
  if (submissionOnly.length) {
    parts.push(
      `⚠️ **Heads-up:** ${submissionOnly.length} entr${submissionOnly.length === 1 ? 'y was' : 'ies were'} left blank, but the English source has text. Did you mean to translate ${fmt(submissionOnly)}?`,
    );
  }
  return '\n\n' + parts.join('\n\n');
}

function previewComment(language, languageName, translations, warnings, existingLocale, sourceStrings, sourceEmptySkips = [], submissionEmptySkips = [], {
  isNewLocale = false,
  fromAttachment = false,
} = {}) {
  const count = Object.keys(translations).length;
  const isEdit = ISSUE_ACTION === 'edited';
  const diff = count
    ? buildDiffBlock(translations, existingLocale, sourceStrings)
    : '_No translation keys in this submission._';
  const warn = warnings.length
    ? `\n\n#### Heads-up (not blockers)\n\n${warnings.map(w => `- ${w}`).join('\n')}`
    : '';
  const skipNote = buildSkipNote(sourceEmptySkips, submissionEmptySkips);
  const newLocaleNote = isNewLocale
    ? `\n\n**New language:** \`${language}\` is not in \`locales/languages.yml\` yet. A maintainer with write access can add the \`approved\` label to register **${languageName}** and apply these strings in one commit. Contributors cannot create a locale themselves.`
    : '';
  const attachmentNote = fromAttachment
    ? `\n\nRead the strings from the YAML file attached to this issue.`
    : '';

  const heading = isEdit
    ? `### 🔄 Updated preview for @${ISSUE_AUTHOR}`
    : `### 🌐 Thanks for the translation, @${ISSUE_AUTHOR}!`;

  const intro = isEdit
    ? `Thanks for the update! Your latest **${count}** entr${count === 1 ? 'y' : 'ies'} for **${languageName}** (\`${language}\`) parsed cleanly. Diff against what's currently on file (or the en-US source for new keys):`
    : `Your **${count}** entr${count === 1 ? 'y' : 'ies'} for **${languageName}** (\`${language}\`) parsed cleanly. Diff against what's currently on file (or the en-US source for new keys):`;

  return [
    heading,
    ``,
    intro,
    ``,
    diff,
    warn,
    skipNote,
    newLocaleNote,
    attachmentNote,
    ``,
    `A Cider maintainer will give this a quick look and add the \`approved\` label to merge it. You'll be credited inside the file (\`source: human, by: @${ISSUE_AUTHOR}, issue: ${ISSUE_NUMBER}\`) and your work will ship in the next OTA build. Appreciate you helping make Cider feel native to more people!`,
  ].join('\n');
}

function errorComment(errors, sourceEmptySkips = [], submissionEmptySkips = []) {
  const isEdit = ISSUE_ACTION === 'edited';
  const heading = isEdit
    ? `### Almost there, @${ISSUE_AUTHOR}`
    : `### Hey @${ISSUE_AUTHOR}, a couple of things to fix first`;
  const intro = isEdit
    ? `Thanks for the update! A few things still need a tweak before a maintainer can merge this:`
    : `Thanks for taking the time to submit! Before a maintainer can merge this, a few items need a tweak:`;
  const skipNote = buildSkipNote(sourceEmptySkips, submissionEmptySkips);
  return [
    heading,
    ``,
    intro,
    ``,
    errors.map(e => `- ${e}`).join('\n'),
    skipNote,
    ``,
    `Edit the issue body and this comment will refresh automatically. If anything is unclear, drop a reply and we'll help out.`,
  ].join('\n');
}

function appliedComment(language, languageName, count, {
  newLocale = false,
  fromAttachment = false,
} = {}) {
  const registered = newLocale
    ? `Registered **${languageName}** (\`${language}\`) as a new language and applied your ${count} translation${count === 1 ? '' : 's'} to \`locales/${language}.yml\`, with credit attached.`
    : `Your ${count} translation${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} now live in \`locales/${language}.yml\` (${languageName}), with credit attached.`;
  const extras = [
    fromAttachment ? 'Read the strings from the YAML file attached to this issue.' : null,
    newLocale ? 'Keys that were not in this submission are left unset, so Cider falls back to English until the AI fill lands the rest.' : null,
  ].filter(Boolean);
  return [
    MARKER_APPLIED,
    `### 🎉 Merged, thanks @${ISSUE_AUTHOR}!`,
    ``,
    registered,
    ...extras,
    `It will ship to users in the next OTA build.`,
    ``,
    `Closing this one out. Come back any time you spot something that could be improved, and feel free to reach out on the Cider Discord if you'd like to chat with the team. Thanks again for making Cider better!`,
  ].join('\n');
}

async function announceApplied(language, languageName, count, errors) {
  const comments = await listComments();
  if (!hasAppliedComment(comments)) {
    if (errors?.length || !language || !languageName) {
      await postComment([
        MARKER_APPLIED,
        `### 🎉 Merged, thanks @${ISSUE_AUTHOR}!`,
        ``,
        `Your translation is on main. Closing this one out.`,
      ].join('\n'));
    } else {
      await postComment(appliedComment(language, languageName, count, {
        newLocale: process.env.NEW_LOCALE_CREATED === '1',
        fromAttachment: process.env.FROM_ATTACHMENT === '1',
      }));
    }
  }
  await closeIssue();
}

function appendGithubEnv(lines) {
  if (!process.env.GITHUB_ENV || !lines.length) return;
  appendFileSync(process.env.GITHUB_ENV, `${lines.join('\n')}\n`);
}

async function postFailComment() {
  const details = process.env.FAIL_COMMENT
    || 'The apply job failed before the translation landed on main.';
  const runLine = process.env.RUN_URL ? `\n\nSee the run log: ${process.env.RUN_URL}` : '';
  await upsertTaggedComment(MARKER_APPLY_ERROR, [
    `### Apply failed`,
    ``,
    details + runLine,
    ``,
    `If the \`approved\` label is still present, the sweep workflow will retry. A maintainer can also re-add \`approved\` to retry now.`,
  ].join('\n'));
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (MODE === 'fail-comment') {
    if (!ISSUE_NUMBER) throw new Error('ISSUE_NUMBER is not set.');
    await postFailComment();
    return;
  }

  if (MODE === 'apply' || MODE === 'announce' || process.env.FETCH_ISSUE === '1') {
    await hydrateIssue();
  }

  // Hard caps on untrusted input before we touch anything else.
  if (Buffer.byteLength(ISSUE_BODY, 'utf8') > MAX_BODY_BYTES) {
    const tooBig = `### ❌ Issue body exceeds ${MAX_BODY_BYTES.toLocaleString()} bytes. Trim it down and the bot will re-check.`;
    if (MODE === 'announce') {
      await announceApplied(null, null, 0, ['body too large']);
      return;
    }
    await postComment(tooBig);
    if (MODE === 'apply') process.exit(1);
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
  const languages = parseYaml(readFileSync('locales/languages.yml', 'utf8'))?.languages ?? {};
  const sourceStrings = parseYaml(readFileSync('locales/en-US.yml', 'utf8')) ?? {};

  const bcp47Ok = Boolean(language && LANG_RE.test(language) && isValidBcp47(language));
  const knownLocale = bcp47Ok && Object.hasOwn(languages, language);
  const reserved = bcp47Ok && isReservedLocale(language);
  const canCreateLocale = ALLOW_NEW_LOCALE && MODE === 'apply';
  const isNewLocale = bcp47Ok && !knownLocale && !reserved
    && (MODE === 'validate' || canCreateLocale || process.env.NEW_LOCALE_CREATED === '1');

  const comments = (MODE === 'fail-comment')
    ? []
    : await listComments().catch(() => []);
  const resolved = await resolveSubmittedTranslations(sections, {
    body: ISSUE_BODY,
    comments,
    language,
    isNewLocale,
  });
  const translations = resolved.translations;
  const fromAttachment = resolved.source === 'attachment';

  // Drop empty submissions before validation. A common pattern: contributors
  // copy every key out of en-US.yml as a starting point, but a handful of
  // legacy keys have empty English (e.g. oobe.amsignin.title — never wired
  // up). The contributor naturally leaves those empty too. There's nothing
  // to translate, so silently skipping is friendlier than rejecting the
  // whole batch. Split into two buckets so the preview can flag the case
  // where the English source DOES have text and the submission just missed
  // it, vs. the legacy-stub case where there's nothing to do.
  const sourceEmptySkips = [];
  const submissionEmptySkips = [];
  if (translations && !translations.__error) {
    for (const k of Object.keys(translations)) {
      const v = translations[k];
      if (typeof v === 'string' && !v.trim()) {
        const sourceVal = sourceStrings[k];
        const sourceEmpty = typeof sourceVal !== 'string' || !sourceVal.trim();
        if (sourceEmpty) sourceEmptySkips.push(k);
        else submissionEmptySkips.push(k);
        delete translations[k];
      }
    }
  }

  const errors = [];
  let warnings = [];
  if (resolved.warning) warnings.push(resolved.warning);

  const optionalField = (v) => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    if (!t || t === '_No response_') return undefined;
    return t.split('\n')[0].trim();
  };
  const nameFields = {
    name: optionalField(sections.language_name) || languageNameFromTitle(ISSUE_TITLE) || optionalField(process.env.LOCALE_NAME),
    native: optionalField(sections.native_name) || optionalField(process.env.LOCALE_NATIVE),
  };
  const inferredNames = bcp47Ok
    ? resolveLanguageNames(language, nameFields)
    : { name: language, native: language, errors: [] };
  if (isNewLocale) errors.push(...inferredNames.errors);
  const languageName = knownLocale
    ? languages[language].name
    : inferredNames.name;

  if (!language) {
    errors.push('Language code missing. Fill in the form.');
  } else if (!LANG_RE.test(language) || !isValidBcp47(language)) {
    errors.push(`Language code \`${language}\` is not a valid BCP 47 locale (expected e.g. \`es\`, \`pt-BR\`, \`is\`).`);
  } else if (reserved) {
    errors.push(`Language code \`${language}\` is the English source and cannot be a target locale.`);
  } else if (!knownLocale && !isNewLocale) {
    const codes = Object.keys(languages).filter(c => c !== 'en-US').sort().join(', ');
    errors.push(`Language code \`${language}\` is not in \`locales/languages.yml\`. Supported: ${codes}.`);
  }

  if (translations.__error) {
    errors.push(translations.__error);
  }

  // Full-locale attachments (and new-language dumps) often still list keys
  // that have since left en-US.yml. Drop those with a warning rather than
  // rejecting thousands of still-valid strings.
  if (!translations.__error && (fromAttachment || isNewLocale)) {
    const { kept, dropped } = dropUnknownKeys(translations, sourceStrings);
    for (const k of Object.keys(translations)) delete translations[k];
    Object.assign(translations, kept);
    if (dropped.length) {
      const shown = dropped.slice(0, 8).map((k) => `\`${k}\``).join(', ');
      const more = dropped.length > 8 ? `, +${dropped.length - 8} more` : '';
      warnings.push(`Skipped ${dropped.length} key${dropped.length === 1 ? '' : 's'} not in \`locales/en-US.yml\`: ${shown}${more}.`);
    }
  }

  const owners = loadOwners(join(ROOT, 'i18n/owners.yml'));
  const isIcuKey = makeIcuCheck({ sourceStrings, owners, consumers: loadConsumers(join(ROOT, 'i18n/consumers')) });
  const maxTranslations = (fromAttachment || isNewLocale)
    ? Math.max(MAX_TRANSLATIONS, Object.keys(sourceStrings).length)
    : MAX_TRANSLATIONS;

  if (!errors.length && language && !translations.__error) {
    const result = validateTranslations(translations, sourceStrings, {
      isIcuKey,
      maxTranslations,
      allowEmpty: isNewLocale,
    });
    errors.push(...result.errors);
    warnings = warnings.concat(result.warnings);
  }

  // Load the existing locale for diff context. Only safe once language has
  // been shape-checked; loadLocale itself refuses suspicious codes, but the
  // guard avoids a noisy throw when the contributor's language is invalid.
  let existingLocale = {};
  if (language && LANG_RE.test(language) && (knownLocale || isNewLocale)) {
    existingLocale = loadLocale(language);
  }

  if (MODE === 'validate') {
    if (errors.length) {
      await upsertValidationComment(errorComment(errors, sourceEmptySkips, submissionEmptySkips));
      process.exit(0);
    }
    await upsertValidationComment(previewComment(
      language,
      languageName,
      translations,
      warnings,
      existingLocale,
      sourceStrings,
      sourceEmptySkips,
      submissionEmptySkips,
      { isNewLocale, fromAttachment },
    ));
    return;
  }

  if (MODE === 'announce') {
    await announceApplied(
      language,
      languageName,
      Object.keys(translations.__error ? {} : translations).length,
      errors,
    );
    return;
  }

  if (MODE !== 'apply') {
    throw new Error(`unknown MODE: ${MODE}`);
  }

  // MODE === 'apply'. Guard against any new validation failures at apply time
  // (the issue body could have been edited between the maintainer setting the
  // `approved` label and this job running). Post a FRESH comment here instead
  // of upserting. GitHub doesn't notify subscribers on comment edits, and an
  // approval that silently didn't apply is exactly the kind of thing the
  // maintainer needs to be pinged about. Drop `approved` so the sweep does
  // not retry an invalid body in a loop.
  if (errors.length) {
    await upsertTaggedComment(MARKER_APPLY_ERROR, [
      `### Couldn't apply: the issue body changed after approval`,
      ``,
      `Looks like the issue body was edited after the \`approved\` label was set, and the new content doesn't validate:`,
      ``,
      errors.map(e => `- ${e}`).join('\n'),
      ``,
      `The \`approved\` label was removed so this does not retry on its own. Once @${ISSUE_AUTHOR} fixes the issue, a maintainer can re-apply the \`approved\` label to try again.`,
    ].join('\n'));
    try {
      await removeApprovedLabel();
    } catch (e) {
      console.error(`failed to remove approved label: ${e.message}`);
    }
    process.exit(1);
  }

  if (fromAttachment) appendGithubEnv(['FROM_ATTACHMENT=1']);

  if (isNewLocale) {
    registerLanguageOnDisk(process.cwd(), language, {
      name: inferredNames.name,
      native: inferredNames.native,
    });
    appendGithubEnv(['NEW_LOCALE_CREATED=1']);
    console.log(`Registered new locale ${language} (${inferredNames.name}).`);
  }

  if (alreadyApplied(existingLocale, translations, ISSUE_NUMBER)) {
    console.log(`Issue #${ISSUE_NUMBER} already applied; skipping file write.`);
    return;
  }

  const updated = { ...existingLocale };
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
  saveState(STATE_DIR, language, stampApplied({
    // New locales must not seed fill-state from English copies, or AI fill
    // would treat the fallback as current and skip the rest of the file.
    state: isNewLocale ? {} : loadState(STATE_DIR, language),
    existingLocale: isNewLocale ? {} : existingLocale,
    keys: Object.keys(translations).filter(k => KEY_RE.test(k)),
    sourceStrings,
  }));
}

export { main as runBot };

// Only run main() when invoked directly as a script. When this file is
// imported (e.g. by the test suite), the runtime side stays dormant.
const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch(async (err) => {
    console.error(err);
    // Best-effort error report. Don't leak stack traces; just the message.
    try {
      if (ISSUE_NUMBER && MODE !== 'fail-comment') {
        await upsertTaggedComment(MARKER_APPLY_ERROR, [
          `### 💥 Saki hit an error`,
          ``,
          '```',
          String(err.message).slice(0, 1500),
          '```',
          ``,
          `Not your fault, @${ISSUE_AUTHOR ?? 'contributor'}. A Cider maintainer will take a look. The sweep workflow will retry if the \`approved\` label is still present.`,
        ].join('\n'));
      }
    } catch (commentErr) {
      console.error('failed to comment on the issue:', commentErr);
    }
    process.exit(1);
  });
}
