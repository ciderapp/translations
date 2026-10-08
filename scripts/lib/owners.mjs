/**
 * Key ownership for locales/en-US.yml (see i18n/owners.yml).
 *
 * Each owner writes only its own slice of en-US.yml. A key belongs to the
 * owner whose prefix it starts with, or to the default owner.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

// The permissive shape legacy desktop keys need: segments may carry digits,
// hyphens and underscores (e.g. `settings.notyf.updateCider.update-downloaded`).
// Same rule as the issue linter's KEY_RE.
export const DEFAULT_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z][a-zA-Z0-9_-]*)+$/;

// What the fill assumes when there is no owners file: one desktop owner that
// holds every key, which is how the repo worked before Android joined.
const SINGLE_OWNER = { owners: { citadel: { platform: 'desktop', default: true } } };

export function parseOwners(raw) {
  const entries = Object.entries(raw?.owners ?? {});
  if (entries.length === 0) throw new Error('owners: no owners defined');

  const owners = entries.map(([name, o]) => ({
    name,
    repo: o.repo ?? null,
    platform: o.platform ?? 'desktop',
    prefixes: Array.isArray(o.prefixes) ? o.prefixes.map(String) : [],
    keyPattern: o.keyPattern ? new RegExp(o.keyPattern) : DEFAULT_KEY_RE,
    icu: o.icu === true,
    prune: o.prune === true,
    reuseFrom: o.reuseFrom ?? null,
    languages: o.languages === true,
    isDefault: o.default === true,
  }));

  const defaults = owners.filter(o => o.isDefault);
  if (defaults.length !== 1) {
    throw new Error(`owners: exactly one owner must be the default (found ${defaults.length})`);
  }
  for (const o of owners) {
    if (!o.isDefault && o.prefixes.length === 0) {
      throw new Error(`owners: ${o.name} has no prefixes and is not the default`);
    }
  }
  const prefixes = owners.flatMap(o => o.prefixes.map(p => ({ p, owner: o.name })));
  for (const a of prefixes) {
    for (const b of prefixes) {
      if (a !== b && a.p.startsWith(b.p)) {
        throw new Error(`owners: prefix ${a.p} (${a.owner}) overlaps ${b.p} (${b.owner})`);
      }
    }
  }
  for (const o of owners) {
    if (o.reuseFrom && !owners.some(x => x.name === o.reuseFrom)) {
      throw new Error(`owners: ${o.name}.reuseFrom names unknown owner ${o.reuseFrom}`);
    }
  }
  return owners;
}

export function loadOwners(path) {
  if (!existsSync(path)) return parseOwners(SINGLE_OWNER);
  return parseOwners(parseYaml(readFileSync(path, 'utf8')));
}

export function ownerOf(key, owners) {
  for (const o of owners) {
    if (o.prefixes.some(p => key.startsWith(p))) return o;
  }
  return owners.find(o => o.isDefault);
}

export function ownerNamed(name, owners) {
  return owners.find(o => o.name === name) ?? null;
}

// i18n/consumers/<owner>.yml lists the keys another owner's app reads but
// doesn't own (Android borrowing desktop strings). Returns key -> [owners].
export function loadConsumers(dir) {
  const byKey = new Map();
  if (!existsSync(dir)) return byKey;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.yml')) continue;
    const consumer = file.slice(0, -4);
    const raw = parseYaml(readFileSync(join(dir, file), 'utf8')) ?? {};
    for (const key of Array.isArray(raw.keys) ? raw.keys : []) {
      if (typeof key !== 'string') continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(consumer);
    }
  }
  return byKey;
}
