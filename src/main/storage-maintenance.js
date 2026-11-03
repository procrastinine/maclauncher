// Starts one derived-data upkeep pass (core/storage-maintenance.js) per app
// start, in the background once startup settles. While games run or prepare,
// or downloads run, the pass waits and checks again; after it runs, nothing
// repeats until the next start. Results go to the log only.
function scheduleStorageMaintenance({ request, isQuiet = () => true, logger,
  firstDelayMs = 2 * 60 * 1000, retryMs = 10 * 60 * 1000 } = {}) {
  let timer = null, stopped = false;
  const later = delay => {
    if (stopped) return;
    timer = setTimeout(run, delay);
    timer.unref?.();
  };
  async function run() {
    timer = null;
    let quiet = false;
    try { quiet = isQuiet(); } catch {}
    if (!quiet) { later(retryMs); return; }
    stopped = true;
    try { await request(); }
    catch (error) { logger?.warn?.(`[storage] upkeep could not run: ${error?.message || error}`); }
  }
  later(firstDelayMs);
  return { stop() { stopped = true; clearTimeout(timer); timer = null; } };
}

module.exports = { scheduleStorageMaintenance };
