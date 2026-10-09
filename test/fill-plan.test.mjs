// Tests for the owner-aware fill: staleness by fill state, reuse of desktop
// translations, pruning, ICU acceptance, prompts, and one end-to-end run
// against a mocked Anthropic endpoint.
//
// Run: `node --test test/`

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  SYSTEM_PROMPT, buildSystemPrompt, planLocale, acceptTranslations, groupBatches, makeIcuCheck,
} from '../scripts/i18n-translate.mjs';
import { loadOwners } from '../scripts/lib/owners.mjs';
import { englishHash } from '../scripts/lib/fill-state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const owners = loadOwners(join(ROOT, 'i18n/owners.yml'));
const human = (value) => ({ value, source: 'human', by: '@someone', issue: 7 });
const stamp = (map) => Object.fromEntries(Object.entries(map).map(([k, en]) => [k, englishHash(en)]));

describe('planLocale', () => {
  const sourceStrings = {
    'action.play': 'Play',
    'action.addToLibrary': 'Add to Library',
    'mobile.queue.playNext': 'Play next',
    'mobile.library.add': 'Add to Library',
  };
  const isIcuKey = makeIcuCheck({ sourceStrings, owners, consumers: new Map() });

  test('fresh keys stay, missing and re-worded keys are translated', () => {
    const plan = planLocale({
      sourceStrings: { 'action.play': 'Play', 'action.stop': 'Stop now' },
      existing: { 'action.play': 'Abspielen', 'action.stop': 'Stopp' },
      state: { 'action.play': englishHash('Play'), 'action.stop': englishHash('Stop') },
      owners, isIcuKey: () => false,
    });
    assert.deepEqual(plan.toTranslate, { 'action.stop': 'Stop now' });
    assert.deepEqual([...plan.changed], ['action.stop']);
  });

  test("one locale's failed batch doesn't make a fresh human entry elsewhere stale", () => {
    // zh-CN's human entry was stamped with the current English at apply time.
    // Whatever happened in other locales, zh-CN has nothing to do.
    const plan = planLocale({
      sourceStrings: { k: 'New English' },
      existing: { k: human('新的') },
      state: { k: englishHash('New English') },
      owners, isIcuKey: () => false,
    });
    assert.deepEqual(plan.toTranslate, {});
  });

  test('a mobile string copies the current desktop translation of the same English, human first', () => {
    const plan = planLocale({
      sourceStrings,
      existing: { 'action.play': 'Abspielen', 'action.addToLibrary': human('Zur Mediathek hinzufügen') },
      state: stamp({ 'action.play': 'Play', 'action.addToLibrary': 'Add to Library' }),
      owners, isIcuKey,
    });
    assert.deepEqual(plan.copies, { 'mobile.library.add': 'Zur Mediathek hinzufügen' });
    assert.deepEqual(plan.toTranslate, { 'mobile.queue.playNext': 'Play next' });
  });

  test('a stale desktop translation is not copied', () => {
    const plan = planLocale({
      sourceStrings,
      existing: { 'action.addToLibrary': 'Zur Bibliothek' },
      state: { 'action.addToLibrary': englishHash('Add to library (old)') },
      owners, isIcuKey,
    });
    assert.deepEqual(plan.copies, {});
    assert.ok('mobile.library.add' in plan.toTranslate);
  });

  test('a copy that would break ICU is not used', () => {
    const src = { 'action.addedTo': 'Added to {playlist}', 'mobile.playlist.addedTo': 'Added to {playlist}' };
    const plan = planLocale({
      sourceStrings: src,
      existing: { 'action.addedTo': "Ajouté à l'{playlist}" },
      state: stamp({ 'action.addedTo': 'Added to {playlist}' }),
      owners, isIcuKey: makeIcuCheck({ sourceStrings: src, owners, consumers: new Map() }),
    });
    assert.deepEqual(plan.copies, {});
    assert.ok('mobile.playlist.addedTo' in plan.toTranslate);
  });

  test("Android's deleted keys lose their AI translations; human ones and desktop orphans stay", () => {
    const plan = planLocale({
      sourceStrings: { 'action.play': 'Play', 'mobile.queue.playNext': 'Play next' },
      existing: {
        'action.play': 'Abspielen',
        'action.legacy': 'Alt',
        'mobile.queue.playNext': 'Als Nächstes',
        'mobile.old.ai': 'Alt',
        'mobile.old.human': human('Alt'),
      },
      state: stamp({ 'action.play': 'Play', 'mobile.queue.playNext': 'Play next', 'mobile.old.ai': 'Old' }),
      owners, isIcuKey: () => false,
    });
    assert.deepEqual(plan.pruned, ['mobile.old.ai']);
    assert.ok('action.legacy' in plan.locale);
    assert.ok('mobile.old.human' in plan.locale);
    assert.deepEqual(Object.keys(plan.state).sort(), ['action.play', 'mobile.queue.playNext']);
  });

  test("an owner whose keys all vanished at once is not pruned (a wholesale overwrite, not a deletion)", () => {
    const plan = planLocale({
      sourceStrings: { 'action.play': 'Play' },
      existing: { 'action.play': 'Abspielen', 'mobile.queue.playNext': 'Als Nächstes', 'mobile.queue.clear': 'Leeren' },
      state: stamp({ 'action.play': 'Play', 'mobile.queue.playNext': 'Play next', 'mobile.queue.clear': 'Clear' }),
      owners, isIcuKey: () => false,
    });
    assert.deepEqual(plan.pruned, []);
    assert.ok('mobile.queue.playNext' in plan.locale);
  });

  test('--force re-translates everything and reuses nothing', () => {
    const plan = planLocale({
      sourceStrings,
      existing: { 'action.addToLibrary': 'Zur Mediathek' },
      state: stamp({ 'action.addToLibrary': 'Add to Library' }),
      owners, isIcuKey, force: true,
    });
    assert.equal(Object.keys(plan.toTranslate).length, 4);
    assert.deepEqual(plan.copies, {});
  });
});

