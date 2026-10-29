const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const {setTimeout: delay} = require("node:timers/promises");
const Writable = require("../writable-input"), Live = require("./live-controls");
const SourceResolution = require("./source-resolution");

const MAX_BYTES = 4096, MAX_STATUS_BYTES = 8192;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const stale = () => Object.assign(new Error("The game stopped before its render source changed."), {code: "GRAPHICS_LIVE_STALE"});
const failure = (code, message) => Object.assign(new Error(message), {code});
function normalize(source, support) {
  const result = SourceResolution.normalizeRequest(source);
  if (result === null) return null;
  if (result.automatic && support?.automatic !== true) throw new Error("This renderer cannot use automatic source sizing.");
  if (Object.hasOwn(result, "height") && !support?.heights) throw new Error("This renderer cannot use the selected source height.");
  if (Object.hasOwn(result, "multiplier") && !support?.percentages && !support?.multipliers?.includes(result.multiplier)) throw new Error("This renderer cannot use the selected source percentage.");
  if (Object.hasOwn(result, "method") && !support?.methods?.includes(result.method)) throw new Error("This renderer cannot use the selected source filter.");
  // The activation protocol represents untouched Original as null. It does
  // not create a native source owner merely to acknowledge a divisor of one.
  if (support?.control === "virtual" && support.activationAPI === 1 && result.multiplier === 1) return null;
  return result;
}
const revision = (control, source) => crypto.createHash("sha256").update(JSON.stringify({control, source})).digest("hex");
function readJSON(file, maximum) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw new Error("Render source controls must be bounded ordinary files.");
    const bytes = Buffer.alloc(maximum + 1);let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);if (!count) break;offset += count; }
    if (offset > maximum) throw new Error("Render source controls are too large.");
    return JSON.parse(bytes.toString("utf8", 0, offset));
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function validateBinding(binding) {
  const suffix = binding?.channel === "virtual" ? "-virtual" : "";
  if (binding?.schema !== 1 || !/^[\w-]{1,128}$/.test(binding.launchId || "") || !["engine", "drawable", "virtual"].includes(binding.control) ||
      binding.channel !== undefined && (binding.channel !== "virtual" || binding.control !== "virtual" || binding.activationAPI !== 1) ||
      !path.isAbsolute(binding.userDataDir || "") || !path.isAbsolute(binding.file || "") || !path.isAbsolute(binding.statusFile || "") ||
      path.dirname(binding.file) !== path.dirname(binding.statusFile) || path.basename(binding.file) !== `source-control-${binding.launchId}${suffix}.json` ||
      path.basename(binding.statusFile) !== `source-status-${binding.launchId}${suffix}.json` || binding.support?.live !== true || binding.support.control !== binding.control ||
      binding.activationAPI !== undefined && (binding.activationAPI !== 1 || binding.control !== "virtual" || binding.support.activationAPI !== 1))
    throw new Error("This game has no live render source channel.");
  Writable.assertOwnDirectory(binding.userDataDir, path.dirname(binding.file), {create: false});
}
function command(binding, epoch, source) {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("The render source revision limit was reached.");
  return {schema: 1, launchId: binding.launchId, epoch, revision: revision(binding.control, source), control: binding.control, source};
}
function readCommand(binding, publication) {
  const bytes = publication?.read(binding.file, "utf8");
  if (bytes !== undefined && Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("Render source controls are too large.");
  const value = bytes === undefined ? readJSON(binding.file, MAX_BYTES) : JSON.parse(bytes);
  const source = normalize(value?.source, binding.support);
  if (value?.schema !== 1 || value.launchId !== binding.launchId || value.control !== binding.control || !Object.hasOwn(value, "source") ||
      !Number.isSafeInteger(value.epoch) || value.epoch < 1 || value.revision !== revision(binding.control, source))
    throw new Error("The game's render source binding changed.");
  return command(binding, value.epoch, source);
}
function prepare(entry, {userDataDir, support, launchId, source = null, channel} = {}) {
  // A dormant unsupported path has no filesystem work or optional preparation.
  const activation = support?.control === "virtual" && support.activationAPI === 1;
  if (support?.live !== true || support.control === "virtual" && !activation && (source == null || source.multiplier === 1)) return null;
  if (!/^[\w-]{1,128}$/.test(launchId || "")) throw new Error("Render source controls require a launch identity.");
  const suffix = channel === "virtual" ? "-virtual" : "";
  const directory = path.dirname(Live.file(entry, userDataDir));
  const binding = {schema: 1, launchId, control: support.control,
    ...(channel !== undefined ? {channel} : {}),
    file: path.join(directory, `source-control-${launchId}${suffix}.json`), statusFile: path.join(directory, `source-status-${launchId}${suffix}.json`),
    userDataDir, support: structuredClone(support), ...(activation ? {activationAPI: 1} : {})};
  Writable.assertOwnDirectory(userDataDir, directory);validateBinding(binding);
  const initial = command(binding, 1, normalize(source, support));
  if (fs.existsSync(binding.file)) {
    if (!equal(readCommand(binding).source, initial.source)) throw new Error("Render source controls already belong to this launch.");
  } else Writable.atomicWrite(binding.file, JSON.stringify(initial), {root: userDataDir});
  if (channel === "virtual") return {binding, environment: {RESHADE_VIRTUAL_SOURCE_CONTROL_FILE: binding.file,
    RESHADE_VIRTUAL_SOURCE_STATUS_FILE: binding.statusFile, RESHADE_VIRTUAL_SOURCE_LAUNCH_ID: launchId,
    RESHADE_VIRTUAL_SOURCE_ACTIVATION_API: "1"}};
  return {binding, environment: {RESHADE_RENDER_SOURCE_CONTROL_FILE: binding.file,
    RESHADE_RENDER_SOURCE_STATUS_FILE: binding.statusFile, RESHADE_RENDER_SOURCE_LAUNCH_ID: launchId,
    ...(activation ? {RESHADE_RENDER_SOURCE_CONTROL: "virtual", RESHADE_RENDER_SOURCE_ACTIVATION_API: "1"} : {})}};
}
function bindings(launch) {
  const rows = Object.values(launch?.sourceControls || {});
  if (launch?.sourceControl && !rows.some(row => row?.file === launch.sourceControl.file)) rows.push(launch.sourceControl);
  return rows;
}
function active(launch) {
  return bindings(launch).filter(binding => {validateBinding(binding);return readCommand(binding).source !== null;});
}
function readStatus(binding) {
  try {
    const value = readJSON(binding.statusFile, MAX_STATUS_BYTES);
    return value?.schema === 1 && value.launchId === binding.launchId && value.control === binding.control &&
      Number.isSafeInteger(value.epoch) && value.epoch > 0 && /^[a-f0-9]{64}$/.test(value.revision || "") ? value : null;
  } catch { return null; }
}
function validAppliedSource(status, control) {
  const value = status.applied;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const dimension = number => Number.isFinite(number) && number >= 1 && number <= 16384;
  const size = pair => pair && dimension(pair.width) && dimension(pair.height);
  if (control === "virtual") {
    // A requested window size alone is not a completed producer frame.
    return size(value) && typeof value.virtual === "boolean" && size(status.observed) &&
      value.width === status.observed.width && value.height === status.observed.height &&
      (!value.virtual || dimension(value.outputWidth) && dimension(value.outputHeight));
  }
  return size(value) || Number.isFinite(value.scale) && value.scale > 0 &&
    dimension(value.viewportWidth) && dimension(value.viewportHeight) &&
    dimension(value.viewportWidth * value.scale) && dimension(value.viewportHeight * value.scale);
}
function matchingStatus(binding, next, status) {
  if (!status || status.epoch !== next.epoch || status.revision !== next.revision) return false;
  let requested;
  try { requested = normalize(status.requested, binding.support); } catch { throw failure("GRAPHICS_SOURCE_ACK_INVALID", "The renderer returned invalid source settings."); }
  if (!Object.hasOwn(status, "requested") || !Object.hasOwn(status, "applied") || !equal(requested, next.source))
    throw failure("GRAPHICS_SOURCE_ACK_INVALID", "The renderer acknowledged different source settings.");
  if (typeof status.reason !== "string") throw failure("GRAPHICS_SOURCE_ACK_INVALID", "The renderer returned an invalid source result.");
  return true;
}
// Explicit preparation/status reads only. Geometry alone is insufficient:
// the native receipt must match this launch's current command and revision.
function completed(binding, {publication} = {}) {
  validateBinding(binding);
  const next = readCommand(binding, publication), status = readStatus(binding);
  try {
    if (!matchingStatus(binding, next, status) || status.reason) return null;
    const dimension = number => Number.isFinite(number) && number >= 1 && number <= 16384;
    const pair = value => value && dimension(value.width) && dimension(value.height) ? {width: value.width, height: value.height} : null;
    let dimensions, outputSize;
    if (binding.control === "virtual") {
      if (next.source === null ? status.applied !== null || status.sessionReady !== true : !validAppliedSource(status, binding.control)) return null;
      dimensions = pair(status.observed);
      if (!dimensions) return null;
      outputSize = pair({width: status.applied?.outputWidth, height: status.applied?.outputHeight});
    } else {
      if (next.source === null || !validAppliedSource(status, binding.control)) return null;
      dimensions = pair(status.applied) || pair({width: status.applied.viewportWidth * status.applied.scale, height: status.applied.viewportHeight * status.applied.scale});
      outputSize = pair({width: status.applied.viewportWidth, height: status.applied.viewportHeight});
    }
    return {verified: true, command: next, control: binding.control, dimensions, outputSize, status};
  } catch { return null; }
}
async function waitForStatus(binding, next, {signal, isCurrent, timeoutMs, pollIntervalMs}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    signal?.throwIfAborted();if (isCurrent && isCurrent() !== true) throw stale();
    const status = readStatus(binding);
    if (matchingStatus(binding, next, status)) {
      if (!status.reason && next.source !== null && !validAppliedSource(status, binding.control))
        throw failure("GRAPHICS_SOURCE_ACK_INVALID", "The renderer returned invalid applied source dimensions.");
      if (!status.reason && (next.source === null && status.applied === null || next.source !== null && validAppliedSource(status, binding.control))) return status;
      if (status.reason && !/^Waiting for /i.test(status.reason)) throw failure("GRAPHICS_SOURCE_REJECTED", status.reason);
    }
    if (Date.now() >= deadline) throw failure("GRAPHICS_SOURCE_TIMEOUT", "The renderer did not apply the source change. The previous source is retained.");
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), undefined, signal ? {signal} : undefined);
  }
}
function stage(nextSource, {binding, publication, signal, isCurrent, timeoutMs = binding?.activationAPI === 1 ? 10000 : 2000, pollIntervalMs = 25} = {}) {
  validateBinding(binding);signal?.throwIfAborted();if (isCurrent && isCurrent() !== true) throw stale();
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1000)
    throw new Error("Render source response timing is invalid.");
  const previous = readCommand(binding, publication), source = normalize(nextSource, binding.support), changed = !equal(previous.source, source);
  // Original is a safe restoration request even if a resize or failed image
  // invalidated the previous receipt. Its command still needs a native ACK.
  if (changed && source !== null && binding.control === "virtual") {
    const receipt = completed(binding, {publication});
    // API 1 activation can start from an untouched dormant launch. Later
    // dormant baselines require an exact no-allocation acknowledgement; an
    // in-flight reduction or a stale status is never treated as Original.
    const status = readStatus(binding);
    const dormant = binding.activationAPI === 1 && previous.source === null &&
      (previous.epoch === 1 && status === null || matchingStatus(binding, previous, status) && !status.reason && status.applied === null);
    if (!dormant && (!receipt || receipt.status.sessionReady !== true && receipt.status.applied?.virtual !== false))
      throw failure("GRAPHICS_SOURCE_UNAVAILABLE", "The current virtual render source has not completed. The accepted source allocation is retained.");
  }
  const next = changed ? command(binding, previous.epoch + 1, source) : previous;
  if (changed) {
    if (publication) {
      if (isCurrent) publication.guard(isCurrent);
      // Staged after the effect plan: source allocation is the last activation.
      publication.write(binding.file, JSON.stringify(next), {root: binding.userDataDir, activation: true});
    } else Writable.atomicWrite(binding.file, JSON.stringify(next), {root: binding.userDataDir});
  }
  return {changed, command: next,
    // A repeated reduction is still a source dependency. Its earlier command
    // may have failed, or resize may have invalidated the completed receipt.
    // Matching accepted status returns on the first read without another write
    // or polling delay; untouched Original needs no allocation acknowledgement.
    wait: () => changed || source !== null ? waitForStatus(binding, next, {signal, isCurrent, timeoutMs, pollIntervalMs}) : Promise.resolve(readStatus(binding)),
    async rollback() {
      if (!changed) return true;
      if (isCurrent && isCurrent() !== true) return false;
      const current = readCommand(binding), status = readStatus(binding);
      // The publication may already have restored its original bytes. A newer
      // independent change owns its command and must never be overwritten.
      if (!equal(current, next) && !equal(current, previous)) return false;
      const restored = command(binding, Math.max(next.epoch, current.epoch, status?.epoch || 0) + 1, previous.source);
      Writable.atomicWrite(binding.file, JSON.stringify(restored), {root: binding.userDataDir});
      await waitForStatus(binding, restored, {isCurrent, timeoutMs, pollIntervalMs});
      return true;
    }};
}
module.exports = {normalize, prepare, stage, readStatus, completed, bindings, active};
