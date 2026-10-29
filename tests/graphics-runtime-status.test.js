const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const {execFileSync} = require("node:child_process"), vm = require("node:vm");
const Status = require("../src/modules/shared/reshade/runtime-status"), Live = require("../src/modules/shared/reshade/live-controls");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-status-")));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const entry = {gameId: "status", gamePath: "/Games/Status", effects: {schema: 2, mode: "advanced", enabled: true, video: [
    {id: "shader", kind: "shader", enabled: true, shader: {enabled: true, preset: "crt"}},
    {id: "neural", kind: "neural", method: "mlx-dlss", enabled: true, settings: {modelPath: "/Models/Local.dlssmodel"}}]}}, options = {userDataDir: root, runningPids: [process.pid]};
  const selected = Status.prepare(entry, {...options, launchId: "current"});assert.equal(fs.existsSync(path.dirname(selected.binding.file)), false);
  const directory = path.dirname(selected.binding.file);fs.mkdirSync(directory, {recursive: true});
  const controls = Buffer.alloc(19116);controls.write("MLFXCTL2");fs.writeFileSync(Live.file(entry, root), controls);
  const revision = "a".repeat(64), digest = crypto.createHash("sha256").update(controls).digest("hex");
  fs.writeFileSync(path.join(directory, "effect-plan.json"), JSON.stringify({schema: 1, mode: "simple", revision, nodes: []}));
  const launch = {schema: 1, launchId: "current", phase: "spawned", effectPlanAPI: 1, pid: process.pid, runtimeStatus: selected.binding,
    graphicsLivePreparation: {preparationStatus: {requested: [{id: "tone", method: "crt"}], pending: [{id: "generation", method: "lsfg", reason: "Model access is pending.", retained: false}]}}};
  const save = () => fs.writeFileSync(path.join(directory, "launch.json"), JSON.stringify(launch));save();
  return {root, entry, options, selected, revision, digest, launch, save, directory};
}
test('selected initial and live static images prime only a bounded observation lease', t => {
  const f = fixture(t), before = Date.now();
  const initial = Status.prepare(f.entry, {...f.options, launchId: 'initial', processingRequested: true});
  const bytes = fs.readFileSync(initial.binding.file);
  assert.equal(bytes.toString('ascii', 0, 8), 'MLFXSTS1');
  assert.ok(Number(bytes.readBigUInt64LE(16)) >= before + 6000);
  assert.ok(Number(bytes.readBigUInt64LE(16)) <= Date.now() + 6000);
  assert.equal(bytes.subarray(4096).some(Boolean), false, 'priming is not an encoded or completed observation');
  assert.equal(Status.prime(f.selected.binding, f.options), true);
  const live = fs.readFileSync(f.selected.binding.file);
  assert.equal(live.subarray(4096).some(Boolean), false);
  const bad = {...f.selected.binding, token: 'f'.repeat(64)};
  assert.equal(Status.prime(bad, f.options), false, 'another launch cannot lease an existing page');
});
test('Automatic neural status and capability checks resolve the same operation preference without expanding model authorization',t=>{
 const f=fixture(t),Neural=require('../src/modules/shared/reshade/neural'),Binding=require('../src/modules/shared/reshade/launch-binding'),row={id:'general',kind:'upscale',method:'realesrgan',enabled:true,settings:{modelPath:null}};
 f.entry.effects={schema:2,mode:'advanced',enabled:true,video:[row]};f.launch.effectPlanNeuralLibrary='/provider.dylib';f.launch.effectPlanNeuralModels=['/models/general.restorationmodel'];f.launch.graphicsLivePreparation={preparationStatus:{applied:[{id:row.id,method:row.method}]}};f.save();
 t.mock.method(Neural,'listModels',()=>[{version:'anime',method:'realesrgan',modelPath:'/outside/anime.restorationmodel'},{version:'general',method:'realesrgan',modelPath:'/models/general.restorationmodel',curatedDefault:true}]);
 const available=Status.read(f.entry,f.options);assert.deepEqual(available.preparation.pending,[]);assert.equal(available.contexts.length,0,'authorized metadata never fabricates native completion');assert.equal(Binding.supportsPlan(f.launch,f.entry.effects,undefined,f.options),true);
 const options={...f.options,settings:{runtimes:{'graphics-neural-models':{defaultVersions:{realesrgan:'anime'}}}}};assert.equal(Status.read(f.entry,options).preparation.pending.length,1);assert.equal(Binding.supportsPlan(f.launch,f.entry.effects,undefined,options),false);assert.equal(row.settings.modelPath,null);
});
test('Automatic shader model attachments share status selection and exact launch authorization',t=>{
 const f=fixture(t),Neural=require('../src/modules/shared/reshade/neural');
 const row={id:'fog',kind:'shader',enabled:true,shader:{enabled:true,preset:'shader:native:estimated-depth-fog'},settings:{modelPath:null}};
 f.entry.effects={schema:2,mode:'advanced',enabled:true,video:[row]};
 f.launch.effectPlanNeuralLibrary='/provider.dylib';f.launch.effectPlanNeuralModels=['/models/depth.depthmodel'];
 f.launch.graphicsLivePreparation={preparationStatus:{applied:[{id:row.id,method:'estimated-depth-fog'}]}};f.save();
 t.mock.method(Neural,'listModels',()=>[
  {version:'rgb',method:'mlx-dlss',modelPath:'/models/restoration.dlssmodel',curatedDefault:true},
  {version:'depth',method:'depth-anything-v2-small',modelPath:'/models/depth.depthmodel',curatedDefault:true},
  {version:'outside',method:'depth-anything-v2-small',modelPath:'/outside/depth.depthmodel'}
 ]);
 assert.deepEqual(Status.read(f.entry,f.options).preparation.pending,[]);
 const outside={...f.options,settings:{runtimes:{'graphics-neural-models':{defaultVersions:{'depth-anything-v2-small':'outside'}}}}};
 assert.match(Status.read(f.entry,outside).preparation.pending[0].reason,/unavailable to this running game/);
 assert.equal(row.settings.modelPath,null,'read-only status preserves Automatic');
});
test("runtime status has no page or binding reads for Off and rejects stale process ownership", t => {
  const f = fixture(t), Binding = require("../src/modules/shared/reshade/launch-binding");
  const read = t.mock.method(Binding, "read", () => assert.fail("Off must not read a launch or create a consumer"));
  assert.deepEqual(Status.read({...f.entry, effects: null}, f.options), {state: "off", contexts: []});
  read.mock.restore();
  assert.equal(Status.read(f.entry, {...f.options, runningPids: [process.pid + 1000]}).state, "unbound");
  assert.equal(Status.read(f.entry, {...f.options, runningPids: []}).state, "stopped");
  assert.equal(fs.existsSync(f.selected.binding.file), false);
});
test("frame-source matrices remain distinct from camera projection metadata",t=>{
  const f=fixture(t);Status.read(f.entry,f.options);
  const bytes=Buffer.alloc(32768),now=BigInt(Date.now());bytes.writeUInt32LE(process.pid,0);bytes.writeBigUInt64LE(1n,8);
  bytes.writeBigUInt64LE(now,504);bytes.writeBigUInt64LE(1n,512);bytes.writeUInt32LE(1,912);bytes.writeUInt32LE(6,916);bytes.writeUInt32LE(32|64,920);bytes.writeBigUInt64LE(now,928);
  const fd=fs.openSync(f.selected.binding.file,'r+');try{fs.writeSync(fd,bytes,0,bytes.length,4096);}finally{fs.closeSync(fd);}
  const source=Status.read(f.entry,f.options).contexts[0].frameSource;
  assert.equal(source.source,'explicit-texture');assert.deepEqual(source.inputs,['viewMatrix','projectionMatrix']);
});
test("resource acceptance is separate from attempted revision and requires current unanimous leased contexts", t => {
  const f = fixture(t);assert.equal(Status.accepted(f.entry, f.options), null);
  assert.equal(fs.existsSync(f.selected.binding.file), false, "acceptance queries do not create a consumer page");
  Status.read(f.entry, f.options);
  const bytes = Buffer.alloc(32768), now = Date.now();bytes.writeUInt32LE(process.pid, 0);bytes.writeBigUInt64LE(1n, 8);
  bytes.writeUInt32LE(6, 16);bytes.write("b".repeat(64), 112);bytes.writeBigUInt64LE(BigInt(now), 504);bytes.writeBigUInt64LE(1n, 512);
  const write = (offset = 4096) => {const fd = fs.openSync(f.selected.binding.file, "r+");try {fs.writeSync(fd, bytes, 0, bytes.length, offset);} finally {fs.closeSync(fd);}};
  write();assert.equal(Status.accepted(f.entry, f.options), null, "Prepared/Failed planRevision is not resource acceptance");
  bytes.write(f.revision, 528);bytes.write(f.digest, 593);bytes.writeBigUInt64LE(BigInt(now), 664);write();
  fs.writeFileSync(path.join(f.directory, "effect-plan.json"), JSON.stringify({schema: 1, mode: "advanced", revision: "b".repeat(64)}));
  const accepted = Status.accepted(f.entry, f.options);
  assert.equal(accepted.revision, f.revision, "the accepted revision need not match a rejected published pointer");
  assert.equal(accepted.launchId, "current");assert.equal(accepted.launchPid, process.pid);assert.equal(accepted.contexts[0].pid, process.pid);
  const admissionOnly = Buffer.alloc(32768);admissionOnly.writeUInt32LE(process.pid, 0);admissionOnly.writeBigUInt64LE(3n, 8);
  admissionOnly.writeBigUInt64LE(BigInt(now), 504);admissionOnly.writeBigUInt64LE(1n, 512);admissionOnly.writeUInt32LE(1, 672);
  const admissionFd = fs.openSync(f.selected.binding.file, "r+");try {fs.writeSync(admissionFd, admissionOnly, 0, admissionOnly.length, 4096 + 32768);} finally {fs.closeSync(admissionFd);}
  assert.equal(Status.accepted(f.entry, f.options).revision, f.revision, "admission checks alone neither adopt resources nor join the accepted-resource vote");
  bytes.writeBigUInt64LE(2n, 8);bytes.fill(0, 528, 593);bytes.write("c".repeat(64), 528);write(4096 + 32768);
  assert.equal(Status.accepted(f.entry, f.options), null, "different active contexts must agree before projection");
  bytes.writeUInt32LE(7, 16);write(4096 + 32768);assert.equal(Status.accepted(f.entry, f.options).revision, f.revision);
  bytes.writeUInt32LE(6, 16);bytes.writeBigUInt64LE(BigInt(now - 10000), 504);write();
  assert.equal(Status.accepted(f.entry, f.options), null, "stale status cannot authorize a new projection");
  bytes.writeBigUInt64LE(BigInt(now), 504);bytes.write(f.revision, 528);write();
  const fd = fs.openSync(f.selected.binding.file, "r+"), lease = Buffer.alloc(8);try {fs.writeSync(fd, lease, 0, 8, 16);} finally {fs.closeSync(fd);}
  assert.equal(Status.accepted(f.entry, f.options), null, "acceptance queries neither renew nor trust an expired lease");
  assert.equal(Status.accepted(f.entry, {...f.options, runningPids: [process.pid + 1000]}), null);
});

