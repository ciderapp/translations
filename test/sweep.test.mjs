import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isStuckTranslationIssue,
  listStuckTranslationIssues,
  issueNumbersForMatrix,
  MAX_SWEEP_BATCH,
} from '../scripts/sweep-approved-issues.mjs';

describe('isStuckTranslationIssue', () => {
  const stuck = {
    number: 96,
    state: 'open',
    labels: [{ name: 'translation' }, { name: 'approved' }],
  };

  test('accepts an open translation issue with approved', () => {
    assert.equal(isStuckTranslationIssue(stuck), true);
  });

  test('rejects pull requests, closed issues, and missing labels', () => {
    assert.equal(isStuckTranslationIssue({ ...stuck, pull_request: {} }), false);
    assert.equal(isStuckTranslationIssue({ ...stuck, state: 'closed' }), false);
    assert.equal(isStuckTranslationIssue({ ...stuck, labels: [{ name: 'translation' }] }), false);
    assert.equal(isStuckTranslationIssue({ ...stuck, labels: ['approved'] }), false);
    assert.equal(isStuckTranslationIssue(null), false);
  });
});

describe('listStuckTranslationIssues', () => {
  test('filters the issues list and requires repo', async () => {
    await assert.rejects(() => listStuckTranslationIssues({ repo: '' }), /GITHUB_REPOSITORY/);

    const listed = await listStuckTranslationIssues({
      repo: 'ciderapp/translations',
      githubPaginateFn: async () => [
        { number: 96, state: 'open', labels: [{ name: 'translation' }, { name: 'approved' }] },
        { number: 12, state: 'open', labels: [{ name: 'translation' }, { name: 'approved' }], pull_request: { url: 'x' } },
        { number: 77, state: 'open', labels: [{ name: 'translation' }] },
      ],
    });
    assert.deepEqual(listed.map((i) => i.number), [96]);
  });
});

describe('issueNumbersForMatrix', () => {
  test('caps the batch so the matrix stays bounded', () => {
    const issues = Array.from({ length: MAX_SWEEP_BATCH + 5 }, (_, i) => ({ number: i + 1 }));
    const numbers = issueNumbersForMatrix(issues);
    assert.equal(numbers.length, MAX_SWEEP_BATCH);
    assert.equal(numbers[0], 1);
    assert.equal(numbers.at(-1), MAX_SWEEP_BATCH);
  });
});
