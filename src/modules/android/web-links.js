const { TextDecoder } = require("node:util");
const advertisingHosts = require("./runtime-source").json("native/resources/ad-hosts.json");
const MAX_BYTES = 8192;

function advertisingUrl(value) {
  const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  return advertisingHosts.some(host => hostname === host || hostname.endsWith("." + host));
}

/** Capture one browser policy before either execution backend starts. */
function prepareLaunch(config, context, dependencies = {}) {
  const shell = context.ui?.shell || context.shell;
  const confirm = dependencies.confirmGameLink || require("./browser-consent").confirmGameLink;
  const allowed = config.webLinksAllowed === 1 && !require("./launch-policy").networkBlocked(context) &&
    typeof shell?.openExternal === "function" && typeof confirm === "function";
  if (config.webLinksAllowed != null) config.webLinksAllowed = allowed ? 1 : 0;
  const allowAds = context.runtimeSettings?.allowAds === true;
  return { attach(child, { executablePath, launchedAt, presentation = child }) {
    if (config.webLinksAllowed == null) return () => {};
    return attachWebLinks(child, { allowed, allowAds,
      confirmOpen: url => confirm(presentation, { executablePath, launchedAt, title: config.title, url }),
      openExternal: shell?.openExternal?.bind(shell), logger: context.logger });
  } };
}

// This runs outside the guest sandbox. Treat every byte as an untrusted request,
// including requests sent directly by native game code instead of the API bridge.
function webUrl(value) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > MAX_BYTES ||
      /[\u0000-\u0020\u007f\\]/u.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
  return Buffer.byteLength(url.href) <= MAX_BYTES ? url.href : null;
}

function attachWebLinks(child, { allowed, allowAds = false, confirmOpen, openExternal, logger, now = Date.now }) {
  const input = child.stdio?.[3];
  if (!input) return () => {};
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let closed = false, header = Buffer.alloc(2), headerBytes = 0, body = null, bodyBytes = 0;
  let inFlight = false, windowStart = now(), requests = 0;
  const promptedOrigins = new Map();
  function close() {
    if (closed) return;
    closed = true; body = null; promptedOrigins.clear();
    input.removeListener("data", data); input.removeListener("error", close); input.removeListener("end", close);
    child.removeListener("exit", close); child.removeListener("close", close);
    input.destroy();
  }
  function request(bytes) {
    if (!allowed || typeof openExternal !== "function" || typeof confirmOpen !== "function") return close();
    let value;
    try { value = webUrl(decoder.decode(bytes)); } catch { return close(); }
    if (!value) return close();
    // Advertising redirects must not create a prompt.
    if (!allowAds && advertisingUrl(value)) return;
    const time = now();
    if (time - windowStart >= 60000) { windowStart = time; requests = 0; }
    if (++requests > 32) return close();
    // One request owns the UI at a time; an SDK cannot build a dialog queue.
    if (inFlight) return;
    for (const [origin, timestamp] of promptedOrigins) if (time - timestamp >= 60000) promptedOrigins.delete(origin);
    const origin = new URL(value).origin;
    if (promptedOrigins.has(origin)) return;
    promptedOrigins.set(origin, time); inFlight = true;
    Promise.resolve().then(async () => {
      if (!closed && await confirmOpen(value) === true && !closed) await openExternal(value);
    })
      .catch(() => logger?.warn?.("[android] The web link could not be opened in the default browser."))
      .finally(() => { inFlight = false; });
  }
  function data(chunk) {
    if (closed) return;
    for (let at = 0; at < chunk.length && !closed;) {
      if (!body) {
        const size = Math.min(2 - headerBytes, chunk.length - at);
        chunk.copy(header, headerBytes, at, at + size); at += size; headerBytes += size;
        if (headerBytes !== 2) continue;
        const length = header.readUInt16BE(0); headerBytes = 0;
        if (!length || length > MAX_BYTES) { close(); return; }
        body = Buffer.allocUnsafe(length); bodyBytes = 0;
      }
      const size = Math.min(body.length - bodyBytes, chunk.length - at);
      chunk.copy(body, bodyBytes, at, at + size); at += size; bodyBytes += size;
      if (bodyBytes === body.length) { const complete = body; body = null; request(complete); }
    }
  }
  input.on("data", data); input.once("error", close); input.once("end", close);
  child.once("exit", close); child.once("close", close); input.unref?.();
  if (child.exitCode != null || child.signalCode != null) close();
  return close;
}

module.exports = { attachWebLinks, prepareLaunch, webUrl, advertisingUrl };
