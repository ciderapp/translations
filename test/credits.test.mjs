// Tests for the credits/badge generator.
//
// Run: `node --test test/`  (requires Node 22+)
//
// Imports the generator's pure functions and exercises them against
// synthetic locale data. File I/O lives in main(), which is not imported.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateCredits,
  badgeJson,
  langDisplayName,
  renderTranslatorsTable,
  replaceBetweenMarkers,
  HANDLE_RE,
  MARKER_START,
  MARKER_END,
} from '../scripts/update-credits.mjs';

const REGISTRY = {
  fr:      { name: 'French', native: 'Français' },
  tr:      { name: 'Turkish', native: 'Türkçe' },
  'zh-CN': { name: 'Chinese (Simplified)', native: '简体中文' },
};

// ── Aggregation ─────────────────────────────────────────────────────────────
describe('aggregateCredits', () => {
  test('credits map entries with by:, ignores scalars', () => {
    const credits = aggregateCredits({
      fr: {
        'action.apply': 'Appliquer', // scalar = AI, no credit
        'action.back': { value: 'Retour', source: 'human', by: '@lumaa-dev', issue: 4 },
      },
    });
    assert.equal(credits.size, 1);
    assert.deepEqual([...credits.get('lumaa-dev').locales], ['fr']);
    assert.equal(credits.get('lumaa-dev').entries, 1);
  });

  test('superseded entries (source: ai) with by: still count', () => {
    const credits = aggregateCredits({
      ru: {
        'a.b': { value: 'x', source: 'ai', superseded_at: '2026-06-01', by: '@kinlay0', issue: 9 },
      },
    });
    assert.equal(credits.get('kinlay0').entries, 1);
  });

  test('aggregates one handle across several locales', () => {
    const credits = aggregateCredits({
      fr: { 'a.b': { value: 'x', source: 'human', by: '@dual', issue: 1 } },
      tr: {
        'a.b': { value: 'y', source: 'human', by: '@dual', issue: 2 },
        'c.d': { value: 'z', source: 'human', by: '@dual', issue: 2 },
      },
    });
    assert.equal(credits.size, 1);
    assert.deepEqual([...credits.get('dual').locales].sort(), ['fr', 'tr']);
    assert.equal(credits.get('dual').entries, 3);
  });

  test('strips the leading @ and accepts bare handles', () => {
    const credits = aggregateCredits({
      fr: {
        'a.b': { value: 'x', source: 'human', by: '@with-at', issue: 1 },
        'c.d': { value: 'y', source: 'human', by: 'bare', issue: 2 },
      },
    });
    assert.ok(credits.has('with-at'));
    assert.ok(credits.has('bare'));
  });

  test('skips malformed by: values instead of rendering them', () => {
    const credits = aggregateCredits({
      fr: {
        'a.b': { value: 'x', source: 'human', by: '@[markdown](https://evil)', issue: 1 },
        'c.d': { value: 'y', source: 'human', by: '', issue: 2 },
        'e.f': { value: 'z', source: 'human', by: '@-leading-hyphen', issue: 3 },
        'g.h': { value: 'w', source: 'human', by: 42, issue: 4 },
      },
    });
    assert.equal(credits.size, 0);
  });

  test('ignores null/non-object locale maps and entries', () => {
    const credits = aggregateCredits({ fr: null, tr: { 'a.b': null, 'c.d': 7 } });
    assert.equal(credits.size, 0);
  });
});

// ── HANDLE_RE ───────────────────────────────────────────────────────────────
describe('HANDLE_RE', () => {
  test('accepts realistic GitHub logins', () => {
    for (const h of ['MP-K', 'lumaa-dev', 'a', 'x'.repeat(39)]) {
      assert.ok(HANDLE_RE.test(h), h);
    }
  });
  test('rejects over-long and malformed logins', () => {
    for (const h of ['x'.repeat(40), '-lead', 'spa ce', 'semi;colon', '']) {
      assert.ok(!HANDLE_RE.test(h), h);
    }
  });
});

// ── Badge JSON ──────────────────────────────────────────────────────────────
describe('badgeJson', () => {
  test('matches the shields endpoint schema, message stringified', () => {
    assert.deepEqual(badgeJson('Translators', 10), {
      schemaVersion: 1,
      label: 'Translators',
      message: '10',
      color: 'blue',
    });
  });
});

// ── Display names ───────────────────────────────────────────────────────────
describe('langDisplayName', () => {
  test('prefers the registry name', () => {
    assert.equal(langDisplayName('zh-CN', REGISTRY), 'Chinese (Simplified)');
  });
  test('falls back to the base-code registry entry', () => {
    assert.equal(langDisplayName('fr-CA', REGISTRY), 'French');
  });
  test('falls back to Intl for codes missing from the registry', () => {
    assert.equal(langDisplayName('hr', REGISTRY), 'Croatian');
    assert.equal(langDisplayName('et', REGISTRY), 'Estonian');
  });
  test('returns the raw code when nothing resolves', () => {
    assert.equal(langDisplayName('zzz', REGISTRY), 'zzz');
  });
});

// ── Table rendering ─────────────────────────────────────────────────────────
describe('renderTranslatorsTable', () => {
  const credits = aggregateCredits({
    fr: { 'a.b': { value: 'x', source: 'human', by: '@beta', issue: 1 } },
    tr: {
      'a.b': { value: 'y', source: 'human', by: '@Alpha', issue: 2 },
      'c.d': { value: 'z', source: 'human', by: '@gamma', issue: 3 },
      'e.f': { value: 'w', source: 'human', by: '@gamma', issue: 3 },
    },
    'zh-CN': { 'a.b': { value: 'v', source: 'human', by: '@gamma', issue: 4 } },
  });

  test('sorts by entry count desc, then handle case-insensitively', () => {
    const rows = renderTranslatorsTable(credits, REGISTRY).split('\n').slice(2);
    assert.match(rows[0], /@gamma/);   // 3 entries
    assert.match(rows[1], /@Alpha/);   // 1 entry, 'alpha' < 'beta'
    assert.match(rows[2], /@beta/);
  });

  test('links handles and lists display names alphabetically', () => {
    const table = renderTranslatorsTable(credits, REGISTRY);
    assert.match(table, /\[@gamma\]\(https:\/\/github\.com\/gamma\)/);
    assert.match(table, /Chinese \(Simplified\), Turkish/);
  });

  test('renders only the header for empty credits', () => {
    const table = renderTranslatorsTable(new Map(), REGISTRY);
    assert.equal(table.split('\n').length, 2);
  });
});

// ── Marker replacement ──────────────────────────────────────────────────────
describe('replaceBetweenMarkers', () => {
  const doc = `intro\n\n${MARKER_START}\nold table\n${MARKER_END}\n\noutro\n`;

  test('replaces the content and keeps both markers', () => {
    const out = replaceBetweenMarkers(doc, 'NEW');
    assert.equal(out, `intro\n\n${MARKER_START}\nNEW\n${MARKER_END}\n\noutro\n`);
  });

  test('is idempotent: applying twice equals applying once', () => {
    const once  = replaceBetweenMarkers(doc, 'NEW');
    const twice = replaceBetweenMarkers(once, 'NEW');
    assert.equal(once, twice);
  });

  test('returns null when a marker is missing', () => {
    assert.equal(replaceBetweenMarkers('no markers here', 'NEW'), null);
    assert.equal(replaceBetweenMarkers(`only ${MARKER_START}`, 'NEW'), null);
  });

  test('returns null when markers are out of order', () => {
    assert.equal(replaceBetweenMarkers(`${MARKER_END}\n${MARKER_START}`, 'NEW'), null);
  });
});
