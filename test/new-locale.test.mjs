import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';

import {
  LANG_RE, isValidBcp47, isReservedLocale, isSafeLanguageName,
  languageNamesFromIntl, languageNameFromTitle, resolveLanguageNames,
  capitalizeLocaleName,
} from '../scripts/lib/bcp47.mjs';
import {
  insertLanguage, mergeLanguageRegistryText, mergeLanguageMaps,
  applyLanguageMapToText, parseLanguagesFile, yamlLocaleBlock,
  registerLanguageOnDisk,
} from '../scripts/lib/locale-registry.mjs';
import {
  extractAttachmentUrls, pickAttachmentUrl, isAllowedInitialUrl,
  isAllowedRedirectHost, fetchAttachmentText, parseTranslationsYaml,
  loadIssueAttachmentTranslations, translationsNeedAttachment,
  MAX_ATTACHMENT_BYTES,
} from '../scripts/lib/issue-attachments.mjs';
import {
  dropUnknownKeys, extractTranslations, resolveSubmittedTranslations,
  validateTranslations, MAX_TRANSLATIONS,
} from '../scripts/lint-translation-issue.mjs';
import { addLocale } from '../scripts/add-locale.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_LANGUAGES = readFileSync(join(ROOT, 'locales/languages.yml'), 'utf8');

describe('BCP 47', () => {
  test('accepts the codes this repo already ships, plus Icelandic', () => {
    for (const c of ['cs', 'de', 'is', 'is-IS', 'pt-BR', 'zh-CN', 'es-419', 'sv-SE', 'fr-CA']) {
      assert.equal(isValidBcp47(c), true, c);
      assert.ok(LANG_RE.test(c), c);
    }
  });

  test('rejects path traversal, uppercase primary, and junk', () => {
    for (const c of ['../etc', 'en/../etc', 'EN-US', 'es-419-extra', 'en US', 'is\nIS', '', 'und']) {
      assert.equal(isValidBcp47(c), false, c);
    }
  });

  test('reserves the English source', () => {
    assert.equal(isReservedLocale('en'), true);
    assert.equal(isReservedLocale('en-US'), true);
    assert.equal(isReservedLocale('is'), false);
  });

  test('resolves Icelandic names from Intl', () => {
    const names = languageNamesFromIntl('is');
    assert.match(names.name, /Icelandic/i);
    assert.match(names.native, /íslenska/i);
    assert.equal(capitalizeLocaleName('íslenska')[0], 'Í');
  });

  test('parses [language] Add <Name> titles', () => {
    assert.equal(languageNameFromTitle('[language] Add Icelandic'), 'Icelandic');
    assert.equal(languageNameFromTitle('[translation] is'), null);
  });

  test('rejects unsafe display names', () => {
    assert.equal(isSafeLanguageName('Icelandic'), true);
    assert.equal(isSafeLanguageName('Chinese (Simplified)'), true);
    assert.equal(isSafeLanguageName('Íslenska'), true);
    assert.equal(isSafeLanguageName('bad[link]'), false);
    assert.equal(isSafeLanguageName('x'.repeat(81)), false);
    assert.equal(isSafeLanguageName('line\nbreak'), false);
  });

  test('resolveLanguageNames prefers explicit names', () => {
    const r = resolveLanguageNames('is', { name: 'Icelandic', native: 'Íslenska' });
    assert.deepEqual(r.errors, []);
    assert.equal(r.name, 'Icelandic');
    assert.equal(r.native, 'Íslenska');
  });
});

