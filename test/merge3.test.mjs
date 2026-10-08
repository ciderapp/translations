// Tests for the key-level three-way merge a rejected push falls back to,
// and for the fill-state helpers.
//
// Run: `node --test test/`

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mergeLocale3 } from '../scripts/lib/merge3.mjs';
import { englishHash, seedState, isStale } from '../scripts/lib/fill-state.mjs';

const human = (value, by = '@someone') => ({ value, source: 'human', by, issue: 1 });

describe('mergeLocale3', () => {
  test('fill vs apply on the same key: the human side wins, and its stamp follows', () => {
    // The fill (ours) re-translated k because its English changed; meanwhile
    // an issue apply (theirs, already on main) landed a human translation of
    // the new English.
    const r = mergeLocale3({
      base: { k: 'alt' }, ours: { k: 'neu (KI)' }, theirs: { k: human('neu') },
      baseState: { k: 'h-old' }, oursState: { k: 'h-new' }, theirsState: { k: 'h-new' },
    });
    assert.deepEqual(r.locale.k, human('neu'));
    assert.equal(r.state.k, 'h-new');
    assert.deepEqual(r.conflicts, ['k']);
  });

  test('the human side wins when it is ours, too', () => {
    const r = mergeLocale3({
      base: { k: 'alt' }, ours: { k: human('neu') }, theirs: { k: 'neu (KI)' },
      oursState: { k: 'h-human' }, theirsState: { k: 'h-ai' },
    });
    assert.deepEqual(r.locale.k, human('neu'));
    assert.equal(r.state.k, 'h-human');
  });

  test('two AI values: theirs (already on main) wins', () => {
    const r = mergeLocale3({
      base: { k: 'a' }, ours: { k: 'b' }, theirs: { k: 'c' },
      oursState: { k: 'hb' }, theirsState: { k: 'hc' },
    });
    assert.equal(r.locale.k, 'c');
    assert.equal(r.state.k, 'hc');
  });

  test('keys only one side touched take that side', () => {
    const r = mergeLocale3({
      base: { a: '1', b: '1' }, ours: { a: '2', b: '1', n: 'new' }, theirs: { a: '1', b: '3' },
      baseState: { a: 'x', b: 'x' }, oursState: { a: 'y', b: 'x', n: 'z' }, theirsState: { a: 'x', b: 'w' },
    });
    assert.deepEqual(r.locale, { a: '2', b: '3', n: 'new' });
    assert.deepEqual(r.state, { a: 'y', b: 'w', n: 'z' });
    assert.deepEqual(r.conflicts, []);
  });

  test('a deletion on one side (prune) is kept', () => {
    const r = mergeLocale3({
      base: { 'mobile.old': 'x', k: 'v' }, ours: { k: 'v' }, theirs: { 'mobile.old': 'x', k: 'v' },
      baseState: { 'mobile.old': 'h', k: 'h' }, oursState: { k: 'h' }, theirsState: { 'mobile.old': 'h', k: 'h' },
    });
    assert.deepEqual(r.locale, { k: 'v' });
    assert.deepEqual(r.state, { k: 'h' });
  });

  test('a stamp-only change (seeding) survives when values are unchanged', () => {
    const r = mergeLocale3({
      base: { k: 'v' }, ours: { k: 'v' }, theirs: { k: 'v' },
      baseState: {}, oursState: { k: 'seed' }, theirsState: {},
    });
    assert.equal(r.state.k, 'seed');
  });

  test('map key order does not count as a change', () => {
    const a = { value: 'x', source: 'human', by: '@a', issue: 1 };
    const b = { issue: 1, by: '@a', source: 'human', value: 'x' };
    const r = mergeLocale3({ base: { k: a }, ours: { k: b }, theirs: { k: 'y' } });
    assert.equal(r.locale.k, 'y');
    assert.deepEqual(r.conflicts, []);
  });
});

describe('fill state', () => {
  test('a key is stale when missing, unstamped, or stamped with other English', () => {
    const locale = { a: 'A', b: 'B', c: 'C' };
    const state = { a: englishHash('Apple'), b: englishHash('Banana (old)') };
    assert.equal(isStale('a', 'Apple', locale, state), false);
    assert.equal(isStale('b', 'Banana', locale, state), true);
    assert.equal(isStale('c', 'Cherry', locale, state), true);
    assert.equal(isStale('d', 'Date', locale, state), true);
  });

  test('seeding stamps what the seed source knows and skips orphans', () => {
    const state = seedState({ a: 'A', orphan: 'O' }, { a: 'Apple' });
    assert.deepEqual(state, { a: englishHash('Apple') });
  });
});
