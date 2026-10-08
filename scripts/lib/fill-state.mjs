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

export const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?$/;

// The subject every fill commit starts with, before and after per-locale
// commits ("chore(i18n): AI fill" and "chore(i18n): AI fill (de)").
export const FILL_COMMIT_GREP = '^chore\\(i18n\\): AI fill';

export function englishHash(english) {
  return createHash('sha256').update(String(english ?? ''), 'utf8').digest('hex').slice(0, 12);
}

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
  return state[key] !== englishHash(english);
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
