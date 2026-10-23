const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { processVideo } = require("../src/modules/shared/reshade/neural/offline");
const Source = require("../src/modules/shared/reshade/neural/source.json");

function fixture(t, body) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "neural-offline-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "neural"), modelPath = path.join(root, "model.dlssmodel");
  fs.mkdirSync(directory); fs.mkdirSync(modelPath);
  // These files exercise package/path validation; the subprocess below is a
  // protocol fixture and never executes a model or native rendering library.
  const weights = Buffer.from("protocol fixture, not a checkpoint");
  fs.writeFileSync(path.join(modelPath, "manifest.json"), JSON.stringify({ schemaVersion: 1,
    identifier: "org.example.protocol", architecture: "mlxdlss.neural-rendering-transformer.v1",
    inputs: [{ name: "color", dataType: "float32", layout: "nhwc", shape: [1, "height", "width", 16] }],
    outputs: [{ name: "color", dataType: "float32", layout: "nhwc", shape: [1, "height", "width", 4] }],
    state: { kind: "stateless" }, weights: { file: "weights.safetensors",
      sha256: crypto.createHash("sha256").update(weights).digest("hex"), tensors: [{ name: "test", dataType: "float16", shape: [1] }] } }));
  fs.writeFileSync(path.join(modelPath, "weights.safetensors"), weights);
  fs.writeFileSync(path.join(directory, Source.library), "protocol fixture, not a native library");
  fs.writeFileSync(path.join(directory, "maclauncher-neural-video"), "#!/usr/bin/env node\n" + body, { mode: 0o755 });
  const files = [Source.library, "maclauncher-neural-video"].map(name => {
    const bytes = fs.readFileSync(path.join(directory, name));
    return { path: name, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  });
  fs.writeFileSync(path.join(directory, "provider.json"), JSON.stringify({ ...Source, files }));
  const input = path.join(root, "input $(touch shell-marker).mp4"), output = path.join(root, "new output.mp4");
  fs.writeFileSync(input, "original video bytes");
  return { root, modelPath, input, output, platform: "darwin", macOSVersion: "26.0", graphicsArchitecture: "arm64" };
}

const parse = `const fs = require('node:fs');
const args = process.argv.slice(2), options = Object.fromEntries(Array.from({length:args.length/2},(_,i)=>[args[i*2],args[i*2+1]]));
`;
const progress = { type: "progress", inputFrames: 1, outputFrames: 1, estimatedInputFrames: 3, fraction: 1 / 3, elapsedSeconds: 0.5 };

test("offline neural video uses argument arrays, forwards bounded progress and creates a separate output", async t => {
  const selected = fixture(t, parse + `
if (options['--intensity'] !== '1' || options['--temporal'] !== 'off' || args.includes('--audio')) process.exit(9);
const progress = ${JSON.stringify(JSON.stringify(progress) + "\n")};
process.stdout.write(progress.slice(0, 9));
setTimeout(() => {
  process.stdout.write(progress.slice(9));
  fs.writeFileSync(options['--output'], 'processed video bytes');
  process.stdout.write(JSON.stringify({type:'complete',output:options['--output'],inputFrames:3,outputFrames:3,sceneResets:0,elapsedSeconds:1,motionBackend:'disabled'})+'\\n');
}, 5);
`);
  const events = [];
  t.mock.method(require("../src/modules/shared/reshade"), "runtimeRoot", () => selected.root);
  const result = await processVideo({ ...selected, root: undefined, intensity: 1, temporal: false,
    onProgress: event => events.push(event) });
  assert.equal(result.output, selected.output);
  assert.equal(result.inputFrames, 3);
  assert.equal(events.length, 1);
  assert.equal(events[0].fraction, 1 / 3);
  assert.equal(fs.readFileSync(selected.input, "utf8"), "original video bytes");
  assert.equal(fs.readFileSync(selected.output, "utf8"), "processed video bytes");
  assert.equal(fs.existsSync(path.join(selected.root, "shell-marker")), false);
});

test("offline export preserves existing outputs and original videos", async t => {
  const selected = fixture(t, `process.exit(9);`);
  fs.writeFileSync(selected.output, "existing output");
  await assert.rejects(processVideo(selected), /already exists/);
  await assert.rejects(processVideo({ ...selected, output: selected.input }), /new output/);
  assert.equal(fs.readFileSync(selected.output, "utf8"), "existing output");
  assert.equal(fs.readFileSync(selected.input, "utf8"), "original video bytes");
});

test("offline neural progress observer and warning failures cannot terminate encoding", async t => {
  for (const asynchronous of [false, true]) for (const asynchronousLogger of [false, true]) {
    const selected = fixture(t, parse + `
process.stdout.write(${JSON.stringify(JSON.stringify(progress) + "\n")});
setTimeout(() => {
  fs.writeFileSync(options['--output'], 'processed video bytes');
  process.stdout.write(JSON.stringify({type:'complete',output:options['--output'],inputFrames:3,outputFrames:3,sceneResets:0,elapsedSeconds:1})+'\\n');
}, 20);
`);
    let observations = 0, warnings = 0;
    const result = await processVideo({...selected,
      onProgress() {observations++;if (asynchronous) return Promise.reject(new Error("Observer unavailable"));throw new Error("Observer unavailable");},
      logger: {warn() {warnings++;if (asynchronousLogger) return Promise.reject(new Error("Warning sink unavailable"));throw new Error("Warning sink unavailable");}}});
    assert.equal(result.output, selected.output);assert.equal(result.outputFrames, 3);
    assert.equal(observations, 1);assert.equal(warnings, 1);
    assert.equal(fs.readFileSync(selected.output, "utf8"), "processed video bytes");
    assert.equal(fs.readFileSync(selected.input, "utf8"), "original video bytes");
  }
});

