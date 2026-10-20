/**
 * Path-safe BCP 47 language tags for locale files and languages.yml.
 *
 * LANG_RE is the filesystem gate: a 2-3 letter lowercase primary subtag,
 * optional one 2-4 character region/script subtag. That covers every code
 * this repo already ships (cs, pt-BR, zh-CN, es-419, sv-SE) and Icelandic
 * (is, is-IS) without allowing path traversal or extra subtags.
 *
 * isValidBcp47 also asks Intl.Locale to reject tags that match the shape
 * but are not language tags.
 */

export const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?$/;

/** English source. Never a target locale. */
export const SOURCE_LOCALES = new Set(['en', 'en-US']);

/** Codes that would collide with files in locales/. */
export const RESERVED_CODES = new Set(['languages', 'en-US']);

export function isReservedLocale(code) {
  return SOURCE_LOCALES.has(code) || RESERVED_CODES.has(code);
}

export function isValidBcp47(code) {
  if (typeof code !== 'string' || !LANG_RE.test(code)) return false;
  try {
    const loc = new Intl.Locale(code);
    return Boolean(loc.language) && loc.language !== 'und';
  } catch {
    return false;
  }
}

/**
 * Display names for a tag. English `name` is what languages.yml stores as
 * `name`; `native` is the endonym. Falls back to the raw code if Intl
 * cannot resolve it.
 */
export function languageNamesFromIntl(code) {
  let name = code;
  let native = code;
  try {
    const en = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    if (en && en !== code) name = capitalizeLocaleName(en);
  } catch { /* malformed or unknown */ }
  try {
    const loc = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (loc) native = capitalizeLocaleName(loc);
  } catch { /* some tags have no endonym data */ }
  return { name, native };
}

export function capitalizeLocaleName(s) {
  if (!s) return s;
  const chars = [...String(s)];
  chars[0] = chars[0].toLocaleUpperCase();
  return chars.join('');
}

/** Names written into YAML and bot comments. No markdown or newlines. */
export function isSafeLanguageName(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 1 || t.length > 80) return false;
  if (/[\r\n`[\]<>]/.test(t)) return false;
  return true;
}

/**
 * English name and endonym for a new locale.
 * Precedence: explicit args, then Intl, then the raw code.
 */
export function resolveLanguageNames(code, { name, native } = {}) {
  const inferred = isValidBcp47(code) ? languageNamesFromIntl(code) : { name: code, native: code };
  const resolvedName = (typeof name === 'string' && name.trim()) ? name.trim() : inferred.name;
  const resolvedNative = (typeof native === 'string' && native.trim()) ? native.trim() : inferred.native;
  const errors = [];
  if (!isSafeLanguageName(resolvedName)) {
    errors.push(`Language name ${JSON.stringify(resolvedName)} is not a safe display name.`);
  }
  if (resolvedNative && !isSafeLanguageName(resolvedNative)) {
    errors.push(`Native name ${JSON.stringify(resolvedNative)} is not a safe display name.`);
  }
  return { name: resolvedName, native: resolvedNative, errors };
}

/** `[language] Add Icelandic` -> `Icelandic` */
export function languageNameFromTitle(title) {
  if (typeof title !== 'string') return null;
  const m = /\[language\]\s+Add\s+(.+)$/i.exec(title.trim());
  if (!m) return null;
  const name = m[1].trim();
  return name || null;
}
