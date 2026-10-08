/**
 * The en-US.yml writer. It must produce exactly what Citadel's extractor
 * (scripts/i18n-extract.mjs in ciderapp/Citadel) writes, byte for byte: both
 * mirrors decide "nothing to sync" by diffing the file, so any formatting
 * difference would commit a reformat on every sync and the two would
 * ping-pong. test/sync-source.test.mjs round-trips the committed file.
 */

import { Document } from 'yaml';

// Values that YAML 1.1 parsers read as booleans or nulls (e.g. "On", "Yes")
// must be quoted, or downstream tooling sees `true` instead of text.
const YAML11_AMBIGUOUS = /^(?:y|n|yes|no|true|false|on|off|null|~)$/i;

export function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

export function stringifySource(obj) {
  const doc = new Document(sortKeys(obj));
  for (const pair of doc.contents?.items ?? []) {
    const scalar = pair.value;
    if (typeof scalar?.value === 'string' && YAML11_AMBIGUOUS.test(scalar.value)) {
      scalar.type = 'QUOTE_DOUBLE';
    }
  }
  return doc.toString({ lineWidth: 0, defaultStringType: 'PLAIN' });
}
