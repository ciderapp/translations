// Tests for the issue linter's ICU checks (Cider for Android keys) and for the
// fill-state stamp an apply leaves behind.
//
// Run: `node --test test/`

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateTranslations, stampApplied } from '../scripts/lint-translation-issue.mjs';
import { englishHash } from '../scripts/lib/fill-state.mjs';

const source = {
  'mobile.library.songCount': '{count, plural, one {# song} other {# songs}}',
  'mobile.playlist.addedTo': 'Added to {playlist}',
  'action.addedTo': 'Added to {playlist}',
};
const isIcuKey = (k) => k.startsWith('mobile.');

describe('validateTranslations with ICU keys', () => {
  test('a valid plural with the language\'s own categories passes cleanly', () => {
    const { errors, warnings } = validateTranslations({
      'mobile.library.songCount': '{count, plural, one {# utwór} few {# utwory} many {# utworów} other {# utworu}}',
    }, source, { isIcuKey });
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  });

  test('an unbalanced plural is an error', () => {
    const { errors } = validateTranslations({
      'mobile.library.songCount': '{count, plural, one {# chanson} other {# chansons}',
    }, source, { isIcuKey });
    assert.match(errors[0], /not valid ICU/);
  });

  test("a straight apostrophe before the placeholder is an error that says what to do", () => {
    const { errors } = validateTranslations({ 'mobile.playlist.addedTo': "Ajouté à l'{playlist}" }, source, { isIcuKey });
    assert.match(errors[0], /typographic apostrophe/);
    const ok = validateTranslations({ 'mobile.playlist.addedTo': 'Ajouté à l’{playlist}' }, source, { isIcuKey });
    assert.deepEqual(ok.errors, []);
  });

  test('a renamed argument is an error; a dropped one is only a warning', () => {
    const renamed = validateTranslations({ 'mobile.playlist.addedTo': 'Zu {liste} hinzugefügt' }, source, { isIcuKey });
    assert.match(renamed.errors[0], /\{liste\}/);
    const dropped = validateTranslations({ 'mobile.playlist.addedTo': 'Hinzugefügt' }, source, { isIcuKey });
    assert.deepEqual(dropped.errors, []);
    assert.match(dropped.warnings[0], /drops the `\{playlist\}`/);
  });

  test('desktop keys keep the old, lenient placeholder check', () => {
    const { errors } = validateTranslations({ 'action.addedTo': "Ajouté à l'{playlist}" }, source, { isIcuKey });
    assert.deepEqual(errors, []);
  });
});

describe('stampApplied', () => {
  test('stamps applied keys with the English as of the issue', () => {
    const next = stampApplied({
      state: { other: 'x' },
      existingLocale: {},
      keys: ['k'],
      sourceStrings: { k: 'New English' },
      englishThen: () => ({ k: 'Old English' }),
    });
    assert.equal(next.k, englishHash('Old English'));
    assert.equal(next.other, 'x');
  });

  test('a key that did not exist yet when the issue was opened takes the current English', () => {
    const next = stampApplied({
      state: {}, existingLocale: {}, keys: ['k'], sourceStrings: { k: 'Now' }, englishThen: () => ({}),
    });
    assert.equal(next.k, englishHash('Now'));
  });

  test('a locale without state is seeded before stamping, so the rest is not re-translated', () => {
    const next = stampApplied({
      state: null,
      existingLocale: { a: 'A', b: 'B' },
      keys: ['b'],
      sourceStrings: { a: 'Apple', b: 'Banana' },
      seedSource: () => ({ a: 'Apple', b: 'Banana (old)' }),
      englishThen: () => ({ b: 'Banana' }),
    });
    assert.deepEqual(next, { a: englishHash('Apple'), b: englishHash('Banana') });
  });
});
