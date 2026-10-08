/**
 * ICU MessageFormat checks for strings Cider for Android formats with
 * android.icu.text.MessageFormat.
 *
 * The parser follows ICU's apostrophe rule (DOUBLE_OPTIONAL, the one
 * android.icu uses): an ASCII apostrophe directly before `{` or `}` starts
 * quoted literal text. So French "Ajouté à l'{playlist}" parses with no
 * argument at all and would print "{playlist}" on the phone. Comparing the
 * argument sets is what catches it.
 */

import { parse, TYPE } from '@formatjs/icu-messageformat-parser';
import { ownerOf } from './owners.mjs';

// ignoreTag: ICU4J has no tag syntax, so `<b>` is plain text there too.
const PARSE_OPTIONS = { ignoreTag: true, requiresOtherClause: true };

function collectArguments(elements, out) {
  for (const el of elements) {
    if (el.type === TYPE.literal || el.type === TYPE.pound) continue;
    if (typeof el.value === 'string') out.add(el.value);
    if (el.options) {
      for (const option of Object.values(el.options)) collectArguments(option.value, out);
    }
  }
  return out;
}

/** { args: Set<string> } or { error: string } */
export function icuArguments(message) {
  try {
    return { args: collectArguments(parse(String(message), PARSE_OPTIONS), new Set()) };
  } catch (e) {
    return { error: e?.message ?? String(e) };
  }
}

/**
 * Compare a translation with its English.
 *   error:   the translation (or the English) doesn't parse
 *   unknown: arguments the English doesn't have. These print literally on the
 *            phone, so they are always an error.
 *   dropped: English arguments the translation leaves out. Harmless to ICU;
 *            translators sometimes rephrase them away.
 */
export function compareIcu(english, translation) {
  const en = icuArguments(english);
  if (en.error) return { error: `English does not parse as ICU: ${en.error}`, unknown: [], dropped: [] };
  const tr = icuArguments(translation);
  if (tr.error) return { error: tr.error, unknown: [], dropped: [] };
  return {
    error: null,
    unknown: [...tr.args].filter(a => !en.args.has(a)).sort(),
    dropped: [...en.args].filter(a => !tr.args.has(a)).sort(),
  };
}

/** True when an AI answer may be written: parses, and keeps exactly the English's arguments. */
export function acceptableIcu(english, translation) {
  const r = compareIcu(english, translation);
  return !r.error && r.unknown.length === 0 && r.dropped.length === 0;
}

/**
 * Whether a desktop string can be read through ICU unchanged. Desktop has no
 * ICU convention: some strings use `{{count}}` or `${name}`, and a few quote a
 * placeholder with ASCII apostrophes (`in '{playlist}'`), which parses but
 * prints the placeholder literally. Borrow only strings whose ICU arguments
 * are exactly the `{name}` placeholders a plain reading finds.
 */
export function isBorrowableEnglish(english) {
  const s = String(english ?? '');
  if (s.includes('{{') || s.includes('${')) return false;
  const parsed = icuArguments(s);
  if (parsed.error) return false;
  const plain = new Set([...s.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(m => m[1]));
  if (plain.size !== parsed.args.size) return false;
  for (const a of plain) if (!parsed.args.has(a)) return false;
  return true;
}

/** CLDR plural categories the target language uses, e.g. ['few','many','one','other'] for pl. */
export function pluralCategories(lang) {
  try {
    return [...new Intl.PluralRules(lang).resolvedOptions().pluralCategories].sort();
  } catch {
    return ['one', 'other'];
  }
}

/**
 * Whether a key's translations must be valid ICU: every key of an ICU owner
 * (Android), plus desktop keys an ICU owner borrows whose English reads
 * correctly through ICU.
 */
export function makeIcuCheck({ sourceStrings, owners, consumers }) {
  const icuConsumers = new Set(owners.filter(o => o.icu).map(o => o.name));
  return (key) => {
    if (ownerOf(key, owners).icu) return true;
    const users = consumers.get(key) ?? [];
    return users.some(u => icuConsumers.has(u)) && isBorrowableEnglish(sourceStrings[key]);
  };
}
