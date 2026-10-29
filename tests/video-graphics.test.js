const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { preparePlaybackShaders, playbackConfiguration } = require("../src/modules/video/graphics");

test("video preparation bypasses an unavailable or out-of-order row with its reason and keeps the saved selection", async () => {
  const settings={enabled:true,preset:"custom",effectPath:"/selected/missing.hook"};
  const context={};
  assert.deepEqual(await preparePlaybackShaders({effects:{mode:"advanced",video:[{id:"selected",kind:"shader",enabled:true,shader:settings}]}},context,{
    resolveShaderSelection:()=>{throw new Error("The selected shader is missing. Choose an installed shader.");}
  }),[]);
  assert.deepEqual(context.effectsSkipped,[{id:"selected",reason:"The selected shader is missing. Choose an installed shader."}]);
  const entry={effects:{mode:"advanced",video:[{id:"rgb",kind:"spatial",enabled:true,method:"bilinear"},
    {id:"yuv",kind:"shader",enabled:true,shader:settings}]}};
  const before=structuredClone(entry);
  assert.deepEqual(await preparePlaybackShaders(entry,context,{
    resolveShaderSelection:()=>({format:"libplacebo",file:"/selected/video.hook",traits:{requiresVideoPlanes:true}})
  }),[]);
  assert.match(context.effectsSkipped[0].reason,/Move video-plane shaders before shared RGB/);assert.equal(context.effectsSkipped[0].id,"yuv");
  assert.deepEqual(context.effectsEntry.effects.video.map(row=>row.id),["rgb"]);assert.deepEqual(entry,before);
});
test("ordinary video launch bypasses only failed shader rows and preserves saved selections and ordering", async t => {
  const {root, file} = fixture(t), good = file("good.hook", chroma), fx = file("shared.fx", "fixture");
  const failed = node("missing", "/missing.hook"), valid = node("native", good), badParameters = node("bad-parameters", good);
  badParameters.shader.parameters = {Strength: [1, 2]};
  const scale = {id: "scale", kind: "spatial", enabled: true, method: "bilinear", settings: {}};
  const lateYuv = node("late-yuv", good), shared = node("shared", fx);
  const entry = {effects: {schema: 1, mode: "advanced", video: [failed, valid, badParameters, scale, lateYuv, shared]}}, before = structuredClone(entry);
  const warnings = [], context = {userDataDir: root, logger: {warn(message) {warnings.push(message);throw new Error("Warning sink failed");}}};
  const result = await playbackConfiguration(entry, context);
  assert.deepEqual(result.properties["glsl-shaders"], [good]);
  assert.deepEqual(result.properties["glsl-shader-opts"], {}, "failed parameters cannot publish a partial native row");
  assert.deepEqual(result.entry.effects.video.map(row => row.id), ["scale", "late-yuv", "shared"]);
  for (const id of ["missing", "bad-parameters"]) assert.ok(warnings.some(message => message.includes(id)), id);
  assert.equal(warnings.some(message => message.includes("late-yuv")), false, "computed-plane hooks retain their shared-chain position");
  assert.deepEqual(entry, before, "saved requested rows survive launch fallback");
  assert.deepEqual(result.skipped.map(row => row.id), ["missing", "bad-parameters"], "launch and live preparation report the same bypassed rows");
});
test("video launch leaves out a failed shader row and never swallows cancellation", async () => {
  const entry = {effects: {schema: 2, mode: "advanced", video: [node("missing", "/missing.hook")]}}, before = structuredClone(entry);
  const resolveShaderSelection = () => {throw new Error("The selected shader is missing.");};
  const result = await playbackConfiguration(entry, {}, {resolveShaderSelection});
  assert.deepEqual(result.args, []);assert.deepEqual(result.entry.effects.video, []);assert.deepEqual(entry, before);
  await assert.rejects(playbackConfiguration(entry, {}, {
    resolveShaderSelection: () => {throw Object.assign(new Error("cancelled"), {name: "AbortError"});}}), {name: "AbortError"});
});

test("native video spatial hooks use decoded input once and preserve an independent appearance filter", async t => {
  const {root, file} = fixture(t), hook = file("upscale.hook", "//!HOOK MAIN\n//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *\nvec4 hook(){return HOOKED_tex(HOOKED_pos);}");
  const entry = {effects: {schema: 2, mode: "advanced", video: [node("upscale", hook), {id: "crt", kind: "shader", enabled: true, shader: {enabled: true, preset: "crt"}}]}};
  const before = structuredClone(entry);
  const result = await playbackConfiguration(entry, {userDataDir: root}, {resolveShaderSelection: value => value.reshade.preset === "crt"
    ? {format: "fx", file: "/crt.fx"} : {format: "libplacebo", file: hook}});
  assert.deepEqual(result.properties["glsl-shaders"], [hook]);
  assert.deepEqual(result.entry.effects.video.map(row => row.id), ["crt"], "native hook is excluded from duplicate shared processing");
  assert.deepEqual(entry, before);
});

