const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const {setTimeout: delay} = require("node:timers/promises");
const Live = require("./live-controls"), Binding = require("./launch-binding"), Writable = require("../writable-input");
const HEADER = 4096, SLOT = 32768, SLOTS = 8, STAGES = 32, SIZE = HEADER + SLOT * SLOTS;
const identity = value => typeof value === "string" && /^[\w-]{1,128}$/.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const phases = ["unknown", "prepared", "encoded", "completed", "presented", "bypassed", "failed", "stopped"];
function supported(root) {
  try {return JSON.parse(fs.readFileSync(path.join(root, "runtime.json"), "utf8")).features?.graphics?.runtimeStatusAPI === 1;} catch {return false;}
}
function prepare(entry, {userDataDir, launchId} = {}) {
  if (!identity(launchId)) throw new Error("Graphics status requires a launch identity.");
  const binding = {schema: 1, launchId, token: crypto.randomBytes(32).toString("hex"),
    file: path.join(path.dirname(Live.file(entry, userDataDir)), `runtime-status-${launchId}.bin`)};
  // Metadata only: the inspector creates the page when status is requested.
  return {binding, environment: {RESHADE_RUNTIME_STATUS_FILE: binding.file, RESHADE_RUNTIME_STATUS_LAUNCH_ID: launchId,
    RESHADE_RUNTIME_STATUS_TOKEN: binding.token}};
}
function validate(binding, userDataDir) {
  if (binding?.schema !== 1 || !identity(binding.launchId) || !digest(binding.token) ||
      !path.isAbsolute(binding.file || "") || path.basename(binding.file) !== `runtime-status-${binding.launchId}.bin`)
    throw new Error("Runtime processing status is unavailable for this launch.");
  Writable.assertOwnDirectory(userDataDir, path.dirname(binding.file), {create: false});
}
function header(binding) {
  const bytes = Buffer.alloc(HEADER);bytes.write("MLFXSTS1");bytes.writeUInt32LE(1, 8);bytes.writeUInt32LE(SIZE, 12);
  bytes.writeUInt32LE(binding.launchId.length, 24);bytes.write(binding.token, 32);bytes.write(binding.launchId, 96);return bytes;
}
function checkedOpen(binding, create = true) {
  let fd;
  if (!create) fd = fs.openSync(binding.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  else try {
    fd = fs.openSync(binding.file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.ftruncateSync(fd, SIZE);fs.writeSync(fd, header(binding), 0, HEADER, 0);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error.code !== "EEXIST") throw error;
    fd = fs.openSync(binding.file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  }
  try {
    const stat = fs.fstatSync(fd), bytes = Buffer.alloc(224);
    if (!stat.isFile() || stat.size !== SIZE || process.getuid && stat.uid !== process.getuid()) throw new Error("Invalid graphics status page.");
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || bytes.toString("ascii", 0, 8) !== "MLFXSTS1" ||
        bytes.readUInt32LE(8) !== 1 || bytes.readUInt32LE(12) !== SIZE || bytes.readUInt32LE(24) !== binding.launchId.length ||
        bytes.toString("ascii", 32, 96) !== binding.token || bytes.toString("ascii", 96, 96 + binding.launchId.length) !== binding.launchId)
      throw new Error("This graphics status page belongs to another launch.");
    return fd;
  } catch (error) {fs.closeSync(fd);throw error;}
}
const text = (bytes, start, length) => bytes.toString("utf8", start, start + length).split("\0", 1)[0];
const number = (bytes, offset) => Number(bytes.readBigUInt64LE(offset));
const admissionReasons = ["frame-owner-accepted","frame-owner-missing","present-registered","present-already-claimed","present-commit","frame-resource-busy","frame-processor-busy","frame-image-budget","runtime-device-changed","runtime-queue-changed","runtime-size-changed","runtime-format-changed","runtime-placement-changed","runtime-selection-changed","owner-published-new","owner-published-unchanged","owner-unselected","owner-retired","history-replayed","history-original","framebuffer-resource-busy","framebuffer-image-budget","history-empty"];
function admission(bytes) {
  if (bytes.readUInt32LE(672) !== 1) return undefined;
  return {reason: admissionReasons[bytes.readUInt32LE(676)] || "unknown", observedAt: number(bytes, 680),
    counts: Object.fromEntries(admissionReasons.map((reason, index) => [reason, number(bytes, 688 + index * 8)])),
    queue: bytes.readBigUInt64LE(880).toString(16), generation: number(bytes, 888),
    format: bytes.readUInt32LE(896), width: bytes.readUInt32LE(900), height: bytes.readUInt32LE(904)};
}
function context(bytes, includeStages = true) {
  const stages = includeStages ? Math.min(bytes.readUInt32LE(20), STAGES) : 0, rows = [];
  for (let index = 0; index < stages; index++) {
    const start = 1024 + index * 768;
    rows.push({id: text(bytes, start, 129), requestedMethod: text(bytes, start + 129, 128), activeMethod: text(bytes, start + 257, 128),
      reason: text(bytes, start + 385, 256), phase: phases[bytes.readUInt32LE(start + 644)] || "unknown",
      input: {width: bytes.readUInt32LE(start + 648), height: bytes.readUInt32LE(start + 652)},
      output: {width: bytes.readUInt32LE(start + 656), height: bytes.readUInt32LE(start + 660)},
      frameId: number(bytes, start + 672), encoded: number(bytes, start + 680), completed: number(bytes, start + 688), presented: number(bytes, start + 696), observedAt: number(bytes, start + 704)});
  }
  const nativeAdmission = admission(bytes);
  return {pid: bytes.readUInt32LE(0), id: bytes.readBigUInt64LE(8).toString(16), phase: phases[bytes.readUInt32LE(16)] || "unknown",
    frameId: number(bytes, 24), encoded: number(bytes, 32), completed: number(bytes, 40), presentedReal: number(bytes, 48), presentedGenerated: number(bytes, 56),
    sourceTime: bytes.readDoubleLE(64), presentedTime: bytes.readDoubleLE(72),
    input: {width: bytes.readUInt32LE(80), height: bytes.readUInt32LE(84)}, output: {width: bytes.readUInt32LE(88), height: bytes.readUInt32LE(92)},
    requestedBytes: number(bytes, 96), admittedBytes: number(bytes, 104), planRevision: text(bytes, 112, 65), controlsDigest: text(bytes, 177, 65), reason: text(bytes, 242, 256), observedAt: number(bytes, 504),
    processStart: {seconds: number(bytes, 512), microseconds: number(bytes, 520)},
    acceptedRevision: text(bytes, 528, 65), acceptedControlsDigest: text(bytes, 593, 65), acceptedAt: number(bytes, 664), ...(nativeAdmission ? {admission: nativeAdmission} : {}), stages: rows};
}
function contexts(fd, includeStages = true) {
  const result = [], sequence = Buffer.alloc(4), bytes = Buffer.alloc(includeStages ? SLOT : 1024);
  for (let index = 0; index < SLOTS; index++) {
    const offset = HEADER + index * SLOT;
    if (fs.readSync(fd, sequence, 0, 4, offset + 4) !== 4) continue;
    const before = sequence.readUInt32LE(0);if (before & 1) continue;
    if (fs.readSync(fd, bytes, 0, bytes.length, offset) !== bytes.length || fs.readSync(fd, sequence, 0, 4, offset + 4) !== 4) continue;
    if (sequence.readUInt32LE(0) !== before || bytes.readUInt32LE(4) !== before || !bytes.readUInt32LE(0)) continue;
    const row = context(bytes, includeStages);if (row.id !== "0") result.push(row);
  }
  return result;
}
function historical(row, now = Date.now()) {
  return row.phase === "stopped" || !row.processStart.seconds || !row.observedAt || row.observedAt > now + 1000 || now - row.observedAt > 6000;
}
function acceptedFrom(launch, fd, after = 0) {
  const now = Date.now(), lease = Buffer.alloc(8);
  if (fs.readSync(fd, lease, 0, 8, 16) !== 8) return null;
  const until = number(lease, 0);if (until < now || until - now > 10000) return null;
  const current = contexts(fd, false).filter(row => !historical(row, now) &&
    !(row.admission && row.phase === "unknown" && !row.acceptedRevision));
  if (!current.length || current.some(row => !digest(row.acceptedRevision) || !row.acceptedAt || row.acceptedAt < after ||
      row.acceptedAt > row.observedAt || row.acceptedControlsDigest !== "" && !digest(row.acceptedControlsDigest))) return null;
  const first = current[0];
  if (current.some(row => row.acceptedRevision !== first.acceptedRevision || row.acceptedControlsDigest !== first.acceptedControlsDigest)) return null;
  return {launchId: launch.launchId, launchPid: launch.pid, revision: first.acceptedRevision, controlsDigest: first.acceptedControlsDigest,
    contexts: current.map(({pid, id, processStart, acceptedRevision, acceptedControlsDigest, acceptedAt}) =>
      ({pid, id, processStart, acceptedRevision, acceptedControlsDigest, acceptedAt}))};
}
// Resource acceptance is a native observation, never the latest published
// pointer. This noncreating read cannot turn absence into a live-edit failure.
function accepted(entry, {userDataDir, runningPids = []} = {}) {
  if (!Array.isArray(runningPids) || !runningPids.length) return null;
  let fd;
  try {
    const launch = Binding.read(entry, {userDataDir, runningPids});
    if (launch?.phase !== "spawned") return null;
    validate(launch.runtimeStatus, userDataDir);
    if (launch.runtimeStatus.launchId !== launch.launchId) return null;
    fd = checkedOpen(launch.runtimeStatus, false);
    return acceptedFrom(launch, fd);
  } catch {return null;}
  finally {if (fd !== undefined) try {fs.closeSync(fd);} catch {}}
}
// Only partial live projection needs this bounded control acknowledgement.
// Its short lease is independent of the optional inspector and is restored
// after the request; it never changes the plan, renderer or processing demand.
async function acquireAccepted(entry, options = {}) {
  const {userDataDir, runningPids = [], launchBinding, signal, isCurrent, timeoutMs = 2500} = options;
  if (!Array.isArray(runningPids) || !runningPids.length) return null;
  signal?.throwIfAborted();
  const launch = launchBinding || Binding.read(entry, {userDataDir, runningPids});
  if (launch?.phase !== "spawned" || !launch.runtimeStatus) return null;
  const guard = () => {
    signal?.throwIfAborted();
    if (!Binding.matches(launch, runningPids) || !Binding.isCurrent(entry, launch, {userDataDir, isCurrent}))
      throw Object.assign(new Error("The running graphics session changed during its update."), {code: "GRAPHICS_LIVE_STALE"});
  };
  guard();
  const existing = accepted(entry, {userDataDir, runningPids});
  if (existing) {guard();if (existing.launchId === launch.launchId && existing.launchPid === launch.pid) return existing;return null;}
  let fd, priorLease, ownedLease;
  try {
    validate(launch.runtimeStatus, userDataDir);
    if (launch.runtimeStatus.launchId !== launch.launchId) return null;
    fd = checkedOpen(launch.runtimeStatus);
    const lease = Buffer.alloc(8);if (fs.readSync(fd, lease, 0, 8, 16) !== 8) return null;
    priorLease = number(lease, 0);
    const budget = Number.isFinite(timeoutMs) ? Math.min(5000, Math.max(1, Math.floor(timeoutMs))) : 2500;
    const requestedAt = Date.now(), deadline = performance.now() + budget;
    ownedLease = Math.max(priorLease <= requestedAt + 10000 ? priorLease : 0, requestedAt + budget + 1000);
    lease.writeBigUInt64LE(BigInt(Math.ceil(ownedLease)));fs.writeSync(fd, lease, 0, 8, 16);
    while (true) {
      guard();const result = acceptedFrom(launch, fd, requestedAt);
      if (result) {guard();return result;}
      const remaining = deadline - performance.now();if (remaining <= 0) return null;
      await delay(Math.min(50, remaining), undefined, signal ? {signal} : undefined);
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === "GRAPHICS_LIVE_STALE") throw error;
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        const lease = Buffer.alloc(8);
        if (ownedLease !== undefined && priorLease !== undefined && fs.readSync(fd, lease, 0, 8, 16) === 8 && number(lease, 0) === ownedLease) {
          lease.writeBigUInt64LE(BigInt(priorLease));fs.writeSync(fd, lease, 0, 8, 16);
        }
      } catch {}
      try {fs.closeSync(fd);} catch {}
    }
  }
}
function prepared(entry, userDataDir) {
  try {
    const file = path.join(path.dirname(Live.file(entry, userDataDir)), "effect-plan.json"), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return null;
    const plan = JSON.parse(fs.readFileSync(file, "utf8")), controls = fs.readFileSync(Live.file(entry, userDataDir));
    return digest(plan.revision) && controls.length === 19116 ? {mode: plan.mode, planRevision: plan.revision, controlsDigest: hash(controls)} : null;
  } catch {return null;}
}
function read(entry, {userDataDir, runningPids = []} = {}) {
  const demand = require("../effects/execution-requirements").analyze(entry);
  if (!demand.needed.processor) return {state: "off", contexts: []};
  if (!runningPids.length) return {state: "stopped", contexts: []};
  const launch = Binding.read(entry, {userDataDir, runningPids});
  if (!launch || launch.phase !== "spawned") return {state: "unbound", contexts: []};
  const Plan = require("../effects/plan.mjs"), requested = (Plan.normalize(entry.effects) || Plan.fromLegacy(entry)).video.filter(node => node.enabled);
  const previous = launch.graphicsLivePreparation?.preparationStatus || launch.graphicsPreparation || null;
  const {selectionKey} = require("../effects/live-plan");
  const pending = requested.flatMap(node => {
    const prior = previous?.pending?.find(row => row.id === node.id && row.requestKey === selectionKey(node));
    const reason = Binding.nodeUnavailableReason(launch, node) || prior?.reason;
    return reason ? [{id: node.id, kind: node.kind, method: node.kind === "shader" ? node.shader.preset : node.method, reason,
      retained: prior?.retained === true}] : [];
  });
  const metadata = {launchId: launch.launchId, launchPid: launch.pid, prepared: prepared(entry, userDataDir),
    preparation: {...previous, requested: requested.map(node => ({id: node.id, kind: node.kind, method: node.kind === "shader" ? node.shader.preset : node.method})), pending}};
  let fd;
  try {
    validate(launch.runtimeStatus, userDataDir);
    if (launch.runtimeStatus.launchId !== launch.launchId) throw new Error("This graphics status belongs to another launch.");
    fd = checkedOpen(launch.runtimeStatus);
    const lease = Buffer.alloc(8);lease.writeBigUInt64LE(BigInt(Date.now() + 6000));fs.writeSync(fd, lease, 0, 8, 16);
    const observed = contexts(fd);
    for (const row of observed) {
      const expected = metadata.prepared;
      row.identityState = !expected || !digest(row.planRevision) ? "unverified"
        : row.planRevision !== expected.planRevision ? "previous"
        : digest(row.controlsDigest) ? row.controlsDigest === expected.controlsDigest ? "matching" : "previous"
        : row.controlsDigest === "" && expected.mode === "advanced" ? "matching" : "unverified";
      row.matchesPrepared = row.identityState === "matching";
      row.historical = historical(row);
    }
    return {...metadata, state: observed.some(row => row.matchesPrepared && !row.historical && row.completed > 0) ? "observed"
      : observed.some(row => row.matchesPrepared && row.completed > 0) ? "historical"
      : observed.some(row => row.identityState === "unverified" && row.completed > 0) ? "unverified" : "prepared", contexts: observed};
  } catch (error) {return {...metadata, state: "unavailable", reason: error.message, contexts: []};}
  finally {if (fd !== undefined) fs.closeSync(fd);}
}
module.exports = {supported, prepare, read, accepted, acquireAccepted};
