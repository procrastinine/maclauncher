const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const Editor = require("../src/modules/shared/mvmz/save-editor");
const Codec = require("../src/modules/shared/mvmz/rpgmaker-save");

function save() {
  return {
    "@c": 1, system: { "@": "Game_System", "@c": 2, _pluginState: { "@r": 1 } },
    switches: { "@": "Game_Switches", "@c": 3, _data: { "@c": 4, "@a": [null, true, null] } },
    variables: { "@": "Game_Variables", "@c": 5, _data: { "@c": 6, "@a": [null, 3.5, "hello", { "@r": 2 }] } },
    party: { "@": "Game_Party", "@c": 7, _gold: 12, _items: { "@c": 8, 1: 2 }, _weapons: {}, _armors: {},
      _actors: { "@c": 9, "@a": [1] }, _custom: { opaque: [null, -0, { "@": "PluginThing", value: "keep" }] } },
    actors: { "@": "Game_Actors", "@c": 10, _data: { "@c": 11, "@a": [null, { "@r": 12 }] } },
    pluginActor: { "@": "Game_Actor", "@c": 12, _actorId: 1, _name: "Renamed", _hp: 50, _mp: 10, _tp: 0, _level: 2,
      _exp: { 1: 25 }, _equips: [{ "@": "Game_Item", _dataClass: "weapon", _itemId: 1 }], _states: [2], _self: { "@r": 12 } }
  };
}
const database = {
  switches: ["", "Door opened", "", "Later switch"], variables: ["", "Score", "Player name", "Object", "Later variable"],
  actors: [null, { id: 1, name: "Hero" }], items: [null, { id: 1, name: "Potion" }, { id: 2, name: "Ether" }],
  weapons: [null, { id: 1, name: "Sword" }], armors: [null, { id: 1, name: "Hat" }]
};
function modernSave() {
  const legacy = save();
  const actor = { ...legacy.pluginActor };
  delete actor["@c"];
  delete actor._self;
  const party = { ...legacy.party, _items: { 1: 2 }, _actors: [1] };
  delete party["@c"];
  return {
    system: { "@": "Game_System", _pluginState: { unknown: true } },
    switches: { "@": "Game_Switches", _data: [null, true, null] },
    variables: { "@": "Game_Variables", _data: [null, 3.5, "hello", { "@": "PluginValue", value: 9 }] },
    party, actors: { "@": "Game_Actors", _data: [null, actor] }
  };
}
function fixture(t, engineId = "mv") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-mvmz-editor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const indexDir = path.join(root, "www");
  const saveDir = path.join(root, "saves");
  fs.mkdirSync(path.join(indexDir, "data"), { recursive: true });
  fs.mkdirSync(saveDir);
  fs.writeFileSync(path.join(indexDir, "data", "System.json"), JSON.stringify({ switches: database.switches, variables: database.variables }));
  for (const category of ["actors", "items", "weapons", "armors"]) {
    fs.writeFileSync(path.join(indexDir, "data", `${category[0].toUpperCase()}${category.slice(1)}.json`), JSON.stringify(database[category]));
  }
  const fileName = `file1.${engineId === "mv" ? "rpgsave" : "rmmzsave"}`;
  const filePath = path.join(saveDir, fileName);
  fs.writeFileSync(filePath, Codec.encodeSave(engineId, JSON.stringify(engineId === "mz" ? modernSave() : save())
    .replace('"opaque":[null,0,', '"opaque":[null,-0,')));
  return { root, indexDir, filePath, fileName, entry: { indexDir, defaultSaveDir: saveDir } };
}

test("structured inspection reads database names, default slots, actor aliases and opaque variables", () => {
  const input = save();
  const result = Editor.inspectSaveData(input, database);
  assert.deepEqual(result.sections.switches.map(row => [row.id, row.name, row.value]),
    [[1, "Door opened", true], [2, "Switch 2", false], [3, "Later switch", false]]);
  assert.equal(result.sections.variables[0].value, 3.5);
  assert.equal(result.sections.variables[1].valueType, "string");
  assert.equal(result.sections.variables[2].editable, false);
  assert.equal(result.sections.variables[3].value, 0);
  assert.deepEqual(result.sections.gold, { value: 12, editable: true });
  assert.equal(result.sections.inventory.items[1].name, "Ether");
  assert.equal(result.sections.inventory.items[1].value, 0);
  assert.equal(result.sections.actors[0].name, "Renamed");
  assert.equal(result.sections.actors[0].fields[0].value, 50);
  assert.equal(input.switches._data["@a"].length, 3);
});

