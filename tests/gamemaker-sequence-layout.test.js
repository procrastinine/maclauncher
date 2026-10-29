const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Inspect = require("../src/modules/gamemaker/inspect");
const Detect = require("../src/modules/gamemaker/detect");
const Official = require("../src/modules/gamemaker/runtime/official");
const OfficialLaunch = require("../src/modules/gamemaker/runtime/official-launch");
const Module = require("../src/modules/gamemaker/main");
const { LIMITS } = require("../src/modules/gamemaker/sequence-layout");
const { writeRuntimeCatalog } = require("../src/modules/shared/runtime/runtime-catalog");
const Catalog = require("../src/modules/gamemaker/runtime/official-catalog");

// Serialized format fixtures, independent of the inspector: a normal GMS2
// sprite, its automatic frame track, and the documented 32/40-byte headers.
function archive(layouts, { noSequence = false, noTracks = false } = {}) {
  const texts = ["Format fixture", "gml_Script_start", "", "GMSpriteFramesTrack", "frames"];
  const strings = Buffer.alloc(4 + texts.length * 4 + texts.reduce((sum, s) => sum + 5 + Buffer.byteLength(s), 0));
  const sizes = layouts.map(n => 88 + (noSequence ? 0 : 4 + n + 8 + 32 + 12));
  const sprites = Buffer.alloc(4 + layouts.length * 4 + sizes.reduce((sum, n) => sum + n, 0));
  const gen = Buffer.alloc(128), code = Buffer.alloc(32), chunks = [
    { id: "GEN8", data: gen }, { id: "EXTN", data: Buffer.alloc(4) },
    { id: "SPRT", data: sprites }, { id: "SEQN", data: Buffer.alloc(4) },
    { id: "STRG", data: strings }, { id: "CODE", data: code }
  ];
  let cursor = 8;
  for (const chunk of chunks) { chunk.offset = cursor; chunk.dataOffset = cursor + 8; cursor += 8 + chunk.data.length; }
  const strg = chunks.find(c => c.id === "STRG"), sprt = chunks.find(c => c.id === "SPRT"), codeChunk = chunks.at(-1);
  strings.writeUInt32LE(texts.length);
  let at = 4 + texts.length * 4;
  const pointers = texts.map((text, index) => {
    const pointer = strg.dataOffset + at + 4, bytes = Buffer.from(text + "\0");
    strings.writeUInt32LE(strg.dataOffset + at, 4 + index * 4);
    strings.writeUInt32LE(bytes.length - 1, at); bytes.copy(strings, at + 4); at += 4 + bytes.length;
    return pointer;
  });
  gen[1] = 17; gen.writeUInt32LE(pointers[0], 40); gen.writeUInt32LE(2, 44); gen.writeUInt32LE(pointers[0], 100);
  code.writeUInt32LE(1); code.writeUInt32LE(codeChunk.dataOffset + 12, 4);
  code.writeUInt32LE(pointers[1], 12); code.writeUInt32LE(4, 16); code.writeInt32LE(-16, 24);
  sprites.writeUInt32LE(layouts.length);
  at = 4 + layouts.length * 4;
  for (let index = 0; index < layouts.length; index++) {
    const headerBytes = layouts[index], pointer = sprt.dataOffset + at;
    sprites.writeUInt32LE(pointer, 4 + index * 4);
    sprites.writeUInt32LE(pointers[0], at); sprites.writeUInt32LE(32, at + 4); sprites.writeUInt32LE(32, at + 8);
    sprites.writeInt32LE(-1, at + 56); sprites.writeUInt32LE(3, at + 60); sprites.writeFloatLE(30, at + 68);
    if (!noSequence) {
      const q = at + 88, sequence = q + 4;
      sprites.writeUInt32LE(sprt.dataOffset + q, at + 76); sprites.writeUInt32LE(1, q);
      sprites.writeUInt32LE(pointers[2], sequence); sprites.writeUInt32LE(1, sequence + 4);
      sprites.writeFloatLE(30, sequence + 8); sprites.writeFloatLE(1, sequence + 16); sprites.writeFloatLE(1, sequence + 28);
      if (headerBytes === 40) { sprites.writeFloatLE(32, sequence + 32); sprites.writeFloatLE(32, sequence + 36); }
      sprites.writeUInt32LE(noTracks ? 0 : 1, sequence + headerBytes + 4);
      sprites.writeUInt32LE(pointers[3], sequence + headerBytes + 8);
      sprites.writeUInt32LE(pointers[4], sequence + headerBytes + 12);
    }
    at += sizes[index];
  }
  const output = Buffer.alloc(cursor);
  output.write("FORM"); output.writeUInt32LE(cursor - 8, 4);
  for (const chunk of chunks) { output.write(chunk.id, chunk.offset); output.writeUInt32LE(chunk.data.length, chunk.offset + 4); chunk.data.copy(output, chunk.dataOffset); }
  return output;
}
function file(t, bytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-sequence-layout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "data.win"); fs.writeFileSync(target, bytes); return target;
}

test("legacy sprite sequence headers reject incompatible official runners before execution or installation", async t => {
  const bytes = archive([32]), target = file(t, bytes), inspection = Inspect.inspectStudio(target);
  assert.equal(inspection.spriteSequenceLayout, "legacy-32");
  assert.equal(inspection.detectedVersion, "2.3–<2024.13");
  assert.equal(inspection.exactEngineVersion, null);
  assert.throws(() => OfficialLaunch.preflight(target, "2024.13.1.242"), /sequence Width\/Height/);
  assert.doesNotThrow(() => OfficialLaunch.preflight(target, "2024.11.0.227"));
  const detected = Detect.detectGame({ inputPath: target, stat: fs.statSync(target) });
  assert.equal(detected.moduleData.spriteSequenceLayout, "legacy-32");
  const entry = { ...detected, runtimeData: { "official-studio": { version: "2024.13.1.242" } } };
  await assert.rejects(Module.ensureRuntime(entry, { runtimeId: "official-studio", settings: {}, userDataDir: path.dirname(target) }), /sequence Width\/Height/);
  assert.equal(fs.existsSync(path.join(path.dirname(target), "runtimes")), false);
  assert.deepEqual(fs.readFileSync(target), bytes);
});

