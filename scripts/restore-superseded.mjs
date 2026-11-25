#!/usr/bin/env node
/**
 * Bring back community translations the AI fill superseded although their
 * English never really changed: the 2026-07-08 sync that dropped keys for a
 * few hours, and the 2026-10-16 switch to sentence case.
 *
 *   node scripts/restore-superseded.mjs [--lang zh-CN] [--write]
 *
 * For each entry with `superseded_at`, it finds the last human version of
 * the entry in git history and the English the contributor translated (en-US
 * at the commit that applied their issue). When that English and today's
 * differ only cosmetically (scripts/lib/fill-state.mjs looseEnglish), the
 * human value comes back with a fresh stamp. Anything else is left as it is
 * and listed, since its meaning really changed. Without --write it only
 * reports. Needs full history.
 */

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { looseEnglish, englishHash, loadState, saveState, LANG_RE } from './lib/fill-state.mjs';
import { sortKeys } from './lib/source-yaml.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const showMap = (sha, path) => { try { return parseYaml(git(['show', `${sha}:${path}`])) ?? {}; } catch { return null; } };

const applyCommitCache = new Map();
function englishForIssue(issue) {
  if (applyCommitCache.has(issue)) return applyCommitCache.get(issue);
  const sha = git(['log', '-1', '--format=%H', '-F', `--grep=apply translation from #${issue}`]).trim();
  const en = sha ? showMap(sha, 'locales/en-US.yml') : null;
  applyCommitCache.set(issue, en);
  return en;
}

/** key -> last human entry, walking the locale's history newest first. */
function lastHumanVersions(lang, keys) {
  const want = new Set(keys);
  const found = {};
  const shas = git(['log', '--format=%H', '--', `locales/${lang}.yml`]).split('\n').filter(Boolean);
  for (const sha of shas) {
    if (!want.size) break;
    const map = showMap(sha, `locales/${lang}.yml`);
    if (!map) continue;
    for (const key of [...want]) {
      const e = map[key];
      if (e && typeof e === 'object' && e.source === 'human') { found[key] = e; want.delete(key); }
    }
  }
  return found;
}

export function decide({ entry, human, englishThen, englishNow }) {
  if (!human) return 'no-history';
  if (englishThen === undefined) return 'no-english';
  return looseEnglish(englishThen) === looseEnglish(englishNow) ? 'restore' : 'real-change';
}

function main() {
  const args = process.argv.slice(2);
  const only = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : null;
  const write = args.includes('--write');
  const englishNow = parseYaml(readFileSync(join(ROOT, 'locales/en-US.yml'), 'utf8'));
  const langs = readdirSync(join(ROOT, 'locales'))
    .map(f => f.replace(/\.yml$/, ''))
    .filter(l => l !== 'en-US' && l !== 'languages' && LANG_RE.test(l) && (!only || l === only));

  const totals = {};
  for (const lang of langs) {
    const path = join(ROOT, 'locales', `${lang}.yml`);
    const locale = parseYaml(readFileSync(path, 'utf8')) ?? {};
    const superseded = Object.keys(locale).filter(k =>
      locale[k] && typeof locale[k] === 'object' && locale[k].superseded_at && Object.hasOwn(englishNow, k));
    if (!superseded.length) continue;
    const humans = lastHumanVersions(lang, superseded);
    const state = loadState(join(ROOT, 'i18n/fill-state'), lang) ?? {};
    const counts = {};
    const realChanges = [];
    for (const key of superseded) {
      const entry = locale[key];
      const english = englishForIssue(entry.issue ?? humans[key]?.issue);
      const verdict = decide({ entry, human: humans[key], englishThen: english?.[key], englishNow: englishNow[key] });
      counts[verdict] = (counts[verdict] ?? 0) + 1;
      if (verdict === 'restore') {
        const { superseded_at, previous, review, ...rest } = entry;
        locale[key] = { ...rest, value: humans[key].value, source: 'human' };
        state[key] = englishHash(englishNow[key]);
      } else if (verdict === 'real-change') {
        realChanges.push(key);
      }
    }
    totals[lang] = counts;
    console.log(`${lang}: ${JSON.stringify(counts)}${realChanges.length ? `  real changes: ${realChanges.slice(0, 3).join(', ')}${realChanges.length > 3 ? ', …' : ''}` : ''}`);
    if (write) {
      writeFileSync(path, stringifyYaml(sortKeys(locale), { lineWidth: 0, defaultStringType: 'PLAIN' }), 'utf8');
      saveState(join(ROOT, 'i18n/fill-state'), lang, state);
    }
  }
  const sum = {};
  for (const c of Object.values(totals)) for (const [k, n] of Object.entries(c)) sum[k] = (sum[k] ?? 0) + n;
  console.log(`\nall locales: ${JSON.stringify(sum)}${write ? '' : '  (dry run; add --write to apply)'}`);
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  try { main(); } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
}
