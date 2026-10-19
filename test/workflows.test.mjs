import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

describe('translation-issue.yml concurrency', () => {
  const yml = read('.github/workflows/translation-issue.yml');

  test('apply uses a per-issue concurrency group, not a shared one', () => {
    assert.match(yml, /group:\s*translation-issue-apply-\$\{\{\s*github\.event\.issue\.number\s*\}\}/);
    assert.doesNotMatch(yml, /group:\s*translation-issue-apply\s*$/m);
  });

  test('keeps pending runs instead of replacing them', () => {
    assert.match(yml, /cancel-in-progress:\s*false/);
    assert.match(yml, /queue:\s*max/);
  });

  test('announces only after push and comments on failure', () => {
    assert.match(yml, /MODE: announce/);
    assert.match(yml, /comment-apply-failure\.sh/);
  });
});

describe('translation-sweep.yml', () => {
  const yml = read('.github/workflows/translation-sweep.yml');

  test('is scheduled and can be run manually', () => {
    assert.match(yml, /workflow_dispatch:/);
    assert.match(yml, /cron:/);
  });

  test('shares the per-issue concurrency group with the label apply job', () => {
    assert.match(yml, /group:\s*translation-issue-apply-\$\{\{\s*matrix\.issue\s*\}\}/);
    assert.match(yml, /queue:\s*max/);
    assert.match(yml, /fail-fast:\s*false/);
  });

  test('lists stuck issues then applies them', () => {
    assert.match(yml, /sweep-approved-issues\.mjs --list-json/);
    assert.match(yml, /FETCH_ISSUE:/);
    assert.match(yml, /lookup-approver\.sh/);
  });
});

describe('ai-fill.yml concurrency', () => {
  const yml = read('.github/workflows/ai-fill.yml');
  test('queues overlapping fills instead of dropping them', () => {
    assert.match(yml, /group:\s*ai-fill-\$\{\{\s*github\.ref\s*\}\}/);
    assert.match(yml, /cancel-in-progress:\s*false/);
    assert.match(yml, /queue:\s*max/);
  });
});
