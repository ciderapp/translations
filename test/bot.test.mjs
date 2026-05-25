// Tests for the translation issue bot.
//
// Run: `node --test test/`  (requires Node 22+)
//
// Imports the bot's pure functions and exercises them against synthetic
// issue bodies and adversarial inputs. Anything that touches the GitHub API
// or the filesystem is tested separately (or not at all) since those paths
// go through `main()` which we don't import here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseIssueBody,
  extractLanguage,
  extractTranslations,
  extractPlaceholders,
  validateTranslations,
  PROPER_NOUNS,
  KEY_RE,
  LANG_RE,
  AUTHOR_RE,
  MAX_TRANSLATIONS,
  MAX_VALUE_LENGTH,
} from '../scripts/lint-translation-issue.mjs';

// ── Issue body parser ───────────────────────────────────────────────────────
describe('parseIssueBody', () => {
  const standardBody = [
    '### Language code',
    '',
    'es',
    '',
    '### Translations',
    '',
    '```yaml',
    'action.apply: Aplicar',
    'action.back: Atrás',
    '```',
    '',
    '### Notes (optional)',
    '',
    '_No response_',
  ].join('\n');

  test('extracts three sections from a standard form submission', () => {
    const r = parseIssueBody(standardBody);
    assert.equal(r.language, 'es');
    assert.match(r.translations, /action\.apply: Aplicar/);
    assert.equal(r.notes, '_No response_');
  });

  test('survives CRLF line endings', () => {
    const r = parseIssueBody(standardBody.replace(/\n/g, '\r\n'));
    assert.equal(r.language, 'es');
    assert.match(r.translations, /Aplicar/);
  });

  test('ignores preamble before first heading', () => {
    const withPreamble = `Some intro\n\nthat the user typed\n\n${standardBody}`;
    const r = parseIssueBody(withPreamble);
    assert.equal(r.language, 'es');
  });

  test('returns empty object on empty body', () => {
    assert.deepEqual(parseIssueBody(''), {});
  });

  test('maps "Notes (optional)" label to `notes` key', () => {
    const r = parseIssueBody(standardBody);
    assert.ok('notes' in r);
    assert.ok(!('notes-(optional)' in r));
  });
});

// ── Language extraction ─────────────────────────────────────────────────────
describe('extractLanguage', () => {
  test('returns the trimmed code', () => {
    assert.equal(extractLanguage({ language: 'es' }), 'es');
    assert.equal(extractLanguage({ language: '  pt-BR  ' }), 'pt-BR');
  });

  test('strips backticks and quotes contributors add anyway', () => {
    assert.equal(extractLanguage({ language: '`es`' }), 'es');
    assert.equal(extractLanguage({ language: '"es"' }), 'es');
  });

  test('returns null for missing or _No response_', () => {
    assert.equal(extractLanguage({}), null);
    assert.equal(extractLanguage({ language: '_No response_' }), null);
    assert.equal(extractLanguage({ language: '' }), null);
  });

  test('takes only the first line if the user pasted extra', () => {
    assert.equal(extractLanguage({ language: 'es\nextra junk here' }), 'es');
  });
});

// ── Translations extraction ─────────────────────────────────────────────────
describe('extractTranslations', () => {
  test('strips ```yaml ... ``` fences', () => {
    const r = extractTranslations({ translations: '```yaml\naction.apply: Aplicar\n```' });
    assert.deepEqual(r, { 'action.apply': 'Aplicar' });
  });

  test('accepts a bare YAML block without fences', () => {
    const r = extractTranslations({ translations: 'action.apply: Aplicar' });
    assert.deepEqual(r, { 'action.apply': 'Aplicar' });
  });

  test('reports an error object on invalid YAML', () => {
    const r = extractTranslations({ translations: '```yaml\nthis: is: not: valid\n```' });
    assert.ok(r.__error, 'expected __error field');
  });

  test('reports an error on missing field', () => {
    assert.ok(extractTranslations({}).__error);
    assert.ok(extractTranslations({ translations: '_No response_' }).__error);
  });

  test('preserves unicode and placeholders', () => {
    const r = extractTranslations({
      translations: "smartPlaylist.building.analyzing: 'Analizando flujo ({done}/{total})…'",
    });
    assert.equal(r['smartPlaylist.building.analyzing'], 'Analizando flujo ({done}/{total})…');
  });
});

