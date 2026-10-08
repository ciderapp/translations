// Tests for scripts/i18n-remerge.mjs: what it agrees to merge, and a real
// fill-vs-apply race replayed in a throwaway git repository.
//
// Run: `node --test test/`

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { classifyChanges } from '../scripts/i18n-remerge.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/i18n-remerge.mjs');

describe('classifyChanges', () => {
  test('locales and their state merge; README and badges regenerate; the rest is refused', () => {
    const r = classifyChanges([
      'locales/de.yml', 'i18n/fill-state/de.yml', 'i18n/fill-state/fr.yml',
      'README.md', '.github/badges/translators.json',
      'locales/en-US.yml', 'locales/languages.yml', 'i18n/owners.yml', 'scripts/x.mjs',
    ]);
    assert.deepEqual(r.langs, ['de', 'fr']);
    assert.deepEqual(r.generated, ['README.md', '.github/badges/translators.json']);
    assert.deepEqual(r.refused, ['locales/en-US.yml', 'locales/languages.yml', 'i18n/owners.yml', 'scripts/x.mjs']);
  });
});

describe('re-merge in a real repository', () => {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (dir, path, obj) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), stringifyYaml(obj));
  };
  const human = (value) => ({ value, source: 'human', by: '@someone', issue: 9 });

  test('the fill lost the push to an issue apply: both survive, the human wins the shared key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cider-remerge-'));
    try {
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'config', 'user.email', 't@example.com');
      git(dir, 'config', 'user.name', 'test');
      git(dir, 'config', 'core.autocrlf', 'false');

      write(dir, 'locales/de.yml', { a: 'alt', b: 'B', c: 'C' });
      write(dir, 'i18n/fill-state/de.yml', { a: 'h-a-old', b: 'h-b', c: 'h-c' });
      git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
      const base = git(dir, 'rev-parse', 'HEAD');

      // Theirs (landed first): an issue apply for a and b.
      write(dir, 'locales/de.yml', { a: human('neu'), b: human('Bee'), c: 'C' });
      write(dir, 'i18n/fill-state/de.yml', { a: 'h-a-new', b: 'h-b', c: 'h-c' });
      git(dir, 'commit', '-qam', 'apply');
      const theirs = git(dir, 'rev-parse', 'HEAD');

      // Ours (the fill, started from base): re-translated a, added d, pruned c.
      git(dir, 'checkout', '-q', '-b', 'fill', base);
      write(dir, 'locales/de.yml', { a: 'neu (KI)', b: 'B', d: 'D' });
      write(dir, 'i18n/fill-state/de.yml', { a: 'h-a-new', b: 'h-b', d: 'h-d' });
      git(dir, 'commit', '-qam', 'fill');

      const out = join(dir, '.remerge');
      execFileSync(process.execPath, [SCRIPT, '--root', dir, '--base', base, '--ours', 'HEAD', '--theirs', theirs, '--out', out],
        { stdio: 'pipe' });

      const locale = parseYaml(readFileSync(join(out, 'locales/de.yml'), 'utf8'));
      const state = parseYaml(readFileSync(join(out, 'i18n/fill-state/de.yml'), 'utf8'));
      assert.deepEqual(locale, { a: human('neu'), b: human('Bee'), d: 'D' });
      assert.deepEqual(state, { a: 'h-a-new', b: 'h-b', d: 'h-d' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses when the job touched en-US.yml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cider-remerge-'));
    try {
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'config', 'user.email', 't@example.com');
      git(dir, 'config', 'user.name', 'test');
      write(dir, 'locales/en-US.yml', { a: 'A' });
      git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
      const base = git(dir, 'rev-parse', 'HEAD');
      write(dir, 'locales/en-US.yml', { a: 'B' });
      git(dir, 'commit', '-qam', 'oops');
      const out = join(dir, '.remerge');
      assert.throws(() => execFileSync(process.execPath,
        [SCRIPT, '--root', dir, '--base', base, '--ours', 'HEAD', '--theirs', base, '--out', out], { stdio: 'pipe' }),
        (e) => e.status === 2);
      assert.equal(existsSync(out), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
