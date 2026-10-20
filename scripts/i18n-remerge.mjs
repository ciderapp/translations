#!/usr/bin/env node
/**
 * Re-merge a rejected push onto the new tip of main.
 *
 * The AI fill and the issue apply both write locales/<lang>.yml and
 * i18n/fill-state/<lang>.yml, under separate concurrency groups, so either
 * can lose a push race to the other. A `git rebase` replays a textual diff,
 * and two writers touching neighbouring lines of a sorted file conflict.
 * This merges the YAML maps key by key instead (scripts/lib/merge3.mjs):
 * whatever only one side changed is kept, a two-sided change goes to the
 * human translation (else to theirs), and stamps travel with their values.
 *
 *   node scripts/i18n-remerge.mjs --base <ref> --ours <ref> --theirs <ref> --out <dir> [--root <repo>]
 *
 *   base    the commit the job started from
 *   ours    the job's commit(s)
 *   theirs  the new tip of main (FETCH_HEAD)
 *
 * Writes the merged files under <dir>, at their repository paths, and changes
 * nothing in the working tree. The workflow then resets to theirs, copies
 * <dir> over it, re-runs update-credits.mjs (README.md and the badges are
 * regenerated, never merged), commits and pushes.
 *
 * Exits 2 if ours touched anything else: the fill never writes en-US.yml,
 * languages.yml or the ownership files. An issue apply / add-locale job may
 * write languages.yml when registering a new locale; that file is merged as
 * a map of codes (union, never drop) rather than as locale keys.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { mergeLocale3 } from './lib/merge3.mjs';
import { sortKeys } from './lib/source-yaml.mjs';
import { LANG_RE } from './lib/fill-state.mjs';
import { applyLanguageMapToText, mergeLanguageMaps, parseLanguagesFile } from './lib/locale-registry.mjs';

let ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const LOCALE_RE = /^locales\/([A-Za-z0-9-]+)\.yml$/;
const STATE_RE  = /^i18n\/fill-state\/([A-Za-z0-9-]+)\.yml$/;
const GENERATED = [/^README\.md$/, /^\.github\/badges\//];
const NEVER     = new Set(['en-US']);

/**
 * Sort the paths `ours` changed into locales to merge, generated files to
 * leave to update-credits, a languages.yml registry merge, and anything
 * that must not be there.
 */
export function classifyChanges(paths) {
  const langs = new Set();
  const generated = [];
  const refused = [];
  let languagesYml = false;
  for (const p of paths) {
    if (p === 'locales/languages.yml') {
      languagesYml = true;
      continue;
    }
    const locale = LOCALE_RE.exec(p);
    const state = STATE_RE.exec(p);
    const lang = locale?.[1] ?? state?.[1];
    if (lang && !NEVER.has(lang) && LANG_RE.test(lang)) langs.add(lang);
    else if (GENERATED.some(re => re.test(p))) generated.push(p);
    else refused.push(p);
  }
  return { langs: [...langs].sort(), generated, refused, languagesYml };
}

// Same shape the fill and the linter write locale files in.
export function stringifyLocale(entries) {
  return stringifyYaml(sortKeys(entries), { lineWidth: 0, defaultStringType: 'PLAIN' });
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function showText(ref, path) {
  try {
    const text = execFileSync('git', ['show', `${ref}:${path}`], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
    return { exists: true, text };
  } catch {
    return { exists: false, text: '' };
  }
}

function showMap(ref, path) {
  const shown = showText(ref, path);
  if (!shown.exists) return { exists: false, map: {} };
  // A file that exists but doesn't parse is a real problem; let it throw.
  return { exists: true, map: parseYaml(shown.text) ?? {} };
}

function main() {
  const args = process.argv.slice(2);
  const arg = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
  const [base, ours, theirs, out] = ['--base', '--ours', '--theirs', '--out'].map(arg);
  if (arg('--root')) ROOT = arg('--root');
  if (!base || !ours || !theirs || !out) {
    console.error('usage: i18n-remerge.mjs --base <ref> --ours <ref> --theirs <ref> --out <dir>');
    process.exit(2);
  }
  const [b, o, t] = [base, ours, theirs].map(r => git(['rev-parse', '--verify', `${r}^{commit}`]).trim());

  const changed = git(['diff', '--name-only', b, o]).split('\n').map(s => s.trim()).filter(Boolean);
  const { langs, generated, refused, languagesYml } = classifyChanges(changed);
  if (refused.length) {
    console.error(`refusing to re-merge: this job changed files it never should: ${refused.join(', ')}`);
    process.exit(2);
  }
  if (generated.length) console.log(`regenerate after merge: ${generated.join(', ')}`);
  if (languagesYml) {
    const [lb, lo, lt] = [b, o, t].map((r) => showText(r, 'locales/languages.yml'));
    const merged = mergeLanguageMaps({
      base: parseLanguagesFile(lb.text).languages,
      ours: parseLanguagesFile(lo.text).languages,
      theirs: parseLanguagesFile(lt.text).languages,
    });
    const text = applyLanguageMapToText(lt.exists ? lt.text : (lo.text || 'languages:\n'), merged);
    mkdirSync(join(out, 'locales'), { recursive: true });
    writeFileSync(join(out, 'locales/languages.yml'), text, 'utf8');
    console.log('merged locales/languages.yml');
  }

  let conflicts = 0;
  for (const lang of langs) {
    const localePath = `locales/${lang}.yml`;
    const statePath = `i18n/fill-state/${lang}.yml`;
    const [lb, lo, lt] = [b, o, t].map(r => showMap(r, localePath));
    const [sb, so, st] = [b, o, t].map(r => showMap(r, statePath));

    const merged = mergeLocale3({
      base: lb.map, ours: lo.map, theirs: lt.map,
      baseState: sb.map, oursState: so.map, theirsState: st.map,
    });
    conflicts += merged.conflicts.length;

    mkdirSync(join(out, 'locales'), { recursive: true });
    writeFileSync(join(out, localePath), stringifyLocale(merged.locale), 'utf8');
    if (so.exists || st.exists) {
      mkdirSync(join(out, 'i18n/fill-state'), { recursive: true });
      writeFileSync(join(out, statePath), stringifyYaml(sortKeys(merged.state), { lineWidth: 0 }), 'utf8');
    }
    const note = merged.conflicts.length
      ? ` (${merged.conflicts.length} key(s) changed on both sides: ${merged.conflicts.slice(0, 5).join(', ')}${merged.conflicts.length > 5 ? ', …' : ''})`
      : '';
    console.log(`merged ${lang}${note}`);
  }
  console.log(`re-merged ${langs.length} locale(s), ${conflicts} two-sided change(s)`);
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  try {
    main();
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
