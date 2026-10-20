#!/usr/bin/env node
/**
 * Maintainer-only helper to register a locale in this repo.
 *
 *   node scripts/add-locale.mjs --code is --name Icelandic [--native Íslenska]
 *   LOCALE_CODE=is LOCALE_NAME=Icelandic ISSUE_NUMBER=77 node scripts/add-locale.mjs
 *
 * Without an issue: writes languages.yml plus an empty locales/<code>.yml
 * (missing keys fall back to English; AI fill populates them after the
 * languages.yml push).
 *
 * With an issue: registers the locale (so the name comes from the workflow
 * inputs), then runs the same apply path as labeling the issue `approved`.
 *
 * The workflow must set ALLOW_NEW_LOCALE=1 after verify-approver.sh. This
 * script refuses to create a locale without that flag.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  isValidBcp47, isReservedLocale, resolveLanguageNames, LANG_RE,
} from './lib/bcp47.mjs';
import { registerLanguageOnDisk } from './lib/locale-registry.mjs';
import { runBot } from './lint-translation-issue.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const arg = (f, d) => {
  const i = args.indexOf(f);
  return i !== -1 ? args[i + 1] : d;
};

function appendGithubEnv(lines) {
  if (!process.env.GITHUB_ENV || !lines.length) return;
  appendFileSync(process.env.GITHUB_ENV, `${lines.join('\n')}\n`);
}

export async function addLocale({
  code,
  name,
  native,
  issue,
  root = ROOT,
} = {}) {
  if (process.env.ALLOW_NEW_LOCALE !== '1') {
    throw new Error('Refusing to add a locale: ALLOW_NEW_LOCALE=1 is required (maintainer workflows only).');
  }
  const trimmed = String(code ?? '').trim();
  if (!trimmed) throw new Error('Locale code is required (--code or LOCALE_CODE).');
  if (!LANG_RE.test(trimmed) || !isValidBcp47(trimmed)) {
    throw new Error(`Locale code ${trimmed} is not a valid BCP 47 tag (expected e.g. is, pt-BR).`);
  }
  if (isReservedLocale(trimmed)) {
    throw new Error(`Locale code ${trimmed} is reserved (English source).`);
  }

  const names = resolveLanguageNames(trimmed, { name, native });
  if (names.errors.length) throw new Error(names.errors.join(' '));

  const languages = parseYaml(readFileSync(join(root, 'locales/languages.yml'), 'utf8'))?.languages ?? {};
  const already = Object.hasOwn(languages, trimmed);
  const registered = registerLanguageOnDisk(root, trimmed, {
    name: names.name,
    native: names.native,
  });
  if (registered.added) {
    console.log(`Registered ${trimmed} (${names.name} / ${names.native}).`);
    appendGithubEnv(['NEW_LOCALE_CREATED=1']);
  } else {
    console.log(`${trimmed} is already in locales/languages.yml.`);
  }

  if (issue) {
    process.env.ISSUE_NUMBER = String(issue);
    process.env.FETCH_ISSUE = '1';
    process.env.MODE = process.env.MODE || 'apply';
    process.env.ALLOW_NEW_LOCALE = '1';
    process.env.LOCALE_NAME = names.name;
    if (names.native) process.env.LOCALE_NATIVE = names.native;
    await runBot();
    return { code: trimmed, added: registered.added, names, appliedIssue: String(issue) };
  }

  if (!already) {
    writeFileSync(join(root, `locales/${trimmed}.yml`), stringifyYaml({}, { lineWidth: 0 }), 'utf8');
    console.log(`Wrote empty locales/${trimmed}.yml (English fallback until AI fill).`);
  }
  return { code: trimmed, added: registered.added, names, appliedIssue: null };
}

async function main() {
  await addLocale({
    code: arg('--code', process.env.LOCALE_CODE),
    name: arg('--name', process.env.LOCALE_NAME),
    native: arg('--native', process.env.LOCALE_NATIVE),
    issue: arg('--issue', process.env.ISSUE_NUMBER),
  });
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
