// Guards against the two events that superseded most human translations:
// a sync that dropped keys for a few hours (2026-07-08) and a case-only
// English edit (2026-10-16).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { planLocale, mergeTranslations } from '../scripts/i18n-translate.mjs';
import { loadOwners } from '../scripts/lib/owners.mjs';
import { englishHash, looseEnglish, isCosmeticChange } from '../scripts/lib/fill-state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const owners = loadOwners(join(ROOT, 'i18n/owners.yml'));
const human = (value) => ({ value, source: 'human', by: '@someone', issue: 7 });
const plan = (sourceStrings, existing, state) =>
  planLocale({ sourceStrings, existing, state, owners, isIcuKey: () => false });

describe('cosmetic English edits', () => {
  test('case, quotes, ellipsis and trailing punctuation are cosmetic', () => {
    for (const [a, b] of [['Sign In', 'Sign in'], ['Loading…', 'Loading...'], ["Don't add", 'Don’t add'], ['Done.', 'Done']]) {
      assert.equal(looseEnglish(a), looseEnglish(b), `${a} vs ${b}`);
    }
  });

  test('placeholders and words are not', () => {
    for (const [a, b] of [['Add {Count}', 'Add {count}'], ['Sign In', 'Sign Out'], ['Add $PLAYLIST', 'Add $LIST']]) {
      assert.notEqual(looseEnglish(a), looseEnglish(b), `${a} vs ${b}`);
    }
  });

  test('a human translation survives a case-only change and is restamped', () => {
    const p = plan({ 'action.signIn': 'Sign in' }, { 'action.signIn': human('登录') }, { 'action.signIn': englishHash('Sign In') });
    assert.deepEqual(p.toTranslate, {});
    assert.deepEqual(p.restamped, ['action.signIn']);
    assert.equal(p.state['action.signIn'], englishHash('Sign in'));
  });

  test('an AI translation is still refreshed on a cosmetic change', () => {
    const p = plan({ 'action.signIn': 'Sign in' }, { 'action.signIn': 'Anmelden' }, { 'action.signIn': englishHash('Sign In') });
    assert.deepEqual(p.toTranslate, { 'action.signIn': 'Sign in' });
  });

  test('a real change still re-translates a human entry', () => {
    const p = plan({ 'action.signIn': 'Sign in with Apple' }, { 'action.signIn': human('登录') }, { 'action.signIn': englishHash('Sign In') });
    assert.deepEqual(Object.keys(p.toTranslate), ['action.signIn']);
  });

  test('a legacy one-part stamp is never treated as cosmetic', () => {
    const legacy = englishHash('Sign In').split('~')[0];
    assert.equal(isCosmeticChange('k', 'Sign in', { k: legacy }), false);
  });

  test('a current legacy stamp is upgraded in place', () => {
    const legacy = englishHash('Play').split('~')[0];
    const p = plan({ 'action.play': 'Play' }, { 'action.play': 'Abspielen' }, { 'action.play': legacy });
    assert.equal(p.state['action.play'], englishHash('Play'));
  });
});

describe('keys that leave en-US.yml for a while', () => {
  test('a desktop key missing from one sync keeps its stamp, so it is fresh when it returns', () => {
    const existing = { 'settings.audio.title': human('音频') };
    const state = { 'settings.audio.title': englishHash('Audio') };
    const during = plan({ 'action.play': 'Play' }, existing, state);
    assert.equal(during.state['settings.audio.title'], englishHash('Audio'));
    const after = plan({ 'settings.audio.title': 'Audio' }, during.locale, during.state);
    assert.deepEqual(after.toTranslate, {});
  });
});

describe('superseding a human translation', () => {
  test('keeps the human text and flags the key for review', () => {
    const out = mergeTranslations({ k: human('旧的') }, { k: '新的' }, new Set(['k']));
    assert.equal(out.k.value, '新的');
    assert.equal(out.k.previous, '旧的');
    assert.equal(out.k.review, true);
  });
});

describe('sync removal limit', async () => {
  const { removalLimit } = await import('../scripts/i18n-sync-source.mjs');
  test('allows small cleanups and stops mass deletions', () => {
    assert.equal(removalLimit(100), 25);
    assert.equal(removalLimit(5216), 105);
    assert.ok(838 > removalLimit(5216));
  });
});

describe('areas', async () => {
  const { loadAreas, resolveArea, areaByPaths } = await import('../scripts/lib/areas.mjs');
  const { groupBatches, buildUserPrompt } = await import('../scripts/i18n-translate.mjs');
  const areas = loadAreas(join(ROOT, 'i18n/areas.yml'));

  test('the longest key prefix wins', () => {
    assert.equal(resolveArea('settings.option.audio.eq', { areas }), 'settings.audio');
    assert.equal(resolveArea('settings.option.weird', { areas }), 'settings.shell');
    assert.equal(resolveArea('mobile.settings.theme', { areas }), 'android.settings');
  });

  test('shared words take the screen that uses them', () => {
    const pathArea = areaByPaths(['components/applemusic/queue/QueueItem.vue'], areas);
    assert.equal(resolveArea('term.song', { areas, pathArea }), 'player');
    assert.equal(resolveArea('term.song', { areas }), 'shared');
    assert.equal(resolveArea('settings.audio.title', { areas, pathArea }), 'settings.audio');
  });

  test('batches stay within one area and the prompt names it', () => {
    const byId = new Map(areas.map(a => [a.id, a]));
    const areaOf = (k) => byId.get(resolveArea(k, { areas }));
    const batches = groupBatches({ 'settings.audio.a': 'A', 'settings.visual.b': 'B', 'settings.audio.c': 'C' },
      { owners, isIcuKey: () => false, batchSize: 60, areaOf });
    assert.equal(batches.length, 2);
    assert.match(buildUserPrompt({ k: 'A' }, 'de', 'German', batches[0].area), /Settings › Audio/);
  });
});
