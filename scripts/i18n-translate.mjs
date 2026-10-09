#!/usr/bin/env node
/**
 * i18n Translator for Cider (powered by Anthropic Claude)
 *
 * Reads locales/en-US.yml as source and uses Claude Haiku 5.5 to translate
 * new or changed strings into every language listed in
 * locales/languages.yml. Existing target locale files are loaded
 * first so only the delta is sent to the model.
 *
 * Provenance model (per-key shape in each target locale file):
 *   action.apply: Aplicar                # scalar = AI-translated
 *   action.back:                         # map = community-contributed
 *     value: Atrás
 *     source: human                      # or 'ai' if AI later overwrote
 *     by: '@username'                    # original contributor (preserved)
 *     issue: 1234                        # original issue number
 *
 * Staleness is tracked per key and locale in i18n/fill-state/<lang>.yml
 * (see scripts/lib/fill-state.mjs): each key is stamped with a hash of
 * the English its value was made from. A key whose English changed since
 * is re-translated for that locale, overriding `source: human` (the
 * human value is for the old English text). The map shape is preserved
 * with `source: ai` so credit isn't lost. A locale without a state file
 * is seeded from en-US.yml as of the last fill commit, so this needs
 * full git history (ai-fill.yml checks out with fetch-depth: 0).
 *
 * Two owners write en-US.yml (i18n/owners.yml): Citadel (desktop) and
 * Cider-Android (`mobile.*`). Batches never mix owners, so each gets a
 * prompt for its platform. Android's strings are ICU MessageFormat: their
 * batches get ICU rules, and an answer that doesn't parse or changes the
 * arguments is dropped (the app shows English; the next run retries).
 * The same check covers desktop keys Android borrows (i18n/consumers/).
 * A `mobile.*` string with the same English as a desktop string copies
 * that string's translation instead of asking Claude, and a `mobile.*`
 * key gone from en-US.yml loses its AI translations.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=<key> node scripts/i18n-translate.mjs [options]
 *
 * Options:
 *   --source <path>      Source English YAML (default: locales/en-US.yml)
 *   --out <dir>          Output directory (default: locales)
 *   --languages <path>   Languages file (default: locales/languages.yml)
 *   --owners <path>      Ownership file (default: i18n/owners.yml)
 *   --state <dir>        Fill-state directory (default: i18n/fill-state)
 *   --lang <codes>       Comma-separated language codes to process
 *                        (default: all from languages.yml, excluding source)
 *   --list-langs         Print the target language codes, one per line, and exit
 *   --list-pending       Print only the codes with work to do (no API calls), and exit
 *   --json               With --list-pending: print one JSON array instead of lines
 *   --model <id>         Anthropic model ID (default: claude-haiku-5-5)
 *   --batch-size <n>     Strings per API request (default: 60)
 *   --force              Re-translate every key, ignoring existing files
 *   --dry-run            Preview what would be translated without calling the API
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadOwners, ownerOf, loadConsumers } from './lib/owners.mjs';
import { compareIcu, acceptableIcu, pluralCategories, makeIcuCheck } from './lib/icu.mjs';
import {
  englishHash, isStale, loadState, saveState, seedState, englishAtLastFill,
} from './lib/fill-state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

// Official Claude API model ID for Claude Haiku 5.5.
// https://platform.claude.com/docs/en/models/haiku-5-5/overview
export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
// Required by the Messages API. Sized for a 60-string JSON batch plus
// adaptive-thinking tokens (they count toward max_tokens on Haiku 5.5).
export const DEFAULT_MAX_TOKENS = 16384;
// Official Claude API minimum for Haiku 5.5 prompt caching (not Haiku 4.5's 4096).
// https://platform.claude.com/docs/en/build-with-claude/prompt-caching#cache-limitations
export const HAIKU_MIN_CACHE_TOKENS = 512;
export const CACHE_CONTROL = { type: 'ephemeral', ttl: '5m' };

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg  = (f, d) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : d; };
const flag = (f) => args.includes(f);

const SOURCE_FILE    = arg('--source',    join(ROOT, 'locales/en-US.yml'));
const OUT_DIR        = arg('--out',       join(ROOT, 'locales'));
const LANGUAGES_FILE = arg('--languages', join(ROOT, 'locales/languages.yml'));
const OWNERS_FILE    = arg('--owners',    join(ROOT, 'i18n/owners.yml'));
const STATE_DIR      = arg('--state',     join(ROOT, 'i18n/fill-state'));
const CONSUMERS_DIR  = join(dirname(OWNERS_FILE), 'consumers');
const LANG_OVERRIDE  = arg('--lang',      null);
const LIST_LANGS     = flag('--list-langs');
const LIST_PENDING   = flag('--list-pending');
const JSON_OUT       = flag('--json');
const ANTHROPIC_MODEL = arg('--model',    DEFAULT_MODEL);
const BATCH_SIZE     = parseInt(arg('--batch-size', '60'), 10);
const FORCE          = flag('--force');
const DRY_RUN        = flag('--dry-run');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── ANSI colours ──────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  cyan: '\x1b[36m', red: '\x1b[31m', magenta: '\x1b[35m',
};
const log = {
  info:    (m) => console.log(`${c.blue}ℹ${c.reset} ${m}`),
  success: (m) => console.log(`${c.green}✓${c.reset} ${m}`),
  warn:    (m) => console.log(`${c.yellow}⚠${c.reset} ${m}`),
  error:   (m) => console.error(`${c.red}✗${c.reset} ${m}`),
  step:    (m) => console.log(`${c.cyan}→${c.reset} ${m}`),
  dim:     (m) => console.log(`${c.dim}  ${m}${c.reset}`),
};

// ── Language metadata ────────────────────────────────────────────────────────
function loadLanguagesFile() {
  if (!existsSync(LANGUAGES_FILE)) {
    log.error(`Languages file not found: ${relative(ROOT, LANGUAGES_FILE)}`);
    process.exit(1);
  }
  const raw = parseYaml(readFileSync(LANGUAGES_FILE, 'utf8')) ?? {};
  return raw.languages ?? {};
}

function langName(code, registry) {
  const entry = registry[code];
  if (entry?.name) return entry.name;
  const fallback = registry[code.split('-')[0]];
  return fallback?.name ?? code;
}

// ── Translation file I/O (YAML, mixed scalar/map shape) ──────────────────────
function localFilePath(lang) {
  return join(OUT_DIR, `${lang}.yml`);
}

// A locale that fails to parse is an error, not an empty file: treating it as
// empty would mark every key missing, re-translate the lot and then overwrite
// the file, human contributions included.
function loadLocalTranslation(lang) {
  const p = localFilePath(lang);
  if (!existsSync(p)) return {};
  try {
    return parseYaml(readFileSync(p, 'utf8')) ?? {};
  } catch (e) {
    throw new Error(`${relative(ROOT, p)} does not parse; refusing to touch it (${e.message})`);
  }
}

function saveTranslation(lang, entries) {
  const sortedKeys = Object.keys(entries).sort((a, b) => a.localeCompare(b));
  const sorted = {};
  for (const k of sortedKeys) sorted[k] = entries[k];
  const out = stringifyYaml(sorted, { lineWidth: 0, defaultStringType: 'PLAIN' });
  writeFileSync(localFilePath(lang), out, 'utf8');
}

// ── Anthropic Messages API ────────────────────────────────────────────────────
// Plain HTTP (no SDK) to keep dependencies small. Official request shape:
// https://platform.claude.com/docs/en/build-with-claude/working-with-messages
//
// Haiku 5.5 notes from Anthropic's overview / migration guide:
//   - max_tokens is required
//   - system prompt is the top-level `system` field, not a messages role
//   - omit temperature / top_p / top_k (non-default values return 400)
//   - adaptive thinking is on by default; effort:low keeps it cheap for
//     high-volume JSON translation. Select content blocks by `type`, not index.
//   - 429 responses may include Retry-After; 529 is overloaded_error.

export const SYSTEM_PROMPT = `\
You are a professional translator localizing Cider, a premium Apple Music desktop client.

Rules:
- Preserve all placeholders exactly: \${variable}, $VARIABLE, {{ variable }}, {{variable}}
- Do NOT translate proper nouns: Cider, Apple Music, AirPlay, Dolby Atmos, Chromecast, AudioLab
- Keep strings concise. These are UI labels, buttons, notifications, and menu items
- Match Apple Music's tone: clean, professional, and friendly
- Return ONLY a valid JSON object with identical keys and translated string values
- Do not include markdown code fences, explanations, or any text outside the JSON object`;

// Shared across every batch (desktop/Android, every locale). Cached with an
// explicit breakpoint so later requests read it. Per-batch English JSON stays
// in the user message and is never marked cache_control.
//
// The raw SYSTEM_PROMPT is well under 512 tokens. Anthropic will silently
// skip caching a shorter prefix, so this restates the standing rules in
// enough detail to clear the Haiku 5.5 floor. It does not add new rules.
export const SHARED_CACHE_PREFIX = `\
The following instructions are the stable prefix for every Cider UI translation batch. They are identical on every request. Only the user message (the English strings for this batch) changes.

Placeholder preservation. Copy every placeholder into the translation with the same spelling, braces, dollar signs, and spacing. Recognised forms include \${variable}, $VARIABLE, {{ variable }}, and {{variable}}. Do not translate the name inside a placeholder. Do not add placeholders the English did not have. Do not drop placeholders the English did have. If the English has two placeholders, the translation has those same two, written the same way.

Proper nouns stay in English exactly as written: Cider, Apple Music, AirPlay, Dolby Atmos, Chromecast, AudioLab. Do not localize those product names, even when the rest of the sentence is translated. Do not invent extra brand names.

Tone. These are UI labels, buttons, notifications, and menu items. Keep them short. Match Apple Music: clean, professional, and friendly. Do not add marketing copy, emoji, or explanations. Do not wrap the answer in prose.

Output format. Return only a JSON object. Keys must match the input keys exactly. Values are the translated strings. No markdown fences, no preamble, no trailing commentary. If a value needs a quote or a line break, escape it as JSON requires. Do not invent keys. Do not omit keys that were in the input.

Examples of correct behaviour (do not echo these examples in the output; they only illustrate the rules above):
- English {"action.apply":"Apply"} becomes Spanish {"action.apply":"Aplicar"}
- English {"status.loading":"Loading \${count} tracks"} keeps \${count} unchanged
- English {"cast.airplay":"Use AirPlay"} keeps the word AirPlay untranslated
- English {"action.addToLastPlaylist":"Add to Last Playlist, $PLAYLIST"} keeps $PLAYLIST
- English {"hint":"Tap {{ variable }} to continue"} keeps {{ variable }} including the spaces
- English {"hint2":"Open {{variable}}"} keeps {{variable}} with no added spaces
- A response that adds a sentence of explanation around the JSON is wrong
- A response wrapped in triple backticks is wrong
- A response that translates Chromecast as a local word is wrong

This prefix exists so the request meets Claude Haiku 5.5's 512-token cache minimum on the Claude API. Cache writes use a 5-minute ephemeral TTL and refresh on each hit, which covers sequential batches in one fill job. Per-batch strings are not part of this prefix and must not be cached.

Rules (same as every batch):
- Preserve all placeholders exactly: \${variable}, $VARIABLE, {{ variable }}, {{variable}}
- Do NOT translate proper nouns: Cider, Apple Music, AirPlay, Dolby Atmos, Chromecast, AudioLab
- Keep strings concise. These are UI labels, buttons, notifications, and menu items
- Match Apple Music's tone: clean, professional, and friendly
- Return ONLY a valid JSON object with identical keys and translated string values
- Do not include markdown code fences, explanations, or any text outside the JSON object`;

/** Lower-bound token estimate (older ~4 chars/token). Haiku 5.5 counts more. */
export function estimateTokensLowerBound(text) {
  return Math.floor(String(text).length / 4);
}