test("video spatial hooks follow prior neural reconstruction in the shared RGB chain", async () => {
  const entry = {effects: {schema: 2, mode: "advanced", video: [{id: "neural", kind: "neural", enabled: true, method: "mlx-dlss", settings: {}},
    node("upscale", "/upscale.hook")]}};
  const result = await playbackConfiguration(entry, {}, {resolveShaderSelection: () => ({format: "libplacebo", file: "/upscale.hook"})});
  assert.deepEqual(result.properties["glsl-shaders"], []);assert.equal(result.entry, entry);
});
test("ordinary module Play reaches its original player when the optional selected shader is missing", async t => {
  const {root, file} = fixture(t), video = file("clip.mp4", "video fixture");
  const Manager = require("../src/modules/video/runtime/manager"), Live = require("../src/modules/video/live"), Video = require("../src/modules/video/main");
  t.mock.method(Manager, "resolveSelection", () => ({ready: true, install: {executablePath: "/player/mpv"}}));
  t.mock.method(Live, "create", () => ({socket: path.join(root, "mpv.sock"), bind() {}, cleanup() {}}));
  const entry = {gamePath: video, effects: {schema: 2, mode: "advanced", video: [node("missing", path.join(root, "missing.hook"))]}};
  const before = structuredClone(entry), calls = [], child = {pid: 0, exitCode: 0, signalCode: null};let warnings = 0;
  const context = {userDataDir: root, applyGameEnvironment: async () => ({}),
    logger: {warn() {warnings++;throw new Error("Warning sink failed");}},
    spawnDetachedChecked: async (...args) => {calls.push(args);return child;}};
  assert.equal(await Video.launchRuntime("mpv", entry, context), child);
  assert.equal(calls.length, 1);assert.equal(calls[0][0], "/player/mpv");
  assert.ok(calls[0][1].includes("--scale=bilinear"));
  // The missing row and the default filter this mpv build lacks each warn once.
  assert.deepEqual(context.effectsEntry.effects.video, []);assert.deepEqual(entry, before);assert.equal(warnings, 2);
});
test("video Play forwards literal game arguments before the existing file boundary without changing empty launches", async t => {
  const {root, file} = fixture(t), video = file("clip with spaces.mp4", "video fixture");
  const Manager = require("../src/modules/video/runtime/manager"), Live = require("../src/modules/video/live"), Video = require("../src/modules/video/main");
  const {spawnSync} = require("node:child_process");
  t.mock.method(Manager, "resolveSelection", () => ({ready: true, install: {executablePath: "/player/mpv"}}));
  t.mock.method(Live, "create", () => ({socket: path.join(root, "mpv.sock"), bind() {}, cleanup() {}}));
  const gameArguments = ["--title=A quoted title", "", "$(touch forbidden)", "first\nsecond", "--vf"], before = [...gameArguments];
  const deliveries = [], child = {pid: 0, exitCode: 0, signalCode: null};
  const context = {userDataDir: root, applyGameEnvironment: async () => ({}),
    spawnDetachedChecked: async (_executable, args) => {
      const received = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...args], {encoding: "utf8"});
      assert.equal(received.status, 0, received.stderr);
      deliveries.push(JSON.parse(received.stdout).map(arg => {
        if (!arg.startsWith("--config-dir=")) return arg;
        assert.match(path.basename(arg.slice("--config-dir=".length)), /^maclauncher-mpv-/);
        return "--config-dir=<owned configuration>";
      }));return child;
    }};
  const entry = {gamePath: video, graphics: {spatialMethod: "off"}};
  await Video.launchRuntime("mpv", entry, context);
  await Video.launchRuntime("mpv", entry, {...context, gameArguments: []});
  await Video.launchRuntime("mpv", entry, {...context, gameArguments});
  assert.deepEqual(deliveries[1], deliveries[0]);
  assert.deepEqual(deliveries[2], [...deliveries[0].slice(0, -2), ...gameArguments, "--", video]);
  assert.deepEqual(gameArguments, before);assert.equal(fs.existsSync(path.join(root, "forbidden")), false);
});
for (const failure of ["create", "bind"]) test("optional video IPC " + failure + " failure cannot veto playback through cleanup or warnings", async t => {
  const {root, file} = fixture(t), video = file("clip.mp4", "video fixture");
  const Manager = require("../src/modules/video/runtime/manager"), Live = require("../src/modules/video/live"), Video = require("../src/modules/video/main");
  t.mock.method(Manager, "resolveSelection", () => ({ready: true, install: {executablePath: "/player/mpv"}}));
  let cleaned = 0, warnings = 0;
  t.mock.method(Live, "create", () => {
    if (failure === "create") throw Object.assign(new Error("Temporary controls are not writable"), {code: "EACCES"});
    return {socket: path.join(root, "mpv.sock"), bind() {throw new Error("Cannot publish controls");},
      cleanup() {cleaned++;throw new Error("Cannot remove controls");}};
  });
  const entry = {gamePath: video, effects: {schema: 2, mode: "advanced", enabled: false, video: []}}, before = structuredClone(entry);
  const calls = [], child = {pid: 0, exitCode: 0, signalCode: null};
  const context = {userDataDir: root, logger: {warn() {warnings++;throw new Error("Warning sink failed");}},
    applyGameEnvironment: async () => ({KEPT: "vendor environment"}),
    spawnDetachedChecked: async (...args) => {calls.push(args);return child;}};
  assert.equal(await Video.launchRuntime("mpv", entry, context), child);
  assert.equal(calls.length, 1);assert.equal(calls[0][0], "/player/mpv");
  assert.deepEqual(calls[0][1].slice(-2), ["--", video]);assert.ok(calls[0][1].includes("--scale=bilinear"));
  assert.equal(calls[0][1].some(arg => arg.startsWith("--input-ipc-server=")), failure === "bind");
  assert.equal(calls[0][2].env.KEPT, "vendor environment");
  assert.equal(cleaned, failure === "bind" ? 1 : 0);assert.equal(warnings, 1);assert.deepEqual(entry, before);
});
test("video spawn errors retain their identity when optional IPC cleanup fails", async t => {
  const {root, file} = fixture(t), video = file("clip.mp4", "video fixture");
  const Manager = require("../src/modules/video/runtime/manager"), Live = require("../src/modules/video/live"), Video = require("../src/modules/video/main");
  t.mock.method(Manager, "resolveSelection", () => ({ready: true, install: {executablePath: "/player/mpv"}}));
  let cleaned = 0;
  t.mock.method(Live, "create", () => ({socket: path.join(root, "mpv.sock"), bind() {assert.fail("bound failed spawn");},
    cleanup() {cleaned++;throw new Error("Cleanup failed");}}));
  for (const error of [Object.assign(new Error("Player spawn failed"), {code: "ENOENT"}), Object.assign(new Error("Launch cancelled"), {name: "AbortError"})]) {
    const context = {userDataDir: root, applyGameEnvironment: async () => ({}), spawnDetachedChecked: async () => {throw error;}};
    await assert.rejects(Video.launchRuntime("mpv", {gamePath: video, effects: {schema: 2, mode: "advanced", enabled: false, video: []}}, context), actual => actual === error);
  }
  assert.equal(cleaned, 2);
});
for (const failure of ["AbortError", "ABORT_ERR", "signal"]) test("video IPC setup never treats " + failure + " cancellation as optional", async t => {
  const {root, file} = fixture(t), video = file("clip.mp4", "video fixture");
  const Manager = require("../src/modules/video/runtime/manager"), Live = require("../src/modules/video/live"), Video = require("../src/modules/video/main");
  t.mock.method(Manager, "resolveSelection", () => ({ready: true, install: {executablePath: "/player/mpv"}}));
  const controller = new AbortController(), reason = new Error("Launch was cancelled");
  t.mock.method(Live, "create", () => {
    if (failure === "signal") {controller.abort(reason);throw new Error("Concurrent IPC failure");}
    throw Object.assign(reason, failure === "AbortError" ? {name: failure} : {code: failure});
  });
  const context = {userDataDir: root, signal: controller.signal, applyGameEnvironment: async () => ({}),
    logger: {warn() {assert.fail("warned for cancellation");}}, spawnDetachedChecked: async () => assert.fail("spawned cancelled player")};
  await assert.rejects(Video.launchRuntime("mpv", {gamePath: video, effects: {schema: 2, mode: "advanced", enabled: false, video: []}}, context), actual => actual === reason);
});
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "video-shader-")));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = (name, source) => { const target = path.join(root, name);fs.writeFileSync(target, source);return target; };
  return { root, file };
}
const chroma = "//!HOOK CHROMA\n//!BIND HOOKED\n//!BIND LUMA\nvec4 hook(){return HOOKED_tex(HOOKED_pos);}\n";
function node(id, file) { return { id, kind: "shader", enabled: true, shader: { enabled: true, preset: "custom", effectPath: file } }; }
test("native video routing follows declared planes and keeps the saved plan unchanged", async t => {
  const { root, file } = fixture(t), source = file("Arbitrary:name with spaces.hook", chroma), row = node("planes", source);
  row.shader.parameters = { Strength: [0.6] };
  const entry = { gamePath: "/Video/clip.mp4", effects: { schema: 2, mode: "advanced", video: [row] } };
  const before = structuredClone(entry), context = { userDataDir: root };
  const args = await preparePlaybackShaders(entry, context);
  assert.equal(args[0], `--glsl-shader=${source}`);assert.ok(args.includes("--glsl-shader-opts-append=Arbitrary:name with spaces/Strength=0.6"));
  assert.deepEqual(context.effectsEntry.effects.video, []);assert.deepEqual(entry, before);
});
test("native mpv shader prefixes use original frames while later shared stages retain their order", async t => {
  const { root, file } = fixture(t), yuv = file("planes.hook", chroma), rgb = file("colour.hook", "//!HOOK MAIN\n//!BIND HOOKED\nvec4 hook(){return HOOKED_tex(HOOKED_pos);}\n");
  const scale = { id: "scale", kind: "spatial", enabled: true, method: "bilinear", settings: {} };
  const entry = { gamePath: "/Video/clip.mp4", effects: { schema: 1, mode: "advanced", renderResolution: { height: 480 }, video: [node("planes", yuv), node("colour", rgb), scale, node("later-rgb", rgb)] } };
  const original = structuredClone(entry), warnings = [], context = { userDataDir: root, logger: { warn: message => warnings.push(message) } };
  assert.deepEqual(await preparePlaybackShaders(entry, context), [`--glsl-shader=${yuv}`, `--glsl-shader=${rgb}`]);
  assert.deepEqual(context.effectsEntry.effects.video.map(row => row.id), ["scale", "later-rgb"]);assert.deepEqual(context.effectsEntry.effects.renderResolution, { height: 480 });
  assert.equal(warnings.length, 0);assert.deepEqual(entry, original);
  entry.effects.video.push(node("late",yuv));
  const fresh={userDataDir:root};
  await preparePlaybackShaders(entry,fresh);
  assert.deepEqual(fresh.effectsEntry.effects.video.map(row => row.id), ["scale", "later-rgb", "late"]);
});
test("schema2 graphics bypass clears native shaders without opening their files", async () => {
  const entry = {effects: {schema: 2, mode: "advanced", enabled: false, video: [node("missing", "/missing.hook")]}};
  const original = structuredClone(entry), context = {};
  assert.deepEqual(await preparePlaybackShaders(entry, context, {resolveShaderSelection: () => assert.fail("bypass must not prepare shaders")}), []);
  assert.equal(context.effectsEntry, entry);
  const configured = await playbackConfiguration(entry, context, {resolveShaderSelection: () => assert.fail("bypass must not resolve shader")});
  assert.deepEqual(configured.properties, {"glsl-shaders": [], "glsl-shader-opts": {}});
  assert.deepEqual(require("../src/modules/video/scaling").argumentsFor(entry, ["bilinear", "ewa_lanczossharp"]), ["--scale=bilinear", "--cscale=bilinear", "--dscale=bilinear"]);
  assert.deepEqual(entry, original);
});
test("alternative RGB hooks run in original mpv and cancellation is never swallowed", async t => {
  const { root, file } = fixture(t), source = file("alternative.hook", "//!HOOK LUMA\n//!HOOK MAIN\n//!BIND HOOKED\nvec4 hook(){return HOOKED_tex(HOOKED_pos);}\n");
  const entry = { effects: { schema: 2, mode: "advanced", video: [node("alternative", source)] } }, context = { userDataDir: root };
  assert.deepEqual(await preparePlaybackShaders(entry, context), [`--glsl-shader=${source}`]);assert.deepEqual(context.effectsEntry.effects.video, []);
  await assert.rejects(preparePlaybackShaders(entry, context, { resolveShaderSelection: () => { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); } }), { name: "AbortError" });
});

