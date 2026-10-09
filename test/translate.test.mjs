// Tests for the Anthropic-backed i18n translator.
//
// Run: `node --test test/`  (requires Node 22+)
//
// Covers request shape, response parsing, 429 Retry-After handling, and
// provenance merge. Live Anthropic calls are mocked; no API key required.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MODEL,
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  DEFAULT_MAX_TOKENS,
  HAIKU_MIN_CACHE_TOKENS,
  CACHE_CONTROL,
  SYSTEM_PROMPT,
  SHARED_CACHE_PREFIX,
  buildUserPrompt,
  buildMessagesRequest,
  buildSystemBlocks,
  extractTextFromMessage,
  parseTranslationJson,
  retryWaitMs,
  callAnthropic,
  mergeTranslations,
  estimateTokensLowerBound,
  extractCacheUsage,
  emptyCacheTotals,
  addCacheUsage,
  formatCacheUsage,
  formatCacheTotals,
} from '../scripts/i18n-translate.mjs';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('request shape', () => {
  test('uses the official Claude Haiku 5.5 model id', () => {
    assert.equal(DEFAULT_MODEL, 'claude-haiku-5-5');
  });

  test('requires max_tokens and a top-level system field', () => {
    const req = buildMessagesRequest({
      model: DEFAULT_MODEL,
      maxTokens: DEFAULT_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      user: 'hello',
    });
    assert.equal(req.model, 'claude-haiku-5-5');
    assert.equal(req.max_tokens, DEFAULT_MAX_TOKENS);
    assert.deepEqual(req.system, buildSystemBlocks(SYSTEM_PROMPT));
    assert.deepEqual(req.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(req.output_config.effort, 'low');
    assert.equal('temperature' in req, false);
    assert.equal('top_p' in req, false);
    assert.equal('top_k' in req, false);
  });

  test('system prompt keeps placeholder and glossary rules', () => {
    assert.match(SYSTEM_PROMPT, /\$\{variable\}/);
    assert.match(SYSTEM_PROMPT, /\$VARIABLE/);
    assert.match(SYSTEM_PROMPT, /\{\{\s*variable\s*\}\}/);
    assert.match(SYSTEM_PROMPT, /Cider/);
    assert.match(SYSTEM_PROMPT, /Apple Music/);
    assert.match(SYSTEM_PROMPT, /AirPlay/);
    assert.match(SYSTEM_PROMPT, /Dolby Atmos/);
    assert.match(SYSTEM_PROMPT, /Chromecast/);
    assert.match(SYSTEM_PROMPT, /AudioLab/);
    assert.match(SYSTEM_PROMPT, /JSON object/);
  });

  test('user prompt includes locale and source JSON', () => {
    const prompt = buildUserPrompt({ 'action.apply': 'Apply' }, 'es', 'Spanish');
    assert.match(prompt, /Spanish \(locale: es\)/);
    assert.match(prompt, /"action\.apply": "Apply"/);
  });
});

describe('extractTextFromMessage', () => {
  test('selects text blocks by type, not by position', () => {
    const text = extractTextFromMessage({
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: '{"a":"b"}' },
      ],
    });
    assert.equal(text, '{"a":"b"}');
  });

  test('concatenates multiple text blocks', () => {
    const text = extractTextFromMessage({
      content: [
        { type: 'text', text: '{"a":' },
        { type: 'text', text: '"b"}' },
      ],
    });
    assert.equal(text, '{"a":"b"}');
  });

  test('returns empty string when there is no text block', () => {
    assert.equal(extractTextFromMessage({ content: [{ type: 'thinking' }] }), '');
    assert.equal(extractTextFromMessage({}), '');
  });
});

describe('parseTranslationJson', () => {
  test('parses a bare JSON object', () => {
    assert.deepEqual(parseTranslationJson('{"action.apply":"Aplicar"}'), {
      'action.apply': 'Aplicar',
    });
  });

  test('strips optional markdown fences around the JSON object', () => {
    const fenced = '```json\n{"action.apply":"Aplicar"}\n```';
    assert.deepEqual(parseTranslationJson(fenced), { 'action.apply': 'Aplicar' });
  });

  test('throws when there is no JSON object', () => {
    assert.throws(() => parseTranslationJson('sorry, no'), /No JSON object found in Claude response/);
  });
});