export function extractCacheUsage(data) {
  const usage = data?.usage ?? {};
  return {
    cacheCreation: Number(usage.cache_creation_input_tokens) || 0,
    cacheRead: Number(usage.cache_read_input_tokens) || 0,
    input: Number(usage.input_tokens) || 0,
  };
}

export function emptyCacheTotals() {
  return { created: 0, read: 0, requests: 0 };
}

export function addCacheUsage(totals, usage) {
  totals.created += usage.cacheCreation;
  totals.read += usage.cacheRead;
  totals.requests += 1;
  return totals;
}

export function formatCacheUsage(usage) {
  return `cache write ${usage.cacheCreation} · cache read ${usage.cacheRead}`;
}

export function formatCacheTotals(totals) {
  return `Prompt cache totals: write ${totals.created} tokens, read ${totals.read} tokens, ${totals.requests} request(s)`;
}

const DESKTOP_INTRO = 'Cider, a premium Apple Music desktop client';
const ANDROID_INTRO = 'Cider for Android, a premium Apple Music app for phones';

export const ANDROID_RULES = `\
- These strings appear on a phone: in the app, in its notifications, and on Android Auto car screens. Keep them short`;

/**
 * Rules for strings formatted with ICU MessageFormat (Cider for Android).
 * `categories` are the CLDR plural categories the target language uses.
 */
