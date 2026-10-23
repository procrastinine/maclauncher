const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const {setTimeout: delay} = require("node:timers/promises");
const Writable = require("../writable-input"), Live = require("./live-controls");
const identity = value => typeof value === "string" && /^[\w-]{1,128}$/.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const stale = () => Object.assign(new Error("Video playback changed during its graphics update."), {code: "GRAPHICS_LIVE_STALE"});

function read(file, maximum) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > maximum) throw new Error("Presentation controls must be bounded ordinary files.");
    const bytes = Buffer.alloc(maximum + 1);let offset = 0;
    while (offset < bytes.length) {const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);if (!count) break;offset += count;}
    const after = fs.fstatSync(fd), named = fs.lstatSync(file);
    if (offset > maximum || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        named.ino !== before.ino || named.size !== before.size || named.mtimeMs !== before.mtimeMs || named.isSymbolicLink())
      throw new Error("Presentation controls changed while reading.");
    return bytes.subarray(0, offset);
  } catch (error) {if (error.code === "ENOENT") return null;throw error;}
  finally {if (fd !== undefined) fs.closeSync(fd);}
}
const json = (file, maximum) => {const bytes = read(file, maximum);return bytes === null ? null : JSON.parse(bytes);};
function supported(root) {
  try {return path.isAbsolute(root || "") && json(path.join(root, "runtime.json"), 1024 * 1024)?.features?.graphics?.presentationHoldAPI === 1;}
  catch {return false;}
}
function validateBinding(binding, userDataDir) {
  if (binding?.schema !== 1 || !identity(binding.launchId) || !digest(binding.token) || !path.isAbsolute(userDataDir || "") ||
      !path.isAbsolute(binding.file || "") || !path.isAbsolute(binding.statusFile || "") ||
      path.dirname(binding.file) !== path.dirname(binding.statusFile) ||
      path.basename(binding.file) !== `presentation-control-${binding.launchId}.json` ||
      path.basename(binding.statusFile) !== `presentation-status-${binding.launchId}.json`)
    throw new Error("This playback session has no presentation hold channel. Restart playback to use this combination of live changes.");
  Writable.assertOwnDirectory(userDataDir, path.dirname(binding.file), {create: false});
}
function prepare(entry, {userDataDir, launchId, root} = {}) {
  if (!identity(launchId)) throw new Error("Presentation controls require a launch identity.");
  const directory = path.dirname(Live.file(entry, userDataDir)), binding = {schema: 1, launchId, token: crypto.randomBytes(32).toString("hex"),
    file: path.join(directory, `presentation-control-${launchId}.json`), statusFile: path.join(directory, `presentation-status-${launchId}.json`)};
  const features = path.isAbsolute(root || "") ? json(path.join(root, "runtime.json"), 1024 * 1024)?.features?.graphics : null;
  if (features?.presentationHoldAPI === 1 && features.presentationHoldAbandonAPI === 1) binding.abandonAPI = 1;
  Writable.assertOwnDirectory(userDataDir, directory);validateBinding(binding, userDataDir);
  // No initial command, watcher or timer is needed in the launcher.
  return {binding, environment: {RESHADE_PRESENTATION_CONTROL_FILE: binding.file, RESHADE_PRESENTATION_STATUS_FILE: binding.statusFile,
    RESHADE_PRESENTATION_LAUNCH_ID: launchId, RESHADE_PRESENTATION_TOKEN: binding.token}};
}
function contract(planBytes, controlsBytes) {
  if (planBytes === null || controlsBytes === null) return null;
  if (planBytes.length > 4 * 1024 * 1024 || controlsBytes.length !== 19116 || controlsBytes.toString("ascii", 0, 8) !== "MLFXCTL2")
    throw new Error("The saved graphics presentation contract is invalid.");
  const plan = JSON.parse(planBytes);
  if (plan?.schema !== 1 || !["simple", "advanced"].includes(plan.mode) || !digest(plan.revision) || !Array.isArray(plan.nodes) || plan.nodes.length > 32)
    throw new Error("The saved graphics presentation plan is invalid.");
  const requiresPresentation = plan.mode === "advanced" ? plan.nodes.some(node => node.enabled === true) :
    Boolean(controlsBytes.readUInt32LE(16) & 9 || controlsBytes.readUInt32LE(152));
  return {planRevision: plan.revision, controlsDigest: hash(controlsBytes), requiresPresentation};
}
function contracts(entry, {userDataDir, publication} = {}) {
  const controlsFile = Live.file(entry, userDataDir), planFile = path.join(path.dirname(controlsFile), "effect-plan.json");
  Writable.assertOwnDirectory(userDataDir, path.dirname(controlsFile), {create: false});
  function bytes(file, maximum, original) {
    if (!publication) return read(file, maximum);
    // Check the on-disk leaf even when publication buffers already contain it.
    const stat = (() => {try {return fs.lstatSync(file);} catch (error) {if (error.code === "ENOENT") return null;throw error;}})();
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)) throw new Error("Presentation controls must be bounded ordinary files.");
    try {
      const value = original ? publication.readOriginal(file) : publication.read(file);
      if (!Buffer.isBuffer(value) || value.length > maximum) throw new Error("Presentation controls exceed their size limit.");
      return value;
    } catch (error) {if (error.code === "ENOENT") return null;throw error;}
  }
  const planBefore = bytes(planFile, 4 * 1024 * 1024, true), planAfter = bytes(planFile, 4 * 1024 * 1024, false),
    controlsBefore = bytes(controlsFile, 19116, true), controlsAfter = bytes(controlsFile, 19116, false);
  const equal = (a, b) => a === null ? b === null : b !== null && a.equals(b);
  const changed = !equal(planBefore, planAfter) || !equal(controlsBefore, controlsAfter);
  const before = contract(planBefore, controlsBefore), after = contract(planAfter, controlsAfter);
  return {before, after, changed, requiresPresentation: after?.requiresPresentation === true};
}
const wireContract = value => {
  if (!digest(value?.planRevision) || !digest(value?.controlsDigest)) throw new Error("This live change has no complete presentation contract.");
  return {planRevision: value.planRevision, controlsDigest: value.controlsDigest};
};
async function begin(binding, {userDataDir, before, after, isCurrent, signal, timeoutMs = 5000, onReady} = {}) {
  validateBinding(binding, userDataDir);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("The presentation response limit is invalid.");
  const accepted = wireContract(before), candidate = wireContract(after);
  if (before.requiresPresentation !== true || after.requiresPresentation !== true)
    throw new Error("This combination of live changes requires an existing and a continuing graphics presentation. Apply the changes separately or restart playback.");
  const current = () => {if (isCurrent && isCurrent() !== true) throw stale();};
  const owns = value => value?.schema === 1 && value.launchId === binding.launchId && value.token === binding.token;
  const status = () => json(binding.statusFile, 8192);
  current();signal?.throwIfAborted();
  const previousCommand = json(binding.file, 4096);let previousStatus = status();
  if ([previousCommand, previousStatus].some(value => value && !owns(value))) throw stale();
  if (previousCommand?.action === "finish" || previousCommand?.action === "abandon" && binding.abandonAPI === 1) {
    // The preceding update committed synchronously. Do not overwrite its
    // finish mailbox before the native reader has consumed it.
    const deadline = Date.now() + timeoutMs;
    while (!(owns(previousStatus) && previousStatus.epoch === previousCommand.epoch &&
        previousStatus.transactionId === previousCommand.transactionId && previousStatus.state === (previousCommand.action === "finish" ? "finished" : "abandoned") &&
        (previousCommand.action !== "abandon" || previousStatus.holding === false && previousStatus.presentedTime === 0) &&
        previousStatus.planRevision === previousCommand.expected?.planRevision && previousStatus.controlsDigest === previousCommand.expected?.controlsDigest)) {
      current();signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error("The previous video presentation update has not finished. Try again after playback resumes.");
      await delay(Math.min(25, Math.max(1, deadline - Date.now())), undefined, signal ? {signal} : undefined);previousStatus = status();
    }
  } else if (previousCommand && !(previousCommand.action === "hold" && owns(previousStatus) &&
      previousStatus.epoch === previousCommand.epoch && previousStatus.transactionId === previousCommand.transactionId && previousStatus.state === "failed" && previousStatus.holding === false)) {
    throw new Error("A previous graphics update is still holding playback. Stop playback before starting another update.");
  }
  let epoch = Math.max(...[previousCommand, previousStatus].map(value => Number.isSafeInteger(value?.epoch) && value.epoch > 0 ? value.epoch : 0));
  const transactionId = crypto.randomUUID();let held, state = "starting", displayed, lastCommand;
  function write(action, expected) {
    current();
    if (!Number.isSafeInteger(++epoch)) throw new Error("The presentation revision limit was reached.");
    const next = {schema: 1, launchId: binding.launchId, token: binding.token, epoch, transactionId, action, expected,
      ...(action === "hold" ? {candidate: {...candidate, requiresPresentation: true}} : {})};
    // A successful rename is the acceptance point. Cleanup must not throw
    // after finish becomes observable and provoke an outer shared rollback.
    Writable.assertOwnDirectory(userDataDir, path.dirname(binding.file), {create: false});
    const temporary = path.join(path.dirname(binding.file), ".presentation-" + crypto.randomUUID());let fd, renamed = false;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);fs.writeFileSync(fd, JSON.stringify(next));fs.fsyncSync(fd);fs.closeSync(fd);fd = undefined;
      fs.renameSync(temporary, binding.file);renamed = true;
    } finally {
      if (fd !== undefined) try {fs.closeSync(fd);} catch {}
      if (!renamed) try {fs.rmSync(temporary, {force: true});} catch {}
    }
    lastCommand = next;return next;
  }
  function finish(expected) {
    current();
    const command = json(binding.file, 4096);
    if (!owns(command) || command.epoch !== lastCommand.epoch || command.transactionId !== transactionId) throw stale();
    write("finish", expected);state = "finished";
  }
  async function send(action, expected, {abortSignal = signal, onReady} = {}) {
    current();abortSignal?.throwIfAborted();
    const next = write(action, expected);
    const wanted = action === "hold" ? "held" : action === "present" ? "presented" : action === "abandon" ? "abandoned" : "cancelled", deadline = Date.now() + timeoutMs;
    let ready = false;
    while (true) {
      current();abortSignal?.throwIfAborted();const value = status();
      if (owns(value) && Number.isSafeInteger(value.epoch) && value.epoch > next.epoch) throw stale();
      if (owns(value) && value.epoch === next.epoch && value.transactionId === transactionId) {
        if (value.state === "failed") throw new Error(value.reason || "The video presentation could not complete this live change.");
        if (!ready && value.state === "presenting" && onReady) {ready = true;await onReady();current();}
        if (value.state === wanted) {
          if (action === "abandon") {
            if (value.planRevision !== expected.planRevision || value.controlsDigest !== expected.controlsDigest || value.holding !== false || value.presentedTime !== 0)
              throw new Error("The renderer did not confirm release to the restored original rendering.");
            return value;
          }
          if (value.planRevision !== expected.planRevision || value.controlsDigest !== expected.controlsDigest ||
              !Number.isSafeInteger(value.window) || value.window < 1 || !Number.isSafeInteger(value.frameId) || value.frameId < 0 ||
              !Number.isSafeInteger(value.width) || value.width < 1 || value.width > 16384 ||
              !Number.isSafeInteger(value.height) || value.height < 1 || value.height > 16384 ||
              !Number.isFinite(value.presentedTime) || value.presentedTime <= 0 ||
              held && (value.window !== held.window || value.presentedTime <= held.presentedTime))
            throw new Error("The renderer did not confirm the matching displayed video frame.");
          return value;
        }
      }
      if (Date.now() >= deadline) throw new Error("The video player did not confirm a displayed frame for this live change.");
      await delay(Math.min(25, Math.max(1, deadline - Date.now())), undefined, abortSignal ? {signal: abortSignal} : undefined);
    }
  }
  try {held = await send("hold", accepted);state = "held";}
  catch (error) {
    // Nothing has changed yet. Retire a possibly late hold with a newer epoch;
    // never let an aborted launcher wait leave playback covered indefinitely.
    if (error.code !== "GRAPHICS_LIVE_STALE" && (!isCurrent || isCurrent() === true)) {
      let value;try {value = status();} catch {}
      // Failure can follow lease acquisition. Only an explicit native no-lease
      // report permits skipping restoration; absent metadata stays guarded.
      if (!(owns(value) && value.epoch === epoch && value.transactionId === transactionId && value.state === "failed" && value.holding === false)) {
        try {await send("cancel", accepted, {abortSignal: null, onReady});finish(accepted);}
        catch (rollback) {
          if (binding.abandonAPI === 1) {
            try {await send("abandon", accepted, {abortSignal: null});state = "abandoned";}
            catch (abandon) {error.message += " The original presentation could not be confirmed: " + rollback.message + " " + abandon.message;}
          } else error.message += " The original presentation could not be confirmed: " + rollback.message;
        }
      }
    }
    throw error;
  }
  return {
    canAbandon: binding.abandonAPI === 1,
    async present(options) {if (state !== "held") throw new Error("This presentation update is already finished.");
      const result = await send("present", candidate, options);state = "presented";displayed = candidate;return result;},
    async cancel(options = {}) {if (state === "cancelled") return;
      if (["finished", "abandoned"].includes(state)) throw new Error("This presentation update is already finished.");
      const result = await send("cancel", accepted, {...options, abortSignal: null});state = "cancelled";displayed = accepted;return result;},
    async abandon() {
      if (binding.abandonAPI !== 1) throw new Error("This playback session cannot release a failed graphics presentation. Stop playback to restore original rendering.");
      if (["finished", "abandoned"].includes(state)) throw new Error("This presentation update is already finished.");
      const result = await send("abandon", accepted, {abortSignal: null});state = "abandoned";return result;
    },
    finish() {if (!["presented", "cancelled"].includes(state)) throw new Error("A displayed frame is required before finishing its presentation update.");finish(displayed);}
  };
}
module.exports = {supported, prepare, contracts, begin};