// ── Security regex gates ────────────────────────────────────────────────────
describe('KEY_RE — translation key shape', () => {
  test('accepts well-formed dot-separated keys', () => {
    for (const k of [
      'action.apply',
      'settings.connectivity.scrobbler.cleanLive',
      'home.greeting.morning',
      'smartPlaylist.builder.advancedHintLead',
    ]) {
      assert.ok(KEY_RE.test(k), `should accept: ${k}`);
    }
  });

  test('accepts hyphens and underscores in segment bodies (legacy keys)', () => {
    // Real keys in en-US.yml that pre-date the lowerCamelCase convention.
    // Each segment still starts with a letter; the body widens to include
    // `-` and `_` so contributors can submit translations for them.
    for (const k of [
      'settings.notyf.updateCider.update-downloaded',
      'settings.option.audio.atmosphereRealizerMode.E168_1',
      'settings.option.audio.atmosphereRealizerMode.NATURAL_PLUS',
      'a.b-c_d',
    ]) {
      assert.ok(KEY_RE.test(k), `should accept: ${k}`);
    }
  });

  test('rejects prototype-pollution attacks', () => {
    for (const k of ['__proto__', 'constructor', 'prototype', '__proto__.polluted']) {
      assert.ok(!KEY_RE.test(k), `should reject: ${k}`);
    }
  });

  test('rejects path-traversal-style keys', () => {
    for (const k of ['../etc/passwd', '..', './foo', 'foo/bar', 'foo\\bar']) {
      assert.ok(!KEY_RE.test(k), `should reject: ${k}`);
    }
  });

  test('rejects single-segment, leading-dot, trailing-dot, and empty', () => {
    for (const k of ['action', '.action.apply', 'action.apply.', '', ' ', 'foo..bar']) {
      assert.ok(!KEY_RE.test(k), `should reject: ${k}`);
    }
  });
});

describe('LANG_RE — locale code shape', () => {
  test('accepts BCP-47 codes from the supported list', () => {
    for (const c of ['cs', 'de', 'es', 'es-419', 'pt-BR', 'zh-CN', 'sv-SE', 'fr-CA']) {
      assert.ok(LANG_RE.test(c), `should accept: ${c}`);
    }
  });

  test('blocks path traversal and shell metacharacters', () => {
    for (const c of [
      '../etc',
      'en/../etc',
      'en;rm -rf',
      'en$RM',
      'en US',
      'en\nUS',
      'EN-US',       // uppercase primary
      'es-419-extra' // too many subtags
    ]) {
      assert.ok(!LANG_RE.test(c), `should reject: ${c}`);
    }
  });
});

describe('AUTHOR_RE — GitHub handle shape', () => {
  test('accepts realistic handles', () => {
    for (const h of ['cryptofyre', 'cider-bot', 'JaneDoe', 'a', 'A1', 'user-with-dashes']) {
      assert.ok(AUTHOR_RE.test(h), `should accept: ${h}`);
    }
  });

  test('rejects markdown-injection attempts', () => {
    for (const h of [
      '@evil',
      'evil[ping](https://evil)',
      'evil_underscore',
      '-leadingdash',
      'evil/path',
      '',
    ]) {
      assert.ok(!AUTHOR_RE.test(h), `should reject: ${h}`);
    }
  });
});

