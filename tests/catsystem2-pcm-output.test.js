const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), { EventEmitter } = require("node:events");
const { openPcmOutput, validateEvent } = require("../src/modules/catsystem2/runtime/pcm-output"), Audio = require("../src/modules/catsystem2/runtime/audio-decode"), { inspectWave } = require("../src/modules/catsystem2/runtime/audio-cache");
function child() {
  const c = new EventEmitter(), requests = []; c.pid = 50; c.stdout = new EventEmitter(); c.stderr = { resume() {} }; c.stdin = new EventEmitter();
  const emit = record => c.stdout.emit("data", Buffer.from(JSON.stringify(record) + "\n"));
  c.stdin.write = (data, callback) => { const r = JSON.parse(data); requests.push(r); setImmediate(() => emit({ type: r.type === "play" ? "playing" : r.type === "stop" ? "stopped" : "gain", id: r.id })); callback?.(); };
  c.stdin.end = () => setImmediate(() => c.emit("close", 0, null)); c.kill = signal => setImmediate(() => c.emit("close", null, signal));
  return { c, emit, requests, spawnChild: () => {
    setImmediate(() => emit({ type: "ready", protocolVersion: 1 })); return c;
  } };
}
async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "catsystem-pcm-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(path.join(root, "audio"));
  const bytes = Audio.wave({ channels: 1, sampleRate: 44100, frames: 2, pcm: Buffer.from([0, 0, 1, 0]) }), sha = crypto.createHash("sha256").update(bytes).digest("hex"), file = path.join(root, "audio", sha + ".wav"); fs.writeFileSync(file, bytes);
  return { root, bytes, decoded: { file, waveSha256: sha, ...inspectWave(bytes) } };
}
test("PCM output uses verified local cache data, real completion and isolated per-track gain controls", async t => {
  const { root, decoded, bytes } = await fixture(t), mock = child(); let completed = 0;
  const output = await openPcmOutput({ cacheRoot: root, helper: { version: "1.0.0-ml1", protocolVersion: 1, executablePath: "/included/cocoa-audio" }, spawnChild: mock.spawnChild });
  t.after(() => output.close()); const one = await output.start({ decoded, gain: 0.6, loops: 1, onFinished: () => completed++ }), two = await output.start({ decoded, gain: 0.2, loops: 0 });
  assert.notEqual(one.id, two.id); assert.equal(one.active, true); assert.equal(mock.requests[0].sha256, decoded.waveSha256); assert.equal(mock.requests[1].loops, 0);
  await one.setGain(0.4); assert.equal(mock.requests[2].gain, 0.4); mock.emit({ type: "finished", id: one.id }); assert.equal(completed, 1); assert.equal(one.active, false); assert.equal(two.active, true);
  await two.stop(); assert.equal(two.active, false); assert.deepEqual(fs.readFileSync(decoded.file), bytes);
  assert.throws(() => validateEvent({ type: "finished", id: -1 }), /protocol/); await assert.rejects(output.start({ decoded, gain: 1.1, loops: 1 }), /request/);
});
test("PCM output rejects altered audio metadata and files before invoking native playback", async t => {
  const { root, decoded } = await fixture(t), mock = child(), output = await openPcmOutput({ cacheRoot: root,
    helper: { version: "1.0.0-ml1", protocolVersion: 1, executablePath: "/included/cocoa-audio" }, spawnChild: mock.spawnChild }); t.after(() => output.close());
  await assert.rejects(output.start({ decoded: { ...decoded, frames: 3 }, gain: 1, loops: 1 }), /cache changed/);
  await assert.rejects(output.start({ decoded: { ...decoded, file: "/other/audio.wav" }, gain: 1, loops: 1 }), /request/);
  const bytes = fs.readFileSync(decoded.file); bytes[45] ^= 1; fs.writeFileSync(decoded.file, bytes);
  await assert.rejects(output.start({ decoded, gain: 1, loops: 1 }), /cache changed/); assert.equal(mock.requests.length, 0);
});