test("native candidate Preparing is decoded without becoming accepted or borrowing an old completion", t => {
  const f = fixture(t);assert.equal(Status.preparation(f.entry, {...f.options, documentRevision: f.revision}), null);
  assert.equal(fs.existsSync(f.selected.binding.file), false, "a progress read creates no observation page");
  Status.read(f.entry, f.options);
  const candidate = "b".repeat(64), now = Date.now();
  fs.writeFileSync(path.join(f.directory, "effect-plan.json"), JSON.stringify({schema: 1, mode: "advanced", revision: candidate, nodes: []}));
  const old = Buffer.alloc(32768);old.writeUInt32LE(process.pid, 0);old.writeBigUInt64LE(1n, 8);old.writeUInt32LE(3, 16);
  old.write(f.revision, 112);old.write(f.revision, 528);old.writeBigUInt64LE(BigInt(now - 1), 504);old.writeBigUInt64LE(1n, 512);old.writeBigUInt64LE(BigInt(now - 1), 664);old.writeBigUInt64LE(1n, 40);
  const pending = Buffer.alloc(32768);pending.writeUInt32LE(process.pid, 0);pending.writeBigUInt64LE(2n, 8);pending.writeUInt32LE(8, 16);
  pending.write(candidate, 112);pending.write("Preparing a pipeline.", 242);pending.writeBigUInt64LE(BigInt(now), 504);pending.writeBigUInt64LE(1n, 512);
  const write = bytes => {const fd = fs.openSync(f.selected.binding.file, "r+");try {fs.writeSync(fd, old, 0, old.length, 4096);fs.writeSync(fd, bytes, 0, bytes.length, 4096 + 32768);} finally {fs.closeSync(fd);}};
  write(pending);
  assert.equal(Status.read(f.entry, f.options).state, "preparing");
  old.writeUInt32LE(6, 16);old.fill(0, 112, 176);old.write(candidate, 112);write(pending);
  assert.equal(Status.read(f.entry, f.options).state, "preparing", "fresh preparation for changed geometry outranks an older failed attempt of the same document");
  old.writeUInt32LE(3, 16);old.fill(0, 112, 176);old.write(f.revision, 112);write(pending);
  assert.equal(Status.accepted(f.entry, f.options).revision, f.revision, "only accepted contexts vote for retained resources");
  assert.deepEqual(Status.preparation(f.entry, {...f.options, documentRevision: candidate}), {launchId: "current", documentRevision: candidate,
    phase: "preparing", reason: "Preparing a pipeline.", observedAt: now});
  assert.equal(Status.preparation(f.entry, {...f.options, documentRevision: f.revision}), null);
  pending.writeUInt32LE(6, 16);pending.fill(0, 242, 498);pending.write("The pipeline failed.", 242);write(pending);
  assert.equal(Status.preparation(f.entry, {...f.options, documentRevision: candidate}).phase, "failed");
  pending.writeBigUInt64LE(BigInt(now - 7000), 504);write(pending);
  assert.equal(Status.preparation(f.entry, {...f.options, documentRevision: candidate}), null, "stale progress cannot extend confirmation");
});
test("a game drawable stall explains an unconfirmed change without failing it or voting on acceptance (D18)", t => {
  const f = fixture(t);Status.read(f.entry, f.options);
  const candidate = "c".repeat(64), now = Date.now(), reason = "The game stopped drawing after macOS returned no display image after 1007 ms; changes apply if it draws again";
  const drawing = Buffer.alloc(32768);drawing.writeUInt32LE(process.pid, 0);drawing.writeBigUInt64LE(16n, 8);drawing.writeUInt32LE(3, 16);
  drawing.write(f.revision, 112);drawing.write(f.revision, 528);drawing.writeBigUInt64LE(BigInt(now - 1), 504);drawing.writeBigUInt64LE(1n, 512);drawing.writeBigUInt64LE(BigInt(now - 1), 664);drawing.writeBigUInt64LE(1n, 40);
  // The stall context is the layer address with its low bit set, Prepared without accepted resources.
  const stall = Buffer.alloc(32768);stall.writeUInt32LE(process.pid, 0);stall.writeBigUInt64LE(17n, 8);stall.writeUInt32LE(1, 16);
  stall.write(candidate, 112);stall.write(reason, 242);stall.writeBigUInt64LE(BigInt(now), 504);stall.writeBigUInt64LE(1n, 512);
  const fd = fs.openSync(f.selected.binding.file, "r+");try {fs.writeSync(fd, drawing, 0, drawing.length, 4096);fs.writeSync(fd, stall, 0, stall.length, 4096 + 32768);} finally {fs.closeSync(fd);}
  assert.equal(Status.preparation(f.entry, {...f.options, documentRevision: candidate}), null, "a stall is neither preparation nor failure");
  assert.equal(Status.accepted(f.entry, f.options).revision, f.revision, "a stall row does not vote on acceptance");
  assert.equal(Status.pendingReason(f.entry, f.options), reason, "the stall reason explains the unconfirmed change");
  assert.notEqual(Status.read(f.entry, f.options).state, "failed");
});
test("a hidden game window withholds acceptance and explains the change until the report clears", async t => {
  const f = fixture(t);Status.read(f.entry, f.options);
  const now = Date.now(), reason = "The game window is hidden, so the game is not drawing; changes apply when it is visible again";
  // A temporal context keeps encoding the accepted revision while nothing presents.
  const encoding = Buffer.alloc(32768);encoding.writeUInt32LE(process.pid, 0);encoding.writeBigUInt64LE(16n, 8);encoding.writeUInt32LE(2, 16);
  encoding.write(f.revision, 112);encoding.write(f.revision, 528);encoding.writeBigUInt64LE(BigInt(now - 1), 504);encoding.writeBigUInt64LE(1n, 512);encoding.writeBigUInt64LE(BigInt(now - 1), 664);encoding.writeBigUInt64LE(1500n, 32);
  // The window report shares the layer's stall context: Hidden, then Prepared without a reason once a frame presents.
  const window = Buffer.alloc(32768);window.writeUInt32LE(process.pid, 0);window.writeBigUInt64LE(17n, 8);window.writeUInt32LE(9, 16);
  window.write(f.revision, 112);window.write(reason, 242);window.writeBigUInt64LE(BigInt(now), 504);window.writeBigUInt64LE(1n, 512);
  const write = () => {const fd = fs.openSync(f.selected.binding.file, "r+");try {fs.writeSync(fd, encoding, 0, encoding.length, 4096);fs.writeSync(fd, window, 0, window.length, 4096 + 32768);} finally {fs.closeSync(fd);}};
  write();
  assert.equal(Status.read(f.entry, f.options).contexts.find(row => row.id === "11").phase, "hidden");
  assert.equal(Status.accepted(f.entry, f.options), null, "encoded frames that never present are not acceptance");
  assert.equal(Status.pendingReason(f.entry, f.options), reason);
  assert.equal(Status.preparation(f.entry, {...f.options, documentRevision: f.revision}), null, "a hidden window is neither preparation nor failure");
  window.writeBigUInt64LE(BigInt(now - 7000), 504);write();
  assert.equal(Status.accepted(f.entry, f.options).revision, f.revision, "a lapsed report no longer withholds acceptance");
  // A wait that outlasts the drawing grace still ignores the encoding context while the
  // once-a-second report is current, although that report predates the request.
  window.writeBigUInt64LE(BigInt(Date.now() - 300), 504);write();
  const waiting = Status.acquireAccepted(f.entry, {...f.options, revision: "e".repeat(64), timeoutMs: 900});
  const refresh = setInterval(() => {const at = BigInt(Date.now());encoding.writeBigUInt64LE(at, 504);encoding.writeBigUInt64LE(at, 664);
    encoding.fill(0, 528, 593);encoding.write("e".repeat(64), 528);write();}, 50);
  try {assert.equal(await waiting, null, "the hidden report withholds acceptance through the idle filter");} finally {clearInterval(refresh);}
  window.writeUInt32LE(1, 16);window.fill(0, 242, 498);window.writeBigUInt64LE(BigInt(Date.now()), 504);write();
  assert.equal(Status.accepted(f.entry, f.options).revision, "e".repeat(64), "the cleared report accepts at once");
  assert.equal(Status.pendingReason(f.entry, f.options), null);
});

