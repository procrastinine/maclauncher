const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const Audio = require("../src/modules/catsystem2/runtime/audio-decode"), { parseSoundConfig } = require("../src/modules/catsystem2/runtime/sound-config");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { createAudioCache, inspectWave } = require("../src/modules/catsystem2/runtime/audio-cache");
function response(channels = 1, frames = 2) {
  const bytes = Buffer.alloc(32 + channels * frames * 2); bytes.write("MLPC"); bytes.writeUInt32LE(1,4); bytes.writeUInt32LE(channels,8); bytes.writeUInt32LE(44100,12);
  bytes.writeBigUInt64LE(BigInt(frames),16); bytes.writeUInt32LE(bytes.length-32,24); return bytes;
}
test("CatSystem decoded audio validates exact dimensions before writing standard PCM WAVE", () => {
  const decoded = Audio.inspectPcm(response(2,3)), wav = Audio.wave(decoded);
  assert.equal(wav.toString("ascii",0,4), "RIFF"); assert.equal(wav.length, 56); assert.equal(wav.readUInt16LE(22),2); assert.equal(wav.readUInt32LE(24),44100);
  assert.throws(() => Audio.inspectPcm(response().subarray(0,33)), /disagree/);
  const invalid = response(); invalid.writeUInt32LE(3,8); assert.throws(() => Audio.inspectPcm(invalid), /disagree/);
  invalid.writeUInt32LE(1,8); invalid[28]=1; assert.throws(() => Audio.inspectPcm(invalid), /protocol/);
  assert.throws(() => Audio.wave({ ...decoded, sampleRate: -1 }), /Bounded/);
});
test("CatSystem audio decoding waits for child exit and rejects corrupt streams", async () => {
  const source = Buffer.concat([Buffer.from("OggS"),Buffer.alloc(64)]), helper = { version: Audio.VERSION, protocolVersion:1, executablePath:"/included/ogg-decode" };
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = { resume(){} }; child.stdin = new EventEmitter(); child.stdin.end=()=>{}; child.kill=()=>{};
  let settled = false; const decoded = Audio.decodeOgg(helper,source,{spawnChild:()=>child}).then(result=>{settled=true;return result;});
  child.stdout.emit("data",response()); await new Promise(resolve=>setImmediate(resolve)); assert.equal(settled,false);
  child.emit("close",0); assert.equal((await decoded).frames,2);
  const rejected = Audio.decodeOgg(helper,source,{spawnChild:()=>child}); child.emit("close",1); await assert.rejects(rejected,/corrupt or unsupported/);
});
test("CatSystem authored sound parts inherit preferences and select the longest matching archive prefix", () => {
  const config=Buffer.from(`<document><SOUNDGROUP><group00><id>2</id><label>voice</label><min>0</min><max>7</max></group00></SOUNDGROUP>
<MASTER><volume>80</volume><play>1</play></MASTER><PART><voice><id>2</id><group>2</group><volume>90</volume><mastervol>100</mastervol><play>1</play><head></head><int></int><type>voice</type>
<part><speaker><id>0</id><head>A_</head><int>voice_a</int><volume>70</volume></speaker></part></voice></PART></document>`);
  const settings=parseSoundConfig(config); assert.equal(settings.query("volume_id",[2,0]),70); assert.equal(settings.soundFor("A_line","voice").int,"voice_a"); assert.equal(settings.query("play","speaker".split()),1);
  assert.throws(()=>settings.soundFor("B_line","voice"),/selection is absent/); assert.throws(()=>settings.query("volume_id",[2,9]),/absent/);
  assert.throws(()=>parseSoundConfig(Buffer.from(config.toString().replace("<volume>70</volume>","<volume>700</volume>"))),/range/);
});
test("CatSystem sound volumes remain editable independently of identity metadata and inherited defaults", () => {
  const config = Buffer.from(`<document><SOUNDGROUP><group00><id>2</id><label>voice</label><min>0</min><max>7</max></group00></SOUNDGROUP>
<MASTER><volume>80</volume><play>1</play></MASTER><PART><voice><id>2</id><group>2</group><volume>90</volume><mastervol>100</mastervol><play>1</play><head></head><int></int><sameid>0</sameid>
<part><speaker><id>0</id><head>A_</head><int>voice_a</int></speaker></part></voice></PART></document>`);
  const preserved = Buffer.from(config), settings = parseSoundConfig(config);
  assert.equal(settings.query("volume", ["voice"]), 90); assert.equal(settings.query("volume_id", [2, 0]), 90);
  settings.set("volume", 80, ["voice"]); assert.equal(settings.query("volume", ["voice"]), 80);
  assert.equal(settings.query("volume_id", [2, 0]), 90);
  settings.set("volume_id", 70, [2, 0]); assert.equal(settings.query("volume_id", [2, 0]), 70);
  assert.equal(settings.query("volume", ["voice"]), 80); assert.deepEqual(config, preserved);
  assert.throws(() => settings.set("volume", 101, ["voice"]), /range/);
  assert.equal(settings.query("volume", ["voice"]), 80);
  assert.throws(() => settings.set("play", 1, ["voice"]), /identity mode/);
});
test("CatSystem 2.6 sound-part lookups keep native absent-volume defaults separate from filename resolution", () => {
  const config = Buffer.from(`<document><SOUNDGROUP><group00><id>1</id><label>se</label><min>0</min><max>7</max></group00></SOUNDGROUP>
<MASTER><volume>100</volume><play>1</play></MASTER><PART>
<SE><id>1</id><group>1</group><volume>90</volume><mastervol>100</mastervol><play>1</play><head>SE</head><int>effects</int><type>se</type>
<part><nested><id>0</id><head>SE_SYS_</head><int>nested-effects</int></nested></part></SE>
<voice><id>2</id><group>1</group><volume>70</volume><mastervol>100</mastervol><play>1</play><head></head><int></int><type>voice</type>
<part><speaker><id>0</id><head>A_</head><int>voice-a</int></speaker></part></voice>
</PART></document>`), preserved = Buffer.from(config);
  const settings = parseSoundConfig(config, { engineVersion: "2.6.1.76" });
  assert.equal(settings.profile, "CatSystem2-sound-parts-2.6.1.76");
  assert.equal(settings.query("volume", ["sys-effects"]), 100);
  assert.equal(settings.query("volume", ["se"]), 90); assert.equal(settings.query("volume", ["SE"]), 90);
  assert.equal(settings.tags.has("sys-effects"), false);
  assert.equal(settings.soundFor("se_sys_05", "sys-effects", 2).int, "effects");
  assert.equal(settings.soundFor("A_line", "SE", 0).int, "voice-a");
  settings.set("volume", 55, ["Se"]); assert.equal(settings.query("volume", ["SE"]), 55);
  assert.throws(() => settings.set("volume", 50, ["sys-effects"]), /absent/);
  assert.throws(() => settings.query("play", ["sys-effects"]), /absent/);
  assert.throws(() => settings.query("volume_id", [1, 99]), /absent/);
  assert.throws(() => settings.query("volume", []), /selector/);
  assert.throws(() => settings.query("volume_id", [-1]), /ID path/);
  assert.throws(() => settings.soundFor("unmatched", "SE", 1), /selection is absent/);
  assert.throws(() => parseSoundConfig(config).query("volume", ["sys-effects"]), /absent/);
  assert.throws(() => parseSoundConfig(config, { engineVersion: "2.6.1.75" }), /version/);
  assert.deepEqual(config, preserved);
});
test("CatSystem derived audio caches reuse one decode, isolate game/CPU identity and detect corruption", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catsystem-audio-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const helper = { version: Audio.VERSION, protocolVersion: 1, binarySha256: "a".repeat(64) }, source = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(64)]), preserved = Buffer.from(source);
  let count = 0; const decode = async () => { count++; await new Promise(resolve => setImmediate(resolve)); return Audio.inspectPcm(response(2, 3)); };
  const cache = await createAudioCache({ cacheRoot: path.join(root, "one"), helper, arch: "arm64", decode });
  const [first, second] = await Promise.all([cache.get(source), cache.get(source)]); assert.equal(count, 1); assert.equal(first.file, second.file);
  assert.equal((await cache.get(source)).reused, true); assert.equal(count, 1); assert.deepEqual(source, preserved);
  assert.deepEqual(inspectWave(fs.readFileSync(first.file)), { channels: 2, sampleRate: 44100, frames: 3, pcmBytes: 12 });
  const cpu = await createAudioCache({ cacheRoot: path.join(root, "one"), helper, arch: "x64", decode }); assert.notEqual((await cpu.get(source)).file, first.file);
  const game = await createAudioCache({ cacheRoot: path.join(root, "two"), helper, arch: "arm64", decode }); assert.notEqual((await game.get(source)).file, first.file);
  const bytes = fs.readFileSync(first.file); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(first.file, bytes); await assert.rejects(cache.get(source), /modified/);
  const controller = new AbortController(); controller.abort(); const stopped = await createAudioCache({ cacheRoot: path.join(root, "three"), helper, arch: "arm64", signal: controller.signal, decode });
  await assert.rejects(stopped.get(source), /abort/i); assert.equal(count, 3);
});