test("pure edits preserve JsonEx identities, null placeholders, plugin fields and referenced actors", () => {
  const input = save();
  const changed = Editor.applySaveChanges(input, [
    { kind: "switch", id: 3, value: true }, { kind: "variable", id: 4, value: "a value" },
    { kind: "gold", value: 100000000 }, { kind: "inventory", category: "items", id: 2, value: 1000 },
    { kind: "actor", id: 1, field: "hp", value: 99 }
  ], database);
  assert.deepEqual(changed.switches._data, { "@c": 4, "@a": [null, true, null, true] });
  assert.deepEqual(changed.variables._data["@a"], [null, 3.5, "hello", { "@r": 2 }, "a value"]);
  assert.equal(changed.party._gold, 100000000);
  assert.deepEqual(changed.party._items, { "@c": 8, 1: 2, 2: 1000 });
  assert.equal(changed.pluginActor._hp, 99);
  assert.equal(input.pluginActor._hp, 50);
  assert.deepEqual(changed.actors, input.actors);
  assert.deepEqual(changed.party._custom, input.party._custom);
  assert.deepEqual(changed.pluginActor._exp, input.pluginActor._exp);
  assert.deepEqual(changed.pluginActor._states, [2]);
});

test("JSON token edits preserve all unedited spelling, negative zero and large numeric literals", () => {
  const json = '{\n "party" : {"_gold":12,"_items":{},"_weapons":{},"_armors":{}}, "opaque": [-0,1e999,9007199254740993,1.00e+02,"\\u0061"], "unknown":null\n}';
  assert.equal(Editor.applyJsonSaveChanges(json, []).json, json);
  const result = Editor.applyJsonSaveChanges(json, [{ kind: "gold", value: 7 }]);
  assert.equal(result.json, json.replace('"_gold":12', '"_gold":7'));
  assert.equal(result.changed, 1);
  assert.ok(Object.is(Editor.parseSaveData(result.json).opaque[0], -0));
});

test("JSON additions retain existing tokens and wrapped array metadata", () => {
  const json = JSON.stringify(save());
  const result = Editor.applyJsonSaveChanges(json, [
    { kind: "switch", id: 3, value: false }, { kind: "variable", id: 4, value: -0 },
    { kind: "inventory", category: "weapons", id: 1, value: 1 }, { kind: "inventory", category: "items", id: 2, value: 3 }
  ], database);
  const data = Editor.parseSaveData(result.json);
  assert.equal(data.switches._data["@c"], 4);
  assert.deepEqual(data.switches._data["@a"], [null, true, null, false]);
  assert.ok(Object.is(data.variables._data["@a"][4], -0));
  assert.deepEqual(data.party._weapons, { 1: 1 });
  assert.deepEqual(data.party._items, { 1: 2, 2: 3, "@c": 8 });
  assert.ok(result.json.includes('"@r":12'));
});

test("schema checks reject arbitrary fields, opaque variables, invalid IDs, types and ranges", () => {
  const invalid = [
    { kind: "variable", id: 3, value: 0 }, { kind: "variable", id: 1, value: {} },
    { kind: "variable", id: 1, value: Infinity }, { kind: "variable", id: 999, value: 0 },
    { kind: "switch", id: 0, value: true }, { kind: "switch", id: 1, value: "true" },
    { kind: "gold", value: -1 }, { kind: "gold", value: 1.5 }, { kind: "gold", value: Number.MAX_SAFE_INTEGER + 1 },
    { kind: "inventory", category: "__proto__", id: 1, value: 1 }, { kind: "inventory", category: "items", id: 999, value: 1 },
    { kind: "actor", id: 1, field: "_exp", value: 20 }, { kind: "actor", id: 1, field: "level", value: 0 },
    { kind: "actor", id: 2, field: "hp", value: 20 }, { kind: "raw", path: "party._gold", value: 20 }
  ];
  for (const change of invalid) assert.throws(() => Editor.applySaveChanges(save(), [change], database), JSON.stringify(change));
  assert.throws(() => Editor.applySaveChanges(save(), [{ kind: "gold", value: 2 }, { kind: "gold", value: 3 }]), /Duplicate/);
  assert.throws(() => Editor.applySaveChanges(save(), new Array(Editor.LIMITS.changes + 1).fill({ kind: "gold", value: 1 })), /excessive/);
});

