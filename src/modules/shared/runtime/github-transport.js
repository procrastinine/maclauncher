const https = require("node:https");
const { promisify } = require("node:util");
const execute = promisify(require("node:child_process").execFile);
const CLI = require("./github-cli");
const { createAbortError, throwIfAborted, attachAbortSignal } = require("./download-utils");
const { createWebFallback } = require("./github-web");
const HOSTS = new Set(["api.github.com", "github.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "codeload.github.com"]);
const LIMIT = 32 * 1024 * 1024;
function officialUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname) || url.username || url.password || url.port && url.port !== "443") throw new Error("GitHub request must use an official HTTPS host.");
  return url;
}
function redirectHeaders(headers, before, after) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => before.origin === after.origin || !/^(?:authorization|proxy-authorization|cookie)$/i.test(key)));
}
function requestOfficial(value, { headers = {}, signal, maxBytes = LIMIT, method = "GET", redirectDepth = 0, httpsRequest = https.request } = {}) {
  const url = officialUrl(value); throwIfAborted(signal);
  if (!["GET", "HEAD"].includes(method) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > LIMIT || redirectDepth > 5) return Promise.reject(new Error("GitHub request exceeds its method or response limits."));
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { headers, method }, async response => {
      const status = Number(response.statusCode || 0);
      try {
        if ([301, 302, 303, 307, 308].includes(status)) {
          const next = officialUrl(new URL(response.headers.location || "", url).href); response.resume();
          resolve(await requestOfficial(next.href, { headers: redirectHeaders(headers, url, next), signal, maxBytes, method, redirectDepth: redirectDepth + 1, httpsRequest })); return;
        }
        const chunks = []; let size = 0;
        if (method === "HEAD") response.resume();
        else {
          if (Number(response.headers["content-length"]) > maxBytes) throw new Error("GitHub response exceeds its size limit.");
          for await (const chunk of response) { size += chunk.length; if (size > maxBytes) throw new Error("GitHub response exceeds its size limit."); chunks.push(Buffer.from(chunk)); }
        }
        throwIfAborted(signal);
        const safeHeaders = Object.fromEntries(Object.entries(response.headers).filter(([key]) => !/^(?:set-cookie|authorization|proxy-authorization)$/i.test(key)));
        resolve({ status, headers: safeHeaders, body: Buffer.concat(chunks, size) });
      } catch (error) { response.destroy(); reject(error); }
    });
    const detach = attachAbortSignal(signal, () => request.destroy(createAbortError()));
    request.once("error", reject); request.once("close", detach); request.setTimeout?.(30000, () => request.destroy(new Error("GitHub request timed out."))); request.end();
  });
}
function subscribe(entry, signal) {
  throwIfAborted(signal); const subscriber = Symbol(); entry.subscribers.add(subscriber);
  return new Promise((resolve, reject) => {
    let finished = false;
    const release = () => { entry.subscribers.delete(subscriber); signal?.removeEventListener("abort", cancel); if (!entry.done && !entry.subscribers.size) entry.controller.abort(); };
    const finish = (callback, value) => { if (finished) return; finished = true; release(); callback(value); };
    const cancel = () => finish(reject, createAbortError());
    signal?.addEventListener("abort", cancel, { once: true });
    entry.promise.then(result => finish(resolve, result), error => finish(reject, error));
  });
}
function createGithubTransport({ request = requestOfficial, runCommand = execute, env = process.env, now = Date.now, cacheMs = 15000 } = {}) {
  let authPromise, auth = { checked: false, available: false, authenticated: false }, rejectedToken = false;
  const inflight = new Map(), cache = new Map(), limited = new Map(), repositories = new Map(); let cacheBytes = 0;
  let active = 0;
  const queue = [];
  function acquire(signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const task = { start() { signal?.removeEventListener("abort", cancel); active++; resolve(() => {
        active--; queue.shift()?.start();
      }); } };
      const cancel = () => { const index = queue.indexOf(task); if (index !== -1) queue.splice(index, 1); reject(createAbortError()); };
      if (active < 8) task.start();
      else { queue.push(task); signal?.addEventListener("abort", cancel, { once: true }); }
    });
  }
  async function credential() {
    if (!authPromise) authPromise = (async () => {
      auth = { checked: true, available: false, authenticated: false };
      const executable = CLI.executable({ env });
      auth.available = require("node:path").isAbsolute(executable);
      const fromEnvironment = env.GH_TOKEN || env.GITHUB_TOKEN;
      if (fromEnvironment && /^[A-Za-z0-9_.-]{10,4096}$/.test(fromEnvironment)) { auth.authenticated = true; return fromEnvironment; }
      try {
        const result = await runCommand(executable, ["auth", "token", "--hostname", "github.com"], { timeout: 10000, maxBuffer: 8192, encoding: "utf8", windowsHide: true });
        auth.available = true; const token = String(result.stdout || "").trim();
        if (/^[A-Za-z0-9_.-]{10,4096}$/.test(token)) { auth.authenticated = true; return token; }
      } catch (error) { auth.available = error.code !== "ENOENT"; }
      return null;
    })();
    const value = await authPromise; return rejectedToken ? null : value;
  }
  async function authenticationStatus() { await credential(); return { ...auth }; }
  function headersFor(url, given = {}, token) {
    const headers = { "User-Agent": "MacLauncher", Accept: "application/vnd.github+json", "Cache-Control": "no-cache" };
    for (const [name, value] of Object.entries(given)) if (/^(?:accept|x-github-api-version|git-protocol)$/i.test(name)) headers[name] = String(value);
    if (url.hostname !== "api.github.com") headers.Accept = "text/html, application/xml;q=0.9, */*;q=0.8";
    if (token && url.hostname === "api.github.com") headers.Authorization = "Bearer " + token;
    return headers;
  }
  async function network(value, options = {}, token) {
    const url = officialUrl(value);
    const release = await acquire(options.signal);
    try { return await request(url.href, { ...options, headers: headersFor(url, options.headers, token) }); }
    finally { release(); }
  }
  const web = createWebFallback((url, options) => cached(url, { ...options, publicOnly: true }));
  function rateLimited(response, scope) {
    if (![403, 429].includes(response.status) || response.status !== 429 && String(response.headers?.["x-ratelimit-remaining"]) !== "0" && !/rate limit/i.test(Buffer.from(response.body).toString("utf8"))) return false;
    const reset = Number(response.headers?.["x-ratelimit-reset"]) * 1000;
    const retry = String(response.headers?.["retry-after"] || "");
    const retryAt = /^\d+$/.test(retry) ? now() + Number(retry) * 1000 : Date.parse(retry);
    limited.set(scope, Math.min(now() + 3600000, Math.max(now() + 60000,
      Number.isFinite(reset) ? reset : 0, Number.isFinite(retryAt) ? retryAt : 0))); return true;
  }
  async function perform(value, options) {
    const url = officialUrl(value);
    if (url.hostname !== "api.github.com" || options.publicOnly) return network(url.href, options, null);
    let token = await credential(), scope = token ? "authenticated" : "anonymous", result;
    if (!(limited.get(scope) > now())) {
      result = await network(url.href, options, token);
      if (token && result.status === 401) { rejectedToken = true; auth.authenticated = false; token = null; scope = "anonymous"; result = await network(url.href, options, null); }
      if (result.status === 200) {
        const source = /^\/repos\/([^/]+\/[^/]+)\//.exec(url.pathname)?.[1];
        if (source) for (const match of String(result.headers?.link || "").matchAll(/https:\/\/api\.github\.com\/repositories\/(\d+)\//g)) repositories.set(match[1], source);
        return result;
      }
      if (!rateLimited(result, scope) && result.status < 500) return result;
    }
    const numeric = /^\/repositories\/(\d+)\/(.*)$/.exec(url.pathname);
    if (numeric && repositories.has(numeric[1])) url.pathname = "/repos/" + repositories.get(numeric[1]) + "/" + numeric[2];
    const fallback = await web(url.href, options);
    return fallback || result || { status: 403, headers: { "x-ratelimit-remaining": "0" }, body: Buffer.from('{"message":"GitHub API rate limit reached; authentication is required for this endpoint."}') };
  }
  function cached(value, options = {}) {
    const url = officialUrl(value).href, method = options.method || "GET", maxBytes = options.maxBytes ?? LIMIT;
    if (!["GET", "HEAD"].includes(method) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > LIMIT)
      return Promise.reject(new Error("GitHub request exceeds its method or response limits."));
    const identity = /^sha256:[a-f0-9]{64}$/i.test(options.assetDigest || "") ? options.assetDigest.toLowerCase() : "";
    const representation = Object.entries(options.headers || {}).filter(([name]) => /^(?:accept|x-github-api-version|git-protocol)$/i.test(name))
      .map(([name, value]) => [name.toLowerCase(), String(value)]).sort();
    const key = JSON.stringify([method, url, maxBytes, representation, options.deferAssetSizes === true, identity]);
    throwIfAborted(options.signal); const previous = cache.get(key);
    if (!options.force && previous && previous.expires > now()) return Promise.resolve({ ...previous.response, headers: { ...previous.response.headers }, body: Buffer.from(previous.response.body) });
    let entry = inflight.get(key);
    if (entry?.controller.signal.aborted) { inflight.delete(key); entry = null; }
    if (!entry) {
      entry = { controller: new AbortController(), subscribers: new Set(), done: false };
      entry.promise = perform(url, { ...options, signal: entry.controller.signal }).then(response => {
        const normalized = { status: response.status, headers: response.headers || {}, body: Buffer.from(response.body || []) };
        if (normalized.body.length > maxBytes) throw new Error("GitHub response exceeds its size limit.");
        if (normalized.status === 200 && cacheMs > 0 && normalized.body.length <= 8 * 1024 * 1024) {
          if (cache.has(key)) { cacheBytes -= cache.get(key).response.body.length; cache.delete(key); }
          while (cache.size && (cache.size >= 128 || cacheBytes + normalized.body.length > 32 * 1024 * 1024)) { const oldest = cache.keys().next().value; cacheBytes -= cache.get(oldest).response.body.length; cache.delete(oldest); }
          const duration = method === "HEAD" && identity ? Math.max(cacheMs, 5 * 60000) : cacheMs;
          cache.set(key, { response: normalized, expires: now() + duration }); cacheBytes += normalized.body.length;
        }
        return normalized;
      }).finally(() => { entry.done = true; if (inflight.get(key) === entry) inflight.delete(key); });
      inflight.set(key, entry);
    }
    return subscribe(entry, options.signal).then(response => ({ ...response, headers: { ...response.headers }, body: Buffer.from(response.body) }));
  }
  return { request: cached, authenticatedRequest: cached, authenticationStatus, peekAuthenticationStatus: () => ({ ...auth }) };
}
const local = createGithubTransport(); let host, serial = 0, remoteAuth = { checked: false, available: false, authenticated: false };
function configureHostTransport(callHost) { if (callHost !== undefined && typeof callHost !== "function") throw new Error("GitHub host transport requires a callback."); host = callHost; }
async function request(url, options = {}) {
  if (!host) return local.request(url, options);
  officialUrl(url); throwIfAborted(options.signal); const id = String(++serial), { signal, headers, method, maxBytes, force, deferAssetSizes, assetDigest } = options;
  let cancel;
  try {
    const canceled = new Promise((_, reject) => { cancel = () => { void host("githubCancel", id).catch(() => {}); reject(createAbortError()); }; signal?.addEventListener("abort", cancel, { once: true }); });
    const waiting = host("githubFetch", id, url, { headers, method, maxBytes, force, deferAssetSizes, assetDigest });
    const result = await Promise.race([waiting, canceled]); remoteAuth = result.authentication || remoteAuth;
    return { status: result.status, headers: result.headers, body: Buffer.from(result.body) };
  } finally { signal?.removeEventListener("abort", cancel); }
}
async function authenticationStatus() { if (!host) return local.authenticationStatus(); remoteAuth = await host("githubAuthStatus"); return { ...remoteAuth }; }
function createBroker(transport = local) {
  const requests = new Map();
  return {
    async request(id, url, options = {}) {
      if (typeof id !== "string" || id.length > 64 || requests.has(id)) throw new Error("GitHub request identity is invalid.");
      const controller = new AbortController(); requests.set(id, controller);
      try { const result = await transport.request(url, { ...options, signal: controller.signal }); return { ...result, authentication: transport.peekAuthenticationStatus() }; }
      finally { requests.delete(id); }
    },
    cancel(id) { requests.get(id)?.abort(); }, authenticationStatus: transport.authenticationStatus,
    close() { for (const controller of requests.values()) controller.abort(); requests.clear(); }
  };
}
module.exports = { request, authenticatedRequest: request, authenticationStatus, peekAuthenticationStatus: () => host ? { ...remoteAuth } : local.peekAuthenticationStatus(),
  configureHostTransport, createGithubTransport, createBroker, requestOfficial, officialUrl, redirectHeaders };