export function icuRules(categories) {
  return `\
- These strings use ICU MessageFormat. Keep every {argument} name exactly as written; never translate or rename it
- In {name, plural, ...} and {name, select, ...}, translate only the text inside each branch's braces. Keep the keywords (plural, select, one, few, many, other, =0) untranslated. # stands for the number
- Give every plural the categories this language uses (${categories.join(', ')}), and always include other
- Never put a straight apostrophe (') right before { or after }: ICU treats it as a quote. Use the typographic apostrophe (’) in translated text instead`;
}

/**
 * The system prompt for one batch. Desktop batches get SYSTEM_PROMPT
 * unchanged; Android and ICU batches add their rules to it.
 */
export function buildSystemPrompt({ platform = 'desktop', icu = false, lang = 'en' } = {}) {
  let prompt = SYSTEM_PROMPT;
  if (platform === 'android') prompt = prompt.replace(DESKTOP_INTRO, ANDROID_INTRO);
  const extra = [];
  if (platform === 'android') extra.push(ANDROID_RULES);
  if (icu) extra.push(icuRules(pluralCategories(lang)));
  if (extra.length === 0) return prompt;
  return prompt.replace('\n\nRules:\n', `\n\nRules:\n${extra.join('\n')}\n`);
}

export function buildUserPrompt(strings, targetLang, targetLangName) {
  const sourceJson = JSON.stringify(strings, null, 2);
  return `Translate the following UI strings from English to ${targetLangName} (locale: ${targetLang}).

English strings:
${sourceJson}`;
}

