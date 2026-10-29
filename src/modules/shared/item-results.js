// Per-item outcomes of an aggregate (rows, presets, collections, packages,
// models). One item's failure is recorded with its id and reason and the
// aggregate continues; only cancellation and a changed launch end it. A caller
// that cannot use a partial result validates its own envelope first.
const reason = error => String(error?.message || error || "This item could not be read.").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 512);
function fatal(error, signal) {
  return Boolean(signal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR" || error?.code === "GRAPHICS_LIVE_STALE");
}
const identify = (id, item, index) => typeof id === "function" ? id(item, index) : item?.id ?? index;
// {results, failures: [{id, reason, error}]}; `results` keeps item order.
function settle(items, run, {id, signal} = {}) {
  const results = [], failures = [];let index = 0;
  for (const item of items) {
    signal?.throwIfAborted();
    try { results.push(run(item, index)); }
    catch (error) { if (fatal(error, signal)) throw error;failures.push({id: identify(id, item, index), reason: reason(error), error}); }
    index++;
  }
  return {results, failures};
}
async function settleAsync(items, run, {id, signal} = {}) {
  const results = [], failures = [];let index = 0;
  for (const item of items) {
    signal?.throwIfAborted();
    try { results.push(await run(item, index)); }
    catch (error) { if (fatal(error, signal)) throw error;failures.push({id: identify(id, item, index), reason: reason(error), error}); }
    index++;
  }
  return {results, failures};
}
// One section of a larger result: its value, or `fallback` and the reason.
function section(read, fallback, failures, id) {
  try { return read(); }
  catch (error) { if (fatal(error)) throw error;failures?.push({id, reason: reason(error), error});return fallback; }
}
module.exports = {settle, settleAsync, section, fatal, reason};
