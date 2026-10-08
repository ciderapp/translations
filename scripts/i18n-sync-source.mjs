#!/usr/bin/env node
/**
 * Sync one owner's English into locales/en-US.yml.
 *
 * Citadel (desktop) and Cider-Android each own a slice of en-US.yml
 * (i18n/owners.yml). Their mirror workflows clone this repo and run:
 *
 *   node scripts/i18n-sync-source.mjs --owner citadel --source <Citadel's en-US.yml> \
 *        --languages <Citadel's languages.yml>
 *   node scripts/i18n-sync-source.mjs --owner android --source <extracted en-US.yml> \
 *        --borrowed <borrowed.yml>
 *
 * The result keeps every key other owners own and replaces this owner's keys
 * with the source, so the mirrors can land in either order without deleting
 * each other's strings. It's a pure function of (the file here, the source):
 * on a rejected push, reset to the new tip and run it again. Nothing ever
 * replays a textual diff, so nothing can conflict.
 *
 * Options:
 *   --owner <name>       Owner from i18n/owners.yml (required)
 *   --source <path>      That owner's English as a flat YAML map (required)
 *   --borrowed <path>    Keys this owner's app reads from other owners: a YAML
 *                        map (key: inline English) or list. Written to
 *                        i18n/consumers/<owner>.yml
 *   --languages <path>   languages.yml to copy (only the owner marked `languages`)
 *   --root <dir>         Repository root (default: this script's repo)
 *
 * Exits 1, changing nothing, if the source holds a key the owner doesn't own,
 * a key of the wrong shape, or (for ICU owners) a value that doesn't parse.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadOwners, ownerOf, ownerNamed, loadConsumers } from './lib/owners.mjs';
import { icuArguments, isBorrowableEnglish } from './lib/icu.mjs';
import { stringifySource } from './lib/source-yaml.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @returns {{ result, added, removed, changed, errors }}
 *   result: the new en-US map (null when there are errors)
 */
export function syncSource({ current, source, owner, owners }) {
  const errors = [];

  for (const [key, value] of Object.entries(source)) {
    const o = ownerOf(key, owners);
    if (o.name !== owner.name) {
      errors.push(`${key}: belongs to ${o.name}, not ${owner.name}`);
      continue;
    }
    if (!owner.keyPattern.test(key)) {
      errors.push(`${key}: doesn't match ${owner.name}'s key pattern ${owner.keyPattern}`);
      continue;
    }
    if (typeof value !== 'string') {
      errors.push(`${key}: value must be a string (got ${value === null ? 'null' : typeof value})`);
      continue;
    }
    if (owner.icu) {
      const parsed = icuArguments(value);
      if (parsed.error) errors.push(`${key}: not valid ICU MessageFormat (${parsed.error}): ${value}`);
    }
  }
  if (errors.length) return { result: null, added: [], removed: [], changed: [], errors };

  const result = {};
  for (const [key, value] of Object.entries(current)) {
    if (ownerOf(key, owners).name !== owner.name) result[key] = value;
  }
  Object.assign(result, source);

  const added   = Object.keys(source).filter(k => !Object.hasOwn(current, k));
  const changed = Object.keys(source).filter(k => Object.hasOwn(current, k) && current[k] !== source[k]);
  const removed = Object.keys(current).filter(k =>
    ownerOf(k, owners).name === owner.name && !Object.hasOwn(source, k));

  return { result, added, removed, changed, errors };
}

/** Borrowed keys: a list, or a map of key -> inline English. */
export function normalizeBorrowed(raw) {
  if (Array.isArray(raw)) return raw.filter(k => typeof k === 'string');
  if (raw && typeof raw === 'object') return Object.keys(raw);
  return [];
}

/**
 * Check what an owner borrows against the merged en-US. Returns errors (keys
 * the owner can't borrow at all) and warnings (keys missing or not usable
 * through ICU, which the app shows in English).
 */
