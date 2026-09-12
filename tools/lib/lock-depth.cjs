/**
 * Normalise a requested hop depth.
 *
 * Exists because `parseInt(String(args.depth || 2), 10) || 2` erased an explicit
 * zero twice over: `args.depth || 2` turns 0 into 2 because 0 is falsy, and the
 * trailing `|| 2` turns the parsed 0 back into 2. lock_subgraph therefore locked
 * two hops for every caller that asked for one node — including every worker
 * following this project's own instruction to lock with depth 0.
 *
 * The distinction that matters: "no value given" and "unreadable value" fall
 * back to the default, while a value that reads as 0 stays 0. `??` alone is not
 * enough — parseInt("abc") is NaN, which has to be caught explicitly, because
 * any truthy-based fallback re-introduces exactly this bug.
 */
const MAX_DEPTH = 10;

function normalizeDepth(value, fallback = 2) {
  const raw = value ?? fallback;
  const parsed = parseInt(String(raw), 10);
  const depth = Number.isNaN(parsed) ? fallback : parsed;
  return Math.max(0, Math.min(MAX_DEPTH, depth));
}

module.exports = { normalizeDepth, MAX_DEPTH };
