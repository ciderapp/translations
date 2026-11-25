/**
 * Per-locale fill state: i18n/fill-state/<lang>.yml maps each key to a short
 * hash of the English that locale's current value was made from.
 *
 * A key is stale in a locale when the hash of its English differs. The fill
 * stamps a key when it writes it; an issue apply stamps the English the
 * contributor translated. So a failed batch in one locale only leaves that
 * locale stale, and a human translation of the current English is never
 * superseded because some other locale's batch failed.
 *
 * This replaced diffing en-US.yml against HEAD~1, which missed changes
 * whenever GitHub cancelled a queued fill run.
 */

import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { sortKeys } from './source-yaml.mjs';
import { LANG_RE } from './bcp47.mjs';
export { LANG_RE };

// The subject every fill commit starts with, before and after per-locale
// commits ("chore(i18n): AI fill" and "chore(i18n): AI fill (de)").
export const FILL_COMMIT_GREP = '^chore\\(i18n\\): AI fill';

const hash = (s, n) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, n);

// Placeholders keep their exact spelling: `{Count}` and `{count}` are
// different arguments, so a change there is never cosmetic.
const PLACEHOLDER_RE = /\{\{\s*[\w.]+\s*\}\}|\$\{[\w.]+\}|\$[A-Z][A-Z0-9_]*|\{[^{}]*\}/g;

/**
 * English with the differences that never change a translation's meaning
 * folded away: letter case, typographic vs straight quotes and ellipses,
 * arrow glyphs, runs of whitespace and trailing punctuation. Placeholders
 * are left exactly as written.
 */
export function looseEnglish(english) {
  const text = String(english ?? '').normalize('NFKC');
  const parts = [];
  let last = 0;
  const fold = (s) => s
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[\u2192\u203a\u00bb]|->/g, '>')
    .replace(/\s+/g, ' ');
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    parts.push(fold(text.slice(last, m.index)), m[0]);
    last = m.index + m[0].length;
  }
  parts.push(fold(text.slice(last)));
  return parts.join('').trim().replace(/[\s.!:;,]+$/, '');
}

/**
 * The stamp for one key: `<exact>~<loose>`. The exact half decides whether a
 * value is current; the loose half lets the fill tell a cosmetic English
 * edit (case, quotes, punctuation) from a real one. Stamps written before
 * the loose half existed are a bare `<exact>`.
 */
export function englishHash(english) {
  const text = String(english ?? '');
  return `${hash(text, 12)}~${hash(looseEnglish(text), 8)}`;
}

const exactPart = (stamp) => (typeof stamp === 'string' ? stamp.split('~')[0] : undefined);
const loosePart = (stamp) => (typeof stamp === 'string' ? stamp.split('~')[1] : undefined);

function statePath(dir, lang) {
  if (!LANG_RE.test(lang)) throw new Error(`refused suspicious lang code: ${lang}`);
  return join(dir, `${lang}.yml`);
}

/** The state map, or null when the locale has none yet. Throws on a parse error. */
export function loadState(dir, lang) {
  const p = statePath(dir, lang);
  if (!existsSync(p)) return null;
  const raw = parseYaml(readFileSync(p, 'utf8'));
  if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error(`${p} is not a key: hash map`);
  }
  return raw ?? {};
}

export function saveState(dir, lang, state) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(dir, lang), stringifyYaml(sortKeys(state), { lineWidth: 0 }), 'utf8');
}

/**
 * First state for a locale that predates the state files: stamp every key it
 * has with the English it was last filled against. Keys the seed source
 * doesn't know (orphans) get no stamp.
 */
export function seedState(locale, seedSource) {
  const state = {};
  for (const key of Object.keys(locale)) {
    if (Object.hasOwn(seedSource, key)) state[key] = englishHash(seedSource[key]);
  }
  return state;
}

/** Stale = missing from the locale, or made from different English (or no stamp at all). */
export function isStale(key, english, locale, state) {
  if (!Object.hasOwn(locale, key)) return true;
  return exactPart(state[key]) !== exactPart(englishHash(english));
}

/**
 * True when a stale key's English only changed cosmetically since its value
 * was made (see looseEnglish). Legacy stamps without a loose half never
 * qualify, because there's nothing to compare.
 */
export function isCosmeticChange(key, english, state) {
  const loose = loosePart(state[key]);
  return !!loose && loose === loosePart(englishHash(english));
}

/** Upgrade a current legacy stamp to the two-part form. */
export function upgradeStamp(stamp, english) {
  const next = englishHash(english);
  return exactPart(stamp) === exactPart(next) ? next : stamp;
}

/**
 * en-US.yml as of the last AI fill commit: what every existing translation
 * was last filled against. Needs full history (fetch-depth: 0). Returns null
 * when there's no git or no fill commit, and the caller decides.
 */
export function englishAtLastFill(root) {
  try {
    const sha = execSync(`git log -1 --format=%H -E --grep="${FILL_COMMIT_GREP}"`, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!sha) return null;
    const text = execSync(`git show ${sha}:locales/en-US.yml`, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
    return parseYaml(text) ?? {};
  } catch {
    return null;
  }
}

/**
 * en-US.yml as it stood at an ISO time (an issue's creation), or null. Used to
 * stamp a human translation with the English the contributor was looking at.
 */
export function englishAt(root, isoTime) {
  if (!isoTime || Number.isNaN(Date.parse(isoTime))) return null;
  try {
    const sha = execSync(`git rev-list -1 --before="${new Date(isoTime).toISOString()}" HEAD`, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!sha) return null;
    const text = execSync(`git show ${sha}:locales/en-US.yml`, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
    return parseYaml(text) ?? {};
  } catch {
    return null;
  }
}