/**
 * Explicit cache breakpoint on the shared prefix only.
 * Automatic top-level cache_control would mark the last block (the
 * per-batch user message) and never hit. See Anthropic's "Common mistake:
 * Breakpoint on content that changes every request".
 */
export function buildSystemBlocks(systemPrompt) {
  return [
    {
      type: 'text',
      text: SHARED_CACHE_PREFIX,
      cache_control: { ...CACHE_CONTROL },
    },
    {
      type: 'text',
      text: systemPrompt,
    },
  ];
}

export function buildMessagesRequest({ model, maxTokens, system, user }) {
  const systemBlocks = Array.isArray(system) ? system : buildSystemBlocks(system);
  return {
    model,
    max_tokens: maxTokens,
    system: systemBlocks,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: user }],
  };
}

export function extractTextFromMessage(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

export function parseTranslationJson(response) {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON object found in Claude response');
  return JSON.parse(jsonMatch[0]);
}

export function retryWaitMs(res, attempt) {
  const header = res?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(seconds * 1000, 1000);
    }
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(date - Date.now(), 1000);
  }
  return 2000 * attempt;
}

export async function callAnthropic(userPrompt, {
  retries = 3,
  apiKey = ANTHROPIC_API_KEY,
  model = ANTHROPIC_MODEL,
  maxTokens = DEFAULT_MAX_TOKENS,
  system = SYSTEM_PROMPT,
  fetchImpl = globalThis.fetch,
  sleepFn = sleep,
  onUsage,
} = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const body = buildMessagesRequest({
    model,
    maxTokens,
    system,
    user: userPrompt,
  });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });

      // 429 rate_limit_error (honor Retry-After) and 529 overloaded_error.
      if (res.status === 429 || res.status === 529) {
        const wait = retryWaitMs(res, attempt);
        log.warn(`Rate limited (${res.status}); waiting ${wait / 1000}s before retry ${attempt}/${retries}`);
        await sleepFn(wait);
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }

      const data = await res.json();
      if (data.stop_reason === 'refusal') {
        throw new Error('Claude refused to translate this batch');
      }
      if (data.stop_reason === 'max_tokens') {
        throw new Error('Claude response truncated (max_tokens reached)');
      }

      const text = extractTextFromMessage(data);
      if (!text) throw new Error('Empty response from Claude');
      const usage = extractCacheUsage(data);
      if (typeof onUsage === 'function') onUsage(usage);
      return text;
    } catch (e) {
      if (attempt < retries) {
        log.warn(`  Attempt ${attempt} failed: ${e.message}; retrying…`);
        await sleepFn(1000 * attempt);
      } else {
        throw e;
      }
    }
  }

  throw new Error(`Rate limited after ${retries} retries`);
}

async function translateBatch(strings, targetLang, targetLangName, apiOptions) {
  const userPrompt = buildUserPrompt(strings, targetLang, targetLangName);
  const response = await callAnthropic(userPrompt, apiOptions);
  const parsed = parseTranslationJson(response);

  // Sanity check: warn if more than 10% of keys are missing
  const inputKeys  = Object.keys(strings);
  const missing    = inputKeys.filter(k => typeof parsed[k] !== 'string');
  if (missing.length > inputKeys.length * 0.1) {
    log.warn(`  ${missing.length}/${inputKeys.length} keys missing from translation response`);
  }

  // Only the keys that were asked for, and only strings: a key the model
  // invents must never reach the locale file.
  const out = {};
  for (const k of inputKeys) if (typeof parsed[k] === 'string') out[k] = parsed[k];
  return out;
}