test("native video shader rows retain independent parameters for equal basenames and repeated sources", async t => {
  const {root, file} = fixture(t);fs.mkdirSync(path.join(root, "one"));fs.mkdirSync(path.join(root, "two"));
  const first = file("one/filter.hook", chroma), second = file("two/filter.hook", chroma + "// second source\n");
  const rows = [["first", first, 0.2], ["second", second, 0.8], ["repeat", first, 0.5]].map(([id, source, strength]) => ({
    ...node(id, source), shader: {...node(id, source).shader, parameters: {Strength: [strength]}}
  }));
  const entry = {effects: {schema: 1, mode: "advanced", video: rows}}, before = structuredClone(entry);
  const context = {userDataDir: root, snapshotNativeShaders: true};
  const result = await playbackConfiguration(entry, context), paths = result.properties["glsl-shaders"];
  assert.equal(paths.length, 3);assert.equal(new Set(paths).size, 3);
  const namespace = source => path.basename(source, path.extname(source));
  assert.deepEqual(result.properties["glsl-shader-opts"], Object.fromEntries(paths.map((source, i) => [`${namespace(source)}/Strength`, String([0.2, 0.8, 0.5][i])])));
  assert.deepEqual((await playbackConfiguration(entry, context)).properties, result.properties, "row aliases remain stable for unchanged bindings");
  assert.equal(fs.readFileSync(paths[0], "utf8"), chroma);assert.equal(fs.readFileSync(paths[2], "utf8"), chroma);
  fs.appendFileSync(first, "// changed source\n");
  const edited = (await playbackConfiguration(entry, context)).properties["glsl-shaders"];
  assert.notEqual(edited[0], paths[0]);assert.notEqual(edited[2], paths[2]);assert.equal(edited[1], paths[1]);
  assert.equal(fs.readFileSync(paths[0], "utf8"), chroma);assert.deepEqual(entry, before);
});