test("JsonEx reference containers can be edited without replacing reference markers", () => {
  const input = save();
  input.pluginSwitchData = input.switches._data;
  input.switches._data = { "@r": 4 };
  const edited = Editor.applySaveChanges(input, [{ kind: "switch", id: 1, value: false }], database);
  assert.deepEqual(edited.switches._data, { "@r": 4 });
  assert.deepEqual(edited.pluginSwitchData, { "@c": 4, "@a": [null, false, null] });
  const raw = JSON.stringify(input);
  assert.equal(Editor.parseSaveData(Editor.applyJsonSaveChanges(raw, [{ kind: "switch", id: 1, value: false }], database).json)
    .pluginSwitchData["@a"][1], false);
  input.variables._data = { "@r": 999 };
  assert.match(Editor.inspectSaveData(input, database).warnings.join(" "), /Unresolved/);
  assert.throws(() => Editor.applySaveChanges(input, [{ kind: "gold", value: 20 }]), /Unresolved/);
});

test("ambiguous identities, duplicate keys and excessive structure are rejected", () => {
  const input = save();
  input.party._items["@c"] = 7;
  assert.throws(() => Editor.inspectSaveData(input), /duplicate JsonEx/);
  assert.throws(() => Editor.parseSaveData('{"party":{"_gold":1,"_gold":2}}'), /Duplicate JSON/);
  const deep = '{"x":'.repeat(Editor.LIMITS.depth + 1) + "0" + "}".repeat(Editor.LIMITS.depth + 1);
  assert.throws(() => Editor.parseSaveData(deep), /structure exceeds/);
  assert.throws(() => Editor.applySaveChanges({ x: new Array(Editor.LIMITS.index + 1).fill(null) }, []), /index limit/);
  const accessor = {};
  Object.defineProperty(accessor, "x", { get() { throw new Error("must not run"); }, enumerable: true });
  assert.throws(() => Editor.inspectSaveData(accessor), /accessors/);
  const cyclic = {}; cyclic.x = cyclic;
  assert.throws(() => Editor.inspectSaveData(cyclic), /cycles/);
});