describe('ICU keys', () => {
  const sourceStrings = {
    'mobile.library.songCount': '{count, plural, one {# song} other {# songs}}',
    'action.addToLibrary': 'Add to Library',
    'action.addedTo': 'Added to {playlist}',
    'party.full': '{{count}} track(s) were not added.',
    'action.play': 'Play',
  };
  const consumers = new Map([
    ['action.addToLibrary', ['android']],
    ['action.addedTo', ['android']],
    ['party.full', ['android']],
  ]);
  const isIcuKey = makeIcuCheck({ sourceStrings, owners, consumers });

  test('every mobile key, and borrowed desktop keys that read correctly through ICU', () => {
    assert.equal(isIcuKey('mobile.library.songCount'), true);
    assert.equal(isIcuKey('action.addToLibrary'), true);
    assert.equal(isIcuKey('action.addedTo'), true);
    assert.equal(isIcuKey('party.full'), false);   // borrowed, but mustache
    assert.equal(isIcuKey('action.play'), false);  // not borrowed
  });

  test('answers that break ICU are rejected, others accepted', () => {
    const { accepted, rejected } = acceptTranslations({
      translated: {
        'mobile.library.songCount': '{count, plural, one {# Lied} other {# Lieder}}',
        'action.addedTo': "Ajouté à l'{playlist}",
        'action.play': "L'{x} n'importe quoi",
      },
      sourceStrings, isIcuKey,
    });
    assert.deepEqual(Object.keys(accepted).sort(), ['action.play', 'mobile.library.songCount']);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].key, 'action.addedTo');
    assert.match(rejected[0].reason, /dropped/);
  });

  test('batches never mix platforms or ICU and non-ICU keys', () => {
    const batches = groupBatches({
      'mobile.library.songCount': 'x', 'action.addedTo': 'y', 'action.play': 'z', 'party.full': 'w',
    }, { owners, isIcuKey, batchSize: 60 });
    const shapes = batches.map(b => `${b.platform}|${b.icu}|${b.entries.map(e => e[0]).join(',')}`).sort();
    assert.deepEqual(shapes, [
      'android|true|mobile.library.songCount',
      'desktop|false|action.play,party.full',
      'desktop|true|action.addedTo',
    ]);
  });
});

