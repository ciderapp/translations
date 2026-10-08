/**
 * Key-level three-way merge of one locale and its fill state, for a push that
 * lost a race. The fill and the issue apply both write locales/<lang>.yml,
 * under separate concurrency groups, so either can be rejected because the
 * other landed first. Instead of replaying a textual diff with `git rebase`
 * (two writers touching neighbouring lines of a sorted file conflict), the
 * job resets to the new tip and merges the maps:
 *
 *   - a key only one side changed takes that side;
 *   - a key both sides changed goes to the human-contributed side, else to
 *     theirs (the commit that is already on main);
 *   - a key's fill-state stamp always travels with the value that won, so
 *     the next fill judges it against the English it was really made from.
 */

function canonical(v) {
  if (v === undefined) return undefined;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))));
  }
  return JSON.stringify(v);
}

const same = (a, b) => canonical(a) === canonical(b);
const isHuman = (e) => !!e && typeof e === 'object' && e.source === 'human';

export function mergeLocale3({
  base = {}, ours = {}, theirs = {},
  baseState = {}, oursState = {}, theirsState = {},
}) {
  const locale = {};
  const state = {};
  const conflicts = [];

  const keys = new Set([
    ...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs),
    ...Object.keys(baseState), ...Object.keys(oursState), ...Object.keys(theirsState),
  ]);

  for (const key of keys) {
    const vb = base[key], vo = ours[key], vt = theirs[key];
    const sb = baseState[key], so = oursState[key], st = theirsState[key];
    const oursChanged = !same(vo, vb);
    const theirsChanged = !same(vt, vb);

    let value, stamp;
    if (!oursChanged && !theirsChanged) {
      value = vt;
      // A stamp-only change (seeding a locale's state) on one side survives.
      stamp = (so !== sb && st === sb) ? so : st;
    } else if (oursChanged && !theirsChanged) {
      value = vo; stamp = so;
    } else if (!oursChanged && theirsChanged) {
      value = vt; stamp = st;
    } else if (same(vo, vt)) {
      value = vt; stamp = st ?? so;
    } else {
      conflicts.push(key);
      const oursWins = !isHuman(vt) && isHuman(vo);
      value = oursWins ? vo : vt;
      stamp = oursWins ? so : st;
    }

    if (value !== undefined) locale[key] = value;
    if (value !== undefined && stamp !== undefined) state[key] = stamp;
  }

  return { locale, state, conflicts };
}