describe('languages.yml registry', () => {
  test('inserts is between id and it without dropping comments', () => {
    const { text, added } = insertLanguage(REAL_LANGUAGES, 'is', {
      name: 'Icelandic', native: 'Íslenska',
    });
    assert.equal(added, true);
    assert.match(text, /Locked snapshot/);
    const langs = parseLanguagesFile(text).languages;
    assert.equal(langs.is.name, 'Icelandic');
    assert.equal(langs.is.native, 'Íslenska');
    assert.ok(Object.hasOwn(langs, 'id'));
    assert.ok(Object.hasOwn(langs, 'it'));
    assert.ok(text.indexOf('\n  is:\n') > text.indexOf('\n  id:\n'));
    assert.ok(text.indexOf('\n  is:\n') < text.indexOf('\n  it:\n'));
  });

  test('insert is a no-op when the code exists', () => {
    const once = insertLanguage(REAL_LANGUAGES, 'is', { name: 'Icelandic', native: 'Íslenska' });
    const twice = insertLanguage(once.text, 'is', { name: 'Nope', native: 'Nope' });
    assert.equal(twice.added, false);
    assert.equal(twice.languages.is.name, 'Icelandic');
  });

  test('merge keeps extras and is byte-identical when there are none', () => {
    assert.equal(mergeLanguageRegistryText(REAL_LANGUAGES, REAL_LANGUAGES).text, REAL_LANGUAGES);
    assert.deepEqual(mergeLanguageRegistryText(REAL_LANGUAGES, REAL_LANGUAGES).extras, []);

    const local = insertLanguage(REAL_LANGUAGES, 'is', { name: 'Icelandic', native: 'Íslenska' }).text;
    const { text, extras } = mergeLanguageRegistryText(REAL_LANGUAGES, local);
    assert.deepEqual(extras, ['is']);
    assert.equal(parseLanguagesFile(text).languages.is.name, 'Icelandic');
    assert.match(text, /snapshotted: 2026-05-20/);
  });

  test('three-way merge keeps locales added on either side', () => {
    const merged = mergeLanguageMaps({
      base: { de: { name: 'German' } },
      ours: { de: { name: 'German' }, is: { name: 'Icelandic' } },
      theirs: { de: { name: 'German' }, eu: { name: 'Basque' } },
    });
    assert.equal(merged.is.name, 'Icelandic');
    assert.equal(merged.eu.name, 'Basque');
    assert.equal(merged.de.name, 'German');
  });

  test('applyLanguageMapToText inserts onto theirs without rewriting existing keys', () => {
    const theirs = REAL_LANGUAGES;
    const text = applyLanguageMapToText(theirs, {
      ...parseLanguagesFile(theirs).languages,
      is: { name: 'Icelandic', native: 'Íslenska' },
    });
    assert.equal(parseLanguagesFile(text).languages.de.name, 'German');
    assert.equal(parseLanguagesFile(text).languages.is.name, 'Icelandic');
  });

  test('yamlLocaleBlock is indented as a languages: child', () => {
    const block = yamlLocaleBlock('is', { name: 'Icelandic', native: 'Íslenska' });
    assert.equal(block, '  is:\n    name: Icelandic\n    native: Íslenska\n');
  });

  test('registerLanguageOnDisk writes once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cider-lang-'));
    try {
      mkdirSync(join(dir, 'locales'));
      writeFileSync(join(dir, 'locales/languages.yml'), REAL_LANGUAGES);
      const a = registerLanguageOnDisk(dir, 'is', { name: 'Icelandic', native: 'Íslenska' });
      const b = registerLanguageOnDisk(dir, 'is', { name: 'Icelandic', native: 'Íslenska' });
      assert.equal(a.added, true);
      assert.equal(b.added, false);
      assert.match(readFileSync(join(dir, 'locales/languages.yml'), 'utf8'), /\n  is:\n/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('issue attachments', () => {
  test('extracts user-attachments YAML URLs and ignores other links', () => {
    const body = [
      '### Notes (optional)',
      '',
      '[is.yaml](https://github.com/user-attachments/files/31047038/is.yaml)',
      'https://evil.example/payload.yml',
      'https://github.com/user-attachments/files/1/notes.txt',
    ].join('\n');
    assert.deepEqual(extractAttachmentUrls(body), [
      'https://github.com/user-attachments/files/31047038/is.yaml',
    ]);
  });

  test('picks the file whose name matches the locale', () => {
    const urls = [
      'https://github.com/user-attachments/files/1/other.yml',
      'https://github.com/user-attachments/files/2/is.yaml',
    ];
    assert.equal(pickAttachmentUrl(urls, 'is'), urls[1]);
    assert.equal(pickAttachmentUrl(urls, 'de'), urls[0]);
  });

  test('allows GitHub attachment hosts only', () => {
    assert.equal(isAllowedInitialUrl('https://github.com/user-attachments/files/1/is.yaml'), true);
    assert.equal(isAllowedInitialUrl('https://evil.com/is.yaml'), false);
    assert.equal(isAllowedInitialUrl('http://github.com/user-attachments/files/1/is.yaml'), false);
    assert.equal(isAllowedRedirectHost('objects.githubusercontent.com'), true);
    assert.equal(isAllowedRedirectHost('evil.com'), false);
  });

  test('follows a GitHub redirect and enforces size and host', async () => {
    const yaml = 'action.apply: Apply\n';
    const fetchImpl = async (url, opts) => {
      assert.equal(opts.redirect, 'manual');
      if (url === 'https://github.com/user-attachments/files/1/is.yaml') {
        return new Response('', {
          status: 302,
          headers: { location: 'https://objects.githubusercontent.com/is.yaml' },
        });
      }
      if (url === 'https://objects.githubusercontent.com/is.yaml') {
        return new Response(yaml, { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const text = await fetchAttachmentText('https://github.com/user-attachments/files/1/is.yaml', { fetchImpl });
    assert.equal(text, yaml);

    await assert.rejects(
      () => fetchAttachmentText('https://github.com/user-attachments/files/1/is.yaml', {
        fetchImpl: async () => new Response('', {
          status: 302,
          headers: { location: 'https://evil.com/is.yaml' },
        }),
      }),
      /Refusing attachment redirect host/,
    );

    await assert.rejects(
      () => fetchAttachmentText('https://github.com/user-attachments/files/1/is.yaml', {
        fetchImpl: async () => new Response('x'.repeat(MAX_ATTACHMENT_BYTES + 1), { status: 200 }),
      }),
      /too large/,
    );
  });

  test('parseTranslationsYaml requires a map', () => {
    assert.deepEqual(parseTranslationsYaml('action.apply: Hæ\n'), { 'action.apply': 'Hæ' });
    assert.ok(parseTranslationsYaml('- just a list').__error);
    assert.ok(parseTranslationsYaml('not a map').__error);
  });

  test('loadIssueAttachmentTranslations reads the #77 shape', async () => {
    const body = [
      '### Language code',
      '',
      'is',
      '',
      '### Translations',
      '',
      '```yaml',
      'Translations exceeded character limit. yaml file uploaded in notes',
      '```',
      '',
      '### Notes (optional)',
      '',
      '[is.yaml](https://github.com/user-attachments/files/31047038/is.yaml)',
    ].join('\n');
    let hops = 0;
    const fetchHops = async (url) => {
      hops += 1;
      if (hops === 1) {
        return new Response('', {
          status: 302,
          headers: { location: 'https://objects.githubusercontent.com/is.yaml' },
        });
      }
      return new Response('action.apply: Hæ\naction.back: Til baka\n', { status: 200 });
    };
    const loaded = await loadIssueAttachmentTranslations({ body, language: 'is', fetchImpl: fetchHops });
    assert.equal(loaded.translations['action.apply'], 'Hæ');
    assert.equal(loaded.translations['action.back'], 'Til baka');
  });
});

describe('resolveSubmittedTranslations', () => {
  const issue77 = {
    'language code': 'is',
    language: 'is',
    translations: '```yaml\nTranslations exceeded character limit. yaml file uploaded in notes\n```',
    notes: '[is.yaml](https://github.com/user-attachments/files/31047038/is.yaml)',
  };

  test('uses the body when it is a YAML map', async () => {
    const r = await resolveSubmittedTranslations(
      { translations: 'action.apply: Hæ' },
      { body: '### Translations\n\naction.apply: Hæ', language: 'is' },
    );
    assert.equal(r.source, 'body');
    assert.equal(r.translations['action.apply'], 'Hæ');
  });

  test('falls back to the attachment when the body is not a map', async () => {
    let hops = 0;
    const fetchImpl = async () => {
      hops += 1;
      if (hops === 1) {
        return new Response('', {
          status: 302,
          headers: { location: 'https://objects.githubusercontent.com/is.yaml' },
        });
      }
      return new Response('action.apply: Hæ\n', { status: 200 });
    };
    const r = await resolveSubmittedTranslations(issue77, {
      body: `### Notes (optional)\n\n[is.yaml](https://github.com/user-attachments/files/31047038/is.yaml)`,
      language: 'is',
      fetchImpl,
    });
    assert.equal(r.source, 'attachment');
    assert.equal(r.translations['action.apply'], 'Hæ');
  });

  test('a new locale with no strings is empty, not an error', async () => {
    const r = await resolveSubmittedTranslations(
      { translations: '_No response_' },
      { body: 'no files here', language: 'is', isNewLocale: true },
    );
    assert.equal(r.source, 'empty');
    assert.deepEqual(r.translations, {});
    assert.match(r.warning, /fall back to English/);
  });

  test('translationsNeedAttachment is true only on parse errors', () => {
    assert.equal(translationsNeedAttachment({ __error: 'nope' }), true);
    assert.equal(translationsNeedAttachment({ 'action.apply': 'Hæ' }), false);
  });
});

describe('dropUnknownKeys and full-locale caps', () => {
  test('keeps current keys and lists extras', () => {
    const { kept, dropped } = dropUnknownKeys({
      'action.apply': 'Hæ',
      'gone.key': 'x',
    }, { 'action.apply': 'Apply', 'action.back': 'Back' });
    assert.deepEqual(kept, { 'action.apply': 'Hæ' });
    assert.deepEqual(dropped, ['gone.key']);
  });

  test('attachments may include every en-US key; in-body still caps at MAX_TRANSLATIONS', () => {
    const source = { 'action.apply': 'Apply', 'action.back': 'Back' };
    const ok = validateTranslations({ 'action.apply': 'Hæ' }, source, {
      maxTranslations: Object.keys(source).length,
    });
    assert.equal(ok.errors.length, 0);

    const bulk = {};
    for (let i = 0; i < MAX_TRANSLATIONS + 1; i++) bulk[`stress.k${i}`] = 'v';
    const body = validateTranslations(bulk, source);
    assert.ok(body.errors[0].includes('Too many'));
  });

  test('new locales may be empty', () => {
    const { errors } = validateTranslations({}, { 'action.apply': 'Apply' }, { allowEmpty: true });
    assert.deepEqual(errors, []);
  });
});

describe('addLocale maintainer gate', () => {
  test('refuses to create a locale without ALLOW_NEW_LOCALE', async () => {
    const prev = process.env.ALLOW_NEW_LOCALE;
    delete process.env.ALLOW_NEW_LOCALE;
    try {
      await assert.rejects(() => addLocale({ code: 'is', name: 'Icelandic' }), /ALLOW_NEW_LOCALE/);
    } finally {
      if (prev === undefined) delete process.env.ALLOW_NEW_LOCALE;
      else process.env.ALLOW_NEW_LOCALE = prev;
    }
  });

  test('registers the locale and writes an empty file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cider-add-'));
    const prev = process.env.ALLOW_NEW_LOCALE;
    process.env.ALLOW_NEW_LOCALE = '1';
    try {
      mkdirSync(join(dir, 'locales'));
      writeFileSync(join(dir, 'locales/languages.yml'), REAL_LANGUAGES);
      const result = await addLocale({
        code: 'is', name: 'Icelandic', native: 'Íslenska', root: dir,
      });
      assert.equal(result.added, true);
      const langs = parseYaml(readFileSync(join(dir, 'locales/languages.yml'), 'utf8')).languages;
      assert.equal(langs.is.name, 'Icelandic');
      const locale = parseYaml(readFileSync(join(dir, 'locales/is.yml'), 'utf8'));
      assert.deepEqual(locale, {});
    } finally {
      if (prev === undefined) delete process.env.ALLOW_NEW_LOCALE;
      else process.env.ALLOW_NEW_LOCALE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects reserved and malformed codes', async () => {
    process.env.ALLOW_NEW_LOCALE = '1';
    await assert.rejects(() => addLocale({ code: 'en-US', name: 'English' }), /reserved/);
    await assert.rejects(() => addLocale({ code: '../etc', name: 'X' }), /BCP 47/);
    delete process.env.ALLOW_NEW_LOCALE;
  });
});

describe('extractTranslations still rejects a non-map body', () => {
  test('#77 placeholder is not a YAML map', () => {
    const r = extractTranslations({
      translations: '```yaml\nTranslations exceeded character limit. yaml file uploaded in notes\n```',
    });
    assert.ok(r.__error);
  });
});
