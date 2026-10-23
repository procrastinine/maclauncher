const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const crypto = require("node:crypto");
const Hold = require("../src/modules/shared/reshade/presentation-hold"), Live = require("../src/modules/shared/reshade/live-controls");
const {createPublication} = require("../src/modules/shared/reshade/live-publication");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-hold-"))), entry = {gameId: "video"};
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const prepared = Hold.prepare(entry, {userDataDir: root, launchId: "launch-1"}), controls = Live.file(entry, root), plan = path.join(path.dirname(controls), "effect-plan.json");
  const packet = Buffer.alloc(19116);packet.write("MLFXCTL2");packet.writeUInt32LE(8, 16);
  const document = {schema: 1, mode: "advanced", revision: "a".repeat(64), nodes: [{id: "scale", enabled: true}]};
  fs.writeFileSync(controls, packet);fs.writeFileSync(plan, JSON.stringify(document));
  return {root, entry, ...prepared, controls, plan, packet, document};
}
function renderer(t, f, behavior) {
  const commands = [];let epoch = 0, time = 1, timer;
  const write = value => fs.writeFileSync(f.binding.statusFile, JSON.stringify(value));
  timer = setInterval(() => {
    if (!fs.existsSync(f.binding.file)) return;
    const command = JSON.parse(fs.readFileSync(f.binding.file));if (command.epoch === epoch) return;epoch = command.epoch;commands.push(command);
    const value = {schema: 1, launchId: f.binding.launchId, token: f.binding.token, epoch, transactionId: command.transactionId,
      state: command.action === "hold" ? "held" : command.action === "present" ? "presented" : command.action === "finish" ? "finished" : "cancelled", window: 91,
      width: 1920, height: 1080, frameId: epoch, presentedTime: ++time, ...command.expected};
    behavior ? behavior(command, value, write) : write(value);
  }, 2);
  t.after(() => clearInterval(timer));return commands;
}
function staged(f, mode = "advanced") {
  const publication = createPublication(), candidate = {...f.document, mode, revision: "b".repeat(64)};
  publication.write(f.plan, JSON.stringify(candidate), {root: f.root});
  return {publication, ...Hold.contracts(f.entry, {userDataDir: f.root, publication})};
}
test("hold binding is feature-gated, per-launch, and creates no command or idle timer", t => {
  const f = fixture(t);
  assert.equal(fs.existsSync(f.binding.file), false);assert.equal(fs.existsSync(f.binding.statusFile), false);
  assert.match(f.binding.token, /^[a-f0-9]{64}$/);assert.equal(Object.keys(f.environment).length, 4);
  assert.equal(Hold.supported(f.root), false);fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify({features: {graphics: {presentationHoldAPI: 1}}}));
  assert.equal(Hold.supported(f.root), true);
  assert.equal(Hold.prepare(f.entry, {userDataDir: f.root, launchId: "old-core", root: f.root}).binding.abandonAPI, undefined);
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify({features: {graphics: {presentationHoldAPI: 1, presentationHoldAbandonAPI: 1}}}));
  assert.equal(Hold.prepare(f.entry, {userDataDir: f.root, launchId: "new-core", root: f.root}).binding.abandonAPI, 1);
  assert.throws(() => Hold.prepare(f.entry, {userDataDir: f.root, launchId: "../other"}), /launch identity/);
});
test("mixed contract identity hashes the complete control packet and compares exact staged bytes", t => {
  const f = fixture(t), publication = createPublication();
  publication.write(f.plan, fs.readFileSync(f.plan), {root: f.root});publication.write(f.controls, f.packet, {root: f.root});
  let result = Hold.contracts(f.entry, {userDataDir: f.root, publication});assert.equal(result.changed, false);
  const changed = Buffer.from(f.packet);changed.writeFloatLE(0.25, 19000);publication.write(f.controls, changed, {root: f.root});
  result = Hold.contracts(f.entry, {userDataDir: f.root, publication});assert.equal(result.changed, true);
  assert.equal(result.before.planRevision, result.after.planRevision);assert.notEqual(result.before.controlsDigest, result.after.controlsDigest);
  assert.equal(result.after.controlsDigest, crypto.createHash("sha256").update(changed).digest("hex"));
  const empty = {...f.document, nodes: []};publication.write(f.plan, JSON.stringify(empty), {root: f.root});
  assert.equal(Hold.contracts(f.entry, {userDataDir: f.root, publication}).requiresPresentation, false, "empty Advanced suppresses legacy shader flags");
});
test("protocol requires positive matching display ACK and advances epochs for rollback", async t => {
  const f = fixture(t), contracts = staged(f), commands = renderer(t, f);
  const update = await Hold.begin(f.binding, {...contracts, userDataDir: f.root});
  assert.throws(() => update.finish(), /displayed frame/);await update.cancel();await update.cancel();update.finish();
  assert.deepEqual(commands.map(value => value.action), ["hold", "cancel"]);
  assert.ok(commands[1].epoch > commands[0].epoch);assert.deepEqual(commands[0].candidate, {...contracts.after, requiresPresentation: true});
  assert.deepEqual(commands[1].expected, {planRevision: contracts.before.planRevision, controlsDigest: contracts.before.controlsDigest});
  assert.equal(JSON.parse(fs.readFileSync(f.binding.file)).action, "finish");
});
test("paused renderer wakes only after matching resume arm and accepts a resized actual frame", async t => {
  const f = fixture(t), contracts = staged(f);let pending, woke = false;
  renderer(t, f, (command, value, write) => {
    if (command.action === "present") {pending = () => write({...value, width: 1200, height: 800});write({...value, state: "presenting", presentedTime: 0});}
    else write(value);
  });
  const update = await Hold.begin(f.binding, {...contracts, userDataDir: f.root});
  const ack = await update.present({onReady() {woke = true;pending();}});
  assert.equal(woke, true);assert.equal(ack.width, 1200);assert.equal(ack.state, "presented");update.finish();
});
test("wrong displayed identity or zero presentation timestamp is rejected, not accepted as completion", async t => {
  const f = fixture(t), contracts = staged(f);
  renderer(t, f, (command, value, write) => write(command.action === "hold" ? {...value, presentedTime: 0} : value));
  await assert.rejects(Hold.begin(f.binding, {...contracts, userDataDir: f.root, timeoutMs: 100}), /matching displayed video frame/);
});
test("stale launch and unsupported all-off destination issue no hold command", async t => {
  const f = fixture(t), contracts = staged(f);
  await assert.rejects(Hold.begin(f.binding, {...contracts, userDataDir: f.root, isCurrent: () => false}), {code: "GRAPHICS_LIVE_STALE"});
  await assert.rejects(Hold.begin(f.binding, {...contracts, after: {...contracts.after, requiresPresentation: false}, userDataDir: f.root}), /continuing graphics presentation/);
  assert.equal(fs.existsSync(f.binding.file), false);
  fs.rmSync(f.controls);fs.symlinkSync(f.plan, f.controls);
  assert.throws(() => Hold.contracts(f.entry, {userDataDir: f.root}), /ordinary files|ELOOP/);
});
test("abort after a possible hold compensates with a higher epoch despite the aborted signal", async t => {
  const f = fixture(t), contracts = staged(f), abort = new AbortController();
  const commands = renderer(t, f, (command, value, write) => {if (command.action === "hold") abort.abort();else write(value);});
  await assert.rejects(Hold.begin(f.binding, {...contracts, userDataDir: f.root, signal: abort.signal, timeoutMs: 100}), {name: "AbortError"});
  assert.deepEqual(commands.map(value => value.action), ["hold", "cancel"]);
  assert.equal(JSON.parse(fs.readFileSync(f.binding.file)).action, "finish");
});
test("a new transaction cannot overwrite the preceding finish before its native acknowledgment", async t => {
  const f = fixture(t), contracts = staged(f);let observedFinish = false, first = true;
  const commands = renderer(t, f, (command, value, write) => {
    if (command.action === "finish") setTimeout(() => {observedFinish = true;write(value);}, 30);
    else {if (command.action === "hold" && !first) assert.equal(observedFinish, true);first = false;write(value);}
  });
  const update = await Hold.begin(f.binding, {...contracts, userDataDir: f.root});await update.present();update.finish();
  const next = await Hold.begin(f.binding, {...contracts, userDataDir: f.root});await next.cancel();
  assert.deepEqual(commands.map(value => value.action), ["hold", "present", "finish", "hold", "cancel"]);next.finish();
});
test("failed hold status skips compensation only for an explicitly unheld preflight rejection", async t => {
  for (const holding of [true, undefined, false]) await t.test(holding === false ? "preflight confirms no lease" : holding === true ? "failure retains active lease" : "missing ownership remains conservative", async t => {
    const f = fixture(t), contracts = staged(f), commands = renderer(t, f, (command, value, write) => {
      write(command.action === "hold" ? {...value, state: "failed", holding, reason: "GPU retirement failed", presentedTime: 0, frameId: 0} : value);
    });
    await assert.rejects(Hold.begin(f.binding, {...contracts, userDataDir: f.root, timeoutMs: 150}), /GPU retirement failed/);
    if (holding === false) {
      assert.deepEqual(commands.map(value => value.action), ["hold"]);
      assert.equal(JSON.parse(fs.readFileSync(f.binding.file)).action, "hold");
    } else {
      assert.deepEqual(commands.map(value => value.action), ["hold", "cancel"]);
      assert.deepEqual(commands[1].expected, {planRevision: contracts.before.planRevision, controlsDigest: contracts.before.controlsDigest});
      assert.equal(JSON.parse(fs.readFileSync(f.binding.file)).action, "finish", "finish follows the positively displayed accepted frame");
    }
  });
});
test("terminal failure releases only through the gated matching abandoned acknowledgment, with no display or finish claim", async t => {
  const f = fixture(t), contracts = staged(f);f.binding.abandonAPI = 1;
  const commands = renderer(t, f, (command, value, write) => write(command.action === "abandon"
    ? {...value, state: "abandoned", holding: false, presentedTime: 0, frameId: 0}
    : command.action === "cancel" ? {...value, state: "failed", holding: true, presentedTime: 0, reason: "Terminal GPU failure"} : value));
  const update = await Hold.begin(f.binding, {...contracts, userDataDir: f.root, timeoutMs: 150});
  assert.equal(update.canAbandon, true);await assert.rejects(update.cancel(), /Terminal GPU failure/);
  const result = await update.abandon();assert.equal(result.presentedTime, 0);assert.equal(result.holding, false);
  assert.throws(() => update.finish(), /displayed frame/);
  const next = await Hold.begin(f.binding, {...contracts, userDataDir: f.root, timeoutMs: 150});
  assert.deepEqual(commands.map(row => row.action), ["hold", "cancel", "abandon", "hold"]);
  assert.equal(next.canAbandon, true);
});
test("abandon rejects stale identity, an unreleased lease or a fake positive presentation timestamp", async t => {
  for (const change of [{controlsDigest: "c".repeat(64)}, {holding: true}, {presentedTime: 1}]) await t.test(JSON.stringify(change), async t => {
    const f = fixture(t), contracts = staged(f);f.binding.abandonAPI = 1;
    renderer(t, f, (command, value, write) => write(command.action === "abandon" ? {...value, state: "abandoned", holding: false, presentedTime: 0, ...change} : value));
    const update = await Hold.begin(f.binding, {...contracts, userDataDir: f.root, timeoutMs: 100});
    await assert.rejects(update.abandon(), /release to the restored original/);
    assert.throws(() => update.finish(), /displayed frame/);
  });
});
test("failed begin retires its unchanged original lease after cancel failure only on a capable core", async t => {
  for (const capable of [false, true]) await t.test(String(capable), async t => {
    const f = fixture(t), contracts = staged(f);if (capable) f.binding.abandonAPI = 1;
    const commands = renderer(t, f, (command, value, write) => write(command.action === "abandon"
      ? {...value, state: "abandoned", holding: false, presentedTime: 0}
      : {...value, state: "failed", holding: true, presentedTime: 0, reason: "Terminal GPU failure"}));
    await assert.rejects(Hold.begin(f.binding, {...contracts, userDataDir: f.root, timeoutMs: 100}), /Terminal GPU failure/);
    assert.deepEqual(commands.map(row => row.action), capable ? ["hold", "cancel", "abandon"] : ["hold", "cancel"]);
  });
});
test("stale ownership or an unacknowledged abandoned mailbox cannot be replaced by a new hold", async t => {
  const f = fixture(t), contracts = staged(f);f.binding.abandonAPI = 1;let current = true;
  renderer(t, f, (command, value, write) => write(command.action === "abandon" ? {...value, state: "abandoned", holding: false, presentedTime: 0} : value));
  const update = await Hold.begin(f.binding, {...contracts, userDataDir: f.root, isCurrent: () => current});
  const accepted = fs.readFileSync(f.binding.file, "utf8");current = false;
  await assert.rejects(update.abandon(), {code: "GRAPHICS_LIVE_STALE"});assert.equal(fs.readFileSync(f.binding.file, "utf8"), accepted);
  current = true;await update.abandon();
  const command = JSON.parse(fs.readFileSync(f.binding.file)), status = JSON.parse(fs.readFileSync(f.binding.statusFile));
  status.transactionId = "different-transaction";fs.writeFileSync(f.binding.statusFile, JSON.stringify(status));
  await assert.rejects(Hold.begin(f.binding, {...contracts, userDataDir: f.root, timeoutMs: 50}), /previous video presentation update has not finished/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.binding.file)), command, "no hold overwrites the still-unaccepted abandonment");
});
