import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  retryWaitMs,
  isRetryableGithubStatus,
  githubRequest,
  githubPaginate,
} from '../scripts/lib/github.mjs';

describe('retryWaitMs', () => {
  test('honors Retry-After seconds', () => {
    const res = new Response('', { headers: { 'retry-after': '5' } });
    assert.equal(retryWaitMs(res, 1), 5000);
  });

  test('falls back to exponential backoff capped at 30s', () => {
    assert.equal(retryWaitMs(null, 1), 1000);
    assert.equal(retryWaitMs(null, 2), 2000);
    assert.equal(retryWaitMs(null, 10), 30_000);
  });
});

describe('isRetryableGithubStatus', () => {
  test('retries rate limits and gateway errors', () => {
    for (const s of [408, 429, 500, 502, 503, 504]) {
      assert.equal(isRetryableGithubStatus(s), true, String(s));
    }
  });

  test('does not retry ordinary client errors', () => {
    for (const s of [400, 401, 403, 404, 422]) {
      assert.equal(isRetryableGithubStatus(s), false, String(s));
    }
  });
});

describe('githubRequest', () => {
  test('retries 429 then succeeds', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (calls.length === 1) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '1' } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const sleeps = [];
    const result = await githubRequest('/repos/ciderapp/translations/issues/1', {
      token: 't',
      fetchImpl,
      sleepFn: async (ms) => { sleeps.push(ms); },
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 2);
    assert.equal(sleeps[0], 1000);
  });

  test('treats DELETE 404 as success', async () => {
    const result = await githubRequest('/repos/x/y/issues/1/labels/approved', {
      token: 't',
      method: 'DELETE',
      fetchImpl: async () => new Response('not found', { status: 404 }),
      retries: 1,
    });
    assert.equal(result, null);
  });

  test('fails loudly on 403 without retrying', async () => {
    let calls = 0;
    await assert.rejects(
      () => githubRequest('/repos/x/y', {
        token: 't',
        fetchImpl: async () => {
          calls += 1;
          return new Response('nope', { status: 403 });
        },
        retries: 4,
      }),
      /403/,
    );
    assert.equal(calls, 1);
  });

  test('fails if GITHUB_TOKEN is missing', async () => {
    await assert.rejects(
      () => githubRequest('/repos/x/y', { token: '', retries: 1 }),
      /GITHUB_TOKEN/,
    );
  });
});

describe('githubPaginate', () => {
  test('walks pages until a short one', async () => {
    const pages = [];
    const fetchImpl = async (url) => {
      const u = new URL(url);
      pages.push(u.searchParams.get('page'));
      const page = Number(u.searchParams.get('page'));
      const body = page === 1
        ? Array.from({ length: 100 }, (_, i) => ({ id: i }))
        : [{ id: 100 }];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const items = await githubPaginate('/repos/x/y/issues?state=open', {
      token: 't',
      fetchImpl,
    });
    assert.equal(items.length, 101);
    assert.equal(items[0].id, 0);
    assert.equal(items.at(-1).id, 100);
    assert.deepEqual(pages, ['1', '2']);
  });
});
