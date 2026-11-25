#!/usr/bin/env node
/**
 * A translator's worklist for one language, one area at a time.
 *
 *   node scripts/i18n-worklist.mjs --lang zh-CN --area settings.audio
 *   node scripts/i18n-worklist.mjs --lang zh-CN --only review
 *   node scripts/i18n-worklist.mjs --lang zh-CN --summary
 *
 *   --area <id>    one area from i18n/areas.yml (default: all, grouped)
 *   --only <what>  review | ai | missing | human | all (default: all)
 *   --summary      a table of areas with counts per status instead
 *   --out <file>   write to a file instead of stdout
 *
 * The YAML it prints has the English, the area, the components that use the
 * string and its status as comments over each line, so a translator can
 * edit values in place and paste the lines they changed into a translation
 * issue unchanged.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parse as parseYaml } from 'yaml';
import { loadAreas, areaByKey, loadContext, loadNotes } from './lib/areas.mjs';
import { loadState, isStale } from './lib/fill-state.mjs';
import { LANG_RE } from './lib/bcp47.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const valueOf = (e) => (typeof e === 'string' ? e : e?.value);

export function statusOf(key, english, locale, state) {
  const e = locale[key];
  if (e === undefined) return 'missing';
  if (e && typeof e === 'object' && e.review) return 'review';
  if (e && typeof e === 'object' && e.source === 'human') {
    return isStale(key, english, locale, state) ? 'review' : 'human';
  }
  return 'ai';
}

const LABEL = {
  missing: 'not translated yet (shows in English)',
  review: 'needs review',
  ai: 'AI translation',
  human: 'community translation',
};

export function buildRows({ source, locale, state, areas, context, notes }) {
  return Object.entries(source).map(([key, english]) => {
    const ctx = context[key] ?? {};
    const area = ctx.area ?? areaByKey(key, areas) ?? 'other';
    const entry = locale[key];
    return {
      key, english, area,
      status: statusOf(key, english, locale, state),
      value: valueOf(entry),
      previous: entry && typeof entry === 'object' ? entry.previous : undefined,
      by: entry && typeof entry === 'object' ? entry.by : undefined,
      seenIn: ctx.seen_in ?? [],
      note: notes[key],
    };
  });
}

const q = (s) => JSON.stringify(String(s ?? ''));
const oneLine = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' ⏎ ');

export function renderWorklist({ rows, areas, lang, langName }) {
  const out = [];
  for (const a of areas) {
    const mine = rows.filter(r => r.area === a.id);
    if (!mine.length) continue;
    const counts = ['human', 'ai', 'review', 'missing']
      .map(s => [s, mine.filter(r => r.status === s).length]).filter(([, n]) => n);
    out.push(`# ── ${a.name} ── ${langName} (${lang})`);
    if (a.description) out.push(`# ${a.description}`);
    const words = { human: 'community', ai: 'AI', review: 'to review', missing: 'missing' };
    out.push(`# ${mine.length} strings: ${counts.map(([s, n]) => `${n} ${words[s]}`).join(', ')}`, '');
    for (const r of mine) {
      out.push(`# English: ${oneLine(r.english)}`);
      const meta = [LABEL[r.status]];
      if (r.by) meta.push(r.status === 'human' ? `by ${r.by}` : `replaced ${r.by}'s translation`);
      if (r.seenIn.length) meta.push(`in ${r.seenIn.join(', ')}`);
      out.push(`# ${meta.join(' · ')}`);
      if (r.previous !== undefined) out.push(`# Before the English changed: ${oneLine(r.previous)}`);
      if (r.note) out.push(`# Note: ${oneLine(r.note)}`);
      out.push(`${r.key}: ${r.value === undefined ? '' : q(r.value)}`, '');
    }
  }
  return out.join('\n');
}

export function renderSummary({ rows, areas }) {
  const lines = ['| Area | Strings | Community | AI | Needs review | Missing |', '| --- | --: | --: | --: | --: | --: |'];
  for (const a of areas) {
    const mine = rows.filter(r => r.area === a.id);
    if (!mine.length) continue;
    const n = (s) => mine.filter(r => r.status === s).length;
    lines.push(`| ${a.name} (\`${a.id}\`) | ${mine.length} | ${n('human')} | ${n('ai')} | ${n('review')} | ${n('missing')} |`);
  }
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const arg = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
  const lang = arg('--lang');
  if (!lang || !LANG_RE.test(lang)) {
    console.error('usage: i18n-worklist.mjs --lang <code> [--area <id>] [--only review|ai|missing|human|all] [--summary] [--out <file>]');
    process.exit(2);
  }
  const root = arg('--root') ?? ROOT;
  const localePath = join(root, 'locales', `${lang}.yml`);
  if (!existsSync(localePath)) { console.error(`no locales/${lang}.yml`); process.exit(2); }

  const areas = loadAreas(join(root, 'i18n/areas.yml'));
  const source = parseYaml(readFileSync(join(root, 'locales/en-US.yml'), 'utf8')) ?? {};
  const locale = parseYaml(readFileSync(localePath, 'utf8')) ?? {};
  const state = loadState(join(root, 'i18n/fill-state'), lang) ?? {};
  const languages = parseYaml(readFileSync(join(root, 'locales/languages.yml'), 'utf8'))?.languages ?? {};
  const langName = (typeof languages[lang] === 'string' ? languages[lang] : languages[lang]?.name) ?? lang;

  let rows = buildRows({
    source, locale, state, areas,
    context: loadContext(join(root, 'i18n/context')),
    notes: loadNotes(join(root, 'i18n/notes.yml')),
  });
  const area = arg('--area');
  if (area) {
    if (!areas.some(a => a.id === area)) { console.error(`unknown area ${area}; see i18n/areas.yml`); process.exit(2); }
    rows = rows.filter(r => r.area === area);
  }
  const only = arg('--only') ?? 'all';
  if (only !== 'all') rows = rows.filter(r => r.status === only);

  const text = args.includes('--summary') ? renderSummary({ rows, areas }) : renderWorklist({ rows, areas, lang, langName });
  if (arg('--out')) writeFileSync(arg('--out'), text + '\n', 'utf8');
  else console.log(text);
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  try { main(); } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
}