export function checkBorrowed({ keys, owner, owners, english }) {
  const errors = [];
  const warnings = [];
  for (const key of keys) {
    const o = ownerOf(key, owners);
    if (o.name === owner.name) {
      errors.push(`${key}: ${owner.name} owns this key; it can't also borrow it`);
    } else if (!Object.hasOwn(english, key)) {
      warnings.push(`${key}: borrowed but not in en-US.yml (deleted or renamed by ${o.name}?)`);
    } else if (owner.icu && !isBorrowableEnglish(english[key])) {
      warnings.push(`${key}: its English isn't usable through ICU as written: ${english[key]}`);
    }
  }
  return { errors, warnings };
}

function readYamlMap(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
  const raw = parseYaml(readFileSync(path, 'utf8'));
  if (raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} is not a YAML map: ${path}`);
  return raw;
}

function annotate(level, message) {
  if (process.env.GITHUB_ACTIONS) console.log(`::${level}::${message}`);
  else console.log(`${level === 'error' ? '✗' : '⚠'} ${message}`);
}

function main() {
  const args = process.argv.slice(2);
  const arg = (f, d) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : d; };

  const root = arg('--root', join(__dirname, '..'));
  const ownerName = arg('--owner', null);
  const sourcePath = arg('--source', null);
  const borrowedPath = arg('--borrowed', null);
  const languagesPath = arg('--languages', null);
  if (!ownerName || !sourcePath) {
    console.error('usage: i18n-sync-source.mjs --owner <name> --source <file> [--borrowed <file>] [--languages <file>]');
    process.exit(2);
  }

  const owners = loadOwners(join(root, 'i18n/owners.yml'));
  const owner = ownerNamed(ownerName, owners);
  if (!owner) {
    console.error(`unknown owner ${ownerName}; owners: ${owners.map(o => o.name).join(', ')}`);
    process.exit(2);
  }
  if (languagesPath && !owner.languages) {
    console.error(`${owner.name} doesn't curate languages.yml; drop --languages`);
    process.exit(2);
  }

  const enPath = join(root, 'locales/en-US.yml');
  const current = existsSync(enPath) ? readYamlMap(enPath, 'en-US.yml') : {};
  const source = readYamlMap(sourcePath, 'source');

  const { result, added, removed, changed, errors } = syncSource({ current, source, owner, owners });
  if (errors.length) {
    for (const e of errors) annotate('error', e);
    console.error(`refusing to sync: ${errors.length} problem(s) in ${owner.name}'s source`);
    process.exit(1);
  }

  // Keys other apps borrow that this sync deletes. Not fatal: the borrowing
  // app falls back to its inline English. But someone should know.
  const consumers = loadConsumers(join(root, 'i18n/consumers'));
  for (const key of removed) {
    const users = (consumers.get(key) ?? []).filter(c => c !== owner.name);
    if (users.length) annotate('warning', `${key} is removed, but ${users.join(', ')} still reads it`);
  }

  let borrowedOut = null;
  if (borrowedPath) {
    const keys = [...new Set(normalizeBorrowed(parseYaml(readFileSync(borrowedPath, 'utf8'))))].sort();
    const check = checkBorrowed({ keys, owner, owners, english: result });
    if (check.errors.length) {
      for (const e of check.errors) annotate('error', e);
      process.exit(1);
    }
    for (const w of check.warnings) annotate('warning', w);
    borrowedOut = [
      `# Keys ${owner.repo ?? owner.name} reads but doesn't own. Written by its sync`,
      '# (scripts/i18n-sync-source.mjs); do not edit by hand.',
      stringifyYaml({ keys }, { lineWidth: 0 }),
    ].join('\n');
  }

  const next = stringifySource(result);
  const before = existsSync(enPath) ? readFileSync(enPath, 'utf8').replace(/\r\n/g, '\n') : null;
  if (next !== before) writeFileSync(enPath, next, 'utf8');

  if (borrowedOut !== null) {
    const dir = join(root, 'i18n/consumers');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${owner.name}.yml`), borrowedOut, 'utf8');
  }
  if (languagesPath) copyFileSync(languagesPath, join(root, 'locales/languages.yml'));

  console.log(`${owner.name}: +${added.length} added, ~${changed.length} changed, -${removed.length} removed` +
    `${next === before ? ' (en-US.yml unchanged)' : ''}`);
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