for (const engineId of ["mv", "mz"]) {
  test(`${engineId} bounded codec agrees with the existing codec and rejects oversized expansion`, () => {
    for (const value of ["", "a", "😀 café 日本語", "abc".repeat(50000), JSON.stringify(save())]) {
      const encoded = Codec.encodeSave(engineId, value);
      assert.equal(Codec.decodeSave(engineId, encoded, { maxOutputBytes: Math.max(1, Buffer.byteLength(value)) }), value);
    }
    assert.throws(() => Codec.decodeSave(engineId, Codec.encodeSave(engineId, "a".repeat(1000)), { maxOutputBytes: 32 }));
    assert.throws(() => Codec.decodeSave(engineId, "garbage", { maxOutputBytes: 32 }));
    assert.throws(() => Codec.decodeSave(engineId, Codec.encodeSave(engineId, "abcdef").slice(0, 2), { maxOutputBytes: 32 }));
  });

  test(`${engineId} file edit validates hash, snapshots and codec, retaining an original-byte backup`, async t => {
    const fx = fixture(t, engineId);
    const original = fs.readFileSync(fx.filePath);
    const seen = Editor.inspectStructuredSave(engineId, fx.entry, { fileName: fx.fileName });
    assert.equal(seen.sections.inventory.items[0].name, "Potion");
    let checks = 0;
    let snapshots = 0;
    const result = await Editor.editStructuredSave(engineId, fx.entry, {
      fileName: fx.fileName, expectedHash: seen.sourceHash, changes: [{ kind: "actor", id: 1, field: "hp", value: 80 }]
    }, {
      assertSaveWriteAllowed() { checks += 1; },
      snapshotSaves({ reason }) { assert.equal(reason, "structured-edit"); snapshots += 1; return { id: "snapshot-1" }; }
    });
    assert.equal(checks, 2);
    assert.equal(snapshots, 1);
    assert.equal(result.snapshotId, "snapshot-1");
    assert.equal(result.changed, 1);
    assert.notEqual(result.sourceHash, seen.sourceHash);
    assert.equal(result.sections.actors[0].fields[0].value, 80);
    assert.deepEqual(fs.readFileSync(result.backupPath), original);
    const loaded = Editor.parseSaveData(Codec.decodeSave(engineId, fs.readFileSync(fx.filePath, "utf8")));
    if (engineId === "mv") assert.deepEqual(loaded.actors._data["@a"][1], { "@r": 12 });
    else {
      assert.equal(loaded.actors._data[1]["@"], "Game_Actor");
      assert.equal(loaded.actors._data[1]._hp, 80);
      assert.deepEqual(loaded.actors._data[1]._exp, { 1: 25 });
    }
    assert.deepEqual(loaded.party._custom, save().party._custom);
    await assert.rejects(Editor.editStructuredSave(engineId, fx.entry, {
      fileName: fx.fileName, expectedHash: seen.sourceHash, changes: [{ kind: "gold", value: 99 }]
    }), /changed since inspection/);
  });
}

test("file edits stop on active games, invalid changes, snapshot races, or failed backup", async t => {
  const fx = fixture(t);
  const original = fs.readFileSync(fx.filePath);
  const seen = Editor.inspectStructuredSave("mv", fx.entry, { fileName: fx.fileName });
  const payload = { fileName: fx.fileName, expectedHash: seen.sourceHash, changes: [{ kind: "gold", value: 99 }] };
  await assert.rejects(Editor.editStructuredSave("mv", fx.entry, payload,
    { assertSaveWriteAllowed() { throw new Error("Game is running"); } }), /running/);
  await assert.rejects(Editor.editStructuredSave("mv", fx.entry, { ...payload, changes: [{ kind: "gold", value: -1 }] },
    { snapshotSaves() { throw new Error("must not run"); } }), /safe integer/);
  await assert.rejects(Editor.editStructuredSave("mv", fx.entry, payload,
    { snapshotSaves() { throw new Error("Snapshot failed"); } }), /Snapshot failed/);
  assert.deepEqual(fs.readFileSync(fx.filePath), original);
  await assert.rejects(Editor.editStructuredSave("mv", fx.entry, payload,
    { snapshotSaves() { fs.writeFileSync(fx.filePath, "concurrent save"); return { id: "snap" }; } }), /changed during backup/);
  assert.equal(fs.readFileSync(fx.filePath, "utf8"), "concurrent save");
  fs.writeFileSync(fx.filePath, original);
  fs.mkdirSync(`${fx.filePath}.maclauncher.bak`);
  await assert.rejects(Editor.editStructuredSave("mv", fx.entry, payload), /backup must be a regular file/);
  assert.deepEqual(fs.readFileSync(fx.filePath), original);
});

test("no-op edits do not rewrite, snapshot or create a backup", async t => {
  const fx = fixture(t);
  const seen = Editor.inspectStructuredSave("mv", fx.entry, { fileName: fx.fileName });
  const original = fs.readFileSync(fx.filePath);
  const result = await Editor.editStructuredSave("mv", fx.entry, { fileName: fx.fileName, expectedHash: seen.sourceHash,
    changes: [{ kind: "gold", value: 12 }] }, { snapshotSaves() { throw new Error("must not run"); } });
  assert.equal(result.changed, 0);
  assert.equal(result.backupPath, null);
  assert.deepEqual(fs.readFileSync(fx.filePath), original);
  assert.equal(fs.existsSync(`${fx.filePath}.maclauncher.bak`), false);
});

