#!/usr/bin/env node
/**
 * Credits and badge generator for ciderapp/translations.
 *
 * Scans every target locale file for community-contributed entries (the
 * map shape with a `by: '@handle'` field — see lint-translation-issue.mjs)
 * and turns them into:
 *
 *   .github/badges/translators.json   shields.io endpoint badge: unique
 *                                     human translators across all locales
 *   .github/badges/languages.json     shields.io endpoint badge: language
 *                                     count from locales/languages.yml
 *   README.md                         the table between the
 *                                     <!-- translators:start/end --> markers
 *
 * Entries whose `source` flipped to 'ai' (superseded by a re-translation)
 * still carry their original `by:` and still count — credit isn't lost just
 * because the English source moved underneath the contribution.
 *
 * Runs in CI right before the commit step of both committing workflows
 * (ai-fill, translation-issue), so badges and the README table ride along
 * in the same commit as the locale change that affected them. Output is
 * deterministic and idempotent: same locale data, byte-identical output.
 *
 * Missing README markers are a warning, not an error — a cosmetic
 * regression must never block applying an approved translation.
 *
 * Usage:
 *   node scripts/update-credits.mjs [--dry-run]
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

const LOCALES_DIR    = join(ROOT, 'locales');
const LANGUAGES_FILE = join(LOCALES_DIR, 'languages.yml');
const BADGES_DIR     = join(ROOT, '.github', 'badges');
const README_FILE    = join(ROOT, 'README.md');

const DRY_RUN = process.argv.includes('--dry-run');

// Same shape as AUTHOR_RE in lint-translation-issue.mjs: a GitHub login.
// Anything else in a `by:` field is treated as malformed and skipped rather
// than rendered into the README.
export const HANDLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const MARKER_START = '<!-- translators:start -->';
export const MARKER_END   = '<!-- translators:end -->';

// ── Aggregation ──────────────────────────────────────────────────────────────
/**
 * localeMaps: { 'fr': parsedYamlObject, ... }
 * Returns Map<handle, { locales: Set<code>, entries: number }>.
 */
export function aggregateCredits(localeMaps) {
  const credits = new Map();
  for (const [code, entries] of Object.entries(localeMaps)) {
    if (!entries || typeof entries !== 'object') continue;
    for (const entry of Object.values(entries)) {
      // Scalar = AI-translated, no credit. Map with `by:` = community work,
      // counted regardless of `source` (superseded entries keep their credit).
      if (!entry || typeof entry !== 'object' || typeof entry.by !== 'string') continue;
      const handle = entry.by.replace(/^@/, '');
      if (!HANDLE_RE.test(handle)) continue;
      let credit = credits.get(handle);
      if (!credit) {
        credit = { locales: new Set(), entries: 0 };
        credits.set(handle, credit);
      }
      credit.locales.add(code);
      credit.entries += 1;
    }
  }
  return credits;
}

// ── Rendering ────────────────────────────────────────────────────────────────
export function badgeJson(label, message) {
  return { schemaVersion: 1, label, message: String(message), color: 'blue' };
}

/**
 * Display name for a locale code: the languages.yml registry first, then the
 * registry entry for the base code, then Intl (covers locale files that
 * exist without a registry entry, e.g. hr/et today), then the raw code.
 */
export function langDisplayName(code, registry) {
  const name = registry?.[code]?.name ?? registry?.[code.split('-')[0]]?.name;
  if (name) return name;
  try {
    const intl = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    if (intl && intl !== code) return intl;
  } catch { /* malformed code — fall through to the raw string */ }
  return code;
}

/**
 * Markdown table, most entries first, ties broken by handle (case-insensitive).
 * Depends only on locale data, so reruns are byte-identical.
 */
export function renderTranslatorsTable(credits, registry) {
  const rows = [...credits.entries()].sort(([aHandle, a], [bHandle, b]) =>
    b.entries - a.entries
    || aHandle.toLowerCase().localeCompare(bHandle.toLowerCase())
    || aHandle.localeCompare(bHandle),
  );
  const lines = [
    '| Translator | Languages | Entries |',
    '| --- | --- | --- |',
  ];
  for (const [handle, { locales, entries }] of rows) {
    const names = [...locales]
      .map(code => langDisplayName(code, registry))
      .sort((a, b) => a.localeCompare(b))
      .join(', ');
    lines.push(`| [@${handle}](https://github.com/${handle}) | ${names} | ${entries} |`);
  }
  return lines.join('\n');
}

/**
 * Replace everything between the markers (markers stay). Returns the new
 * text, or null when either marker is missing or out of order.
 */
export function replaceBetweenMarkers(text, block) {
  const start = text.indexOf(MARKER_START);
  const end   = text.indexOf(MARKER_END);
  if (start === -1 || end === -1 || end < start) return null;
  const before = text.slice(0, start + MARKER_START.length);
  const after  = text.slice(end);
  return `${before}\n${block}\n${after}`;
}

// ── File I/O ─────────────────────────────────────────────────────────────────
function writeIfChanged(path, content, label) {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === content) {
    console.log(`  ${label}: unchanged`);
    return false;
  }
  if (DRY_RUN) {
    console.log(`  ${label}: would update (dry run)`);
    return true;
  }
  writeFileSync(path, content, 'utf8');
  console.log(`  ${label}: updated`);
  return true;
}

function loadLocaleMaps() {
  const maps = {};
  for (const file of readdirSync(LOCALES_DIR).sort()) {
    if (!file.endsWith('.yml')) continue;
    const code = file.slice(0, -4);
    // languages.yml is the registry, en-US is the source — neither carries credit.
    if (code === 'languages' || code === 'en-US') continue;
    try {
      maps[code] = parseYaml(readFileSync(join(LOCALES_DIR, file), 'utf8')) ?? {};
    } catch (e) {
      console.warn(`  skipping unparseable ${file}: ${e.message}`);
    }
  }
  return maps;
}

function main() {
  const registry = parseYaml(readFileSync(LANGUAGES_FILE, 'utf8'))?.languages ?? {};
  const credits  = aggregateCredits(loadLocaleMaps());

  const translatorCount = credits.size;
  const languageCount   = Object.keys(registry).length;
  console.log(`Credits: ${translatorCount} translator${translatorCount === 1 ? '' : 's'}, ${languageCount} languages in the registry.`);

  if (!DRY_RUN) mkdirSync(BADGES_DIR, { recursive: true });
  writeIfChanged(
    join(BADGES_DIR, 'translators.json'),
    JSON.stringify(badgeJson('Translators', translatorCount), null, 2) + '\n',
    'badges/translators.json',
  );
  writeIfChanged(
    join(BADGES_DIR, 'languages.json'),
    JSON.stringify(badgeJson('Languages', languageCount), null, 2) + '\n',
    'badges/languages.json',
  );

  const readme  = readFileSync(README_FILE, 'utf8');
  const updated = replaceBetweenMarkers(readme, renderTranslatorsTable(credits, registry));
  if (updated === null) {
    console.warn('  README.md: translators markers not found — table skipped (badges still written).');
    return;
  }
  writeIfChanged(README_FILE, updated, 'README.md translators table');
}

// Only run main() when invoked directly as a script, so the test suite can
// import the pure helpers without side effects.
const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main();
}
