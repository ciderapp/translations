/**
 * Functional areas (i18n/areas.yml): which screen or feature a key belongs
 * to, for translators and for the AI fill's prompts.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { parse as parseYaml } from 'yaml';

// Areas that only catch words used all over the app. A key there takes the
// area of the screen that uses it, when the sync knows one.
const SHARED = new Set(['shared']);

export function loadAreas(path) {
  const raw = parseYaml(readFileSync(path, 'utf8'))?.areas ?? {};
  const areas = Object.entries(raw).map(([id, a]) => ({
    id,
    name: a.name ?? id,
    description: a.description ?? '',
    keys: a.keys ?? [],
    paths: a.paths ?? [],
  }));
  const seen = new Map();
  for (const a of areas) {
    for (const p of a.keys) {
      if (seen.has(p)) throw new Error(`key prefix ${p} is in both ${seen.get(p)} and ${a.id}`);
      seen.set(p, a.id);
    }
  }
  if (!areas.some(a => a.id === 'other')) areas.push({ id: 'other', name: 'Other', description: '', keys: [], paths: [] });
  return areas;
}

/** Area id from the longest matching key prefix, or null. */
export function areaByKey(key, areas) {
  let best = null;
  let len = -1;
  for (const a of areas) {
    for (const p of a.keys) {
      if (key.startsWith(p) && p.length > len) { best = a.id; len = p.length; }
    }
  }
  return best;
}

/** Area id from the first source path that matches a `paths` rule, or null. */
export function areaByPaths(paths, areas) {
  for (const path of paths) {
    let best = null;
    let len = -1;
    for (const a of areas) {
      for (const p of a.paths) {
        if (path.startsWith(p) && p.length > len) { best = a.id; len = p.length; }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * The area for one key: its own prefix rule, unless that only says "shared"
 * and the screen that uses it is known.
 */
export function resolveArea(key, { areas, pathArea = null }) {
  const byKey = areaByKey(key, areas);
  if ((!byKey || SHARED.has(byKey)) && pathArea) return pathArea;
  return byKey ?? 'other';
}

/** A component name worth showing a translator: the file name without its extension. */
export function componentName(path) {
  return basename(String(path).replace(/:\d+$/, '')).replace(/\.(vue|ts|tsx|js|mjs)$/, '');
}

/** Merged i18n/context/<owner>.yml files: key -> { area?, seen_in? }. */
export function loadContext(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.yml')).sort()) {
    const raw = parseYaml(readFileSync(join(dir, f), 'utf8')) ?? {};
    Object.assign(out, raw);
  }
  return out;
}

/** i18n/notes.yml: key -> a note people wrote for translators. */
export function loadNotes(path) {
  if (!existsSync(path)) return {};
  return parseYaml(readFileSync(path, 'utf8')) ?? {};
}
