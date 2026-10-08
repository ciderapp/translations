// Preloaded with `node --import` by test/fill-plan.test.mjs. Replaces fetch so
// the fill runs end to end without the Anthropic API: every string comes back
// prefixed with "DE: ", except mobile.bad.* keys, which come back with a
// straight apostrophe that quotes their placeholder away. Each request's
// system prompt is appended to $MOCK_LOG for the test to inspect.

import { appendFileSync } from 'fs';

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (process.env.MOCK_LOG) appendFileSync(process.env.MOCK_LOG, JSON.stringify(body.system) + '\n');
  const json = body.messages[0].content.slice(body.messages[0].content.indexOf('{'));
  const strings = JSON.parse(json);
  const out = {};
  for (const [k, v] of Object.entries(strings)) {
    out[k] = k.startsWith('mobile.bad.') ? "Ajouté à l'{playlist}" : `DE: ${v}`;
  }
  return new Response(JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(out) }],
    stop_reason: 'end_turn',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};
