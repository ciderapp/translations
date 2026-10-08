// Tests for the ICU checks used on Cider for Android's strings.
//
// Run: `node --test test/`

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  icuArguments, compareIcu, acceptableIcu, isBorrowableEnglish, pluralCategories,
} from '../scripts/lib/icu.mjs';

describe('icuArguments', () => {
  test('finds simple, plural and nested arguments, not #', () => {
    assert.deepEqual([...icuArguments('Added to {playlist}').args], ['playlist']);
    const r = icuArguments('{count, plural, one {# song in {where}} other {# songs}}');
    assert.deepEqual([...r.args].sort(), ['count', 'where']);
  });

  test('reports a parse error instead of throwing', () => {
    assert.ok(icuArguments('{count, plural, one {# song} other {# songs}').error);
    assert.ok(icuArguments('{{count}} tracks').error);
  });

  test('treats tags as text, like ICU4J', () => {
    assert.deepEqual([...icuArguments('Tap <b>{name}</b>').args], ['name']);
    assert.equal(icuArguments('Line<br>break').error, undefined);
  });
});

describe('apostrophes (ICU DOUBLE_OPTIONAL, as android.icu)', () => {
  test("an apostrophe before { quotes the placeholder away", () => {
    assert.deepEqual([...icuArguments("Ajouté à l'{playlist}").args], []);
    assert.deepEqual([...icuArguments('Ajouté à l’{playlist}').args], ['playlist']);
  });

  test("an ordinary apostrophe is just text", () => {
    assert.equal(icuArguments("Don't stop").error, undefined);
    assert.deepEqual([...icuArguments("It''s {n}").args], ['n']);
  });

  test('compareIcu flags the quoted placeholder as dropped', () => {
    const r = compareIcu('Added to {playlist}', "Ajouté à l'{playlist}");
    assert.equal(r.error, null);
    assert.deepEqual(r.dropped, ['playlist']);
    assert.equal(acceptableIcu('Added to {playlist}', "Ajouté à l'{playlist}"), false);
    assert.equal(acceptableIcu('Added to {playlist}', 'Ajouté à l’{playlist}'), true);
  });
});

describe('compareIcu', () => {
  const en = '{count, plural, one {# song} other {# songs}}';

  test('accepts a translation with more plural categories', () => {
    assert.equal(acceptableIcu(en, '{count, plural, one {# utwór} few {# utwory} many {# utworów} other {# utworu}}'), true);
  });

  test('an invented argument is unknown', () => {
    assert.deepEqual(compareIcu('Added to {playlist}', 'Zu {liste} hinzugefügt').unknown, ['liste']);
  });

  test('a renamed plural argument is unknown and the original dropped', () => {
    const r = compareIcu(en, '{anzahl, plural, one {# Lied} other {# Lieder}}');
    assert.deepEqual(r.unknown, ['anzahl']);
    assert.deepEqual(r.dropped, ['count']);
  });

  test('a plural without other does not parse', () => {
    assert.ok(compareIcu(en, '{count, plural, one {# chanson}}').error);
  });
});

describe('isBorrowableEnglish', () => {
  test('plain strings and single-brace placeholders can be borrowed', () => {
    assert.equal(isBorrowableEnglish('Add to Library'), true);
    assert.equal(isBorrowableEnglish('Added to {playlist}'), true);
    assert.equal(isBorrowableEnglish("Don't show again"), true);
  });

  test('mustache, template and quoted placeholders cannot', () => {
    assert.equal(isBorrowableEnglish('{{count}} track(s)'), false);
    assert.equal(isBorrowableEnglish('{{ count }} Genre(s)'), false);
    assert.equal(isBorrowableEnglish('Hi ${name}'), false);
    assert.equal(isBorrowableEnglish("'{songName}' is already in your '{playlist}' playlist."), false);
  });
});

describe('pluralCategories', () => {
  test('CLDR categories per language', () => {
    assert.deepEqual(pluralCategories('pl'), ['few', 'many', 'one', 'other']);
    assert.deepEqual(pluralCategories('ja'), ['other']);
  });
});
