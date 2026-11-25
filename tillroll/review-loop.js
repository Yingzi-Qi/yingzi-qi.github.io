// The sanity-check button is owned by another part of the review loop.
// This hook is the only local surface: a coordinator can set reviewLoop.start,
// and each look-up run records whether the service paused.

export const reviewLoop = {
  start: null,
  lastResult: null,
};

export function recordLookupRun(result) {
  reviewLoop.lastResult = {
    lookupsPaused: Boolean(result?.lookupsPaused),
    pausedReasons: [...(result?.pausedReasons || [])],
    lookupsUsed: result?.lookupsUsed ?? 0,
    lookupsDeferred: result?.lookupsDeferred ?? 0,
  };
  return reviewLoop.lastResult;
}

export function runSanityChecks(context) {
  if (typeof reviewLoop.start !== 'function') return null;
  return reviewLoop.start(context);
}
