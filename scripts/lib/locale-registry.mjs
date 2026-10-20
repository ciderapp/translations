/**
 * locales/languages.yml registry helpers.
 *
 * Citadel still sends its snapshot on every i18n-extract sync. A straight
 * copy used to wipe languages that only existed here (Croatian 2026-05-25,
 * Estonian 2026-06-08). mergeLanguageRegistryText keeps those extras.
 *
 * New locales are inserted as YAML blocks in alphabetical order so the
 * file stays a readable map, not a dump.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { LANG_RE, isValidBcp47, isReservedLocale } from './bcp47.mjs';

const KEY_LINE = /^ {2}([A-Za-z0-9-]+):\s*$/;

export function parseLanguagesFile(text) {
  const raw = parseYaml(text) ?? {};
  const languages = raw.languages && typeof raw.languages === 'object' && !Array.isArray(raw.languages)
    ? raw.languages
    : {};
  return { source: raw.source ?? null, languages };
}

/** YAML block for one locale, indented as a child of `languages:`. */
export function yamlLocaleBlock(code, entry) {
  if (!LANG_RE.test(code)) throw new Error(`refused to write suspicious lang code: ${code}`);
  const node = { [code]: { name: entry.name } };
  if (entry.native) node[code].native = entry.native;
  if (entry.source) node[code].source = true;
  return stringifyYaml(node, { lineWidth: 0, defaultStringType: 'PLAIN' })
    .trimEnd()
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n') + '\n';
}

/**
 * Insert `code` into the languages: map in alphabetical order.
 * No-op (added: false) when the code is already present.
 */
export function insertLanguage(text, code, entry) {
  if (!isValidBcp47(code) || isReservedLocale(code)) {
    throw new Error(`refused to register locale ${code}`);
  }
  if (!entry?.name) throw new Error(`locale ${code} needs a name`);
  const { languages } = parseLanguagesFile(text);
  if (Object.hasOwn(languages, code)) {
    return { text, added: false, languages };
  }
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const langIdx = lines.findIndex((l) => l === 'languages:' || l.startsWith('languages:'));
  if (langIdx === -1) {
    throw new Error('languages.yml has no languages: block');
  }
  let insertAt = lines.length;
  // If the file ends with a trailing empty line, insert before it.
  if (insertAt > 0 && lines[insertAt - 1] === '') insertAt -= 1;
  for (let i = langIdx + 1; i < lines.length; i++) {
    const m = KEY_LINE.exec(lines[i]);
    if (!m) continue;
    if (m[1].localeCompare(code) > 0) {
      insertAt = i;
      break;
    }
  }
  const blockLines = yamlLocaleBlock(code, entry).replace(/\n$/, '').split('\n');
  lines.splice(insertAt, 0, ...blockLines);
  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return {
    text: out,
    added: true,
    languages: { ...languages, [code]: { name: entry.name, ...(entry.native ? { native: entry.native } : {}) } },
  };
}

/**
 * Merge Citadel's snapshot with languages that only exist in this repo.
 * When there are no extras, returns upstreamText unchanged so a sync that
 * does not add a language is byte-identical to a copy.
 */
export function mergeLanguageRegistryText(upstreamText, localText) {
  const upstream = parseLanguagesFile(upstreamText).languages;
  const local = parseLanguagesFile(localText).languages;
  const extras = Object.keys(local)
    .filter((code) => !Object.hasOwn(upstream, code))
    .filter((code) => isValidBcp47(code) && !isReservedLocale(code))
    .sort((a, b) => a.localeCompare(b));
  if (extras.length === 0) return { text: upstreamText, extras };
  let text = upstreamText;
  for (const code of extras) {
    const entry = local[code];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name : code;
    const native = typeof entry.native === 'string' ? entry.native : undefined;
    text = insertLanguage(text, code, { name, native }).text;
  }
  return { text, extras };
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Three-way merge of the languages map for a rejected push.
 * Codes are never dropped: a locale added on either side survives.
 */
export function mergeLanguageMaps({ base = {}, ours = {}, theirs = {} }) {
  const codes = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
  const languages = {};
  for (const code of [...codes].sort((a, b) => a.localeCompare(b))) {
    if (!isValidBcp47(code) && code !== 'en-US') continue;
    const b = base[code];
    const o = ours[code];
    const t = theirs[code];
    const oursChanged = !same(o, b);
    const theirsChanged = !same(t, b);
    let next;
    if (!oursChanged && !theirsChanged) next = t ?? o ?? b;
    else if (oursChanged && !theirsChanged) next = o;
    else if (!oursChanged && theirsChanged) next = t;
    else if (same(o, t)) next = t ?? o;
    else next = { ...(typeof t === 'object' && t ? t : {}), ...(typeof o === 'object' && o ? o : {}) };
    if (next) languages[code] = next;
  }
  return languages;
}

/**
 * Apply a merged language map onto theirs' file text: keep Citadel comments
 * and insert any code theirs does not have.
 */
export function applyLanguageMapToText(theirsText, mergedMap) {
  const theirs = parseLanguagesFile(theirsText).languages;
  let text = theirsText || 'languages:\n';
  if (!theirsText) text = 'languages:\n';
  for (const code of Object.keys(mergedMap).sort((a, b) => a.localeCompare(b))) {
    if (Object.hasOwn(theirs, code)) continue;
    const entry = mergedMap[code];
    if (!entry?.name) continue;
    text = insertLanguage(text, code, {
      name: entry.name,
      native: entry.native,
      source: entry.source,
    }).text;
  }
  return text;
}

export function registerLanguageOnDisk(root, code, entry) {
  const p = join(root, 'locales/languages.yml');
  if (!existsSync(p)) throw new Error('locales/languages.yml is missing');
  const current = readFileSync(p, 'utf8');
  const result = insertLanguage(current, code, entry);
  if (result.added) writeFileSync(p, result.text, 'utf8');
  return result;
}