test("file names, symlinks, oversized files and missing hashes fail before replacement", async t => {
  const fx = fixture(t);
  for (const fileName of ["../file1.rpgsave", "/file1.rpgsave", "a\\b", "..", ""]) {
    assert.throws(() => Editor.inspectStructuredSave("mv", fx.entry, { fileName }), /Invalid save file name/);
  }
  fs.symlinkSync(fx.filePath, path.join(fx.entry.defaultSaveDir, "link.rpgsave"));
  assert.throws(() => Editor.inspectStructuredSave("mv", fx.entry, { fileName: "link.rpgsave" }), /regular file/);
  await assert.rejects(Editor.editStructuredSave("mv", fx.entry, { fileName: fx.fileName, changes: [] }), /source hash/);
  const fd = fs.openSync(fx.filePath, "w");
  fs.ftruncateSync(fd, Editor.LIMITS.encodedBytes + 1);
  fs.closeSync(fd);
  assert.throws(() => Editor.inspectStructuredSave("mv", fx.entry, { fileName: fx.fileName }), /size limits/);
});

test("database labels remain usable by ID when missing, corrupt or symlinked, without executing plugins", t => {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.indexDir, "js-plugin.js"), 'throw new Error("Never execute plugins")');
  fs.rmSync(path.join(fx.indexDir, "data", "Actors.json"));
  fs.writeFileSync(path.join(fx.indexDir, "data", "System.json"), "invalid json");
  const outside = path.join(fx.root, "outside.json");
  fs.writeFileSync(outside, '[null,{"name":"Forbidden"}]');
  fs.rmSync(path.join(fx.indexDir, "data", "Items.json"));
  fs.symlinkSync(outside, path.join(fx.indexDir, "data", "Items.json"));
  const result = Editor.inspectStructuredSave("mv", fx.entry, { fileName: fx.fileName });
  assert.equal(result.sections.switches[0].name, "Switch 1");
  assert.equal(result.sections.inventory.items[0].name, "item 1");
  assert.ok(result.warnings.length >= 3);
});

test("configuration saves remain inspectable with no structured edit targets", () => {
  const result = Editor.inspectSaveData({ alwaysDash: true, commandRemember: false });
  assert.equal(result.sections.gold, null);
  assert.match(result.warnings.join(" "), /configuration/);
  assert.throws(() => Editor.applySaveChanges({ alwaysDash: true }, [{ kind: "gold", value: 0 }]), /Missing/);
});

test("MV and MZ expose structured actions and pure module metadata without Electron", () => {
  for (const engineId of ["mv", "mz"]) {
    const mod = require(`../src/modules/${engineId}/main`);
    assert.equal(mod.manifest.supports.structuredSaveEditing, true);
    assert.equal(typeof mod.actions.inspectStructuredSave, "function");
    assert.equal(typeof mod.actions.editStructuredSave, "function");
    assert.deepEqual(mod.save.structured, { inspectAction: "inspectStructuredSave", editAction: "editStructuredSave" });
  }
});

test("MZ bounds compressed expansion before constructing JSON", () => {
  const zip = zlib.deflateSync(Buffer.from("a".repeat(100000))).toString("binary");
  assert.throws(() => Codec.decodeSave("mz", zip, { maxOutputBytes: 100 }), /larger than|size|length/i);
});

test("strict codec checks reject trailing MZ streams and invalid UTF-8 without rewriting", t => {
  const encoded = Codec.encodeSave("mz", '{"party":{"_gold":1}}');
  assert.throws(() => Codec.decodeSave("mz", `${encoded}trailer`, { maxOutputBytes: 1024 }), /trailing/);
  const corrupt = zlib.deflateSync(Buffer.from([123, 34, 120, 34, 58, 34, 0xff, 34, 125])).toString("binary");
  assert.throws(() => Codec.decodeSave("mz", corrupt, { maxOutputBytes: 1024 }), /encoded data/);
  const fx = fixture(t, "mz");
  fs.writeFileSync(fx.filePath, Buffer.from([0xff]));
  assert.throws(() => Editor.inspectStructuredSave("mz", fx.entry, { fileName: fx.fileName }), /encoded data/);
  assert.throws(() => Codec.decodeSave("mv", "not base64!", { maxOutputBytes: 1024 }), /base64/);
});