test("decoded GPU ingress retains RGB and derived-plane hooks at their canonical row extents", async t => {
  const {root,file}=fixture(t),rgb=file("image.hook","//!HOOK MAIN\nvec4 hook(){return HOOKED_tex(HOOKED_pos);}\n"),derived=file("derived.hook",chroma);
  const entry={effects:{schema:2,mode:"advanced",enabled:true,video:[node("derived",derived),{id:"reduce",kind:"downsample",enabled:true,method:"area",extent:{relativeTo:"input",factor:.5},settings:{}},{...node("resize-hook",rgb),extent:{relativeTo:"presentation",factor:1}}]}};
  const before=structuredClone(entry),result=await playbackConfiguration(entry,{userDataDir:root,decodedFrameProducer:true});
  assert.deepEqual(result.properties["glsl-shaders"],[]);
  assert.deepEqual(result.entry,entry,"decoded RGB processing shares the common graph, including explicit extent and order");
  assert.deepEqual(entry,before);
});
test("decoded ingress keeps original decoder-only hooks in its prefix without moving later common rows", async t => {
  const {root,file}=fixture(t),original=file("decoder.hook","//!HOOK NATIVE\nvec4 hook(){return vec4(1);}\n"),rgb=file("image.hook","//!HOOK MAIN\nvec4 hook(){return HOOKED_tex(HOOKED_pos);}\n");
  const entry={effects:{schema:2,mode:"advanced",enabled:true,video:[node("decoder",original),node("image",rgb)]}},before=structuredClone(entry);
  const result=await playbackConfiguration(entry,{userDataDir:root,decodedFrameProducer:true},{resolveShaderSelection:value=>({format:"libplacebo",file:value.reshade.effectPath,traits:value.reshade.effectPath===original?{requiresVideoPlanes:true}:{rgbCompatible:true}})});
  assert.deepEqual(result.properties["glsl-shaders"],[original]);assert.deepEqual(result.entry.effects.video.map(n=>n.id),["image"]);assert.deepEqual(entry,before);
});

test("a video shader that changes while it is read is read again", t => {
  const Shaders = require("../src/modules/video/native-shaders");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "video-shader-read-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "sharpen.hook"), userDataDir = path.join(root, "profile");
  fs.writeFileSync(source, "//!HOOK MAIN\n");fs.mkdirSync(userDataDir);
  const fstat = fs.fstatSync;let calls = 0;
  t.mock.method(fs, "fstatSync", (...args) => {
    const stat = fstat(...args);
    return ++calls === 2 ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { mtimeMs: stat.mtimeMs + 1 }) : stat;
  });
  const target = Shaders.snapshot(source, userDataDir);
  assert.equal(calls, 4, "the changed first read is followed by one stable read");
  assert.equal(fs.readFileSync(target, "utf8"), "//!HOOK MAIN\n");
  calls = 0;t.mock.method(fs, "fstatSync", (...args) => {const stat = fstat(...args);return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { mtimeMs: ++calls });});
  assert.throws(() => Shaders.snapshot(source, userDataDir), /changed while it was being prepared/);
  assert.equal(calls, 6, "a source that keeps changing is reported after three reads");
});
