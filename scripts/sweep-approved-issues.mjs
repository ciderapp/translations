#!/usr/bin/env node
/**
 * Find translation issues that a maintainer approved but the apply job
 * never finished (still open, still labeled `translation` + `approved`).
 *
 *   node scripts/sweep-approved-issues.mjs --list-json
 *
 * Prints a JSON array of issue numbers for a workflow matrix. Caps at 100
 * so the matrix stays under GitHub's job limit. The next sweep picks up
 * whatever remains.
 */

import { pathToFileURL } from 'url';
import { githubPaginate } from './lib/github.mjs';

export const MAX_SWEEP_BATCH = 100;

export function isStuckTranslationIssue(issue) {
  if (!issue || typeof issue !== 'object') return false;
  if (issue.state && issue.state !== 'open') return false;
  if (issue.pull_request) return false;
  const names = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
  return names.includes('translation') && names.includes('approved');
}

export async function listStuckTranslationIssues({
  repo = process.env.GITHUB_REPOSITORY,
  githubPaginateFn = githubPaginate,
} = {}) {
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set.');
  const issues = await githubPaginateFn(
    `/repos/${repo}/issues?state=open&labels=${encodeURIComponent('translation,approved')}`,
  );
  return issues.filter(isStuckTranslationIssue);
}

export function issueNumbersForMatrix(issues, cap = MAX_SWEEP_BATCH) {
  const numbers = issues.map((i) => i.number).filter((n) => Number.isInteger(n));
  return numbers.slice(0, cap);
}

async function main() {
  const listJson = process.argv.includes('--list-json');
  const stuck = await listStuckTranslationIssues();
  const numbers = issueNumbersForMatrix(stuck);
  if (stuck.length > numbers.length) {
    console.warn(`[sweep] ${stuck.length} stuck issues; processing ${numbers.length} this run`);
  }
  if (listJson) {
    process.stdout.write(JSON.stringify(numbers));
    return;
  }
  if (numbers.length === 0) {
    console.log('No approved-but-unprocessed translation issues.');
    return;
  }
  for (const issue of stuck.slice(0, numbers.length)) {
    console.log(`#${issue.number} ${issue.title ?? ''} ${issue.html_url ?? ''}`.trim());
  }
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