describe('retryWaitMs', () => {
  test('honors Retry-After seconds', () => {
    const res = new Response(null, { headers: { 'retry-after': '4' } });
    assert.equal(retryWaitMs(res, 1), 4000);
  });

  test('falls back to 2000 * attempt when the header is missing', () => {
    const res = new Response(null);
    assert.equal(retryWaitMs(res, 2), 4000);
  });
});

describe('callAnthropic', () => {
  const sleeps = [];
  const sleepFn = async (ms) => { sleeps.push(ms); };

  test('POSTs to /v1/messages with x-api-key and anthropic-version', async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return jsonResponse({
        content: [{ type: 'text', text: '{"k":"v"}' }],
        stop_reason: 'end_turn',
      });
    };

    const text = await callAnthropic('user', {
      apiKey: 'sk-ant-test',
      fetchImpl,
      sleepFn,
    });

    assert.equal(text, '{"k":"v"}');
    assert.equal(captured.url, ANTHROPIC_MESSAGES_URL);
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers['x-api-key'], 'sk-ant-test');
    assert.equal(captured.init.headers['anthropic-version'], ANTHROPIC_VERSION);
    assert.equal(captured.init.headers['content-type'], 'application/json');

    const body = JSON.parse(captured.init.body);
    assert.equal(body.model, DEFAULT_MODEL);
    assert.equal(typeof body.max_tokens, 'number');
    assert.ok(body.max_tokens > 0);
    assert.equal(Array.isArray(body.system), true);
    assert.equal('temperature' in body, false);
  });

  test('retries 429 using Retry-After, then succeeds', async () => {
    sleeps.length = 0;
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '1' },
        });
      }
      return jsonResponse({
        content: [{ type: 'text', text: '{"ok":"yes"}' }],
        stop_reason: 'end_turn',
      });
    };

    const text = await callAnthropic('user', {
      apiKey: 'sk-ant-test',
      fetchImpl,
      sleepFn,
    });
    assert.equal(text, '{"ok":"yes"}');
    assert.equal(calls, 2);
    assert.equal(sleeps[0], 1000);
  });

  test('retries 529 overloaded_error', async () => {
    sleeps.length = 0;
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return new Response('overloaded', { status: 529 });
      return jsonResponse({
        content: [{ type: 'text', text: '{"ok":"yes"}' }],
        stop_reason: 'end_turn',
      });
    };

    const text = await callAnthropic('user', {
      apiKey: 'sk-ant-test',
      fetchImpl,
      sleepFn,
    });
    assert.equal(text, '{"ok":"yes"}');
    assert.equal(calls, 2);
  });

  test('throws when the key is missing', async () => {
    await assert.rejects(
      () => callAnthropic('user', { apiKey: '', fetchImpl: async () => {}, sleepFn }),
      /ANTHROPIC_API_KEY is not set/,
    );
  });

  test('throws on refusal stop_reason', async () => {
    const fetchImpl = async () => jsonResponse({
      content: [{ type: 'text', text: 'nope' }],
      stop_reason: 'refusal',
    });
    await assert.rejects(
      () => callAnthropic('user', { apiKey: 'sk-ant-test', fetchImpl, sleepFn, retries: 1 }),
      /refused/,
    );
  });

  test('throws when output is truncated at max_tokens', async () => {
    const fetchImpl = async () => jsonResponse({
      content: [{ type: 'text', text: '{"partial"' }],
      stop_reason: 'max_tokens',
    });
    await assert.rejects(
      () => callAnthropic('user', { apiKey: 'sk-ant-test', fetchImpl, sleepFn, retries: 1 }),
      /truncated/,
    );
  });
});