// ── Planning (pure; covered by test/fill-plan.test.mjs) ─────────────────────
export { makeIcuCheck };
const entryValue = (e) =>
  typeof e === 'string' ? e :
  (e && typeof e === 'object' && typeof e.value === 'string' ? e.value : undefined);
const isHumanEntry = (e) => !!e && typeof e === 'object' && e.source === 'human';

/**
 * Decide what one locale needs this run.
 *
 * Returns:
 *   toTranslate  key -> English, for keys that are missing or stale
 *   changed      keys whose existing value was made from other English
 *                (feeds mergeTranslations: a human entry there is superseded)
 *   copies       key -> value copied from a same-English desktop translation
 *   pruned       keys removed (AI translations of an owner's deleted keys)
 *   locale       the locale after pruning
 *   state        the state after pruning
 */
export function planLocale({ sourceStrings, existing, state, owners, isIcuKey, force = false }) {
  const locale = { ...existing };
  const nextState = { ...state };
  const pruned = [];

  // Prune: an owner with complete extraction (Android) deleted the key, so
  // its AI translations go too. Human ones stay, as on desktop, so a renamed
  // key's community translation can still be recovered by hand. An owner
  // with no keys left at all is an accident (a sync that overwrote en-US.yml
  // wholesale), not a deletion, so nothing of theirs is pruned until their
  // keys come back.
  const ownersPresent = new Set(Object.keys(sourceStrings).map(k => ownerOf(k, owners).name));
  for (const [key, entry] of Object.entries(existing)) {
    if (Object.hasOwn(sourceStrings, key)) continue;
    const owner = ownerOf(key, owners);
    if (!owner.prune || !ownersPresent.has(owner.name)) continue;
    if (isHumanEntry(entry)) continue;
    delete locale[key];
    pruned.push(key);
  }
  for (const key of Object.keys(nextState)) {
    if (!Object.hasOwn(sourceStrings, key) || !Object.hasOwn(locale, key)) delete nextState[key];
  }

  const toTranslate = {};
  const changed = new Set();
  for (const [key, english] of Object.entries(sourceStrings)) {
    if (typeof english !== 'string' || !english.trim()) continue;
    if (force) { toTranslate[key] = english; changed.add(key); continue; }
    if (!isStale(key, english, locale, nextState)) continue;
    toTranslate[key] = english;
    if (Object.hasOwn(locale, key)) changed.add(key);
  }

  // Reuse: a string whose English matches a string of the owner it reuses
  // from (Android from desktop) takes that translation, if it's current
  // (stamped with this English) and, for ICU keys, valid ICU.
  const copies = {};
  if (!force) {
    const byEnglish = new Map();
    for (const [key, english] of Object.entries(sourceStrings)) {
      if (!byEnglish.has(english)) byEnglish.set(english, []);
      byEnglish.get(english).push(key);
    }
    for (const [key, english] of Object.entries(toTranslate)) {
      const from = ownerOf(key, owners).reuseFrom;
      if (!from) continue;
      const candidates = (byEnglish.get(english) ?? [])
        .filter(k => k !== key && ownerOf(k, owners).name === from)
        .filter(k => Object.hasOwn(locale, k) && !isStale(k, english, locale, nextState))
        .map(k => ({ key: k, entry: locale[k] }))
        .filter(c => typeof entryValue(c.entry) === 'string')
        .filter(c => !isIcuKey(key) || acceptableIcu(english, entryValue(c.entry)))
        .sort((a, b) => Number(isHumanEntry(b.entry)) - Number(isHumanEntry(a.entry)) || a.key.localeCompare(b.key));
      if (candidates.length === 0) continue;
      copies[key] = entryValue(candidates[0].entry);
      delete toTranslate[key];
    }
  }

  return { toTranslate, changed, copies, pruned, locale, state: nextState };
}

/**
 * Split model answers into accepted and rejected. An ICU key's answer must
 * parse and keep exactly the English's arguments: an invented argument would
 * print literally on the phone, and a dropped one in an AI answer is almost
 * always an apostrophe that quoted it away. (Humans may drop arguments on
 * purpose; the issue linter only warns about that.)
 */
