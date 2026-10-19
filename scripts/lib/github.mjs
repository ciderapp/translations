/**
 * GitHub REST helper with retries.
 *
 * Used by the issue bot and the approved-issue sweep. 429 / 5xx responses
 * and network failures retry with exponential backoff, honoring Retry-After.
 */

export function retryWaitMs(res, attempt) {
  const header = res?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(seconds * 1000, 1000);
    }
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(date - Date.now(), 1000);
  }
  const base = 1000 * (2 ** (attempt - 1));
  return Math.min(base, 30_000);
}

export function isRetryableGithubStatus(status) {
  return status === 408
    || status === 429
    || status === 500
    || status === 502
    || status === 503
    || status === 504;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch a GitHub REST path (`/repos/...`) with retries.
 *
 * `body` is JSON-encoded when provided. DELETE of a missing resource (404)
 * is treated as success so label cleanup is idempotent.
 */
export async function githubRequest(path, {
  token = process.env.GITHUB_TOKEN,
  method = 'GET',
  body,
  retries = 6,
  fetchImpl = globalThis.fetch,
  sleepFn = sleep,
  headers = {},
} = {}) {
  if (!token) throw new Error('GITHUB_TOKEN is not set.');

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(`https://api.github.com${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (method === 'DELETE' && res.status === 404) return null;
      if (res.status === 204) return null;

      if (isRetryableGithubStatus(res.status) && attempt < retries) {
        const wait = retryWaitMs(res, attempt);
        console.warn(`[github] ${method} ${path} ${res.status}; retry ${attempt}/${retries} in ${wait}ms`);
        await sleepFn(wait);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub API ${path} ${res.status}: ${text.slice(0, 300)}`);
      }
      return res.json();
    } catch (err) {
      lastErr = err;
      const retryable = isRetryableGithubStatus(err?.status)
        || /GitHub API .* (408|429|500|502|503|504)/.test(String(err?.message))
        || err?.name === 'TypeError'
        || err?.name === 'FetchError';
      // Thrown Error from !res.ok is not retried here except via status in
      // the message; network failures (TypeError from fetch) are retried.
      if (attempt < retries && (retryable || err?.name === 'TypeError')) {
        const wait = retryWaitMs(null, attempt);
        console.warn(`[github] ${method} ${path} ${err.message}; retry ${attempt}/${retries} in ${wait}ms`);
        await sleepFn(wait);
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error(`GitHub API ${path} failed after ${retries} retries`);
}

/** Walk up to 20 pages of a list endpoint. `path` may already include a query. */
export async function githubPaginate(path, opts = {}) {
  const items = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= 20; page++) {
    const batch = await githubRequest(`${path}${sep}per_page=100&page=${page}`, opts);
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}