describe('prompt cache', () => {
  test('Haiku 5.5 minimum cacheable length is 512 tokens', () => {
    assert.equal(HAIKU_MIN_CACHE_TOKENS, 512);
  });

  test('shared prefix meets the Haiku 5.5 minimum (lower-bound estimate)', () => {
    const est = estimateTokensLowerBound(SHARED_CACHE_PREFIX);
    assert.ok(est >= HAIKU_MIN_CACHE_TOKENS, `estimated ${est} tokens, need ${HAIKU_MIN_CACHE_TOKENS}`);
  });

  test('places cache_control on the shared system block, not the user message', () => {
    const req = buildMessagesRequest({
      model: DEFAULT_MODEL,
      maxTokens: DEFAULT_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      user: '{"action.apply":"Apply"}',
    });
    assert.equal(req.system[0].type, 'text');
    assert.equal(req.system[0].text, SHARED_CACHE_PREFIX);
    assert.deepEqual(req.system[0].cache_control, CACHE_CONTROL);
    assert.equal(CACHE_CONTROL.type, 'ephemeral');
    assert.equal(CACHE_CONTROL.ttl, '5m');
    assert.equal(req.system[1].text, SYSTEM_PROMPT);
    assert.equal('cache_control' in req.system[1], false);
    assert.equal(req.messages[0].role, 'user');
    assert.equal(req.messages[0].content, '{"action.apply":"Apply"}');
    assert.equal('cache_control' in req.messages[0], false);
    assert.equal('cache_control' in req, false);
  });

  test('keeps an explicit system array as-is', () => {
    const system = buildSystemBlocks('variant');
    const req = buildMessagesRequest({
      model: DEFAULT_MODEL,
      maxTokens: 16,
      system,
      user: 'x',
    });
    assert.equal(req.system, system);
  });

  test('extractCacheUsage reads cache_creation_input_tokens and cache_read_input_tokens', () => {
    assert.deepEqual(extractCacheUsage({
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 640,
        cache_read_input_tokens: 80,
      },
    }), { cacheCreation: 640, cacheRead: 80, input: 12 });
    assert.deepEqual(extractCacheUsage({}), { cacheCreation: 0, cacheRead: 0, input: 0 });
  });

  test('usage helpers format per-request and run totals', () => {
    const totals = emptyCacheTotals();
    addCacheUsage(totals, { cacheCreation: 640, cacheRead: 0, input: 10 });
    addCacheUsage(totals, { cacheCreation: 0, cacheRead: 640, input: 10 });
    assert.equal(formatCacheUsage({ cacheCreation: 0, cacheRead: 640 }), 'cache write 0 · cache read 640');
    assert.equal(formatCacheTotals(totals), 'Prompt cache totals: write 640 tokens, read 640 tokens, 2 request(s)');
  });

  test('callAnthropic reports usage through onUsage', async () => {
    const seen = [];
    const fetchImpl = async () => jsonResponse({
      content: [{ type: 'text', text: '{"k":"v"}' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 9,
        cache_creation_input_tokens: 700,
        cache_read_input_tokens: 0,
      },
    });
    const text = await callAnthropic('user', {
      apiKey: 'sk-ant-test',
      fetchImpl,
      sleepFn: async () => {},
      onUsage: (u) => seen.push(u),
    });
    assert.equal(text, '{"k":"v"}');
    assert.deepEqual(seen, [{ cacheCreation: 700, cacheRead: 0, input: 9 }]);
  });
});

describe('mergeTranslations', () => {
  test('writes scalars for new AI keys', () => {
    const out = mergeTranslations({}, { 'action.apply': 'Aplicar' }, new Set());
    assert.equal(out['action.apply'], 'Aplicar');
  });

  test('preserves human attribution when English source changes', () => {
    const existing = {
      'action.back': { value: 'Atrás', source: 'human', by: '@user', issue: 12 },
    };
    const out = mergeTranslations(existing, { 'action.back': 'Volver' }, new Set(['action.back']));
    assert.equal(out['action.back'].value, 'Volver');
    assert.equal(out['action.back'].source, 'ai');
    assert.equal(out['action.back'].by, '@user');
    assert.equal(out['action.back'].issue, 12);
    assert.match(out['action.back'].superseded_at, /^\d{4}-\d{2}-\d{2}$/);
  });
});
