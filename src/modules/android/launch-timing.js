// Cold launch work only. Both execution engines report the active operation
// before awaiting it, including launches that never reach an app process.
function createLaunchTiming(logger) {
  const began = performance.now(), phases = {};
  async function measure(name, operation) {
    const start = performance.now();
    logger?.info?.("[android] Preparing: " + name);
    try { return await operation(); }
    finally {
      const elapsed = Math.round(performance.now() - start);
      phases[name] = (phases[name] || 0) + elapsed;
      logger?.info?.("[android] Preparation " + name + " (ms): " + elapsed);
    }
  }
  function finish() {
    logger?.info?.("[android] Launch preparation (ms): " + JSON.stringify({ ...phases, total: Math.round(performance.now() - began) }));
  }
  return { measure, finish };
}
module.exports = { createLaunchTiming };
