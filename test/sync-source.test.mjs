// Tests for the owner-scoped en-US sync and the ownership rules.
//
// Run: `node --test test/`

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';

import { syncSource, checkBorrowed, normalizeBorrowed } from '../scripts/i18n-sync-source.mjs';
import { parseOwners, loadOwners, ownerOf } from '../scripts/lib/owners.mjs';
import { stringifySource } from '../scripts/lib/source-yaml.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const owners = loadOwners(join(ROOT, 'i18n/owners.yml'));
const android = owners.find(o => o.name === 'android');
const citadel = owners.find(o => o.name === 'citadel');

describe('owners', () => {
  test('mobile.* is Android, everything else is Citadel', () => {
    assert.equal(ownerOf('mobile.queue.playNext', owners).name, 'android');
    assert.equal(ownerOf('action.playNext', owners).name, 'citadel');
    assert.equal(ownerOf('client.boot.title', owners).name, 'citadel');
    // A desktop key that merely contains "mobile" is still desktop's.
    assert.equal(ownerOf('settings.mobile.remote', owners).name, 'citadel');
  });

  test('Android keys must be plain segments so . to _ is reversible', () => {
    assert.ok(android.keyPattern.test('mobile.library.songCount'));
    assert.ok(!android.keyPattern.test('mobile.library.song_count'));
    assert.ok(!android.keyPattern.test('mobile.library.song-count'));
    assert.ok(!android.keyPattern.test('mobile'));
  });

  test('rejects zero or two defaults, and overlapping prefixes', () => {
    assert.throws(() => parseOwners({ owners: { a: { prefixes: ['a.'] } } }), /default/);
    assert.throws(() => parseOwners({ owners: { a: { default: true }, b: { default: true } } }), /default/);
    assert.throws(() => parseOwners({
      owners: { a: { default: true }, b: { prefixes: ['mobile.'] }, c: { prefixes: ['mobile.x.'] } },
    }), /overlaps/);
  });

  test('no owners file means one desktop owner for everything', () => {
    const solo = loadOwners(join(ROOT, 'does-not-exist.yml'));
    assert.equal(solo.length, 1);
    assert.equal(ownerOf('mobile.anything', solo).isDefault, true);
  });
});

describe('syncSource', () => {
  const current = {
    'action.play': 'Play',
    'action.pause': 'Pause',
    'mobile.queue.playNext': 'Play next',
    'mobile.queue.clear': 'Clear',
  };

  test("Citadel's sync keeps Android's keys", () => {
    const source = { 'action.play': 'Play', 'action.stop': 'Stop' };
    const { result, added, removed, errors } = syncSource({ current, source, owner: citadel, owners });
    assert.deepEqual(errors, []);
    assert.equal(result['mobile.queue.playNext'], 'Play next');
    assert.equal(result['mobile.queue.clear'], 'Clear');
    assert.equal(result['action.stop'], 'Stop');
    assert.equal('action.pause' in result, false);
    assert.deepEqual(added, ['action.stop']);
    assert.deepEqual(removed, ['action.pause']);
  });

  test("Android's sync keeps Citadel's keys and drops its own removed ones", () => {
    const source = { 'mobile.queue.playNext': 'Play next', 'mobile.library.songCount': '{count, plural, one {# song} other {# songs}}' };
    const { result, added, removed, changed, errors } = syncSource({ current, source, owner: android, owners });
    assert.deepEqual(errors, []);
    assert.equal(result['action.play'], 'Play');
    assert.equal(result['action.pause'], 'Pause');
    assert.equal('mobile.queue.clear' in result, false);
    assert.deepEqual(added, ['mobile.library.songCount']);
    assert.deepEqual(removed, ['mobile.queue.clear']);
    assert.deepEqual(changed, []);
  });

  test('the two syncs commute', () => {
    const fromCitadel = { 'action.play': 'Play!', 'action.new': 'New' };
    const fromAndroid = { 'mobile.queue.playNext': 'Play Next', 'mobile.added': 'Added' };
    const a = syncSource({ current: syncSource({ current, source: fromCitadel, owner: citadel, owners }).result,
      source: fromAndroid, owner: android, owners }).result;
    const b = syncSource({ current: syncSource({ current, source: fromAndroid, owner: android, owners }).result,
      source: fromCitadel, owner: citadel, owners }).result;
    assert.equal(stringifySource(a), stringifySource(b));
  });

  test('an owner may not write another owner\'s keys', () => {
    const { result, errors } = syncSource({ current, source: { 'mobile.sneaky': 'x' }, owner: citadel, owners });
    assert.equal(result, null);
    assert.match(errors[0], /belongs to android/);
    const r2 = syncSource({ current, source: { 'action.sneaky': 'x' }, owner: android, owners });
    assert.match(r2.errors[0], /belongs to citadel/);
  });

  test('Android keys must match the strict key pattern', () => {
    const { errors } = syncSource({ current, source: { 'mobile.song_count': 'x' }, owner: android, owners });
    assert.match(errors[0], /key pattern/);
  });

  test('Android values must parse as ICU', () => {
    const { errors } = syncSource({
      current, source: { 'mobile.library.songCount': '{count, plural, one {# song} other {# songs}' },
      owner: android, owners,
    });
    assert.match(errors[0], /not valid ICU/);
  });

  test('Citadel values are not held to ICU', () => {
    const { errors } = syncSource({ current, source: { 'party.full': '{{count}} track(s)' }, owner: citadel, owners });
    assert.deepEqual(errors, []);
  });
});

describe('borrowed keys', () => {
  const english = {
    'action.addToLibrary': 'Add to Library',
    'action.addToPlaylist.duplicateOne': "'{songName}' is already in your '{playlist}' playlist.",
    'party.full': '{{count}} track(s) were not added.',
    'mobile.queue.playNext': 'Play next',
  };

  test('accepts a map of key: inline English, or a list', () => {
    assert.deepEqual(normalizeBorrowed({ 'action.addToLibrary': 'Add to Library' }), ['action.addToLibrary']);
    assert.deepEqual(normalizeBorrowed(['a.b', 3]), ['a.b']);
  });

  test('warns on missing and on ICU-unsafe desktop strings, errors on own keys', () => {
    const { errors, warnings } = checkBorrowed({
      keys: ['action.addToLibrary', 'action.addToPlaylist.duplicateOne', 'party.full', 'action.gone', 'mobile.queue.playNext'],
      owner: android, owners, english,
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /mobile\.queue\.playNext/);
    assert.equal(warnings.length, 3);
    assert.ok(warnings.some(w => w.startsWith('action.gone')));
    assert.ok(warnings.some(w => w.startsWith('action.addToPlaylist.duplicateOne')));
    assert.ok(warnings.some(w => w.startsWith('party.full')));
  });
});

describe('en-US.yml writer', () => {
  test('round-trips the committed en-US.yml byte for byte', () => {
    // Both mirrors decide "nothing to sync" by diffing this file. If the
    // writer reformatted it, every sync would commit a reformat.
    const original = readFileSync(join(ROOT, 'locales/en-US.yml'), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(stringifySource(parseYaml(original)), original);
  });

  test('quotes YAML 1.1 booleans', () => {
    assert.equal(stringifySource({ 'term.on': 'On', 'term.ok': 'OK' }), 'term.ok: OK\nterm.on: "On"\n');
  });
});
