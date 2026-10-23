const net = require("node:net"), fs = require("node:fs"), crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const messages = Object.freeze({ AUTHORIZATION_FAILED: "The selected Google account is unavailable to this application.",
  NETWORK_DISABLED: "Network access is disabled for this game.", AUTHORIZATION_REQUIRED: "Google account authorization is required.",
  ACCOUNT_PROVIDER_ERROR: "The Google account provider could not complete the request." });
const androidCodes = Object.freeze({ AUTHORIZATION_FAILED: 9, NETWORK_DISABLED: 3, AUTHORIZATION_REQUIRED: 4, ACCOUNT_PROVIDER_ERROR: 5 });

function resolvePeerPid(socket) {
  return new Promise((resolve, reject) => {
    const fd = socket?._handle?.fd;
    if (!Number.isInteger(fd) || fd < 0) return reject(new Error("The Google account connection is unavailable."));
    const child = spawn(require("../provider-clipboard").resolveHelper(), ["--peer-pid"], { stdio: [fd, "pipe", "ignore"] });
    let output = "", settled = false;
    const finish = (error, pid) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(pid); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("The Google account peer could not be verified.")); }, 2000);
    timer.unref?.();
    child.stdout.on("data", data => { output += data; if (output.length > 256) child.kill("SIGKILL"); });
    child.once("error", () => finish(new Error("The Google account peer could not be verified.")));
    child.once("close", code => {
      try { const value = JSON.parse(output); if (code !== 0 || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error(); finish(null, value.pid); }
      catch { finish(new Error("The Google account peer could not be verified.")); }
    });
  });
}
async function descendant(pid, rootPid) {
  const visited = new Set();
  while (pid > 1 && !visited.has(pid)) {
    if (pid === rootPid) return true;
    visited.add(pid);
    const result = await exec("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    pid = Number(result.stdout.trim());
    if (!Number.isSafeInteger(pid)) return false;
  }
  return false;
}
function sameSecret(a, b) {
  return typeof a === "string" && /^[a-f0-9]{64}$/.test(a) && crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
function accountMatches(value, selected) { return !!selected && value?.name === selected.name && value?.type === selected.type; }

async function create({ owner, account = null, networkAllowed = false, signal }, dependencies = {}) {
  if (!owner?.caller || typeof owner.token !== "function") throw new Error("A verified Android account caller is required.");
  const capability = crypto.randomBytes(32).toString("hex"), socketPath = "/private/tmp/maclauncher-google-" + crypto.randomBytes(16).toString("hex") + ".sock";
  const sockets = new Set(), controllers = new Set(); let rootPid = null, closed = false;
  let enrolled; const registration = new Promise(resolve => { enrolled = resolve; });
  const peerPid = dependencies.resolvePeerPid || resolvePeerPid, isDescendant = dependencies.isDescendant || descendant;
  const server = net.createServer({ pauseOnConnect: true }, socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
    const controller = new AbortController(); controllers.add(controller); socket.once("close", () => { controller.abort(); controllers.delete(controller); });
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const authenticatedPeer = peerPid(socket);
    let pending = "", chain = Promise.resolve();
    async function respond(request) {
      if (!sameSecret(request.capability, capability) || !rootPid || !await isDescendant(await authenticatedPeer, rootPid))
        throw Object.assign(new Error(), { code: "AUTHORIZATION_FAILED" });
      if (request.operation === "accounts") {
        if (!account) return { accounts: [] };
        const live = await owner.accounts();
        return { accounts: live.accounts.some(value => accountMatches(value, account)) ? [{ name: account.name, type: account.type }] : [] };
      }
      if (!["token", "peekToken", "invalidateToken"].includes(request.operation) || !accountMatches(request.account, account))
        throw Object.assign(new Error(), { code: "AUTHORIZATION_FAILED" });
      if (request.operation === "token" && !networkAllowed) throw Object.assign(new Error(), { code: "NETWORK_DISABLED" });
      const data = request.operation === "invalidateToken" ? { token: request.token } : { service: request.service, options: request.options || {} };
      if (request.operation === "invalidateToken" ? typeof data.token !== "string" : typeof data.service !== "string" || !data.service || data.service.includes("\0"))
        throw Object.assign(new Error(), { code: "AUTHORIZATION_FAILED" });
      return owner.token(request.operation, account, data, { signal: requestSignal });
    }
    const processLine = async line => {
      try {
        const request = JSON.parse(line); if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error();
        const result = await respond(request); if (!socket.destroyed) socket.write(JSON.stringify({ ok: true, ...result }) + "\n");
      } catch (error) {
        const code = Object.hasOwn(messages, error.code) ? error.code : "ACCOUNT_PROVIDER_ERROR";
        const providerCode = Number.isSafeInteger(error.providerCode) ? error.providerCode : androidCodes[code];
        if (!socket.destroyed) socket.write(JSON.stringify({ ok: false, error: { code: providerCode, type: code, message: messages[code], ...(error.interactiveRequired ? { interactiveRequired: true } : {}) } }) + "\n");
      }
    };
    socket.on("data", bytes => {
      pending += bytes.toString("utf8");
      if (Buffer.byteLength(pending) > 1024 * 1024) { socket.destroy(); return; }
      for (let at; (at = pending.indexOf("\n")) !== -1;) {
        const line = pending.slice(0, at); pending = pending.slice(at + 1);
        chain = chain.then(() => processLine(line));
      }
    });
    Promise.all([registration, authenticatedPeer]).then(() => { if (!socket.destroyed && !closed) socket.resume(); }, () => socket.destroy());
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => { server.off("error", reject); resolve(); }); });
  fs.chmodSync(socketPath, 0o600);
  async function close() {
    if (closed) return; closed = true; enrolled(); signal?.removeEventListener("abort", close);
    for (const controller of controllers) controller.abort();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve)); await fs.promises.rm(socketPath, { force: true });
  }
  signal?.addEventListener("abort", close, { once: true }); if (signal?.aborted) await close();
  return { socket: socketPath, capability, close, enroll(pid) {
    if (closed || !Number.isSafeInteger(pid) || pid <= 0 || rootPid !== null) throw new Error("The Google account process cannot be enrolled.");
    rootPid = pid; enrolled();
  } };
}
module.exports = { create, resolvePeerPid, descendant };