describe('prompts', () => {
  test('desktop batches get the unchanged desktop prompt', () => {
    assert.equal(buildSystemPrompt({ platform: 'desktop', icu: false, lang: 'de' }), SYSTEM_PROMPT);
  });

  test('Android batches name the app and the phone, and keep the base rules', () => {
    const p = buildSystemPrompt({ platform: 'android', icu: true, lang: 'pl' });
    assert.match(p, /Cider for Android/);
    assert.doesNotMatch(p, /desktop client/);
    assert.match(p, /Android Auto/);
    assert.match(p, /ICU MessageFormat/);
    assert.match(p, /few, many, one, other/);
    assert.match(p, /typographic apostrophe/);
    assert.match(p, /Do NOT translate proper nouns/);
  });
});

describe('end to end (mocked Anthropic)', () => {
  test('a fill run copies, translates, rejects, prunes and stamps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cider-fill-'));
    try {
      mkdirSync(join(dir, 'locales'));
      mkdirSync(join(dir, 'i18n/fill-state'), { recursive: true });
      mkdirSync(join(dir, 'i18n/consumers'), { recursive: true });
      copyFileSync(join(ROOT, 'i18n/owners.yml'), join(dir, 'i18n/owners.yml'));

      const en = {
        'action.addToLibrary': 'Add to Library',
        'action.play': 'Play',
        'mobile.bad.addedTo': 'Added to {playlist}',
        'mobile.library.add': 'Add to Library',
        'mobile.queue.playNext': 'Play next',
      };
      writeFileSync(join(dir, 'locales/en-US.yml'), stringifyYaml(en));
      writeFileSync(join(dir, 'locales/languages.yml'), stringifyYaml({
        languages: { de: { name: 'German' }, 'en-US': { name: 'English', source: true } },
      }));
      writeFileSync(join(dir, 'locales/de.yml'), stringifyYaml({
        'action.addToLibrary': human('Zur Mediathek hinzufügen'),
        'action.play': 'Abspielen',
        'mobile.old.ai': 'Alt',
        'mobile.old.human': human('Alt'),
      }));
      writeFileSync(join(dir, 'i18n/fill-state/de.yml'), stringifyYaml(stamp({
        'action.addToLibrary': 'Add to Library', 'action.play': 'Play', 'mobile.old.ai': 'Old',
      })));
      writeFileSync(join(dir, 'i18n/consumers/android.yml'), stringifyYaml({ keys: ['action.addToLibrary'] }));

      const log = join(dir, 'prompts.log');
      execFileSync(process.execPath, [
        '--import', pathToFileURL(join(ROOT, 'test/fixtures/mock-anthropic.mjs')).href,
        join(ROOT, 'scripts/i18n-translate.mjs'),
        '--source', join(dir, 'locales/en-US.yml'),
        '--out', join(dir, 'locales'),
        '--languages', join(dir, 'locales/languages.yml'),
        '--owners', join(dir, 'i18n/owners.yml'),
        '--state', join(dir, 'i18n/fill-state'),
      ], { env: { ...process.env, ANTHROPIC_API_KEY: 'test', MOCK_LOG: log, GITHUB_ACTIONS: '' }, stdio: 'pipe' });

      const de = parseYaml(readFileSync(join(dir, 'locales/de.yml'), 'utf8'));
      const state = parseYaml(readFileSync(join(dir, 'i18n/fill-state/de.yml'), 'utf8'));

      assert.equal(de['mobile.library.add'], 'Zur Mediathek hinzufügen');   // copied from desktop
      assert.equal(de['mobile.queue.playNext'], 'DE: Play next');          // translated
      assert.equal('mobile.bad.addedTo' in de, false);                     // rejected, shows English
      assert.equal('mobile.old.ai' in de, false);                          // pruned
      assert.deepEqual(de['mobile.old.human'], human('Alt'));              // kept
      assert.equal(de['action.play'], 'Abspielen');                        // untouched

      assert.equal(state['mobile.library.add'], englishHash('Add to Library'));
      assert.equal(state['mobile.queue.playNext'], englishHash('Play next'));
      assert.equal('mobile.bad.addedTo' in state, false);
      assert.equal('mobile.old.ai' in state, false);

      const prompts = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert.equal(prompts.length, 1);   // one Android ICU batch; the copy needed no call
      const systemText = Array.isArray(prompts[0])
        ? prompts[0].map(b => b.text).join('\n')
        : prompts[0];
      assert.match(systemText, /Cider for Android/);
      assert.match(systemText, /ICU MessageFormat/);
      assert.equal(prompts[0][0].cache_control.type, 'ephemeral');
      assert.equal('cache_control' in prompts[0][1], false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
