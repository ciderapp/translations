/**
 * YAML translation files attached to a GitHub issue.
 *
 * GitHub issue bodies cap out around 64 KiB, so a full locale (thousands of
 * keys) has to ride as a user-attachments file. Issue #77 (Icelandic) is
 * that shape: the Translations field is a placeholder, and is.yaml is linked
 * from Notes.
 *
 * Only github.com/user-attachments/files/<id>/<name>.yml is fetched.
 * Redirects must stay on GitHub/GitHubusercontent/S3 HTTPS hosts. Size,
 * YAML-map, and key-shape checks happen before anything is applied.
 */

import { parse as parseYaml } from 'yaml';
import { LANG_RE } from './bcp47.mjs';

export const MAX_ATTACHMENT_BYTES = 1_500_000;
export const MAX_ATTACHMENT_REDIRECTS = 5;

export const ATTACHMENT_URL_RE =
  /https:\/\/github\.com\/user-attachments\/files\/\d+\/[A-Za-z0-9._-]+\.ya?ml/gi;

const INITIAL_PATH = /^\/user-attachments\/files\/\d+\/[A-Za-z0-9._-]+\.ya?ml$/i;

export function isAllowedInitialUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:'
      && u.hostname === 'github.com'
      && INITIAL_PATH.test(u.pathname);
  } catch {
    return false;
  }
}

export function isAllowedRedirectHost(hostname) {
  const h = String(hostname ?? '').toLowerCase();
  if (h === 'github.com') return true;
  if (h === 'objects.githubusercontent.com') return true;
  if (h.endsWith('.githubusercontent.com')) return true;
  if (h.endsWith('.s3.amazonaws.com')) return true;
  if (/\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(h)) return true;
  return false;
}

export function extractAttachmentUrls(text) {
  if (typeof text !== 'string' || !text) return [];
  const found = text.match(ATTACHMENT_URL_RE) ?? [];
  return [...new Set(found)];
}

export function pickAttachmentUrl(urls, language) {
  if (!Array.isArray(urls) || urls.length === 0) return null;
  if (language && LANG_RE.test(language)) {
    const lower = language.toLowerCase();
    const match = urls.find((u) => {
      const file = u.split('/').pop() ?? '';
      const stem = file.replace(/\.ya?ml$/i, '').toLowerCase();
      return stem === lower || stem.startsWith(`${lower}.`) || stem.startsWith(`${lower}-`);
    });
    if (match) return match;
  }
  return urls[0];
}

export async function fetchAttachmentText(url, {
  fetchImpl = globalThis.fetch,
  maxBytes = MAX_ATTACHMENT_BYTES,
  maxRedirects = MAX_ATTACHMENT_REDIRECTS,
} = {}) {
  if (!isAllowedInitialUrl(url)) {
    throw new Error('Attachment URL is not a GitHub user-attachments YAML file.');
  }
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetchImpl(current, {
      redirect: 'manual',
      headers: {
        Accept: 'application/octet-stream, text/plain, application/x-yaml, text/yaml, */*',
      },
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('Attachment redirect missing Location.');
      const next = new URL(loc, current);
      if (next.protocol !== 'https:') {
        throw new Error('Attachment redirect must be https.');
      }
      if (!isAllowedRedirectHost(next.hostname)) {
        throw new Error(`Refusing attachment redirect host ${next.hostname}.`);
      }
      current = next.toString();
      continue;
    }
    if (!res.ok) throw new Error(`Attachment download failed (${res.status}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error(`Attachment too large (${buf.length} bytes; max ${maxBytes}).`);
    }
    return buf.toString('utf8');
  }
  throw new Error('Too many redirects fetching attachment.');
}

/** Same YAML-map rules as the Translations field, minus GitHub fences. */
export function parseTranslationsYaml(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { __error: 'Attached file is empty.' };
  }
  let text = raw.replace(/^\uFEFF/, '').trim();
  text = text.replace(/^```(?:yaml|yml)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  try {
    const parsed = parseYaml(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { __error: 'Attached file did not parse as a YAML map.' };
    }
    return parsed;
  } catch (e) {
    return { __error: `YAML parse error: ${e.message}` };
  }
}

export function translationsNeedAttachment(parsed) {
  return Boolean(parsed?.__error);
}

/**
 * Load a YAML map from an issue body and/or comments.
 * Returns { translations, url } or { error }.
 */
export async function loadIssueAttachmentTranslations({
  body,
  comments = [],
  language,
  fetchImpl = globalThis.fetch,
} = {}) {
  const texts = [body, ...comments.map((c) => c?.body)].filter((t) => typeof t === 'string');
  const urls = [...new Set(texts.flatMap(extractAttachmentUrls))];
  if (urls.length === 0) {
    return {
      error: 'No YAML attachment found. Attach a .yml file on this issue (github.com/user-attachments) or paste key: value lines in Translations.',
    };
  }
  const url = pickAttachmentUrl(urls, language);
  try {
    const raw = await fetchAttachmentText(url, { fetchImpl });
    const parsed = parseTranslationsYaml(raw);
    if (parsed.__error) return { error: `Attached file did not parse: ${parsed.__error}`, url };
    return { translations: parsed, url };
  } catch (e) {
    return { error: `Could not read the attached YAML (${e.message}).`, url };
  }
}
