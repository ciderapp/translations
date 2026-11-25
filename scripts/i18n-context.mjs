#!/usr/bin/env node
/**
 * Write translator context for one owner's keys: i18n/context/<owner>.yml.
 *
 *   node scripts/i18n-context.mjs --owner citadel --refs <refs.yml>
 *   node scripts/i18n-context.mjs --report
 *
 * --refs is a YAML map of key -> list of source paths that use it, made by
 * the owner's extractor (Citadel: scripts/i18n-refs.mjs). It's read in CI
 * and never committed here. For each key the output keeps only:
 *   area     the screen it's on, when only its source path tells (shared
 *            words like action.* and term.*)
 *   seen_in  up to four component names that use it
 *
 * --report prints how many keys each area holds, and how many fell to
 * "other", so rules can be added to i18n/areas.yml.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadOwners, ownerOf, ownerNamed } from './lib/owners.mjs';
import { loadAreas, areaByKey, areaByPaths, resolveArea, componentName, loadContext } from './lib/areas.mjs';
import { sortKeys } from './lib/source-yaml.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_SEEN = 4;

export function buildContext({ source, refs, owner, owners, areas }) {
  const out = {};
  for (const key of Object.keys(source)) {
    if (ownerOf(key, owners).name !== owner.name) continue;
    const paths = refs[key] ?? [];
    if (!paths.length) continue;
    const entry = {};
    const pathArea = areaByPaths(paths, areas);
    const area = resolveArea(key, { areas, pathArea });
    if (area !== (areaByKey(key, areas) ?? 'other')) entry.area = area;
    const seen = [...new Set(paths.map(componentName))].slice(0, MAX_SEEN);
    if (seen.length) entry.seen_in = seen;
    out[key] = entry;
  }
  return out;
}

export function areaReport({ source, context, areas }) {
  const counts = new Map(areas.map(a => [a.id, 0]));
  for (const key of Object.keys(source)) {
    const id = context[key]?.area ?? areaByKey(key, areas) ?? 'other';
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return areas.map(a => ({ id: a.id, name: a.name, count: counts.get(a.id) ?? 0 }));
}

function main() {
  const args = process.argv.slice(2);
  const arg = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
  const root = arg('--root') ?? ROOT;
  const areas = loadAreas(join(root, 'i18n/areas.yml'));
  const source = parseYaml(readFileSync(join(root, 'locales/en-US.yml'), 'utf8')) ?? {};

  if (args.includes('--report')) {
    const context = loadContext(join(root, 'i18n/context'));
    const rows = areaReport({ source, context, areas });
    const withSeen = Object.keys(source).filter(k => context[k]?.seen_in).length;
    for (const r of rows) console.log(`${String(r.count).padStart(5)}  ${r.id.padEnd(24)} ${r.name}`);
    console.log(`\n${Object.keys(source).length} keys, ${withSeen} with component names`);
    return;
  }

  const ownerName = arg('--owner');
  const refsPath = arg('--refs');
  if (!ownerName || !refsPath) {
    console.error('usage: i18n-context.mjs --owner <name> --refs <refs.yml> | --report');
    process.exit(2);
  }
  const owners = loadOwners(join(root, 'i18n/owners.yml'));
  const owner = ownerNamed(ownerName, owners);
  if (!owner) { console.error(`unknown owner ${ownerName}`); process.exit(2); }
  const refs = parseYaml(readFileSync(refsPath, 'utf8')) ?? {};
  const context = buildContext({ source, refs, owner, owners, areas });

  const dir = join(root, 'i18n/context');
  mkdirSync(dir, { recursive: true });
  const header = `# Translator context for ${owner.repo ?? owner.name}'s keys. Written by its sync\n` +
    '# (scripts/i18n-context.mjs); do not edit by hand. Notes go in i18n/notes.yml.\n';
  writeFileSync(join(dir, `${owner.name}.yml`), header + stringifyYaml(sortKeys(context), { lineWidth: 0 }), 'utf8');
  console.log(`${owner.name}: context for ${Object.keys(context).length} keys`);
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  try { main(); } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
}
