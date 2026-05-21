#!/usr/bin/env node
/**
 * i18n Translator for Cider (powered by Google Gemini)
 *
 * Reads locales/en-US.yml as source and uses Gemini to translate
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
 * Staleness is detected by diffing locales/en-US.yml against the
 * previous commit's version via `git show`. A key whose English
 * value changed is re-translated for every target locale, overriding
 * `source: human` (the human value is for the old English text).
 * The map shape is preserved with `source: ai` so credit isn't lost.
 *
 * Usage:
 *   GEMINI_API_KEY=<key> node scripts/i18n-translate.mjs [options]
 *
 * Options:
 *   --source <path>      Source English YAML (default: locales/en-US.yml)
 *   --out <dir>          Output directory (default: locales)
 *   --languages <path>   Languages file (default: locales/languages.yml)
 *   --lang <codes>       Comma-separated language codes to process
 *                        (default: all from languages.yml, excluding source)
 *   --model <id>         Gemini model ID (default: gemini-3.5-flash)
 *   --batch-size <n>     Strings per API request (default: 60)
 *   --force              Re-translate every key, ignoring existing files
 *   --dry-run            Preview what would be translated without calling the API
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg  = (f, d) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : d; };
const flag = (f) => args.includes(f);

const SOURCE_FILE    = arg('--source',    join(ROOT, 'locales/en-US.yml'));
const OUT_DIR        = arg('--out',       join(ROOT, 'locales'));
const LANGUAGES_FILE = arg('--languages', join(ROOT, 'locales/languages.yml'));
const LANG_OVERRIDE  = arg('--lang',      null);
const GEMINI_MODEL   = arg('--model',     'gemini-3.5-flash');
const BATCH_SIZE     = parseInt(arg('--batch-size', '60'), 10);
const FORCE          = flag('--force');
const DRY_RUN        = flag('--dry-run');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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

function loadLocalTranslation(lang) {
  const p = localFilePath(lang);
  if (!existsSync(p)) return {};
  try { return parseYaml(readFileSync(p, 'utf8')) ?? {}; } catch { return {}; }
}

function saveTranslation(lang, entries) {
  const sortedKeys = Object.keys(entries).sort((a, b) => a.localeCompare(b));
  const sorted = {};
  for (const k of sortedKeys) sorted[k] = entries[k];
  const out = stringifyYaml(sorted, { lineWidth: 0, defaultStringType: 'PLAIN' });
  writeFileSync(localFilePath(lang), out, 'utf8');
}

// ── Source snapshotting (git-backed staleness detection) ─────────────────────
// changedSourceKeys = keys whose English text differs from the previous
// en-US.yml state. `sourceStrings` (read in main) is always the working tree;
// this returns the "before" snapshot to diff it against:
//   - en-US.yml has uncommitted edits → the latest change is local, so
//     "before" is HEAD (covers a dev running the extractor, then this script).
//   - en-US.yml is clean → the latest change IS the HEAD commit (the normal
//     CI case: en-US.yml arrived already committed), so "before" is HEAD~1.
// A missing ref or path (first commit, fresh clone, non-git) falls back to {},
// so every key counts as new.
function loadPreviousSource() {
  const relPath = relative(ROOT, SOURCE_FILE).replace(/\\/g, '/');

  const showAtRef = (ref) => {
    try {
      const out = execSync(`git show ${ref}:${relPath}`, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return parseYaml(out) ?? {};
    } catch {
      return null;
    }
  };

  let workingTreeDirty = false;
  try {
    execSync(`git diff --quiet HEAD -- ${relPath}`, { cwd: ROOT, stdio: 'ignore' });
  } catch {
    // Non-zero exit: en-US.yml differs from HEAD (or there is no HEAD).
    workingTreeDirty = true;
  }

  const before = workingTreeDirty ? showAtRef('HEAD') : showAtRef('HEAD~1');
  return before ?? {};
}

// ── Gemini API ────────────────────────────────────────────────────────────────
async function callGemini(prompt, retries = 3) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');

  // Key goes in a header, NOT the URL query string. Putting it in `?key=...`
  // would expose it via any error path that includes the URL (Node's fetch
  // can attach the URL to error.cause), and via secret scanners watching
  // workflow logs.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, candidateCount: 1 },
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        const wait = 2000 * attempt;
        log.warn(`Rate limited; waiting ${wait / 1000}s before retry ${attempt}/${retries}`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Empty response from Gemini');
      return text;
    } catch (e) {
      if (attempt < retries) {
        log.warn(`  Attempt ${attempt} failed: ${e.message}; retrying…`);
        await sleep(1000 * attempt);
      } else {
        throw e;
      }
    }
  }
}

async function translateBatch(strings, targetLang, targetLangName) {
  const sourceJson = JSON.stringify(strings, null, 2);

  const prompt = `\
You are a professional translator localizing Cider, a premium Apple Music desktop client.
Translate the following UI strings from English to ${targetLangName} (locale: ${targetLang}).

Rules:
- Preserve all placeholders exactly: \${variable}, $VARIABLE, {{ variable }}, {{variable}}
- Do NOT translate proper nouns: Cider, Apple Music, AirPlay, Dolby Atmos, Chromecast, AudioLab
- Keep strings concise. These are UI labels, buttons, notifications, and menu items
- Match Apple Music's tone: clean, professional, and friendly
- Return ONLY a valid JSON object with identical keys and translated string values
- Do not include markdown code fences, explanations, or any text outside the JSON object

English strings:
${sourceJson}`;

  const response = await callGemini(prompt);

  // Strip potential markdown fences
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON object found in Gemini response');

  const parsed = JSON.parse(jsonMatch[0]);

  // Sanity check: warn if more than 10% of keys are missing
  const inputKeys  = Object.keys(strings);
  const missing    = inputKeys.filter(k => typeof parsed[k] !== 'string');
  if (missing.length > inputKeys.length * 0.1) {
    log.warn(`  ${missing.length}/${inputKeys.length} keys missing from translation response`);
  }

  return parsed;
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
function mergeTranslations(existing, translations, changedSourceKeys) {
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
async function main() {
  console.log(`\n${c.bold}Cider i18n Translator${c.reset} ${c.dim}(Google Gemini)${c.reset}\n`);

  if (!GEMINI_API_KEY && !DRY_RUN) {
    log.error('GEMINI_API_KEY environment variable is required');
    log.dim('Set it with:  export GEMINI_API_KEY=your_key_here');
    process.exit(1);
  }

  // Belt-and-braces: tell GitHub Actions to redact the key from any log
  // output. The runner replaces every occurrence with ***. No-op when run
  // locally (the magic string is just text outside Actions).
  if (process.env.GITHUB_ACTIONS && GEMINI_API_KEY) {
    console.log(`::add-mask::${GEMINI_API_KEY}`);
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

  // Diff against the previous committed source to detect changed keys.
  const previousSource = FORCE ? {} : loadPreviousSource();
  const changedSourceKeys = new Set();
  for (const [key, value] of Object.entries(sourceStrings)) {
    if (previousSource[key] !== value) changedSourceKeys.add(key);
  }
  if (FORCE) {
    log.warn('--force: every key will be re-translated');
  } else if (changedSourceKeys.size > 0) {
    log.info(`Changed English keys to re-translate: ${changedSourceKeys.size}`);
  } else {
    log.info('No English changes detected. Only filling missing entries.');
  }

  // Resolve target languages from locales/languages.yml.
  const languageRegistry = loadLanguagesFile();
  let languages;
  if (LANG_OVERRIDE) {
    languages = LANG_OVERRIDE.split(',').map(l => l.trim()).filter(Boolean);
    log.info(`Languages (--lang): ${languages.join(', ')}`);
  } else {
    languages = Object.keys(languageRegistry).filter(
      code => code !== 'en-US' && code !== 'en' && !languageRegistry[code]?.source,
    );
    log.success(`Found ${languages.length} target languages in ${relative(ROOT, LANGUAGES_FILE)}`);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  let totalTranslated = 0;
  let totalSkipped    = 0;
  let totalErrors     = 0;

  for (const lang of languages) {
    if (lang === 'en-US' || lang === 'en') continue;

    const name = langName(lang, languageRegistry);
    console.log(`\n${c.bold}[${lang}]${c.reset} ${c.dim}${name}${c.reset}`);

    const existing = loadLocalTranslation(lang);
    const existingCount = Object.keys(existing).length;

    // Determine which strings need translation:
    //  - missing entirely, or
    //  - English source changed since the last commit, or
    //  - --force
    const toTranslate = {};
    for (const [key, value] of Object.entries(sourceStrings)) {
      if (FORCE) { toTranslate[key] = value; continue; }
      if (!(key in existing)) { toTranslate[key] = value; continue; }
      if (changedSourceKeys.has(key)) { toTranslate[key] = value; continue; }
    }

    const toTranslateCount = Object.keys(toTranslate).length;
    log.info(`Existing: ${existingCount}  ·  To translate: ${toTranslateCount}`);

    if (toTranslateCount === 0) {
      log.success('All strings already translated');
      totalSkipped++;
      continue;
    }

    if (DRY_RUN) {
      const preview = Object.entries(toTranslate).slice(0, 5);
      preview.forEach(([k, v]) => log.dim(`${k}: "${v}"`));
      if (toTranslateCount > 5) log.dim(`… and ${toTranslateCount - 5} more`);
      continue;
    }

    // Translate in batches.
    const batches = chunk(Object.entries(toTranslate), BATCH_SIZE);
    log.step(`Translating ${toTranslateCount} strings in ${batches.length} batch(es)…`);

    const translations = {};
    let batchErrors = 0;

    for (let i = 0; i < batches.length; i++) {
      const batchObj = Object.fromEntries(batches[i]);
      process.stdout.write(`  Batch ${i + 1}/${batches.length}… `);

      try {
        const translated = await translateBatch(batchObj, lang, name);
        const count = Object.keys(translated).length;
        Object.assign(translations, translated);
        console.log(`${c.green}✓${c.reset} (${count} strings)`);
        totalTranslated += count;
      } catch (e) {
        console.log(`${c.red}✗${c.reset}`);
        log.error(`  Batch ${i + 1} failed: ${e.message}`);
        batchErrors++;
        totalErrors++;
      }

      if (i < batches.length - 1) await sleep(400);
    }

    const merged = mergeTranslations(existing, translations, changedSourceKeys);
    saveTranslation(lang, merged);
    log.success(`Saved → locales/${lang}.yml`);
    if (batchErrors > 0) log.warn(`${batchErrors} batch(es) failed and were skipped`);
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log(`\n${c.bold}─── Summary ───────────────────────────────${c.reset}`);
  log.success(`Processed ${languages.length} language(s)`);
  if (!DRY_RUN) {
    if (totalTranslated > 0) log.success(`Translated  ${totalTranslated} string(s)`);
    if (totalSkipped > 0)   log.dim(`Skipped     ${totalSkipped} language(s) (already complete)`);
    if (totalErrors > 0)    log.warn(`Errors      ${totalErrors} batch(es) failed`);
  }
  console.log('');
}

main().catch(e => {
  log.error(e.message);
  process.exit(1);
});