test("positive 40-byte sequence evidence supplies a format floor even without a UILR chunk", t => {
  const inspection = Inspect.inspectStudio(file(t, archive([40])));
  assert.equal(inspection.spriteSequenceLayout, "dimensions-40");
  assert.equal(inspection.minimumEngineVersion, "2024.13");
  assert.equal(inspection.maximumOfficialRuntimeExclusive, null);
  assert.equal(inspection.exactEngineVersion, null);
  assert.ok(inspection.versionEvidence.some(item => item.headerBytes === 40 && item.value === "2024.13"));
});

test("absent or ambiguous sprite sequences do not invent an upper bound from missing modern chunks", t => {
  for (const options of [{ noSequence: true }, { noTracks: true }]) {
    const inspection = Inspect.inspectStudio(file(t, archive([32], options)));
    assert.equal(inspection.spriteSequenceLayout, "unresolved");
    assert.equal(inspection.maximumOfficialRuntimeExclusive, null);
    assert.equal(inspection.minimumEngineVersion, "2.3");
  }
});

test("mixed sequence layouts retain both constraints rather than claiming a compatible current runner", t => {
  const inspection = Inspect.inspectStudio(file(t, archive([32, 40])));
  assert.equal(inspection.spriteSequenceLayout, "mixed");
  assert.equal(inspection.minimumEngineVersion, "2024.13");
  assert.equal(inspection.maximumOfficialRuntimeExclusive, "2024.13");
  const selection = Official.manager.resolveSelection({ moduleData: inspection, runtimeData: {} }, {}, path.dirname(file(t, archive([32, 40]))));
  assert.equal(selection.version, null); assert.equal(selection.ready, false);
});

test("sprite sequence inspection stays within its read/sample budget on large resource tables", t => {
  const inspection = Inspect.inspectStudio(file(t, archive(Array(128).fill(32))));
  assert.equal(inspection.spriteSequenceLayout, "legacy-32");
  assert.equal(inspection.spriteSequenceInspection.scannedSprites, LIMITS.sprites);
  assert.equal(inspection.spriteSequenceInspection.truncated, true);
  assert.ok(inspection.spriteSequenceInspection.readBytes <= LIMITS.bytes);
});

test("an embedded sequence pointer cannot escape the SPRT resource", t => {
  const bytes = archive([32]);
  let spriteOffset;
  for (let at = 8; at < bytes.length; at += 8 + bytes.readUInt32LE(at + 4)) {
    if (bytes.toString("ascii", at, at + 4) === "SPRT") spriteOffset = bytes.readUInt32LE(at + 12);
  }
  bytes.writeUInt32LE(bytes.length - 4, spriteOffset + 76);
  assert.throws(() => Inspect.inspectStudio(file(t, bytes)), /embedded sprite sequence/);
});

test("fresh Play defers discovery until consent and cached selection retains the detected sequence recommendation", async t => {
  const target = file(t, archive([32])), userDataDir = path.join(path.dirname(target), "profile");
  const moduleData = Inspect.inspectStudio(target);
  const entry = { gamePath: target, moduleData: { ...moduleData, dataPath: target }, runtimeData: {} };
  const missing = Official.manager.resolveSelection(entry, {}, userDataDir);
  assert.equal(missing.version, null);
  assert.equal(missing.discoveryRequired, true);
  let refreshes = 0;
  const refresh = Official.manager.refreshCatalog;
  t.after(() => { Official.manager.refreshCatalog = refresh; });
  Official.manager.refreshCatalog = async () => {
    refreshes++;
    const entries = ["2024.11.0.227", "2.3.7.476"].map(version => ({ version, upstreamRevision: `vendor-runtime:${version}`,
      source: Catalog.FEEDS[0].url, channel: "Stable", feedSha256: "a".repeat(64),
      packages: ["core", "mac", "macYYC"].map(module => ({ module, url: `https://gms.yoyogames.com/${version}-${module}.zip`,
        filename: `${version}-${module}.zip`, bytes: 1, signature: "QUJDREVGR0hJSktMTU5PUA==" })) }));
    writeRuntimeCatalog({ userDataDir, managerId: "gamemaker-official", source: Catalog.FEEDS[0].url, entries });
  };
  const plan = await Module.ensureRuntime(entry, { runtimeId: "official-studio", settings: {}, userDataDir });
  assert.equal(plan.version, null); assert.equal(plan.discoveryRequired, true); assert.equal(refreshes, 0);
  await Official.manager.refreshCatalog({ userDataDir });
  assert.deepEqual(await Module.ensureRuntime(entry, { runtimeId: "official-studio", settings: {}, userDataDir }),
    { managerId: "gamemaker-official", version: "2.3.7.476", installOptions: {} });
  assert.equal(refreshes, 1);
  assert.equal(Official.manager.resolveSelection(entry, {}, userDataDir).version, "2.3.7.476");
  assert.equal(fs.existsSync(path.join(userDataDir, "runtimes/gamemaker-official/2.3.7.476")), false, "cached selection does not install by itself");
});
