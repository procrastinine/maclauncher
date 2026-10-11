const TRANSIENT_CODES = new Set(["ERR_FAILED", "ERR_CONNECTION_REFUSED", "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED"]);

/** Recover a restarted local Chromium network service without another app start. */
async function loadLocalView({ url, load, isDestroyed = () => false, logger,
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }) {
  const parsed = new URL(url);
  const local = ["http:", "https:"].includes(parsed.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  for (let attempt = 0; ; attempt++) {
    if (isDestroyed()) return false;
    try { await load(url); return true; }
    catch (error) {
      const transient = TRANSIENT_CODES.has(error.code) || [...TRANSIENT_CODES].some(code => String(error.message).includes(code));
      if (!local || !transient || attempt >= 2 || isDestroyed()) throw error;
      logger?.warn?.("[view] local renderer connection interrupted; retrying", { attempt: attempt + 1, code: error.code || error.message });
      await delay(attempt === 0 ? 100 : 300);
    }
  }
}

module.exports = { loadLocalView };
