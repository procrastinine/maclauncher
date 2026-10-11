const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { spawn } = require("node:child_process"), { StringDecoder } = require("node:string_decoder");
const B = require("../../shared/runtime/bundled-native"), Helper = require("./pcm-output-helper"), { inspectWave } = require("./audio-cache");
const LIMITS = Object.freeze({ events: 65536, commands: 256, requestMs: 10000, tracks: 65535 });
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
function validateEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid CatSystem2 PCM event.");
  const valid = event.type === "ready" ? event.protocolVersion === 1 : event.type === "error" ? true :
    ["playing", "stopped", "gain", "inactive", "finished", "failed"].includes(event.type) && integer(event.id, 1, LIMITS.tracks);
  if (!valid) throw new Error("The CatSystem2 PCM output protocol differs."); return event;
}
async function openPcmOutput({ cacheRoot, helper, resourcesRoot, helperDependencies, signal, onFailure, spawnChild = spawn } = {}) {
  signal?.throwIfAborted(); if (!path.isAbsolute(cacheRoot || "")) throw new Error("A per-game PCM cache directory is required.");
  B.realDirectory(cacheRoot, { create: true }); const root = await fs.promises.realpath(cacheRoot);
  const selected = helper || await Helper.resolveHelper({ resourcesRoot, dependencies: helperDependencies });
  if (selected.version !== Helper.VERSION || selected.protocolVersion !== 1 || !path.isAbsolute(selected.executablePath || "")) throw new Error("The exact Included PCM player is required.");
  const child = spawnChild(selected.executablePath, ["--cache-root", root], { stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", HOME: os.homedir() }, ...(signal ? { signal } : {}) });
  const pending = new Map(), tracks = new Map(), decoder = new StringDecoder("utf8"); let nextId = 1, ready = false, ended = false, closing = false, failure = null, buffer = "";
  let readyResolve, readyReject, closeResolve;
  const readiness = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }), closed = new Promise(resolve => { closeResolve = resolve; });
  const readinessTimer = setTimeout(() => fail(new Error("Native PCM output did not become ready.")), LIMITS.requestMs);
  function fail(error) {
    if (failure) return; failure = error; clearTimeout(readinessTimer); if (!ready) readyReject(error);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear();
    for (const item of tracks.values()) item.active = false; tracks.clear();
    if (!ended) child.kill("SIGTERM"); onFailure?.(error);
  }
  function assertHealthy() { signal?.throwIfAborted(); if (failure) throw failure; if (ended || closing) throw new Error("The CatSystem2 PCM player is closed."); }
  child.on("error", () => fail(new Error("Native PCM output could not start.")));
  child.stdin.on("error", () => { if (!ended && !closing) fail(new Error("Native PCM input was interrupted.")); }); child.stderr.resume();
  child.stdout.on("data", chunk => {
    buffer += decoder.write(chunk); if (Buffer.byteLength(buffer) > LIMITS.events * 2) { fail(new Error("Native PCM output exceeds its limit.")); return; }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        if (Buffer.byteLength(line) > LIMITS.events) throw new Error("Native PCM event exceeds its limit."); const event = validateEvent(JSON.parse(line));
        if (event.type === "ready") { if (ready) throw new Error("Duplicate PCM ready event."); ready = true; clearTimeout(readinessTimer); readyResolve(); }
        else if (["error", "failed"].includes(event.type)) throw new Error("Native PCM playback failed.");
        else if (event.type === "finished") { const track = tracks.get(event.id); if (!track?.active) continue; track.active = false; tracks.delete(event.id); track.onFinished?.(); }
        else {
          const item = pending.get(event.id); if (!item || !item.accepts.includes(event.type)) throw new Error("Unexpected PCM control response.");
          pending.delete(event.id); clearTimeout(item.timer); item.resolve(event);
        }
      } catch (error) { fail(error); return; }
    }
  });
  child.on("close", (code, exitSignal) => {
    ended = true; clearTimeout(readinessTimer); if (!closing) fail(new Error("Native PCM output exited unexpectedly."));
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("The PCM player is closed.")); } pending.clear();
    for (const item of tracks.values()) item.active = false; tracks.clear(); closeResolve({ code, signal: exitSignal });
  });
  function request(record, accepts) {
    assertHealthy(); if (pending.has(record.id) || pending.size >= LIMITS.commands) throw new Error("PCM controls exceed their queue limit.");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error("Native PCM control timed out.")), LIMITS.requestMs); pending.set(record.id, { accepts, resolve, reject, timer });
      child.stdin.write(JSON.stringify(record) + "\n", error => { if (error) fail(new Error("Native PCM input was interrupted.")); });
    });
  }
  async function start({ decoded, gain, loops, onFinished } = {}) {
    assertHealthy();
    if (nextId > LIMITS.tracks || !integer(loops, 0, 65535) || typeof gain !== "number" || !Number.isFinite(gain) || gain < 0 || gain > 1 ||
        !decoded || path.dirname(decoded.file || "") !== path.join(root, "audio") || !/^[a-f0-9]{64}\.wav$/.test(path.basename(decoded.file || "")) || !/^[a-f0-9]{64}$/.test(decoded.waveSha256 || ""))
      throw new Error("Invalid bounded PCM playback request.");
    const original = B.readRegular(decoded.file, 256 * 1024 * 1024 + 44), dimensions = inspectWave(original.bytes);
    if (original.sha256 !== decoded.waveSha256 || Object.entries(dimensions).some(([name, value]) => decoded[name] !== value)) throw new Error("The PCM playback cache changed.");
    const id = nextId++, track = { active: true, onFinished }; tracks.set(id, track);
    await request({ type: "play", id, path: decoded.file, sha256: decoded.waveSha256, gain, loops }, ["playing"]);
    let serial = Promise.resolve();
    function control(record, accepts) { const operation = serial.then(() => request(record, accepts)); serial = operation.catch(() => {}); return operation; }
    return Object.freeze({ id, get active() { return track.active; }, setGain: value => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return Promise.reject(new Error("PCM gain exceeds its range."));
      if (!track.active) return Promise.resolve(false);
      return control({ type: "gain", id, gain: value }, ["gain", "inactive"]).then(event => event.type === "gain");
    }, stop: async () => {
      if (!track.active) return; track.active = false; tracks.delete(id);
      await control({ type: "stop", id }, ["stopped"]);
    } });
  }
  async function close() {
    if (ended) return closed; closing = true; child.stdin.end('{"type":"close"}\n');
    const term = setTimeout(() => child.kill("SIGTERM"), 2000), kill = setTimeout(() => child.kill("SIGKILL"), 4000);
    try { return await closed; } finally { clearTimeout(term); clearTimeout(kill); }
  }
  try { await readiness; } catch (error) { await close(); throw error; }
  return Object.freeze({ child, pid: child.pid, helper: selected, start, close, closed, assertHealthy });
}
module.exports = { LIMITS, validateEvent, openPcmOutput };
