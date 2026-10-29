const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), net = require("node:net");
const {EventEmitter, getEventListeners} = require("node:events");
const Live = require("../src/modules/video/live"), Shaders = require("../src/modules/video/native-shaders");
const Hold = require("../src/modules/shared/reshade/presentation-hold"), Controls = require("../src/modules/shared/reshade/live-controls");
const {createPublication} = require("../src/modules/shared/reshade/live-publication");
async function player(t, {paused = false} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "video-live-"))), source = path.join(root, "clip with : punctuation.mp4");
  const sockets = new Set();let controls, server, child;
  t.after(async () => {
    try {
      for (const socket of sockets) socket.destroy();
      if (server?.listening) await new Promise(resolve => server.close(resolve));
    } finally {try {child?.emit("close");} finally {try {controls?.cleanup();} finally {fs.rmSync(root, {recursive: true, force: true});}}}
  });
  fs.writeFileSync(source, "unchanged source");
  const entry = {gameId: "movie", gamePath: source}, context = {userDataDir: root};
  child = new EventEmitter();child.pid = 54321;controls = Live.create(entry, context);controls.bind(child, ["bilinear", "nearest", "hermite"]);
  const props = {pid: child.pid, path: source, pause: paused, "time-pos": 1.5, scale: "bilinear", cscale: "bilinear", dscale: "bilinear", "glsl-shaders": [], "glsl-shader-opts": {}, "vo-passes": {fresh: []}};
  const commands = [];let reject, logError, intercept, generation = 0, delayedError = false;
  server = net.createServer(socket => {
    sockets.add(socket);socket.once("close", () => sockets.delete(socket));socket.setEncoding("utf8");let bytes = "";
    socket.on("data", chunk => {bytes += chunk;let end;
      while ((end = bytes.indexOf("\n")) >= 0) {
        const message = JSON.parse(bytes.slice(0, end));bytes = bytes.slice(end + 1);
        const [command, name, value] = message.command;commands.push(message.command);let data, error = "success";
        if (command === "get_property") data = props[name];
        if (command === "set_property") {
          if (reject?.(name, value)) error = "invalid parameter";
          else if (JSON.stringify(props[name]) !== JSON.stringify(value)) {props[name] = value;
            const rendererError = logError?.(name, value);
            if (["scale", "cscale", "dscale", "glsl-shader-opts", "glsl-shaders"].includes(name) && !(rendererError && delayedError)) props["vo-passes"] = {fresh: [{last: ++generation}]};
            if (rendererError) {
              const report = () => {if (!socket.destroyed) socket.write(JSON.stringify({event: "log-message", level: "error", prefix: "vo/gpu-next/libplacebo", text: "Shader compilation failed"}) + "\n");};
              delayedError ? setTimeout(report, 10) : report();
            }
          }
        }
        if (command === "osd-overlay") {
          if (reject?.(command, message.command)) error = "invalid parameter";
          else if (name !== 0 || value !== "ass-events" || message.command[3] !== "") error = "invalid parameter";
          else {props["vo-passes"] = {redraw: [{last: ++generation}]};data = {};}
        }
        const reply = () => {if (!socket.destroyed) socket.write(JSON.stringify({request_id: message.request_id, error, data}) + "\n");};
        if (!intercept?.(message.command, reply)) reply();
      }
    });
  });
  await new Promise((resolve, reject) => {server.once("error", reject);server.listen(controls.socket, resolve);});
  return {root, entry, context, controls, props, commands, child, options: {running: true, runningPids: [child.pid], isCurrent: () => true},
    reject: fn => {reject = fn;}, intercept: fn => {intercept = fn;},
    logError: (fn, delayed = false) => {logError = fn;delayedError = delayed;}};
}
const desired = {scale: "hermite", cscale: "hermite", dscale: "hermite", "glsl-shaders": ["/shaders/second : hook.glsl", "/shaders/first.hook"], "glsl-shader-opts": {"first/strength": "0.5"}};
const configuration = async () => structuredClone(desired);
test("failed fixture listen owns and removes both temporary locations", async t => {
  const reason = new Error("Fixture listen failed"), after = [], directories = [];
  const mkdtemp = fs.mkdtempSync;
  t.mock.method(fs, "mkdtempSync", function(prefix, ...args) {
    const directory = mkdtemp.call(this, prefix, ...args);directories.push(directory);return directory;
  });
  t.mock.method(net, "createServer", () => {
    const server = new EventEmitter();server.listen = () => queueMicrotask(() => server.emit("error", reason));return server;
  });
  t.after(() => {for (const directory of directories) fs.rmSync(directory, {recursive: true, force: true});});
  await assert.rejects(player({after: fn => after.push(fn)}), error => error === reason);
  for (const cleanup of after) await cleanup();
  assert.ok(directories.length >= 2, "the player root and separate IPC directory were created");
  for (const directory of directories) assert.equal(fs.existsSync(directory), false);
});
test("partial video IPC setup removes its owned directory and preserves the setup error", t => {
  const chmod = fs.chmodSync, reason = Object.assign(new Error("Temporary permissions failed"), {code: "EACCES"});let directory;
  t.mock.method(fs, "chmodSync", (file, ...args) => {
    if (path.basename(file).startsWith("ml-mpv-")) {directory = file;throw reason;}
    return chmod(file, ...args);
  });
  assert.throws(() => Live.create({}, {}), error => error === reason);
  assert.ok(directory);assert.equal(fs.existsSync(directory), false);
});
test("video IPC cleanup attempts both owned locations and cannot throw from player close", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "video-live-cleanup-"))), source = path.join(root, "clip.mp4");
  fs.writeFileSync(source, "source preserved");t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const entry = {gameId: "movie", gamePath: source}, context = {userDataDir: root}, child = new EventEmitter();child.pid = 54321;
  const controls = Live.create(entry, context);controls.bind(child, ["bilinear"]);
  const record = Live.location(entry, root), directory = path.dirname(controls.socket), rm = fs.rmSync, attempts = [];
  const mocked = t.mock.method(fs, "rmSync", (file, options) => {
    attempts.push(file);
    if (file === record) throw Object.assign(new Error("Control record removal failed"), {code: "EACCES"});
    return rm(file, options);
  });
  assert.doesNotThrow(() => child.emit("close"));
  assert.deepEqual(attempts, [record, directory]);assert.equal(fs.existsSync(directory), false);
  mocked.mock.restore();controls.cleanup();assert.equal(fs.existsSync(record), false);
  assert.equal(fs.readFileSync(source, "utf8"), "source preserved");
});
test("video IPC cleanup preserves a replacement player's record even when its own directory cannot be removed", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "video-live-replacement-"))), source = path.join(root, "clip.mp4");
  fs.writeFileSync(source, "source preserved");t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const entry = {gameId: "movie", gamePath: source}, context = {userDataDir: root}, child = new EventEmitter();child.pid = 54321;
  const controls = Live.create(entry, context);controls.bind(child, ["bilinear"]);
  const record = Live.location(entry, root), replacement = {...Live.read(entry, context), token: "replacement"};fs.writeFileSync(record, JSON.stringify(replacement));
  const directory = path.dirname(controls.socket), rm = fs.rmSync;
  const mocked = t.mock.method(fs, "rmSync", (file, options) => {
    if (file === directory) throw Object.assign(new Error("Temporary removal failed"), {code: "EACCES"});
    return rm(file, options);
  });
  assert.doesNotThrow(controls.cleanup);assert.deepEqual(Live.read(entry, context), replacement);
  mocked.mock.restore();controls.cleanup();assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(Live.read(entry, context), replacement);
});
async function mixed(t) {
  const f = await player(t), launchId = "mixed-launch", prepared = Hold.prepare(f.entry, {userDataDir: f.root, launchId});
  const descriptor = Live.location(f.entry, f.root), record = JSON.parse(fs.readFileSync(descriptor));record.launchId = launchId;fs.writeFileSync(descriptor, JSON.stringify(record));
  const control = Controls.file(f.entry, f.root), plan = path.join(path.dirname(control), "effect-plan.json"), packet = Buffer.alloc(19116);packet.write("MLFXCTL2");
  const before = {schema: 1, mode: "advanced", revision: "a".repeat(64), nodes: [{enabled: true, kind: "spatial"}]};
  fs.writeFileSync(control, packet);fs.writeFileSync(plan, JSON.stringify(before));
  const publication = createPublication(), candidate = {...before, revision: "b".repeat(64)};
  publication.write(plan, JSON.stringify(candidate), {root: f.root});
  f.options = {...f.options, publication, launchBinding: {launchId, presentationHold: prepared.binding}, rollbackShared: async () => {publication.rollback();}};
  return {...f, publication, plan, before, candidate};
}
test("owned mpv IPC applies every native filter and ordered shader property, preserving source and pause", async t => {
  const f = await player(t);let published = 0;
  assert.equal(fs.statSync(path.dirname(f.controls.socket)).mode & 0o777, 0o700);
  const result = await Live.withGraphicsUpdate(f.entry, f.context, f.options, () => {
    published++;assert.equal(f.props.pause, true);
    for (const [name, value] of Object.entries(desired)) assert.deepEqual(f.props[name], value);
    return "committed";
  }, {configuration});
  assert.equal(result, "committed");assert.equal(published, 1);assert.equal(f.props.pause, false);
  assert.equal(fs.readFileSync(f.entry.gamePath, "utf8"), "unchanged source");
});
test("cancelled video preparation never connects or publishes", async t => {
  const f = await player(t), controller = new AbortController(), reason = Error("Reset cancelled preparation");controller.abort(reason);
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, {...f.options, signal: controller.signal}, () => assert.fail("published"), {
    configuration: () => assert.fail("prepared cancelled candidate"), connect: () => assert.fail("connected cancelled candidate")
  }), error => error === reason);
  await assert.rejects(async () => Live.connect(f.controls.socket, {signal: controller.signal}), error => error === reason);
  assert.deepEqual(f.commands, []);
});
test("separate OSD playback wakes the paused video graph without changing pause or native properties", async t => {
  const f = await player(t, {paused: true});
  const descriptor = Live.location(f.entry, f.root), record = JSON.parse(fs.readFileSync(descriptor));record.osdLayerAPI = 1;fs.writeFileSync(descriptor, JSON.stringify(record));
  const original = Object.fromEntries(["scale", "cscale", "dscale", "glsl-shaders", "glsl-shader-opts"].map(name => [name, f.props[name]]));
  const publication = {committed: true, deferred: false};
  await Live.withGraphicsUpdate(f.entry, f.context, {...f.options, publication}, () => "committed", {
    configuration: async () => original, presentationHold: {contracts: () => ({changed: true})}
  });
  assert.ok(f.commands.some(command => command[0] === "script-message" && command[1] === "maclauncher-video-redraw"));
  assert.equal(f.props.pause, true);assert.ok(!f.commands.some(command => command[0] === "set_property"));
});
test("connection cancellation closes the pending socket and removes its listener", {timeout: 1000}, async t => {
  const f = await player(t), controller = new AbortController(), reason = Error("Cancelled connection");
  const pending = Live.connect(f.controls.socket, {signal: controller.signal});controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
test("cancellation interrupts a held IPC read without waiting for its response timeout", {timeout: 1000}, async t => {
  const f = await player(t), controller = new AbortController(), reason = Error("Reset cancelled IPC read");
  f.intercept(command => {if (command[0] === "get_property" && command[1] === "pid") {controller.abort(reason);return true;}});
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, {...f.options, signal: controller.signal}, () => assert.fail("published"), {configuration}),
    error => error === reason);
  assert.equal(f.commands.some(command => command[0] === "set_property"), false);assert.equal(f.props.pause, false);
});
for (const cancelledProperty of ["pause", "scale"]) test("cancellation after enqueued " + cancelledProperty + " restores options despite a late reply", {timeout: 1000}, async t => {
  const f = await player(t), before = structuredClone(f.props), controller = new AbortController(), reason = Error("Reset cancelled native setter");
  let heldReply, cancelled = false, late = false;
  f.intercept((command, reply) => {
    if (!cancelled && command[0] === "set_property" && command[1] === cancelledProperty) {
      cancelled = true;heldReply = reply;controller.abort(reason);return true;
    }
    if (heldReply) {heldReply();heldReply = null;late = true;}
  });
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, {...f.options, signal: controller.signal}, () => assert.fail("published"), {configuration}),
    error => error === reason);
  assert.equal(cancelled, true);assert.equal(late, true, "the cancelled reply arrives while compensation uses distinct request IDs");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.deepEqual({...f.props, "vo-passes": before["vo-passes"]}, before);
  assert.equal(fs.readFileSync(f.entry.gamePath, "utf8"), "unchanged source");
});
test("all-off and shared CRT-only updates leave unchanged native playback unpaused without setters or redraw queries", async t => {
  const f = await player(t), before = structuredClone(f.props);let published = 0;
  f.entry.graphics = {spatialMethod: "off", frameGeneration: "off", temporalMethod: "off", neuralMethod: "off"};
  for (const entry of [f.entry, {...f.entry, reshade: {enabled: true, preset: "custom", effectPath: "/filters/crt.fx"}}]) {
    await Live.withGraphicsUpdate(entry, f.context, f.options, () => ++published, {
      resolveShaderSelection: () => ({file: "/filters/crt.fx", format: "fx"})
    });
  }
  assert.equal(published, 2);assert.deepEqual(f.props, before);
  assert.equal(f.commands.some(command => ["set_property", "osd-overlay"].includes(command[0]) || command[1] === "vo-passes"), false);
});
test("shared publication failure restores every native property and an already paused player", async t => {
  const f = await player(t, {paused: true}), before = structuredClone(f.props);
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, f.options, () => {throw Error("invalid shared stage");}, {configuration}), /invalid shared stage/);
  assert.deepEqual({...f.props, "vo-passes": before["vo-passes"]}, before);
});
test("a failed resume is reported and restores native settings instead of claiming success", async t => {
  const f = await player(t), before = structuredClone(f.props);f.reject((name, value) => name === "pause" && value === false);
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, f.options, () => true, {configuration}), /pause state could not be restored/);
  assert.deepEqual({...f.props, pause: before.pause, "vo-passes": before["vo-passes"]}, before);
});
test("native setter and renderer shader errors roll back without publishing settings", async t => {
  const f = await player(t), before = structuredClone(f.props);let published = 0;
  f.reject((name, value) => name === "dscale" && value === "hermite");
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, f.options, () => published++, {configuration}), /invalid parameter/);
  assert.deepEqual({...f.props, "vo-passes": before["vo-passes"]}, before);assert.equal(published, 0);
  f.reject(null);f.logError((name, value) => name === "glsl-shaders" && value.length > 0, true);
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, f.options, () => published++, {configuration}), /Shader compilation failed/);
  assert.deepEqual({...f.props, "vo-passes": before["vo-passes"]}, before);assert.equal(published, 0);
});
test("native rollback reports renderer failure instead of accepting property acknowledgments", async t => {
  const f = await player(t);
  f.logError((name, value) => name === "glsl-shaders" && value.length === 0);
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, f.options, () => {
    throw Error("shared publication failed");
  }, {configuration}), /shared publication failed.*Previous video settings could not be restored: Shader compilation failed/);
  assert.equal(f.props.pause, false);
});
test("candidate errors cannot prematurely complete restoration before its asynchronous renderer result", async t => {
  const f = await player(t);let published = 0;
  f.logError(name => name === "glsl-shaders", true);
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, f.options, () => ++published, {configuration}),
    /Previous video settings could not be restored: Shader compilation failed/);
  assert.equal(published, 0);assert.equal(f.props.pause, false);
});
test("an IPC process/source mismatch cannot change the player or publish settings", async t => {
  const f = await player(t);f.props.pid++;
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, f.options, () => assert.fail("published"), {configuration}), {code: "GRAPHICS_LIVE_STALE"});
  assert.equal(f.commands.some(command => command[0] === "set_property"), false);
  f.props.pid--;f.props.path = path.join(f.root, "different.mp4");fs.writeFileSync(f.props.path, "different source");
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, f.options, () => assert.fail("published"), {configuration}), {code: "GRAPHICS_LIVE_STALE"});
  assert.equal(f.commands.some(command => command[0] === "set_property"), false);
});
test("a replaced launch is never restored or unpaused by an older graphics transaction", async t => {
  const f = await player(t);
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, f.options, () => {
    const file = Live.location(f.entry, f.root), record = JSON.parse(fs.readFileSync(file));record.token = "replacement";
    fs.writeFileSync(file, JSON.stringify(record));throw Error("session replaced");
  }, {configuration}), /session replaced/);
  assert.equal(f.props.pause, true);assert.equal(f.props.scale, "hermite");
  assert.equal(f.commands.filter(command => command[0] === "set_property" && command[1] === "pause").length, 1);
});
test("deferred shared settings restore native options and missing owned IPC stays next launch", async t => {
  const f = await player(t), before = structuredClone(f.props);
  await Live.withGraphicsUpdate(f.entry, f.context, f.options, () => ({deferred: true}), {configuration});assert.deepEqual({...f.props, "vo-passes": before["vo-passes"]}, before);
  let calls = 0;
  assert.deepEqual(await Live.withGraphicsUpdate(f.entry, f.context, {...f.options, runningPids: [9]}, () => ++calls, {configuration: () => assert.fail("prepared inactive")}), {deferred: true});
  assert.equal(calls, 0);
  assert.equal(await Live.withGraphicsUpdate(f.entry, f.context, {running: false}, () => ++calls), 1);
});
test("native candidate construction snapshots only the original prefix and uses the launched filter registry", async t => {
  const f = await player(t), first = path.join(f.root, "first.hook"), later = path.join(f.root, "later.hook");
  fs.writeFileSync(first, "//!HOOK MAIN\n//!BIND HOOKED\nvec4 hook(){return HOOKED_tex(HOOKED_pos);}\n");fs.copyFileSync(first, later);
  const shader = (id, file) => ({id, kind: "shader", enabled: true, shader: {enabled: true, preset: "custom", effectPath: file, parameters: {strength: [0.5]}}});
  const entry = {...f.entry, graphics: {spatialMethod: "libplacebo:hermite"}, effects: {schema: 1, mode: "advanced", video: [shader("first", first),
    {id: "scale", kind: "spatial", method: "bilinear", enabled: true, settings: {}}, shader("later", later)]}};
  const before = structuredClone(entry), props = await Live.configuration(entry, f.context, {filters: ["bilinear", "hermite"]}, {
    resolveShaderSelection: value => ({file: value.reshade.effectPath, format: "libplacebo", traits: {rgbCompatible: true}})
  });
  assert.equal(props["glsl-shaders"].length, 1);assert.notEqual(props["glsl-shaders"][0], first);assert.match(path.basename(props["glsl-shaders"][0]), /^ml-[a-f0-9]{64}\.hook$/);
  const namespace = path.basename(props["glsl-shaders"][0], ".hook");
  assert.deepEqual(props["glsl-shader-opts"], {[`${namespace}/strength`]: "0.5"});assert.equal(props.scale, "bilinear");assert.deepEqual(entry, before);
  entry.effects.video[0].shader.parameters.strength = [0.5, 1];
  const invalid = structuredClone(entry), dependencies = {
    resolveShaderSelection: value => ({file: value.reshade.effectPath, format: "libplacebo", traits: {rgbCompatible: true}})
  };
  const partial = await require("../src/modules/video/graphics").playbackConfiguration(entry,
    {...f.context, snapshotNativeShaders: true}, dependencies);
  assert.deepEqual(partial.skipped, [{id: "first", reason: "Native video shader parameters require one numeric value per setting."}]);
  assert.deepEqual(partial.entry.effects.video, entry.effects.video.slice(1), "Only the invalid native shader leaves the shared candidate");
  const surviving = await Live.configuration(entry, f.context, {filters: ["bilinear"]}, dependencies);
  assert.equal(surviving.scale, "bilinear");
  assert.deepEqual(surviving["glsl-shaders"], []);assert.deepEqual(surviving["glsl-shader-opts"], {});
  assert.deepEqual(entry, invalid, "Row isolation preserves the requested source configuration");
});
test("same-path video shader edits create immutable new paths with the original parameter basename", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "video-shader-")));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = path.join(root, "effect with spaces.hook");fs.writeFileSync(source, "original source");
  const first = Shaders.snapshot(source, root);assert.equal(Shaders.snapshot(source, root), first);
  fs.writeFileSync(source, "modified source");const second = Shaders.snapshot(source, root);
  assert.notEqual(first, second);assert.equal(path.basename(second), path.basename(source));
  assert.equal(fs.readFileSync(first, "utf8"), "original source");assert.equal(fs.readFileSync(source, "utf8"), "modified source");
  fs.rmSync(second);fs.symlinkSync(source, second);assert.throws(() => Shaders.snapshot(source, root), /prepared video shader/);
});
test("prepared native shader cache size is checked before reading cached bytes", t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"video-shader-")));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,"effect.hook");fs.writeFileSync(source,"source");
  const target=Shaders.snapshot(source,root);fs.writeFileSync(target,"unexpected cached bytes");
  const read=fs.readFileSync;
  t.mock.method(fs,"readFileSync",function(file,...args){assert.notEqual(file,target,"Mismatched cached length must reject without reading its contents");return Reflect.apply(read,this,[file,...args]);});
  assert.throws(()=>Shaders.snapshot(source,root),/prepared video shader/);
});
test("mixed updates hold before every native setter and finish only after display and pause restoration", async t => {
  const f = await mixed(t), events = [];
  const barrier = {...Hold, async begin(binding, contract) {
    assert.equal(binding.launchId, "mixed-launch");assert.equal(contract.changed, true);assert.equal(f.props.pause, false);
    assert.equal(f.commands.some(command => command[0] === "set_property"), false);events.push("held");
    return {async present({onReady}) {events.push("displayed");assert.equal(f.publication.committed, true);await onReady();},
      cancel() {assert.fail("cancelled successful update");}, finish() {assert.equal(f.props.pause, false);events.push("finished");}};
  }};
  const result = await Live.withGraphicsUpdate(f.entry, f.context, f.options, () => {events.push("published");f.publication.commit();return "saved";}, {configuration, presentationHold: barrier});
  assert.equal(result, "saved");assert.deepEqual(events, ["held", "published", "displayed", "finished"]);
  assert.equal(f.props.scale, "hermite");assert.equal(f.props.pause, false);
});
test("mixed cancellation restores the accepted contract through uncancelled hold cleanup", {timeout: 1000}, async t => {
  const f = await mixed(t), controller = new AbortController(), reason = Error("Reset cancelled mixed update"), events = [];
  f.intercept(command => {
    if (!controller.signal.aborted && command[0] === "set_property" && command[1] === "scale" && command[2] === "hermite") {
      controller.abort(reason);return true;
    }
  });
  const barrier = {...Hold, async begin() {events.push("held");return {
    present() {assert.fail("presented cancelled candidate");},
    async cancel({onReady}) {assert.equal(controller.signal.aborted, true);await onReady();events.push("restored");},
    finish() {assert.equal(f.props.pause, false);events.push("finished");}
  };}};
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, {...f.options, signal: controller.signal},
    () => assert.fail("published cancelled candidate"), {configuration, presentationHold: barrier}), error => error === reason);
  assert.deepEqual(events, ["held", "restored", "finished"]);assert.equal(f.props.scale, "bilinear");assert.equal(f.props.pause, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.plan)), f.before);assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
