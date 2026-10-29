const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), net = require("node:net"), crypto = require("node:crypto");
const Writable = require("../shared/writable-input"), Binding = require("../shared/reshade/launch-binding");
const Scaling = require("./scaling");
const PresentationHold = require("../shared/reshade/presentation-hold");
const PROPERTIES = ["scale", "cscale", "dscale", "glsl-shader-opts", "glsl-shaders"];
function location(entry, userDataDir) {
  if (!path.isAbsolute(userDataDir || "") || !/^[\w-]+$/.test(entry.gameId || "")) throw new Error("Video controls require a saved library entry.");
  return path.join(userDataDir, "games", entry.gameId, "modules", "video", "live-player.json");
}
function read(entry, {userDataDir} = {}) {
  try {
    const file = location(entry, userDataDir), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value.schema === 1 && Number.isSafeInteger(value.pid) && value.pid > 0 &&
      path.isAbsolute(value.socket || "") && path.isAbsolute(value.source || "") &&
      typeof value.token === "string" && Scaling.validFilters(value.filters) ? value : null;
  } catch { return null; }
}
function create(entry, context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ml-mpv-"));
  const removeDirectory = () => {try {fs.rmSync(directory, {recursive: true, force: true});} catch {}};
  let socket, token;
  try {
    fs.chmodSync(directory, 0o700);
    socket = path.join(directory, "player");token = crypto.randomUUID();
    if (Buffer.byteLength(socket) >= 104) throw new Error("The temporary video control path is too long.");
  } catch (error) {removeDirectory();throw error;}
  let record;
  function cleanup() {
    try {
      if (read(entry, context)?.token === token) fs.rmSync(location(entry, context.userDataDir), {force: true});
    } catch {}
    removeDirectory();
  }
  return {socket, cleanup, bind(child, filters,{decodedFrameProducer=false,nativeProperties,source=entry.gamePath,separateOSD=false}={}) {
    const launch = Binding.read(entry, {userDataDir: context.userDataDir, runningPids: [child.pid]});
    record = {schema: 1, token, socket, pid: child.pid, launchId: launch?.launchId || null,
      source: fs.realpathSync(source), filters,...(decodedFrameProducer?{decodedFrameAPI:1}:{}),...(separateOSD?{osdLayerAPI:1}:{})};
    if (nativeProperties) {
      record.nativeProperties = structuredClone(nativeProperties);
      for (const argument of Scaling.argumentsFor(entry, filters, context.logger, {decodedFrameProducer})) {
        const split = argument.indexOf("=");record.nativeProperties[argument.slice(2, split)] = argument.slice(split + 1);
      }
    }
    child.once("close", cleanup);
    if (child.exitCode != null || child.signalCode != null) { cleanup();return; }
    Writable.atomicWrite(location(entry, context.userDataDir), JSON.stringify(record), {root: context.userDataDir});
  }};
}
function stale() { return Object.assign(new Error("Video playback changed while graphics were being updated. Try again."), {code: "GRAPHICS_LIVE_STALE"}); }
function matches(record, entry, context, options) {
  if (options.isCurrent?.() === false || !Array.isArray(options.runningPids) || !options.runningPids.includes(record.pid)) return false;
  const current = read(entry, context);
  if (current?.token !== record.token || current.pid !== record.pid) return false;
  if (options.launchBinding && record.launchId !== options.launchBinding.launchId) return false;
  return true;
}
function connect(socket, {timeout = 10000, signal} = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket), pending = new Map(), errors = [], listeners = new Set();
    let ready = false, bytes = "", next = 0;
    const fail = error => { for (const task of pending.values()) task.reject(error);pending.clear(); };
    const connectingDone = () => {clearTimeout(timer);signal?.removeEventListener("abort", aborted);};
    const aborted = () => {connectingDone();client.destroy();reject(signal.reason);};
    const timer = setTimeout(() => {connectingDone();client.destroy();reject(new Error("The video player did not respond to graphics controls."));}, timeout);
    signal?.addEventListener("abort", aborted, {once: true});
    client.setEncoding("utf8");
    client.on("error", error => { if (!ready) {connectingDone();reject(error);}fail(error); });
    client.on("close", () => {const error = new Error("The video player closed its graphics controls.");
      if (!ready) {connectingDone();reject(error);}fail(error);});
    client.on("data", chunk => {
      bytes += chunk;
      if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) {client.destroy(new Error("The video player response exceeds its limit."));return;}
      let end;
      while ((end = bytes.indexOf("\n")) >= 0) {
        const line = bytes.slice(0, end);bytes = bytes.slice(end + 1);
        let value;try {value = JSON.parse(line);} catch {continue;}
        if (value.event === "log-message" && ["error", "fatal"].includes(value.level) && errors.length < 32)
          errors.push(String(value.text || "Video shader preparation failed.").trim().slice(0, 2048));
        if (value.event) for (const listener of listeners) listener(value);
        const task = pending.get(value.request_id);
        if (!task) continue;
        value.error === "success" ? task.resolve(value.data) : task.reject(new Error(`Video graphics: ${value.error || "control failed"}.`));
      }
    });
    client.once("connect", () => {
      ready = true;connectingDone();
      resolve({errors, onEvent(listener) { listeners.add(listener);return () => listeners.delete(listener); }, request(command, {signal} = {}) {
        return new Promise((resolve, reject) => {
          if (signal?.aborted) {reject(signal.reason);return;}
          if (client.destroyed) {reject(new Error("The video player closed its graphics controls."));return;}
          const request_id = ++next;
          // An aborted request keeps its unique ID. A late reply cannot satisfy
          // a restoration request on this same, ordered IPC connection.
          const done = (callback, value) => {
            if (!pending.delete(request_id)) return;
            clearTimeout(timer);signal?.removeEventListener("abort", aborted);callback(value);
          };
          const aborted = () => done(reject, signal.reason);
          const timer = setTimeout(() => done(reject, new Error("The video player did not respond to graphics controls.")), timeout);
          pending.set(request_id, {resolve: value => done(resolve, value), reject: error => done(reject, error)});
          signal?.addEventListener("abort", aborted, {once: true});
          client.write(JSON.stringify({command, request_id}) + "\n", error => {if (error) done(reject, error);});
        });
      }, close() {client.destroy();}});
    });
  });
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(value) {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
function ownedConfiguration(desired, owned, actual) {
  if (!owned) return desired;
  const merged = structuredClone(actual);
  for (const name of ["scale", "cscale", "dscale"]) if (!same(desired[name], owned[name])) merged[name] = desired[name];
  if (!same(desired["glsl-shaders"], owned["glsl-shaders"])) {
    const shaders = [...actual["glsl-shaders"]];
    // Launcher shaders are appended after configuration shaders. Remove only
    // the last matching occurrences, preserving independently added entries.
    for (const shader of [...owned["glsl-shaders"]].reverse()) {
      const index = shaders.lastIndexOf(shader);if (index !== -1) shaders.splice(index, 1);
    }
    merged["glsl-shaders"] = [...shaders, ...desired["glsl-shaders"]];
  }
  const before = owned["glsl-shader-opts"], after = desired["glsl-shader-opts"], parameters = {...actual["glsl-shader-opts"]};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (Object.hasOwn(after, name)) {
      if (!Object.hasOwn(before, name) || !same(after[name], before[name])) parameters[name] = after[name];
    } else if (Object.hasOwn(parameters, name) && same(parameters[name], before[name])) delete parameters[name];
  }
  merged["glsl-shader-opts"] = parameters;
  return merged;
}
async function configuration(entry, context, record, dependencies) {
  const native = await require("./graphics").playbackConfiguration(entry, {...context, snapshotNativeShaders: true,decodedFrameProducer:record.decodedFrameAPI===1}, dependencies);
  const properties = {...native.properties};
  for (const value of Scaling.argumentsFor(entry, record.filters,context.logger,{decodedFrameProducer:record.decodedFrameAPI===1})) {
    const split = value.indexOf("=");properties[value.slice(2, split)] = value.slice(split + 1);
  }
  return properties;
}
// Shared effects must be staged/validated before entering this callback. A
// pause preserves playback position; it is not a cross-renderer frame barrier.
async function withGraphicsUpdate(entry, context, options, publish, dependencies = {}) {
  if (!options.running) return publish();
  options.signal?.throwIfAborted();
  const record = read(entry, context);
  if (!record || !matches(record, entry, context, options)) return {deferred: true};
  const intent = await (dependencies.configuration || configuration)(entry, {...context, signal: options.signal || context.signal,
    useRuntime: options.useRuntime || context.useRuntime}, record, dependencies);
  options.signal?.throwIfAborted();
  if (!matches(record, entry, context, options)) throw stale();
  const ipc = await (dependencies.connect || connect)(record.socket, {signal: options.signal});
  let paused, changed = false, pauseDirty = false, hold, retainHold = false, result, cleaning = false, desired = intent;
  let intentRecorded = false, accepted = false, failure;
  const previous = {};
  const request = command => {
    if (!cleaning) options.signal?.throwIfAborted();
    return ipc.request(command, cleaning ? {} : {signal: options.signal});
  };
  async function cleanup(action) {
    const previous = cleaning;cleaning = true;
    try {return await action();} finally {cleaning = previous;}
  }
  function recordIntent(properties) {
    if (!record.nativeProperties) return;
    if (!matches(record, entry, context, options)) throw stale();
    const current = read(entry, context);
    Writable.atomicWrite(location(entry, context.userDataDir), JSON.stringify({...current, nativeProperties: properties}), {root: context.userDataDir});
  }
  async function publishIntent() {
    recordIntent(intent);intentRecorded = Boolean(record.nativeProperties);
    return publish();
  }
  async function guard() {
    if (!matches(record, entry, context, options) || await request(["get_property", "pid"]) !== record.pid) throw stale();
    const source = await request(["get_property", "path"]);
    let actual;try {actual = fs.realpathSync(source);} catch {}
    if (!require("./playlist").accepts(entry, source) || !entry.moduleData?.playlist && actual !== record.source) throw stale();
  }
  async function apply(properties, verifyRender = false) {
    const errors = ipc.errors.length, changedProperties = [];
    for (const name of PROPERTIES) if (!same(await request(["get_property", name]), properties[name])) changedProperties.push(name);
    for (const name of changedProperties.slice(0, -1)) await request(["set_property", name, properties[name]]);
    const before = verifyRender ? await request(["get_property", "vo-passes"]) : null;
    if (changedProperties.length) {
      const last = changedProperties.at(-1);await request(["set_property", last, properties[last]]);
    }
    // The property query synchronizes with the VO control queue. Actual GPU
    // compilation can follow option parsing, so also wait for a new render's
    // performance record and observe errors instead of accepting a setter ACK.
    const deadline = Date.now() + 5000;
    do {
      const passes = await request(["get_property", "vo-passes"]);
      await new Promise(resolve => setImmediate(resolve));
      if (!verifyRender || !changedProperties.length || !same(before, passes)) return;
      if (ipc.errors.length > errors) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    if (ipc.errors.length === errors) throw new Error("The video player did not render the updated graphics settings.");
  }
  async function restoreNative() {
    await guard();
    const errors = ipc.errors.length;
    await apply(previous, true);
    for (const name of PROPERTIES) if (!same(await request(["get_property", name]), previous[name]))
      throw new Error("The video player did not restore its accepted graphics settings.");
    if (ipc.errors.length > errors) throw new Error(ipc.errors.slice(errors).join(" "));
  }
  async function wake() {
    await guard();
    if (record.osdLayerAPI === 1) await request(["script-message", "maclauncher-video-redraw"]);
    // Equal option writes are ignored by mpv. An empty ASS overlay belongs to
    // this IPC client's namespace and requests redraw without visible content
    // or changes to playback/user OSD. Shared-only edits wake after commit;
    // mixed edits wait for the resume arm. This is not a display acknowledgment.
    await request(["osd-overlay", 0, "ass-events", ""]);
  }
  async function restorePause() {
    await guard();
    if (await request(["get_property", "pause"]) !== paused) await request(["set_property", "pause", paused]);
    pauseDirty = false;
  }
  async function compensate() {
    await guard();const failures = [];
    try {await options.rollbackShared();} catch (error) {failures.push(error);}
    try {await restoreNative();} catch (error) {failures.push(error);}
    if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join(" "));
    await guard();
    try {await hold.cancel({onReady: wake});}
    catch (error) {
      if (!hold.canAbandon) throw error;
      // Terminal GPU failure may make another positively displayed processed
      // image impossible. Only the native gated abandonment protocol can
      // release that cover, after both original contracts and pause restore.
      await restorePause();await hold.abandon();hold = null;return;
    }
    await restorePause();hold.finish();hold = null;
  }
  try {
    await guard();
    paused = await request(["get_property", "pause"]);
    for (const name of PROPERTIES) previous[name] = await request(["get_property", name]);
    desired = ownedConfiguration(intent, record.nativeProperties, previous);
    const barrier = dependencies.presentationHold || PresentationHold;
    const contracts = options.publication
      ? barrier.contracts(entry, {userDataDir: context.userDataDir, publication: options.publication}) : null;
    // The decoded host always owns the final presenter, including master Off.
    // Bypass changes its graph; it does not remove this output boundary.
    if(record.decodedFrameAPI===1&&contracts)for(const name of ["before","after"])
      if(contracts[name])contracts[name]={...contracts[name],requiresPresentation:true};
    if (PROPERTIES.every(name => same(previous[name], desired[name]))) {
      await guard();options.signal?.throwIfAborted();result = await publishIntent();
      if (contracts?.changed && options.publication.committed && !options.publication.deferred && result?.deferred !== true)
        await wake();
      accepted = result?.deferred !== true;
      return result;
    }
    if (contracts?.changed) {
      if (typeof options.rollbackShared !== "function" || !record.launchId || options.launchBinding?.presentationHold?.launchId !== record.launchId)
        throw new Error("This playback session cannot coordinate these native and shared graphics changes. Restart playback to use this combination.");
      await guard();
      hold = await barrier.begin(options.launchBinding.presentationHold, {...contracts, userDataDir: context.userDataDir,
        isCurrent: () => matches(record, entry, context, options), signal: options.signal, onReady: () => cleanup(wake)});
    }
    await request(["request_log_messages", "error"]);
    await guard();
    // Cancellation can follow an enqueued setter before its reply. Treat the
    // command as potentially applied so cleanup always restores its state.
    changed = true;pauseDirty = true;await request(["set_property", "pause", true]);
    await apply(desired, true);
    for (const name of PROPERTIES) if (!same(await request(["get_property", name]), desired[name]))
      throw new Error("The video player did not accept the selected graphics settings.");
    if (ipc.errors.length) throw new Error(`The video player could not apply these graphics settings: ${ipc.errors.join(" ")}`);
    await guard();options.signal?.throwIfAborted();
    result = await publishIntent();
    if (result?.deferred === true) await cleanup(() => hold ? compensate() : restoreNative());
    else if (hold) {
      // Positive display retains the native lease. Pause restoration and any
      // failure compensation still occur covered; finish is the synchronous
      // commit point, with no fallible asynchronous work afterward.
      await hold.present({onReady: wake});
      await restorePause();hold.finish();hold = null;
    }
    accepted = result?.deferred !== true;
    return result;
  } catch (error) {
    failure = error;
    if ((changed || hold) && matches(record, entry, context, options)) {
      try {await cleanup(() => hold ? compensate() : restoreNative());}
      catch (rollback) {
        retainHold = Boolean(hold);
        if (rollback.code !== "GRAPHICS_LIVE_STALE") error.message += " Previous video settings could not be restored: " + rollback.message;
      }
    }
    throw error;
  } finally {
    let restoreError;
    if (pauseDirty && !retainHold && matches(record, entry, context, options)) {
      try {await cleanup(async () => {await guard();await request(["set_property", "pause", paused]);});}
      catch (error) {
        if (error.code !== "GRAPHICS_LIVE_STALE" && matches(record, entry, context, options)) {
          try {await cleanup(async () => {await guard();await apply(previous);});} catch {}
          restoreError = new Error("The video player's pause state could not be restored. Use the playback controls to resume.", {cause: error});
        }
      }
    }
    if (intentRecorded && (!accepted || restoreError) && matches(record, entry, context, options)) {
      try {recordIntent(record.nativeProperties);}
      catch (error) {
        if (failure) failure.message += " Previous video configuration could not be restored: " + error.message;
        else restoreError ||= new Error("The video configuration state could not be restored.", {cause: error});
      }
    }
    try {ipc.close();} catch {}
    if (restoreError) throw restoreError;
  }
}
module.exports = {location, read, create, connect, configuration, withGraphicsUpdate};