// ── Placeholder extractor ───────────────────────────────────────────────────
describe('extractPlaceholders', () => {
  test('catches mustache (spaced and tight)', () => {
    assert.deepEqual([...extractPlaceholders('Hello {{ name }}, you have {{count}} messages')].sort(),
      ['{{ name }}', '{{count}}'].sort());
  });

  test('catches dollar-brace and bare-dollar uppercase', () => {
    const found = [...extractPlaceholders('Hi ${user}, see $LOG_DIR')];
    assert.ok(found.includes('${user}'));
    assert.ok(found.includes('$LOG_DIR'));
  });

  test('catches single-brace tokens', () => {
    const found = [...extractPlaceholders('Loading {n} of {total} ({done})')];
    assert.deepEqual(found.sort(), ['{done}', '{n}', '{total}']);
  });

  test('does not extract literal braces with spaces inside (single brace)', () => {
    // `{ count }` should not match the single-brace form (spaces forbidden);
    // mustache form requires double braces.
    const found = [...extractPlaceholders('{ count }')];
    assert.deepEqual(found, []);
  });

  test('returns a Set (deduplicates repeated placeholders)', () => {
    const result = extractPlaceholders('{n} plus {n} equals 2{n}');
    assert.ok(result instanceof Set);
    assert.equal(result.size, 1);
  });
});

// ── Validation pipeline ────────────────────────────────────────────────────
describe('validateTranslations', () => {
  const source = {
    'action.apply': 'Apply',
    'action.back': 'Back',
    'home.greeting': 'Hello {name}, you have {count} messages',
    'with.brand': 'Open in Apple Music',
  };

  test('passes a well-formed contribution', () => {
    const { errors, warnings } = validateTranslations({
      'action.apply': 'Aplicar',
      'action.back': 'Atrás',
    }, source);
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 0);
  });

  test('flags missing placeholders', () => {
    const { errors } = validateTranslations({
      'home.greeting': 'Hola, tienes mensajes',  // both {name} and {count} dropped
    }, source);
    assert.ok(errors.some(e => e.includes('{name}')));
    assert.ok(errors.some(e => e.includes('{count}')));
  });

  test('flags empty values', () => {
    const { errors } = validateTranslations({
      'action.apply': '   ',
    }, source);
    assert.ok(errors.some(e => e.includes('empty')));
  });

  test('flags non-string values', () => {
    const { errors } = validateTranslations({
      'action.apply': 42,
    }, source);
    assert.ok(errors.some(e => e.includes('must be a string')));
  });

  test('flags unknown keys', () => {
    const { errors } = validateTranslations({
      'not.a.real.key': 'whatever',
    }, source);
    assert.ok(errors.some(e => e.includes('not a known key')));
  });

  test('Object.hasOwn defense: prototype chain keys are flagged unknown', () => {
    // Confirm we never let __proto__ slip through as a "known" key. (Even
    // before this defense KEY_RE would have rejected it, so this is a
    // belt-and-braces check.)
    const { errors } = validateTranslations({
      '__proto__': 'polluted',
    }, source);
    assert.ok(errors.length > 0);
  });

  test('rejects malformed key shapes (KEY_RE)', () => {
    const { errors } = validateTranslations({
      'action': 'Apply (single segment)',
      '../etc/passwd': 'traversal',
    }, source);
    assert.ok(errors.some(e => e.includes('not a valid key shape')));
  });

  test('flags too-many-translations as a single error', () => {
    const bulk = {};
    for (let i = 0; i < MAX_TRANSLATIONS + 1; i++) bulk[`stress.k${i}`] = 'v';
    const { errors } = validateTranslations(bulk, source);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('Too many'));
  });

  test('flags too-long values', () => {
    const huge = 'x'.repeat(MAX_VALUE_LENGTH + 1);
    const { errors } = validateTranslations({ 'action.apply': huge }, source);
    assert.ok(errors.some(e => e.includes('too long')));
  });

  test('warns (not errors) on missing proper nouns', () => {
    const { errors, warnings } = validateTranslations({
      'with.brand': 'Abrir en Música Manzana',  // "Apple Music" translated
    }, source);
    assert.equal(errors.length, 0);
    assert.ok(warnings.length > 0);
    assert.ok(warnings.some(w => w.includes('Apple Music')));
  });
});

// ── Sanity check on PROPER_NOUNS export ─────────────────────────────────────
describe('PROPER_NOUNS', () => {
  test('includes the core brand names', () => {
    for (const n of ['Cider', 'Apple Music', 'AirPlay']) {
      assert.ok(PROPER_NOUNS.includes(n), `expected to be in PROPER_NOUNS: ${n}`);
    }
  });
});