export function acceptTranslations({ translated, sourceStrings, isIcuKey }) {
  const accepted = {};
  const rejected = [];
  for (const [key, value] of Object.entries(translated)) {
    if (!isIcuKey(key)) { accepted[key] = value; continue; }
    const r = compareIcu(sourceStrings[key], value);
    if (r.error) rejected.push({ key, value, reason: r.error });
    else if (r.unknown.length) rejected.push({ key, value, reason: `unknown argument(s): ${r.unknown.join(', ')}` });
    else if (r.dropped.length) rejected.push({ key, value, reason: `dropped argument(s): ${r.dropped.join(', ')}` });
    else accepted[key] = value;
  }
  return { accepted, rejected };
}

/**
 * Group keys into batches that share a prompt: same owner platform, ICU or
 * not. Returns [{ platform, icu, entries: [[key, english], ...] }].
 */
export function groupBatches(toTranslate, { owners, isIcuKey, batchSize }) {
  const groups = new Map();
  for (const [key, english] of Object.entries(toTranslate)) {
    const platform = ownerOf(key, owners).platform;
    const icu = isIcuKey(key);
    const id = `${platform}|${icu}`;
    if (!groups.has(id)) groups.set(id, { platform, icu, entries: [] });
    groups.get(id).entries.push([key, english]);
  }
  const batches = [];
  for (const g of groups.values()) {
    for (const entries of chunk(g.entries, batchSize)) batches.push({ platform: g.platform, icu: g.icu, entries });
  }
  return batches;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function chunk(entries, size) {
  const chunks = [];
  for (let i = 0; i < entries.length; i += size) chunks.push(entries.slice(i, i + size));
  return chunks;
}

// ── Merge logic (provenance-aware) ───────────────────────────────────────────
// Apply translated strings into the existing locale map, preserving the
// map shape (and original attribution) when a human-contributed entry is
// being overwritten because its English source changed.
export function mergeTranslations(existing, translations, changedSourceKeys) {
  const today = new Date().toISOString().slice(0, 10);
  const out = { ...existing };

  for (const [key, newValue] of Object.entries(translations)) {
    const old = existing[key];
    const isMap = old && typeof old === 'object' && !Array.isArray(old);
    const wasHuman = isMap && old.source === 'human';
    const englishChanged = changedSourceKeys.has(key);

    if (wasHuman && englishChanged) {
      // Human entry being superseded. Preserve attribution, mark as AI.
      out[key] = {
        ...old,
        value: newValue,
        source: 'ai',
        superseded_at: today,
      };
    } else if (isMap) {
      // Map entry but not human. Refresh the value, keep the shape.
      out[key] = { ...old, value: newValue };
    } else {
      // Scalar entry (or missing). Write as scalar.
      out[key] = newValue;
    }
  }

  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function targetLanguages(languageRegistry) {
  if (LANG_OVERRIDE) return LANG_OVERRIDE.split(',').map(l => l.trim()).filter(Boolean);
  return Object.keys(languageRegistry).filter(
    code => code !== 'en-US' && code !== 'en' && !languageRegistry[code]?.source,
  );
}

function writeStepSummary(lines) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path || lines.length === 0) return;
  try { appendFileSync(path, lines.join('\n') + '\n', 'utf8'); } catch { /* best-effort */ }
}