test("a slow acceptance poll renews only the current launch's metadata lease", async t => {
  const f = fixture(t), Effects = require("../src/modules/shared/effects/runtime");Status.read(f.entry, f.options);
  const now = Date.now(), row = Buffer.alloc(32768);
  row.writeUInt32LE(process.pid, 0);row.writeBigUInt64LE(1n, 8);row.writeUInt32LE(3, 16);
  row.write(f.revision, 112);row.write(f.revision, 528);row.writeBigUInt64LE(BigInt(now), 504);
  row.writeBigUInt64LE(1n, 512);row.writeBigUInt64LE(BigInt(now), 664);
  const writeLease = value => {const fd = fs.openSync(f.selected.binding.file, "r+");try {
    const lease = Buffer.alloc(8);lease.writeBigUInt64LE(BigInt(value));fs.writeSync(fd, lease, 0, 8, 16);
    fs.writeSync(fd, row, 0, row.length, 4096);
  } finally {fs.closeSync(fd);}};
  writeLease(0);assert.equal(Status.accepted(f.entry, f.options), null);
  assert.equal((await Effects.acceptance(f.entry, {...f.options, timeoutMs: 0})).revision, f.revision);
  assert.ok(Number(fs.readFileSync(f.selected.binding.file).readBigUInt64LE(16)) >= now + 6000);
  // A held outcome read renews the same lease.
  writeLease(0);assert.deepEqual(Effects.outcomes(f.entry, {...f.options, revision: f.revision}).stages, {});
  assert.ok(Number(fs.readFileSync(f.selected.binding.file).readBigUInt64LE(16)) >= now + 6000);
  writeLease(0);
  fs.writeFileSync(path.join(f.directory, "launch.json"), JSON.stringify({...f.launch, launchId: "replacement"}));
  await assert.rejects(Effects.acceptance(f.entry, {...f.options, launchBinding: f.launch, timeoutMs: 0}), {code: "GRAPHICS_LIVE_STALE"});
  assert.throws(() => Effects.outcomes(f.entry, {...f.options, launchBinding: f.launch, revision: f.revision}), {code: "GRAPHICS_LIVE_STALE"});
  assert.equal(fs.readFileSync(f.selected.binding.file).readBigUInt64LE(16), 0n, "a stale observer cannot renew the old page");
});
test("a context that stopped drawing does not hold back the pass-through acceptance of an Off revision (D8)", async t => {
  const f = fixture(t);Status.read(f.entry, f.options);
  const old = "b".repeat(64), off = "d".repeat(64);
  const row = (slot, {phase, revision, at}) => {
    const bytes = Buffer.alloc(32768);bytes.writeUInt32LE(process.pid, 0);bytes.writeBigUInt64LE(BigInt(slot + 1), 8);bytes.writeUInt32LE(phase, 16);
    bytes.write(revision, 112);bytes.writeBigUInt64LE(BigInt(at), 504);bytes.writeBigUInt64LE(1n, 512);
    bytes.write(revision, 528);bytes.writeBigUInt64LE(BigInt(at), 664);
    const fd = fs.openSync(f.selected.binding.file, "r+");try {fs.writeSync(fd, bytes, 0, bytes.length, 4096 + slot * 32768);} finally {fs.closeSync(fd);}
  };
  // The processing context drew the previous revision just before the Off.
  row(0, {phase: 3, revision: old, at: Date.now() - 1000});
  assert.equal(Status.accepted(f.entry, f.options).revision, old);
  const started = Date.now(), waiting = Status.acquireAccepted(f.entry, {...f.options, revision: off, timeoutMs: 2000});
  await new Promise(resolve => setTimeout(resolve, 100));
  // Pass-through frames of the game's own context report the Off revision.
  row(1, {phase: 5, revision: off, at: Date.now()});
  const refresh = setInterval(() => row(1, {phase: 5, revision: off, at: Date.now()}), 50);t.after(() => clearInterval(refresh));
  const accepted = await waiting;clearInterval(refresh);
  assert.equal(accepted.revision, off, "an earlier acceptance of another revision does not end the wait");
  assert.ok(Date.now() - started < 1500, "the stopped context stops counting after the short drawing grace, not after six seconds");
  assert.deepEqual(accepted.contexts.map(context => context.acceptedRevision), [off]);

  // A context still drawing the previous revision keeps the vote split.
  row(0, {phase: 3, revision: old, at: Date.now()});
  const drawing = setInterval(() => {row(0, {phase: 3, revision: old, at: Date.now()});row(1, {phase: 5, revision: off, at: Date.now()});}, 50);
  t.after(() => clearInterval(drawing));
  assert.equal(await Status.acquireAccepted(f.entry, {...f.options, revision: off, timeoutMs: 800}), null);clearInterval(drawing);
});
test("a last pass-through acknowledgment after an On request and a never-accepted row do not hold back the drawing context (D6)", async t => {
  const f = fixture(t);Status.read(f.entry, f.options);
  const off = "d".repeat(64), on = "e".repeat(64);
  const row = (slot, {phase, revision, at}) => {
    const bytes = Buffer.alloc(32768);bytes.writeUInt32LE(process.pid, 0);bytes.writeBigUInt64LE(BigInt(slot + 1), 8);bytes.writeUInt32LE(phase, 16);
    if (revision) {bytes.write(revision, 112);bytes.write(revision, 528);bytes.writeBigUInt64LE(BigInt(at), 664);}
    bytes.writeBigUInt64LE(BigInt(at), 504);bytes.writeBigUInt64LE(1n, 512);
    const fd = fs.openSync(f.selected.binding.file, "r+");try {fs.writeSync(fd, bytes, 0, bytes.length, 4096 + slot * 32768);} finally {fs.closeSync(fd);}
  };
  row(0, {phase: 5, revision: off, at: Date.now()});
  const started = Date.now(), waiting = Status.acquireAccepted(f.entry, {...f.options, revision: on, timeoutMs: 2000});
  await new Promise(resolve => setTimeout(resolve, 50));
  // The game's context acknowledges the Off revision once more before it
  // reads the new plan, then the processing context draws the On revision.
  // A stage-only row without an acceptance is refreshed alongside.
  row(0, {phase: 5, revision: off, at: Date.now()});
  const drawing = setInterval(() => {row(1, {phase: 3, revision: on, at: Date.now()});row(2, {phase: 0, at: Date.now()});}, 50);
  t.after(() => clearInterval(drawing));
  const accepted = await waiting;clearInterval(drawing);
  assert.equal(accepted?.revision, on);
  assert.ok(Date.now() - started < 1500, "the silent context stops counting after the drawing grace, not after six seconds");
  assert.deepEqual(accepted.contexts.map(context => context.acceptedRevision), [on]);
});
test("acceptance reports each row's outcome from the contexts that accepted the revision (D10)", t => {
  const f = fixture(t);Status.read(f.entry, f.options);
  const revision = "e".repeat(64), missing = "Needs matching renderer depth, motion and jitter";
  const row = (slot, stages, {revision: accepted = revision, at = Date.now()} = {}) => {
    const bytes = Buffer.alloc(32768);bytes.writeUInt32LE(process.pid, 0);bytes.writeBigUInt64LE(BigInt(slot + 1), 8);bytes.writeUInt32LE(3, 16);
    bytes.writeUInt32LE(stages.length, 20);bytes.write(accepted, 112);bytes.writeBigUInt64LE(BigInt(at), 504);bytes.writeBigUInt64LE(1n, 512);
    bytes.write(accepted, 528);bytes.writeBigUInt64LE(BigInt(at), 664);
    stages.forEach(([id, phase, reason, completed], index) => {
      const start = 1024 + index * 768;bytes.write(id, start);bytes.write(reason, start + 385);bytes.writeUInt32LE(phase, start + 644);bytes.writeBigUInt64LE(BigInt(completed), start + 688);
    });
    const fd = fs.openSync(f.selected.binding.file, "r+");try {fs.writeSync(fd, bytes, 0, bytes.length, 4096 + slot * 32768);} finally {fs.closeSync(fd);}
  };
  // Metal FX is bypassed for missing renderer inputs while the shader runs.
  row(0, [["shader", 3, "", 40], ["temporal", 5, missing, 0]]);
  const accepted = Status.accepted(f.entry, {...f.options, revision});
  assert.deepEqual(accepted.stages, {shader: {running: true, reason: "", completed: 40}, temporal: {running: false, reason: missing, completed: 0}});
  // A row another accepting context runs is running; a bypass without a reason is not an outcome.
  row(1, [["temporal", 3, "", 12], ["shader", 5, "", 0]]);
  assert.deepEqual(Status.accepted(f.entry, {...f.options, revision}).stages,
    {shader: {running: true, reason: "", completed: 40}, temporal: {running: true, reason: "", completed: 12}});
  // A stopped context's rows and a wait for another revision report no outcome.
  row(1, [["temporal", 3, "", 12]], {at: Date.now() - 10000});
  assert.equal(Status.accepted(f.entry, {...f.options, revision}).stages.temporal.running, false);
  assert.equal(Status.accepted(f.entry, {...f.options, revision: "f".repeat(64)}).stages, undefined);
  assert.deepEqual(Status.rowOutcomes([{pid: 1, id: "1", phase: "completed", processStart: {seconds: 1}, observedAt: Date.now(), acceptedRevision: revision,
    stages: [{id: "temporal", phase: "failed", reason: "The GPU stopped responding.", completed: 9}]}], revision),
    {temporal: {running: false, reason: "The GPU stopped responding.", completed: 9}}, "a failed row is not running");
  // A provider still warming up is pending; a bypass elsewhere takes precedence, and a run anywhere runs.
  const context = (id, phase, reason) => ({pid: 1, id, phase: "completed", processStart: {seconds: 1}, observedAt: Date.now(), acceptedRevision: revision,
    stages: [{id: "nn", phase, reason, completed: 0}]});
  const warming = "Neural provider is warming up";
  assert.deepEqual(Status.rowOutcomes([context("1", "preparing", warming)], revision), {nn: {running: false, reason: warming, completed: 0, pending: true}});
  assert.deepEqual(Status.rowOutcomes([context("1", "preparing", warming), context("2", "bypassed", missing)], revision), {nn: {running: false, reason: missing, completed: 0}});
  assert.deepEqual(Status.rowOutcomes([context("1", "preparing", warming), context("2", "encoded", "")], revision), {nn: {running: true, reason: "", completed: 0}});
});
test("row outcomes of an accepted revision are read without another acceptance vote, wherever the bypassed row sits (D10)", t => {
  const f = fixture(t);Status.read(f.entry, f.options);
  const revision = "e".repeat(64), previous = "d".repeat(64), missing = "Needs matching renderer depth";
  const row = (slot, stages, accepted) => {
    const bytes = Buffer.alloc(32768), at = Date.now();bytes.writeUInt32LE(process.pid, 0);bytes.writeBigUInt64LE(BigInt(slot + 1), 8);bytes.writeUInt32LE(3, 16);
    bytes.writeUInt32LE(stages.length, 20);bytes.write(accepted, 112);bytes.writeBigUInt64LE(BigInt(at), 504);bytes.writeBigUInt64LE(1n, 512);
    bytes.write(accepted, 528);bytes.writeBigUInt64LE(BigInt(at), 664);
    stages.forEach(([id, phase, reason, completed], index) => {
      const start = 1024 + index * 768;bytes.write(id, start);bytes.write(reason, start + 385);bytes.writeUInt32LE(phase, start + 644);bytes.writeBigUInt64LE(BigInt(completed), start + 688);
    });
    const fd = fs.openSync(f.selected.binding.file, "r+");try {fs.writeSync(fd, bytes, 0, bytes.length, 4096 + slot * 32768);} finally {fs.closeSync(fd);}
  };
  // A context that acknowledged the previous revision is still current: a new vote is split.
  row(1, [], previous);
  for (const position of [0, 1, 3]) {
    const ids = ["ao", "gray", "down", "up"];
    row(0, ids.map((id, index) => index === position ? [id, 5, missing, 0] : [id, 3, "", 40]), revision);
    assert.equal(Status.accepted(f.entry, {...f.options, revision}), null, "the earlier context splits a strict vote");
    const read = Status.outcomes(f.entry, {...f.options, revision});
    assert.equal(read.revision, revision);assert.equal(read.launchId, "current");
    assert.deepEqual(read.stages, Object.fromEntries(ids.map((id, index) =>
      [id, index === position ? {running: false, reason: missing, completed: 0} : {running: true, reason: "", completed: 40}])), "position " + position);
  }
  assert.deepEqual(Status.outcomes(f.entry, {...f.options, revision: "f".repeat(64)}).stages, {}, "no context accepted another revision");
  assert.equal(Status.outcomes(f.entry, {...f.options, revision: "not-a-revision"}), null);
});
test("closed-panel transaction acquires actual CPU resource acceptance without inspector reads", {skip: process.platform !== "darwin"}, async t => {
  const f = fixture(t);
  const binary = path.join(f.root, "accepted-status-fixture"), native = path.resolve(__dirname, "../src/modules/shared/reshade/native");
  execFileSync("clang++", ["-std=c++17", "-UNDEBUG", "-I", native, path.join(native, "runtime-status.cpp"), path.join(native, "test/runtime-status.cpp"), "-o", binary], {stdio: "pipe"});
  assert.equal(fs.existsSync(f.selected.binding.file), false);
  const pending = Status.acquireAccepted(f.entry, {...f.options, launchBinding: f.launch});
  execFileSync(binary, [f.revision, f.digest, "--acceptance"], {env: {...process.env, ...f.selected.environment}, stdio: "pipe", timeout: 5000});
  assert.equal((await pending).revision, f.revision);
  const lease = fs.readFileSync(f.selected.binding.file).readBigUInt64LE(16);assert.equal(lease, 0n, "the control lease ends after the transaction");
  const actual = Status.read(f.entry, f.options), row = actual.contexts[0], accepted = Status.accepted(f.entry, f.options);
  assert.equal(row.phase, "failed");assert.equal(row.planRevision, "c".repeat(64));assert.equal(row.acceptedRevision, f.revision);
  assert.equal(accepted.revision, f.revision);assert.equal(row.completed, 0);assert.equal(row.presentedReal, 0);
});
test("transaction acceptance timeout, abort and session replacement preserve files and release only their own lease", async t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.directory, "effect-plan.json"));
  const lease = () => fs.readFileSync(f.selected.binding.file).readBigUInt64LE(16);
  assert.equal(await Status.acquireAccepted(f.entry, {...f.options, timeoutMs: 20}), null);assert.equal(lease(), 0n);
  const controller = new AbortController(), reason = Object.assign(new Error("Stop requested"), {code: "ABORT_ERR"});
  const aborting = Status.acquireAccepted(f.entry, {...f.options, signal: controller.signal, timeoutMs: 1000});
  controller.abort(reason);await assert.rejects(aborting, error => error === reason);assert.equal(lease(), 0n);
  let current = true;
  const stale = Status.acquireAccepted(f.entry, {...f.options, isCurrent: () => current, timeoutMs: 1000});current = false;
  await assert.rejects(stale, {code: "GRAPHICS_LIVE_STALE"});assert.equal(lease(), 0n);
  const replaced = Status.acquireAccepted(f.entry, {...f.options, timeoutMs: 1000});f.launch.launchId = "replacement";f.save();
  await assert.rejects(replaced, {code: "GRAPHICS_LIVE_STALE"});assert.equal(lease(), 0n);
  f.launch.launchId = "current";f.save();
  const timed = Status.acquireAccepted(f.entry, {...f.options, timeoutMs: 20});
  const fd = fs.openSync(f.selected.binding.file, "r+"), external = Buffer.alloc(8);external.writeBigUInt64LE(BigInt(Date.now() + 6000));
  try {fs.writeSync(fd, external, 0, 8, 16);} finally {fs.closeSync(fd);}
  assert.equal(await timed, null);assert.equal(lease(), external.readBigUInt64LE(0), "a concurrent inspector lease is not revoked");
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "effect-plan.json")), before);
});
test("actual CPU status-page producer preserves prepared, completed, fallback and presentation distinctions", {skip: process.platform !== "darwin"}, t => {
  const f = fixture(t), first = Status.read(f.entry, f.options);
  assert.equal(first.state, "prepared");assert.deepEqual(first.contexts, []);
  const groupNodes=[{id:"tone",kind:"shader",enabled:true,planeGroupMembers:["tone","refinement"]}];
  fs.writeFileSync(path.join(f.directory,"effect-plan.json"),JSON.stringify({schema:1,mode:"simple",revision:f.revision,nodes:groupNodes}));
  assert.equal(first.preparation.pending[0].method, "mlx-dlss");
  assert.equal(first.preparation.requested.some(row => row.id === "generation"), false, "an old prepared request is never labelled as the current selection");
  const binary = path.join(f.root, "status-fixture"), native = path.resolve(__dirname, "../src/modules/shared/reshade/native");
  execFileSync("clang++", ["-std=c++17", "-UNDEBUG", "-I", native, path.join(native, "runtime-status.cpp"), path.join(native, "test/runtime-status.cpp"), "-o", binary], {stdio: "pipe"});
  execFileSync(binary, [f.revision, f.digest], {env: {...process.env, ...f.selected.environment}, stdio: "pipe", timeout: 5000});
  execFileSync(binary, [], {stdio: "pipe", timeout: 5000});
  const actual = Status.read(f.entry, f.options), row = actual.contexts[0];
  assert.equal(actual.state, "observed");assert.equal(row.matchesPrepared, true);assert.notEqual(row.pid, process.pid);
  assert.deepEqual(row.input, {width: 8, height: 8});assert.deepEqual(row.output, {width: 16, height: 16});
  assert.equal(row.encoded, 1);assert.equal(row.completed, 1);assert.equal(row.presentedReal, 1);assert.equal(row.presentedGenerated, 2);
  assert.equal(row.admission.counts["frame-owner-accepted"], 1);assert.equal(row.admission.counts["frame-owner-missing"], 32);
  assert.equal(row.admission.queue, "100");assert.equal(row.admission.format, 80);assert.equal(row.admission.generation, 1);
  assert.equal(row.frameSource.source, "opengl-framebuffer");assert.deepEqual(row.frameSource.inputs, ["depth"]);
  assert.ok(row.frameSource.observedAt > 0);
  assert.equal(row.stages[2].id.length, 128);assert.notEqual(row.stages[2].id, row.stages[3].id);
  assert.equal(row.stages[1].phase, "bypassed");assert.equal(row.stages[1].requestedMethod, "lsfg");assert.equal(row.stages[1].activeMethod, "passthrough");
  assert.equal(row.stages[1].completed, 0);assert.match(row.stages[1].reason, /model unavailable/);
  assert.deepEqual(row.stages.find(stage=>stage.id==="tone").resolutionScope,{kind:"shader-group",members:["tone","refinement"]});
  assert.equal(row.stages[1].resolutionScope,undefined,"independent events retain their individual extent scope");
  assert.ok(row.observedAt > 0);assert.ok(row.presentedTime > 0);
  fs.writeFileSync(path.join(f.directory, "effect-plan.json"), JSON.stringify({schema: 1, revision: "b".repeat(64),nodes:groupNodes}));
  const pending = Status.read(f.entry, f.options);assert.equal(pending.state, "prepared");assert.equal(pending.contexts[0].matchesPrepared, false);
  assert.equal(pending.contexts[0].stages.find(stage=>stage.id==="tone").resolutionScope,undefined,"a different published group never relabels an old stage");
  const descriptor = fs.openSync(f.selected.binding.file, "r+"), odd = Buffer.alloc(4);odd.writeUInt32LE(1);fs.writeSync(descriptor, odd, 0, 4, 4096 + 4);fs.closeSync(descriptor);
  assert.deepEqual(Status.read(f.entry, f.options).contexts, [], "a concurrent incomplete slot never becomes an accepted observation");
});
test("status never follows an untrusted page link or accepts another launch's metadata", t => {
  const f = fixture(t), target = path.join(f.root, "keep");fs.writeFileSync(target, "preserve");fs.symlinkSync(target, f.selected.binding.file);
  assert.equal(Status.read(f.entry, f.options).state, "unavailable");assert.equal(fs.readFileSync(target, "utf8"), "preserve");
  fs.unlinkSync(f.selected.binding.file);f.launch.runtimeStatus.launchId = "previous";f.save();
  assert.equal(Status.read(f.entry, f.options).state, "unavailable");assert.equal(fs.existsSync(f.selected.binding.file), false);
});
test("Advanced revisions confirm ordered work without invented controls; missing Simple identity stays unverified", t => {
  const f = fixture(t);Status.read(f.entry, f.options);
  const bytes = Buffer.alloc(32768);bytes.writeUInt32LE(process.pid, 0);bytes.writeBigUInt64LE(1n, 8);
  bytes.writeUInt32LE(3, 16);bytes.writeBigUInt64LE(1n, 40);bytes.write(f.revision, 112);
  bytes.writeBigUInt64LE(BigInt(Date.now()), 504);bytes.writeBigUInt64LE(1n, 512);
  const write = () => {const fd = fs.openSync(f.selected.binding.file, "r+");try {fs.writeSync(fd, bytes, 0, bytes.length, 4096);} finally {fs.closeSync(fd);}};
  write();let current = Status.read(f.entry, f.options);
  assert.equal(current.state, "unverified");assert.equal(current.contexts[0].identityState, "unverified");
  fs.writeFileSync(path.join(f.directory, "effect-plan.json"), JSON.stringify({schema: 1, mode: "advanced", revision: f.revision}));
  current = Status.read(f.entry, f.options);
  assert.equal(current.state, "observed");assert.equal(current.contexts[0].identityState, "matching");
  assert.equal(current.contexts[0].controlsDigest, "", "the reader never supplies a requested digest as an actual observation");
  bytes.write("b".repeat(64), 177);write();current = Status.read(f.entry, f.options);
  assert.equal(current.contexts[0].identityState, "previous");assert.equal(current.contexts[0].matchesPrepared, false);
  bytes.fill(0, 112, 242);write();current = Status.read(f.entry, f.options);
  assert.equal(current.state, "unverified");assert.equal(current.contexts[0].identityState, "unverified");
});
test('owned fit status matches the applied method without rewriting the saved selection or accepting a stale revision', t => {
  const f=fixture(t), model={id:'model',kind:'upscale',method:'realcugan',enabled:true,settings:{modelPath:'/Models/Three.restorationmodel'}},
    fit={id:'auto-scale-fit-model',kind:'spatial',method:'metalfx',enabled:true,settings:{spatialMultiplier:null}};
  f.entry.effects={schema:2,mode:'advanced',enabled:true,video:[model,fit]};
  const original=structuredClone(f.entry.effects);
  f.launch.effectPlanNeuralLibrary='/provider.dylib';f.launch.effectPlanNeuralModels=[model.settings.modelPath];
  f.launch.graphicsLivePreparation={revision:f.revision,preparationStatus:{requested:[{id:fit.id,kind:fit.kind,method:fit.method}],applied:[{id:fit.id,kind:'spatial',method:'bilinear'}]}};f.save();
  fs.writeFileSync(path.join(f.directory,'effect-plan.json'),JSON.stringify({schema:1,mode:'advanced',revision:f.revision,nodes:[{...fit,method:'bilinear'}]}));
  Status.read(f.entry,f.options);
  const bytes=Buffer.alloc(32768),now=BigInt(Date.now()),start=1024;
  bytes.writeUInt32LE(process.pid,0);bytes.writeBigUInt64LE(1n,8);bytes.writeUInt32LE(3,16);bytes.writeUInt32LE(1,20);
  bytes.writeBigUInt64LE(1n,40);bytes.write(f.revision,112);bytes.write(f.digest,177);bytes.writeBigUInt64LE(now,504);bytes.writeBigUInt64LE(1n,512);
  bytes.write(fit.id,start);bytes.write('bilinear',start+129);bytes.write('bilinear',start+257);bytes.writeUInt32LE(3,start+644);
  bytes.writeBigUInt64LE(1n,start+688);bytes.writeBigUInt64LE(now,start+704);
  const write=()=>{const fd=fs.openSync(f.selected.binding.file,'r+');try{fs.writeSync(fd,bytes,0,bytes.length,4096);}finally{fs.closeSync(fd);}};
  write();let status=Status.read(f.entry,f.options);
  assert.equal(status.state,'observed');assert.equal(status.contexts[0].identityState,'matching');assert.deepEqual(status.preparation.pending,[]);
  assert.equal(status.preparation.requested.find(row=>row.id===fit.id).method,'metalfx');assert.equal(status.preparation.applied[0].method,'bilinear');
  assert.equal(status.contexts[0].stages[0].requestedMethod,'bilinear');assert.equal(status.contexts[0].stages[0].activeMethod,'bilinear');
  bytes.write('b'.repeat(64),112);write();status=Status.read(f.entry,f.options);
  assert.equal(status.state,'prepared');assert.equal(status.contexts[0].identityState,'previous');assert.equal(status.contexts[0].matchesPrepared,false);
  assert.deepEqual(f.entry.effects,original);
});
test('an actual current failure overrides earlier completion counts, remains visible while stale, and clears after newer completion',t=>{
 const f=fixture(t);Status.read(f.entry,f.options);const failed=Buffer.alloc(32768),now=Date.now();
 failed.writeUInt32LE(process.pid,0);failed.writeBigUInt64LE(1n,8);failed.writeUInt32LE(6,16);failed.writeBigUInt64LE(9n,40);
 failed.write(f.revision,112);failed.write(f.digest,177);failed.write('The GPU command timed out.',242);failed.writeBigUInt64LE(BigInt(now-60000),504);failed.writeBigUInt64LE(1n,512);
 const fd=fs.openSync(f.selected.binding.file,'r+');t.after(()=>fs.closeSync(fd));fs.writeSync(fd,failed,0,failed.length,4096);
 const status=Status.read(f.entry,f.options);assert.equal(status.state,'failed');assert.match(status.reason,/GPU command timed out/);assert.equal(status.contexts[0].historical,true);assert.equal(status.contexts[0].completed,9);
 failed.writeBigUInt64LE(BigInt(now+60000),504);fs.writeSync(fd,failed,0,failed.length,4096);assert.notEqual(Status.read(f.entry,f.options).state,'failed','a report with an untrusted timestamp cannot establish current failure');
 failed.writeBigUInt64LE(BigInt(now-60000),504);failed.writeBigUInt64LE(0n,512);fs.writeSync(fd,failed,0,failed.length,4096);assert.notEqual(Status.read(f.entry,f.options).state,'failed','missing process identity does not prove failure');
 failed.writeBigUInt64LE(1n,512);fs.writeSync(fd,failed,0,failed.length,4096);
 const completed=Buffer.from(failed);completed.writeBigUInt64LE(2n,8);completed.writeUInt32LE(3,16);completed.fill(0,242,498);completed.writeBigUInt64LE(BigInt(now),504);fs.writeSync(fd,completed,0,completed.length,4096+32768);
 const recovered=Status.read(f.entry,f.options);assert.equal(recovered.state,'observed');assert.equal(recovered.reason,undefined);
 failed.write('b'.repeat(64),112);fs.writeSync(fd,failed,0,failed.length,4096);assert.equal(Status.read(f.entry,f.options).state,'observed','a previous settings failure never replaces a current completion');
});
test("catalog pending reasons survive only for the exact current model and mode selection", t => {
  const f = fixture(t), {selectionKey} = require("../src/modules/shared/effects/live-plan");
  const row = {id: "generation", kind: "frame-generation", method: "lsfg", enabled: true, settings: {modelVersion: null}};
  f.entry.effects = {schema: 1, mode: "advanced", video: [row]};
  const store = path.join(f.root, "runtimes", "lossless-models");fs.mkdirSync(store, {recursive: true});
  f.launch.effectPlanLiveResources = {schema: 1, modelRoots: {lossless: store}};
  const reason = "Compatible installed models are required.";
  f.launch.graphicsLivePreparation = {preparationStatus: {pending: [{id: row.id, reason, retained: true, requestKey: selectionKey(row)}]}};f.save();
  assert.equal(Status.read(f.entry, f.options).preparation.pending[0].reason, reason);
  row.settings.lsfgMode = "performance";
  assert.deepEqual(Status.read(f.entry, f.options).preparation.pending, [], "a stale compatibility result does not follow a different quality mode");
  row.settings.modelVersion = "sha256-" + "f".repeat(64);
  const selected = path.join(store, row.settings.modelVersion);fs.mkdirSync(selected);fs.writeFileSync(path.join(selected, "Lossless.dll"), "owned model path");
  assert.deepEqual(Status.read(f.entry, f.options).preparation.pending, [], "a stale missing-model result does not follow a new managed selection");
});
test("prepared rows do not prove retention; only the exact acknowledged projection does", t => {
  const f = fixture(t), {selectionKey} = require("../src/modules/shared/effects/live-plan");
  const row = {id: "neural", kind: "neural", method: "mlx-dlss", enabled: true,
    settings: {modelPath: "/Models/Unavailable.dlssmodel", intensity: 1}};
  // A saved schema-2 row keeps a missing model path; only the one-time v0.4.0
  // upgrade turns such a row off.
  f.entry.effects = {schema: 2, mode: "advanced", video: [row]};
  const preparation = {applied: [{id: row.id, kind: row.kind, method: row.method}]};
  f.launch.graphicsLivePreparation = {preparationStatus: preparation};f.save();
  let result = Status.read(f.entry, f.options);
  assert.match(result.preparation.pending[0].reason, /unavailable to this running game/);
  assert.equal(result.contexts.length, 0, "no native resource acceptance has been reported");
  assert.equal(result.preparation.pending[0].retained, false, "a prepared or rejected row cannot establish retention");

  preparation.pending = [{id: row.id, reason: "The accepted model is retained.", retained: true, requestKey: selectionKey(row)}];f.save();
  assert.equal(Status.read(f.entry, f.options).preparation.pending[0].retained, true,
    "the matching projection already obtained native resource acceptance");
  row.settings.intensity = .5;
  assert.equal(Status.read(f.entry, f.options).preparation.pending[0].retained, false,
    "an earlier projection does not establish retention for a different request");
});
test("main status IPC uses current process identity without module, model or catalog discovery", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8"), handlers = new Map(), received = [];
  const entry = {gamePath: "/Game"}, session = {pid: 123}, stopped = {pid: 456, stopRequested: true}, settings = {runtimes:{"graphics-neural-models":{defaultVersions:{realesrgan:"general"}}}};
  const start = source.indexOf('ipcMain.handle("launcher:getGameGraphicsStatus"'), end = source.indexOf('ipcMain.handle(', start + 1);
  vm.runInNewContext(source.slice(start, end), {ipcMain: {handle: (id, callback) => handlers.set(id, callback)}, userDataDir: "/Profile",
    loadGamesHydrated: () => [entry], findGameByPath: () => entry, loadSettings: () => settings, runningGameSessions: new Map([[entry.gamePath, new Map([["current", session], ["stopped", stopped]])]]),
    graphicsStatus: {status: () => ({phase: "saved", running: false, rows: {}})}, graphicsReadOutcomes: new Map(),
    require: id => {assert.equal(id, "../modules/shared/reshade/runtime-status");return {read: (game, options) => {received.push([game, options]);return {state: "prepared"};}};}});
  assert.equal(handlers.get("launcher:getGameGraphicsStatus")(null, entry.gamePath).state, "prepared");
  assert.equal(received[0][0], entry);assert.deepEqual([...received[0][1].runningPids], [123]);
  assert.equal(received[0][1].settings,settings);
  let api;const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/modules/shared/web/preload/launcher.js"), "utf8"), {require: () => ({
    contextBridge: {exposeInMainWorld: (_, value) => {api = value.launcher;}}, ipcRenderer: {invoke: (...args) => {calls.push(args);}}, webUtils: {}})});
  assert.deepEqual(calls, []);await api.getGameGraphicsStatus("/Game");assert.deepEqual(calls, [["launcher:getGameGraphicsStatus", "/Game"]]);
});