test("unchanged native and shared bytes do no native work, and native-only updates never acquire a hold", async t => {
  const f = await mixed(t);let published = 0;
  f.publication.write(f.plan, JSON.stringify(f.before), {root: f.root});
  await Live.withGraphicsUpdate(f.entry, f.context, f.options, () => {f.publication.commit();return ++published;},
    {configuration: async () => Object.fromEntries(Object.keys(desired).map(name => [name, f.props[name]])),
      presentationHold: {...Hold, begin() {assert.fail("held unchanged contract");}}});
  assert.equal(published, 1);assert.equal(f.commands.some(command => ["set_property", "osd-overlay"].includes(command[0])), false);
  const nativeOnly = createPublication();nativeOnly.write(f.plan, JSON.stringify(f.before), {root: f.root});
  await Live.withGraphicsUpdate(f.entry, f.context, {...f.options, publication: nativeOnly}, () => {nativeOnly.commit();return ++published;},
    {configuration, presentationHold: {...Hold, begin() {assert.fail("held byte-identical shared publication");}}});
  assert.equal(published, 2);
});
test("accepted shared-only publication wakes a paused renderer after commit without pause, seek or hold", async t => {
  const f = await mixed(t);f.props.pause = true;
  const before = structuredClone(f.props), native = Object.fromEntries(Object.keys(desired).map(name => [name, before[name]]));
  const result = await Live.withGraphicsUpdate(f.entry, f.context, f.options, () => {
    assert.equal(f.commands.some(command => command[0] === "set_property"), false);
    f.publication.commit();return "saved";
  }, {configuration: async () => native, presentationHold: {...Hold, begin() {assert.fail("held shared-only change");}}});
  assert.equal(result, "saved");assert.equal(f.publication.committed, true);
  assert.deepEqual(f.commands.filter(command => command[0] === "osd-overlay"), [["osd-overlay", 0, "ass-events", ""]]);
  assert.equal(f.commands.some(command => command[0] === "set_property" || command[0] === "show-text"), false);
  assert.equal(f.commands.some(command => command[0] === "seek" || command[1] === "vo-passes"), false);
  assert.notDeepEqual(f.props["vo-passes"], before["vo-passes"], "empty owned OSD requests redraw while identical option writes do not");
  assert.deepEqual({...f.props, "vo-passes": before["vo-passes"]}, before);
});
test("deferred or uncommitted shared-only publications do not wake the renderer", async t => {
  const f = await mixed(t), native = Object.fromEntries(Object.keys(desired).map(name => [name, f.props[name]]));
  for (const publish of [() => ({deferred: true}), () => true]) {
    await Live.withGraphicsUpdate(f.entry, f.context, f.options, publish, {configuration: async () => native});
  }
  f.publication.defer();
  await Live.withGraphicsUpdate(f.entry, f.context, f.options, () => ({deferred: true}), {configuration: async () => native});
  assert.equal(f.commands.some(command => ["set_property", "osd-overlay"].includes(command[0]) || command[1] === "vo-passes"), false);
  assert.equal(f.publication.committed, false);
});
test("shared-only wake rejection rolls back published bytes through the existing graphics transaction", async t => {
  const f = await mixed(t), native = Object.fromEntries(Object.keys(desired).map(name => [name, f.props[name]]));
  f.reject(name => name === "osd-overlay");
  const apply = require("../src/main/graphics-update").apply;
  await assert.rejects(apply(f.entry, {...f.options,
    withGraphicsUpdate: (entry, options, publish) => Live.withGraphicsUpdate(entry, f.context, options, publish, {configuration: async () => native})
  }, options => {options.publication.write(f.plan, JSON.stringify(f.candidate), {root: f.root});return true;}, createPublication), /invalid parameter/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.plan)), f.before);
  assert.equal(f.commands.some(command => command[0] === "set_property" && command[1] === "pause"), false);
});
test("mixed all-off destination and missing hold binding reject before pause or native mutation", async t => {
  const f = await mixed(t);
  f.publication.write(f.plan, JSON.stringify({...f.candidate, nodes: []}), {root: f.root});
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, f.options, () => assert.fail("published"), {configuration}), /continuing graphics presentation/);
  assert.equal(f.commands.some(command => command[0] === "set_property"), false);
  f.publication.write(f.plan, JSON.stringify(f.candidate), {root: f.root});delete f.options.launchBinding.presentationHold;
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, f.options, () => assert.fail("published"), {configuration}), /cannot coordinate/);
  assert.equal(f.commands.some(command => command[0] === "set_property"), false);
});
test("mixed failure restores shared and native contracts before positive cancel and finish", async t => {
  const f = await mixed(t), events = [];
  f.options.rollbackShared = async () => {events.push("shared rollback");f.publication.rollback();};
  const barrier = {...Hold, async begin() {events.push("held");return {
    async present() {events.push("present");throw Error("display failed");},
    async cancel({onReady}) {assert.equal(f.props.scale, "bilinear");assert.deepEqual(JSON.parse(fs.readFileSync(f.plan)), f.before);events.push("old displayed");await onReady();},
    finish() {assert.equal(f.props.pause, false);events.push("finished old");}
  };}};
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, f.options, () => {events.push("published");f.publication.commit();}, {configuration, presentationHold: barrier}), /display failed/);
  assert.deepEqual(events, ["held", "published", "present", "shared rollback", "old displayed", "finished old"]);
  assert.equal(f.props.pause, false);
});
test("failed mixed compensation retains the coherent hold and does not unpause or finish", async t => {
  const f = await mixed(t);f.options.rollbackShared = async () => {throw Error("accepted contract changed");};
  const barrier = {...Hold, async begin() {return {present() {assert.fail("presented");}, cancel() {assert.fail("lifted failed cover");}, finish() {assert.fail("finished failed cover");}};}};
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, f.options, () => {throw Error("commit failed");}, {configuration, presentationHold: barrier}), /accepted contract changed/);
  assert.equal(f.props.pause, true);assert.equal(f.commands.filter(command => command[0] === "set_property" && command[1] === "pause").length, 1);
});
test("mixed pause restoration failure compensates before finish instead of exposing the candidate", async t => {
  const f = await mixed(t), events = [];let failResume = true;
  f.reject((name, value) => name === "pause" && value === false && failResume);
  const barrier = {...Hold, async begin() {return {
    async present() {events.push("new displayed but covered");},
    async cancel() {events.push("old displayed but covered");failResume = false;},
    finish() {assert.equal(f.props.scale, "bilinear");assert.equal(f.props.pause, false);events.push("finished old");}
  };}};
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, f.options, () => {f.publication.commit();}, {configuration, presentationHold: barrier}), /invalid parameter/);
  assert.deepEqual(events, ["new displayed but covered", "old displayed but covered", "finished old"]);
});
test("terminal GPU failure restores shared/native options and original pause before acknowledged abandon", {timeout: 1500}, async t => {
  for (const originallyPaused of [false, true]) await t.test(String(originallyPaused), async t => {
  const f = await mixed(t), binding = f.options.launchBinding.presentationHold, events = [];binding.abandonAPI = 1;
  f.props.pause = originallyPaused;
  let epoch = 0;
  const timer = setInterval(() => {
    if (!fs.existsSync(binding.file)) return;const command = JSON.parse(fs.readFileSync(binding.file));
    if (command.epoch === epoch) return;epoch = command.epoch;events.push(command.action);
    const common = {schema: 1, launchId: binding.launchId, token: binding.token, epoch, transactionId: command.transactionId,
      window: 91, frameId: epoch, width: 1920, height: 1080, ...command.expected};
    if (command.action === "abandon") {
      assert.equal(f.props.pause, originallyPaused);assert.equal(f.props.scale, "bilinear");assert.deepEqual(JSON.parse(fs.readFileSync(f.plan)), f.before);
      fs.writeFileSync(binding.statusFile, JSON.stringify({...common, state: "abandoned", holding: false, presentedTime: 0}));
    } else fs.writeFileSync(binding.statusFile, JSON.stringify({...common, state: command.action === "hold" ? "held" : "failed", holding: true,
      presentedTime: command.action === "hold" ? 1 : 0, reason: "Terminal GPU failure"}));
  }, 2);t.after(() => clearInterval(timer));
  await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, f.options, () => {f.publication.commit();}, {configuration}), /Terminal GPU failure/);
  assert.deepEqual(events, ["hold", "present", "cancel", "abandon"]);assert.equal(f.props.pause, originallyPaused);
  assert.equal(f.props["time-pos"], 1.5);assert.equal(f.props.path, f.entry.gamePath);
  });
});
test("failed restoration never abandons a terminal hold or unmasks an unverified original", async t => {
  for (const failure of ["shared", "native", "pause"]) await t.test(failure, async t => {
    const f = await mixed(t);let abandoned = 0;
    if (failure === "shared") f.options.rollbackShared = async () => {throw Error("shared restore rejected");};
    if (failure === "native") f.reject((name, value) => name === "scale" && value === "bilinear");
    if (failure === "pause") f.reject((name, value) => name === "pause" && value === false);
    const barrier = {...Hold, async begin() {return {canAbandon: true,
      async present() {throw Error("Terminal GPU failure");}, async cancel() {throw Error("Terminal GPU failure");},
      async abandon() {abandoned++;}, finish() {assert.fail("finished unverified cover");}};}};
    await assert.rejects(Live.withGraphicsUpdate(f.entry, f.context, f.options, () => {f.publication.commit();}, {configuration, presentationHold: barrier}), /Previous video settings could not be restored/);
    assert.equal(abandoned, 0);assert.equal(f.props.pause, true);
  });
});

test("decoded host retains its real presentation boundary while a decoder prefix and master bypass change",async t=>{
  const f=await mixed(t),descriptor=Live.location(f.entry,f.root),record=JSON.parse(fs.readFileSync(descriptor));record.decodedFrameAPI=1;fs.writeFileSync(descriptor,JSON.stringify(record));
  f.publication.write(f.plan,JSON.stringify({...f.candidate,nodes:[]}),{root:f.root});let inspected=false;
  const barrier={...Hold,async begin(_binding,contracts){assert.equal(contracts.before.requiresPresentation,true);assert.equal(contracts.after.requiresPresentation,true,"the direct host still presents the unfiltered decoded image");inspected=true;return{async present({onReady}){await onReady();},finish(){},cancel(){assert.fail('cancelled successful bypass');}};}};
  await Live.withGraphicsUpdate(f.entry,f.context,f.options,()=>{f.publication.commit();return true;},{configuration,presentationHold:barrier});assert.equal(inspected,true);assert.equal(f.props.pause,false);
});
