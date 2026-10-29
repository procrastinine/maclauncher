const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Inputs = require("../src/modules/shared/runtime/native-graphics-inputs");
test("D15 signing policy distinguishes confirmed restrictions, same-team libraries and missing facts", () => {
  const Injection = require("../src/modules/shared/runtime/native-injection"), parse = Injection.parseSignature;
  const allow = "<key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>";
  const disable = "<key>com.apple.security.cs.disable-library-validation</key><true/>";
  assert.equal(Injection.evaluate(parse("flags=0x10000(runtime)")).available, false);
  assert.equal(Injection.evaluate(parse("flags=0x10000(runtime)" + allow), [parse("flags=0x2(adhoc)")]).available, false);
  assert.equal(Injection.evaluate(parse("flags=0x10000(runtime)" + allow + disable)).available, true);
  assert.equal(Injection.evaluate(parse("flags=0x10000(runtime)\nTeamIdentifier=ABC\n" + allow), [parse("flags=0x0\nTeamIdentifier=ABC")]).available, true);
  assert.equal(Injection.evaluate(parse("unreadable policy")).available, null);
  assert.equal(Injection.evaluate(parse("code object is not signed at all")).available, true);
  const legacy = require("../src/modules/rgss/runtime/mkxpz-config-helper");
  assert.equal(legacy.validateInjectionSignature("flags=0x2(adhoc)").injectionCompatible, true);
  assert.throws(() => legacy.validateInjectionSignature("flags=0x10000(runtime)"), /blocks the shared config helper/);
  assert.throws(() => legacy.validateInjectionSignature("no flags"), /no readable code-signature policy/);
});
test("D15 signature facts reuse exact file identity and recover from transient queries and independent cancellation", async t => {
  const Injection = require("../src/modules/shared/runtime/native-injection"), root = fs.mkdtempSync(path.join(os.tmpdir(), "native-injection-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const executable = path.join(root, "Player"), bytes = Buffer.alloc(32);bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(0x0100000c, 4);bytes.writeUInt32LE(2, 12);fs.writeFileSync(executable, bytes);
  let queries = 0, output = "flags=0x10000(runtime)";
  const execute = async () => {queries++;return {stdout: "", stderr: output};};
  assert.equal((await Injection.preflight(executable, [], {execute})).available, false);
  assert.equal((await Injection.preflight(executable, [], {execute})).available, false);assert.equal(queries, 1);
  const stamp = fs.statSync(executable);bytes[31] = 1;fs.writeFileSync(executable, bytes);fs.utimesSync(executable, stamp.atime, stamp.mtime);output = "flags=0x2(adhoc)";
  assert.equal((await Injection.preflight(executable, [], {execute})).available, true);assert.equal(queries, 2);
  let failures = 0;const transient = async () => {failures++;if (failures === 1) throw Error("codesign unavailable");return {stdout: "", stderr: "code object is not signed at all"};};
  assert.equal((await Injection.preflight(executable, [], {execute: transient})).available, null);
  assert.equal((await Injection.preflight(executable, [], {execute: transient})).available, true);assert.equal(failures, 2);
  const first = new AbortController(), second = new AbortController();let calls = 0;
  const cancellable = (_cmd, _args, {signal}) => {calls++;return new Promise((resolve, reject) => {
    if (signal === first.signal) signal.addEventListener("abort", () => reject(Object.assign(Error("cancelled"), {name: "AbortError"})), {once: true});
    else resolve({stdout: "", stderr: "flags=0x2(adhoc)"});
  });};
  const cancelled = Injection.preflight(executable, [], {execute: cancellable, signal: first.signal});
  const independent = Injection.preflight(executable, [], {execute: cancellable, signal: second.signal});
  first.abort();await assert.rejects(cancelled, {name: "AbortError"});assert.equal((await independent).available, true);assert.equal(calls, 2);
});
test("D15 blocked native graphics preserves ordinary spawn, reports unavailable and rejects live work before provider preparation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-graphics-preflight-"));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const userDataDir = path.join(root, "data"), ReShade = require("../src/modules/shared/reshade"), Binding = require("../src/modules/shared/reshade/launch-binding"), Live = require("../src/modules/shared/reshade/live-controls");
  const Injection = require("../src/modules/shared/runtime/native-injection"), Status = require("../src/modules/shared/reshade/runtime-status"), {EventEmitter} = require("node:events");
  const reason = "The executable's hardened runtime does not allow DYLD graphics attachment.", spawned = [];
  const manifest = {id: "probe", gameType: "native", runtime: {default: "runner", supported: ["runner"], entries: {runner: {graphicsHost: "window"}}}};
  const mod = {id: "probe", manifest}, registry = {listModules: () => [manifest], getModule: () => mod, getModuleInfo: () => manifest};
  const launcher = require("../src/core/launcher").createLauncher({userDataDir, registry, logger: {warn() {}},
    rosetta: {requiresForExecutable: () => false, isAvailable: () => true}, spawn(command, args, options) {
      spawned.push({command, args, options});const child = new EventEmitter();child.pid = 43000 + spawned.length;
      child.unref = () => queueMicrotask(() => child.emit("spawn"));return child;
    }});
  t.mock.method(ReShade, "prepare", async entry => {
    const file = path.join(path.dirname(Live.file(entry, userDataDir)), "launch.json");fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({schema: 1, phase: "prepared", launchId: entry.gameId, effectPlanAPI: 1}));
    return {DYLD_INSERT_LIBRARIES: "/owned/graphics.dylib", RESHADE_EFFECT_PLAN: "/owned/plan"};
  });
  t.mock.method(Injection, "preflight", async target => {assert.equal(target, "/actual/Player");return {available: false, reason};});
  const entry = {gameId: "d15-test", gamePath: root, moduleId: "probe", runtimeId: "runner", networkAccess: true,
    effects: {schema: 2, mode: "advanced", enabled: true, video: [{id: "gray", kind: "shader", enabled: true, shader: {enabled: true, preset: "grayscale"}}]}};
  const context = launcher.getGameLaunchContext(entry, {}), child = await context.spawnDetachedChecked("/transport/supervisor", ["--literal"],
    {graphicsExecutable: "/actual/Player", env: {DYLD_INSERT_LIBRARIES: "/existing/steam.dylib", KEEP: "yes"}});
  assert.equal(spawned[0].command, "/transport/supervisor");assert.deepEqual(spawned[0].args, ["--literal"]);
  assert.equal(spawned[0].options.env.DYLD_INSERT_LIBRARIES, "/existing/steam.dylib");assert.equal(spawned[0].options.env.KEEP, "yes");
  assert.equal(Object.hasOwn(spawned[0].options.env, "RESHADE_EFFECT_PLAN"), false);assert.equal(Object.hasOwn(spawned[0].options, "graphicsExecutable"), false);
  assert.equal(context.graphicsPreparationFailure.reason, reason);
  assert.equal(Binding.read(entry, {userDataDir, runningPids: [child.pid]}).graphicsAttachment.reason, reason);
  assert.equal(Status.read(entry, {userDataDir, runningPids: [child.pid]}).state, "unavailable");
  assert.equal(Status.read({...entry, effects: {...entry.effects, enabled: false}}, {userDataDir, runningPids: [child.pid]}).state, "off");
  t.mock.method(require("../src/modules/shared/reshade/neural/model-preparation"), "prepare", () => assert.fail("blocked attachment must not prepare providers"));
  await assert.rejects(require("../src/modules/shared/effects/runtime").prepare(entry, {live: true, userDataDir, runningPids: [child.pid]}),
    error => error.code === "GRAPHICS_ATTACHMENT_UNAVAILABLE" && error.message === reason);
  const deferred = {...entry, gameId: "d15-transport"}, unknown = launcher.getGameLaunchContext(deferred, {}, {
    processAdapter: (command, args, options, translation, launch) => launch(command, args, options, translation)});
  await unknown.spawnDetachedChecked("/transport/supervisor", [], {graphicsExecutable: null, env: {KEEP: "yes"}});
  assert.equal(spawned[1].options.env.DYLD_INSERT_LIBRARIES, "/owned/graphics.dylib");assert.equal(unknown.graphicsPreparationFailure, undefined);
});
test("Native graphics reuses Intel, ARM and universal executable metadata", () => {
  const inspect = () => assert.fail("Recorded executable metadata avoids filesystem inspection");
  for (const [architectures, host, expected] of [[["x86_64"], "arm64", "x86_64"], [["arm64"], "x64", "arm64"],
    [["x86_64", "arm64"], "arm64", "arm64"], [["arm64", "x86_64"], "x64", "x86_64"]]) {
    assert.equal(Inputs.resolveArchitecture({moduleData: {executableArchitectures: architectures}},
      {runtimeId: "native", hostArchitecture: host, readArchitectures: inspect}), expected);
  }
});
test("Native graphics preserves engine source contracts and authoritative declarations", () => {
  const graphicsInputs = {architecture: "x64", cameraProjection: true, sourceResolution: false, opacity: false, methods: ["fsr2"]};
  assert.deepEqual(Inputs.withInputs({}, {runtimeId: "native", graphicsInputs, declaredArchitecture: "arm64"}),
    {...graphicsInputs, architecture: "x86_64"});
  assert.equal(Inputs.resolveArchitecture({}, {runtimeId: "native", declaredArchitecture: "arm64"}), "arm64");
  assert.equal(graphicsInputs.architecture, "x64");
});
test("Native architecture fallback reads bounded Mach-O headers without executing the file", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-graphics-inputs-"));t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const executable = path.join(directory, "NativePlayer"), bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);bytes.writeUInt32LE(0x01000007, 4);bytes.writeUInt32LE(2, 12);fs.writeFileSync(executable, bytes);
  const entry = {moduleData: {launchKind: "executable", executablePath: executable}};
  assert.equal(Inputs.resolveArchitecture(entry, {runtimeId: "native", hostArchitecture: "arm64"}), "x86_64");
  assert.deepEqual(require("../src/modules/generic-app/main").resolveGraphicsInputs(entry, {runtimeId: "native"}), {architecture: "x86_64"});
});
test("Unknown paths, scripts and other backends do not invent a native architecture", () => {
  assert.equal(Inputs.resolveArchitecture({}, {runtimeId:"native"}), null);
  assert.equal(Inputs.resolveArchitecture({moduleData:{launchKind:"script", executableArchitectures:["x86_64"]}}, {runtimeId:"native"}), null);
  assert.equal(Inputs.resolveArchitecture({moduleData:{executableArchitectures:["x86_64"]}}, {runtimeId:"godot"}), null);
  assert.equal(Inputs.resolveArchitecture({moduleData:{executablePath:"/missing/native"}}, {runtimeId:"native", readArchitectures:()=>{throw Error("missing");}}), null);
  const source={source:"renderer",cameraProjection:false,sourceResolution:false};
  assert.equal(Inputs.withInputs({}, {runtimeId:"native",graphicsInputs:source}), source);
});
test("Native engine bundles resolve their actual Info.plist executable before choosing graphics providers", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-graphics-bundle-"));t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const bundle = (name, cpus) => {
    const root = path.join(directory, name + ".app"), macos = path.join(root, "Contents", "MacOS");fs.mkdirSync(macos, {recursive: true});
    fs.writeFileSync(path.join(root, "Contents", "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>ActualPlayer</string></dict></plist>');
    const tableSize = 8 + cpus.length * 20, bytes = Buffer.alloc(cpus.length === 1 ? 32 : tableSize + cpus.length * 32);
    if (cpus.length === 1) {bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(cpus[0], 4);bytes.writeUInt32LE(2, 12);}
    else {bytes.writeUInt32BE(0xcafebabe);bytes.writeUInt32BE(cpus.length, 4);cpus.forEach((cpu, i) => {
      const offset = tableSize + i * 32;bytes.writeUInt32BE(cpu, 8 + i * 20);bytes.writeUInt32BE(offset, 16 + i * 20);bytes.writeUInt32BE(32, 20 + i * 20);
      bytes.writeUInt32LE(0xfeedfacf, offset);bytes.writeUInt32LE(cpu, offset + 4);bytes.writeUInt32LE(2, offset + 12);
    });}
    const executable = path.join(macos, "ActualPlayer");fs.writeFileSync(executable, bytes);
    fs.writeFileSync(path.join(macos, "NotThePlayer"), "other bundle file");return {root, executable};
  };
  const intel = bundle("Godot Intel", [0x01000007]), arm = bundle("Godot ARM", [0x0100000c]), universal = bundle("Godot Universal", [0x01000007, 0x0100000c]);
  const options = {runtimeId: "native", hostArchitecture: "arm64"};
  assert.equal(Inputs.resolveArchitecture({nativeAppPath: intel.root, moduleData: {packPath: "/game/game.pck"}}, options), "x86_64");
  assert.equal(Inputs.resolveArchitecture({gamePath: arm.root}, options), "arm64");
  assert.equal(Inputs.resolveArchitecture({nativeAppPath: universal.root}, options), "arm64");
  assert.equal(Inputs.resolveArchitecture({nativeAppPath: universal.root}, {...options, hostArchitecture: "x64"}), "x86_64");
  assert.equal(Inputs.resolveArchitecture({nativeAppPath: intel.root}, {...options, declaredArchitecture: "arm64"}), "arm64");
  assert.equal(Inputs.resolveArchitecture({nativeAppPath: path.join(directory, "Missing.app")}, options), null);
});