test("offline neural processing isolates inherited game graphics controls and preserves ordinary environment", async t => {
  const controls = {RESHADE_EFFECT: "unrelated-game.fx", RESHADE_CONTROL_FILE: "/unrelated-game/controls.bin", FSR4_DLL: "/unrelated-game/fsr4.dll", MACLAUNCHER_OFFLINE_ENV_TEST: "preserved"};
  const previous = Object.fromEntries(Object.keys(controls).map(key => [key, process.env[key]]));
  t.after(() => {for (const [key, value] of Object.entries(previous)) {if (value === undefined) delete process.env[key];else process.env[key] = value;}});
  Object.assign(process.env, controls);
  const selected = fixture(t, parse + `
if (process.env.RESHADE_EFFECT || process.env.RESHADE_CONTROL_FILE || process.env.FSR4_DLL || process.env.MACLAUNCHER_OFFLINE_ENV_TEST !== 'preserved') {
  process.stderr.write('Inherited game graphics controls reached the offline processor');process.exit(9);
}
fs.writeFileSync(options['--output'], 'processed');
process.stdout.write(JSON.stringify({type:'complete',output:options['--output'],inputFrames:1,outputFrames:1,sceneResets:0,elapsedSeconds:1})+'\\n');
`);
  assert.equal((await processVideo(selected)).output, selected.output);
  for (const [key, value] of Object.entries(controls)) assert.equal(process.env[key], value);
});

test("explicit processing rejects unsupported model metadata before launching a child", async t => {
  const selected = fixture(t, "process.exit(9);"), file = path.join(selected.modelPath, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...manifest, state: { kind: "recurrent" } }));
  await assert.rejects(processVideo({ ...selected,
    onToolProcessSpawn: () => assert.fail("invalid model started a processing child") }), /transformer/);
  assert.equal(fs.existsSync(selected.output), false);
});

test("offline export cancellation stops the owned child and lets its native staging cleanup finish", async t => {
  const selected = fixture(t, parse + `
const stage = options['--output']+'.partial'; fs.writeFileSync(stage, 'partial');
process.on('SIGTERM',()=>{fs.rmSync(stage,{force:true});process.stdout.write('{"type":"cancelled"}\\n');process.exit(130);});
process.stdout.write(${JSON.stringify(JSON.stringify(progress) + "\n")});
setInterval(()=>{},1000);
`);
  const controller = new AbortController();
  await assert.rejects(processVideo({ ...selected, signal: controller.signal, onProgress: () => controller.abort() }), { name: "AbortError" });
  assert.equal(fs.existsSync(selected.output), false);
  assert.equal(fs.existsSync(selected.output + ".partial"), false);
  assert.equal(fs.readFileSync(selected.input, "utf8"), "original video bytes");
});

test("offline processing owns its child and leases an imported model until completion", async t => {
  const Models = require("../src/modules/shared/reshade/neural/models");
  const selected = fixture(t, parse + `
process.stdout.write(${JSON.stringify(JSON.stringify(progress) + "\n")});
setTimeout(()=>{
  fs.writeFileSync(options['--output'],'processed');
  process.stdout.write(JSON.stringify({type:'complete',output:options['--output'],inputFrames:1,outputFrames:1,sceneResets:0,elapsedSeconds:1})+'\\n');
},25);
`);
  const userDataDir = path.join(selected.root, "profile"); fs.mkdirSync(userDataDir);
  const imported = await Models.importModel({ userDataDir, runtimePath: selected.modelPath });
  let owner, removal;
  await processVideo({ ...selected, userDataDir, modelPath: imported.modelPath,
    onToolProcessSpawn: (child, options) => { owner = { pid: child.pid, options }; },
    onProgress: () => { removal ||= assert.rejects(Models.removeModel({ userDataDir, version: imported.version }), { code: "RUNTIME_IN_USE" }); } });
  await removal;
  assert.ok(owner.pid > 0); assert.equal(owner.options.stopOnLauncherExit, true);assert.equal(owner.options.shutdownGraceMs, 15000);
  assert.equal(await Models.removeModel({ userDataDir, version: imported.version }), true);
});

test("offline export rejects older macOS and oversized subprocess messages", async t => {
  const selected = fixture(t, `process.stdout.write('x'.repeat(70000));setInterval(()=>{},1000);`);
  await assert.rejects(processVideo({ ...selected, macOSVersion: "15.5" }), /macOS 26/);
  await assert.rejects(processVideo(selected), /oversized progress/);
  assert.equal(fs.existsSync(selected.output), false);
});