async function main() {
  if (LIST_LANGS) {
    for (const code of targetLanguages(loadLanguagesFile())) console.log(code);
    return;
  }

  if (LIST_PENDING) {
    // The locales with work to do, for ai-fill.yml's matrix. No API calls.
    const sourceStrings = parseYaml(readFileSync(SOURCE_FILE, 'utf8')) ?? {};
    const owners = loadOwners(OWNERS_FILE);
    const isIcuKey = makeIcuCheck({ sourceStrings, owners, consumers: loadConsumers(CONSUMERS_DIR) });
    const pending = [];
    for (const lang of targetLanguages(loadLanguagesFile())) {
      const existing = loadLocalTranslation(lang);
      const state = loadState(STATE_DIR, lang);
      // A locale whose state has never been written needs a run to seed it.
      if (state === null && Object.keys(existing).length) { pending.push(lang); continue; }
      const plan = planLocale({ sourceStrings, existing, state: state ?? {}, owners, isIcuKey, force: FORCE });
      if (Object.keys(plan.toTranslate).length || Object.keys(plan.copies).length || plan.pruned.length) {
        pending.push(lang);
      }
    }
    // --json is what the workflow reads: an empty list is exactly "[]".
    console.log(JSON_OUT ? JSON.stringify(pending) : pending.join('\n'));
    return;
  }

  console.log(`\n${c.bold}Cider i18n Translator${c.reset} ${c.dim}(Anthropic Claude Haiku 5.5)${c.reset}\n`);

  if (!ANTHROPIC_API_KEY && !DRY_RUN) {
    log.error('ANTHROPIC_API_KEY environment variable is required');
    log.dim('Set it with:  export ANTHROPIC_API_KEY=your_key_here');
    process.exit(1);
  }

  // Belt-and-braces: tell GitHub Actions to redact the key from any log
  // output. The runner replaces every occurrence with ***. No-op when run
  // locally (the magic string is just text outside Actions).
  if (process.env.GITHUB_ACTIONS && ANTHROPIC_API_KEY) {
    console.log(`::add-mask::${ANTHROPIC_API_KEY}`);
  }

  if (DRY_RUN) log.warn('DRY RUN: no files will be written, no API calls will be made');

  // Load source strings
  if (!existsSync(SOURCE_FILE)) {
    log.error(`Source file not found: ${relative(ROOT, SOURCE_FILE)}`);
    log.dim('Run first:  node scripts/i18n-extract.mjs');
    process.exit(1);
  }

  const sourceStrings = parseYaml(readFileSync(SOURCE_FILE, 'utf8')) ?? {};
  const sourceCount   = Object.keys(sourceStrings).length;
  log.info(`Loaded ${sourceCount} source strings from ${relative(ROOT, SOURCE_FILE)}`);

  const owners    = loadOwners(OWNERS_FILE);
  const consumers = loadConsumers(CONSUMERS_DIR);
  const isIcuKey  = makeIcuCheck({ sourceStrings, owners, consumers });
  log.info(`Owners: ${owners.map(o => o.name).join(', ')}`);
  if (FORCE) log.warn('--force: every key will be re-translated');

  // Resolve target languages from locales/languages.yml.
  const languageRegistry = loadLanguagesFile();
  const languages = targetLanguages(languageRegistry);
  if (LANG_OVERRIDE) log.info(`Languages (--lang): ${languages.join(', ')}`);
  else log.success(`Found ${languages.length} target languages in ${relative(ROOT, LANGUAGES_FILE)}`);

  mkdirSync(OUT_DIR, { recursive: true });

  // en-US.yml as of the last fill: what every existing translation was made
  // from, for seeding a locale that has no state file yet. Only read once,
  // and only if some locale needs it.
  let seedSource;
  const getSeedSource = () => {
    if (seedSource === undefined) {
      seedSource = englishAtLastFill(ROOT);
      if (seedSource === null) {
        log.warn('No AI fill commit in reach (shallow clone?). Seeding from the current en-US.yml, ' +
          'so English changes made since the last fill will not be re-translated.');
        seedSource = sourceStrings;
      }
    }
    return seedSource;
  };

  let totalTranslated = 0;
  let totalReused     = 0;
  let totalSkipped    = 0;
  let totalErrors     = 0;
  const rejectedAll   = [];
  const cacheTotals   = emptyCacheTotals();
  const cacheEst      = estimateTokensLowerBound(SHARED_CACHE_PREFIX);
  log.info(`Prompt cache: shared rules prefix, est. ≥${cacheEst} tokens (Haiku 5.5 minimum is ${HAIKU_MIN_CACHE_TOKENS}). Per-batch strings are not cached.`);
  if (cacheEst < HAIKU_MIN_CACHE_TOKENS) {
    log.warn(`Shared prefix is below ${HAIKU_MIN_CACHE_TOKENS} tokens; Anthropic will process it without caching and return 0 for both cache usage fields.`);
  }

  for (const lang of languages) {
    if (lang === 'en-US' || lang === 'en') continue;

    const name = langName(lang, languageRegistry);
    console.log(`\n${c.bold}[${lang}]${c.reset} ${c.dim}${name}${c.reset}`);

    const existing = loadLocalTranslation(lang);
    let state = loadState(STATE_DIR, lang);
    if (state === null) {
      state = Object.keys(existing).length ? seedState(existing, getSeedSource()) : {};
      if (Object.keys(state).length) log.info(`Seeded fill state for ${Object.keys(state).length} keys`);
    }

    const plan = planLocale({ sourceStrings, existing, state, owners, isIcuKey, force: FORCE });
    const toTranslateCount = Object.keys(plan.toTranslate).length;
    const reuseCount = Object.keys(plan.copies).length;
    log.info(`Existing: ${Object.keys(existing).length}  ·  To translate: ${toTranslateCount}` +
      `  ·  Reused: ${reuseCount}  ·  Pruned: ${plan.pruned.length}`);

    if (DRY_RUN) {
      const preview = Object.entries(plan.toTranslate).slice(0, 5);
      preview.forEach(([k, v]) => log.dim(`${k}: "${v}"`));
      if (toTranslateCount > 5) log.dim(`… and ${toTranslateCount - 5} more`);
      continue;
    }

    const translations = { ...plan.copies };
    totalReused += reuseCount;

    const batches = groupBatches(plan.toTranslate, { owners, isIcuKey, batchSize: BATCH_SIZE });
    if (batches.length) log.step(`Translating ${toTranslateCount} strings in ${batches.length} batch(es)…`);
    else if (!reuseCount && !plan.pruned.length) { log.success('All strings already translated'); totalSkipped++; }

    let batchErrors = 0;
    for (let i = 0; i < batches.length; i++) {
      const { platform, icu, entries } = batches[i];
      const batchObj = Object.fromEntries(entries);
      process.stdout.write(`  Batch ${i + 1}/${batches.length} (${platform}${icu ? ', ICU' : ''})… `);

      try {
        let usage;
        const translated = await translateBatch(batchObj, lang, name, {
          system: buildSystemPrompt({ platform, icu, lang }),
          onUsage: (u) => { usage = u; },
        });
        const { accepted, rejected } = acceptTranslations({ translated, sourceStrings, isIcuKey });
        Object.assign(translations, accepted);
        const count = Object.keys(accepted).length;
        console.log(`${c.green}✓${c.reset} (${count} strings${rejected.length ? `, ${rejected.length} rejected` : ''})`);
        if (usage) {
          addCacheUsage(cacheTotals, usage);
          log.dim(`${formatCacheUsage(usage)}  (run write ${cacheTotals.created} / read ${cacheTotals.read})`);
        }
        totalTranslated += count;
        for (const r of rejected) {
          log.dim(`rejected ${r.key}: ${r.reason}`);
          rejectedAll.push({ lang, ...r });
        }
      } catch (e) {
        console.log(`${c.red}✗${c.reset}`);
        log.error(`  Batch ${i + 1} failed: ${e.message}`);
        batchErrors++;
        totalErrors++;
      }

      if (i < batches.length - 1) await sleep(400);
    }

    // Stamp exactly the keys written this run; a key whose batch failed keeps
    // its old stamp and stays stale for the next run.
    const nextState = { ...plan.state };
    for (const key of Object.keys(translations)) nextState[key] = englishHash(sourceStrings[key]);

    if (Object.keys(translations).length || plan.pruned.length) {
      saveTranslation(lang, mergeTranslations(plan.locale, translations, plan.changed));
      log.success(`Saved → locales/${lang}.yml`);
    }
    saveState(STATE_DIR, lang, nextState);
    if (batchErrors > 0) log.warn(`${batchErrors} batch(es) failed and were skipped`);
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log(`\n${c.bold}─── Summary ───────────────────────────────${c.reset}`);
  log.success(`Processed ${languages.length} language(s)`);
  if (!DRY_RUN) {
    if (totalTranslated > 0) log.success(`Translated  ${totalTranslated} string(s)`);
    if (totalReused > 0)     log.success(`Reused      ${totalReused} desktop translation(s)`);
    if (totalSkipped > 0)    log.dim(`Skipped     ${totalSkipped} language(s) (already complete)`);
    if (totalErrors > 0)     log.warn(`Errors      ${totalErrors} batch(es) failed`);
    if (rejectedAll.length)  log.warn(`Rejected    ${rejectedAll.length} ICU answer(s); English shows until a later run succeeds`);
    if (cacheTotals.requests > 0) {
      log.info(formatCacheTotals(cacheTotals));
      if (cacheTotals.created === 0 && cacheTotals.read === 0) {
        log.warn('Prompt cache usage was 0/0. The prefix was probably below the 512-token Haiku 5.5 minimum.');
      }
    }
  }
  console.log('');

  if (cacheTotals.requests > 0) {
    writeStepSummary([
      `### Prompt cache`,
      '',
      formatCacheTotals(cacheTotals),
      '',
      `Shared prefix (rules and glossary) is marked with cache_control ttl=5m. Per-batch English strings are not cached.`,
    ]);
  }

  if (rejectedAll.length) {
    const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    writeStepSummary([
      `### Rejected ICU translations (${rejectedAll.length})`,
      '',
      'Dropped this run; the app shows English and the next fill retries them.',
      '',
      '| Locale | Key | Reason | Answer |',
      '|---|---|---|---|',
      ...rejectedAll.slice(0, 200).map(r => `| ${r.lang} | \`${r.key}\` | ${cell(r.reason)} | ${cell(r.value)} |`),
    ]);
  }
}

// Only run main() when invoked directly as a script. When this file is
// imported (e.g. by the test suite), the runtime side stays dormant.
const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch(e => {
    log.error(e.message);
    process.exit(1);
  });
}
