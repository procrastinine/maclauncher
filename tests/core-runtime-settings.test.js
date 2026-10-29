const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  resolveRuntimeSettingsSchema,
  resolveRuntimeSettingFallback,
  normalizeListValue,
  normalizeRuntimeSettingValue,
  buildRuntimeSettingsDefaults,
  normalizeRuntimeSettings,
  mergeRuntimeSettingsMap,
  resolveModuleRuntimeSettings,
  resolveRuntimeSettingsForEntry,
  createRuntimeSettingsStore
} = require("../src/core/runtime-settings");

function moduleWithSchema(id, fields, defaults = {}) {
  return { id, runtime: { entries: { shared: { settings: { fields, defaults } } } } };
}

function makeStore(t, stored) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-core-settings-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const settingsPath = path.join(userDataDir, "runtimes", "shared", "settings.json");
  if (stored !== undefined) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, typeof stored === "string" ? stored : JSON.stringify(stored));
  }
  return { userDataDir, settingsPath, store: createRuntimeSettingsStore({ userDataDir }) };
}

test("a runtime defaults write never replaces an unreadable stored document with defaults", t => {
  const one = moduleWithSchema("one", [{ key: "value", type: "number", default: 1 }]);
  const damaged = '{"other": "kept", "value": 3, "broken": {';
  const { store, settingsPath } = makeStore(t, damaged);
  assert.deepEqual(store.writeDefaults("shared", one, { value: 9 }), { value: 9 });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), { other: "kept", value: 9 }, "readable keys of another schema survive");
  const copies = fs.readdirSync(path.dirname(settingsPath)).filter(name => name.startsWith("settings.unreadable-") && name.endsWith(".json"));
  assert.equal(copies.length, 1);assert.equal(fs.readFileSync(path.join(path.dirname(settingsPath), copies[0]), "utf8"), damaged);
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (target, ...args) => {
    if (target === settingsPath) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    return read(target, ...args);
  });
  assert.throws(() => store.writeDefaults("shared", one, { value: 4 }), { code: "SETTINGS_UNREADABLE" });
  t.mock.restoreAll();
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), { other: "kept", value: 9 }, "a failed read leaves the document");
});
test("schema resolution filters malformed fields and rejects arrays as schema objects", () => {
  const field = { key: "enabled", type: "boolean" };
  const moduleInfo = moduleWithSchema("one", [null, [], 7, field]);
  assert.deepEqual(resolveRuntimeSettingsSchema(moduleInfo, "shared").fields, [field]);
  assert.equal(resolveRuntimeSettingsSchema(moduleInfo, "missing"), null);
  assert.equal(resolveRuntimeSettingsSchema(moduleWithSchema("empty", []), "shared"), null);
  moduleInfo.runtime.entries.shared.settings = Object.assign([], { fields: [field] });
  assert.equal(resolveRuntimeSettingsSchema(moduleInfo, "shared"), null);
  moduleInfo.runtime.entries = Object.assign([], { shared: { settings: { fields: [field] } } });
  assert.equal(resolveRuntimeSettingsSchema(moduleInfo, "shared"), null);
});

test("field normalization preserves typed fallbacks, list parsing, and select validation", () => {
  assert.equal(resolveRuntimeSettingFallback({ type: "boolean" }), false);
  assert.equal(resolveRuntimeSettingFallback({ type: "number" }), 0);
  assert.deepEqual(resolveRuntimeSettingFallback({ type: "list" }), []);
  assert.equal(resolveRuntimeSettingFallback({}), "");
  assert.equal(resolveRuntimeSettingFallback({ default: null }), null);
  assert.equal(normalizeRuntimeSettingValue({ type: "boolean" }, "false", true), true);
  assert.equal(normalizeRuntimeSettingValue({ type: "boolean" }, false, true), false);
  assert.equal(normalizeRuntimeSettingValue({ type: "number" }, "12", 9), 12);
  assert.equal(normalizeRuntimeSettingValue({ type: "number" }, Infinity, "9"), 9);
  assert.equal(normalizeRuntimeSettingValue({ type: "number" }, null, 9), 0);
  assert.deepEqual(normalizeListValue(" a , b\r\nc\n ,"), ["a", "b", "c"]);
  assert.deepEqual(normalizeListValue([" a ", null, "", 3]), ["a", "3"]);
  assert.deepEqual(normalizeRuntimeSettingValue({ type: "list" }, undefined, [" x "]), ["x"]);
  const select = { type: "select", options: [{ value: "first" }, { id: "second" }] };
  assert.equal(normalizeRuntimeSettingValue(select, "second", "first"), "second");
  assert.equal(normalizeRuntimeSettingValue(select, "bad", "second"), "second");
  assert.equal(normalizeRuntimeSettingValue(select, "bad", "bad"), "first");
  assert.equal(normalizeRuntimeSettingValue({}, 5, "fallback"), "fallback");
});
test("newline list settings preserve commas in DLL overrides, environment values and arguments", () => {
  const field = { key: "values", type: "list", listSeparator: "newline" };
  const input = "winhttp=n,b\r\nDXMT_CONFIG=key=value,other=value\n--position=10,20\n";
  const expected = ["winhttp=n,b", "DXMT_CONFIG=key=value,other=value", "--position=10,20"];
  assert.deepEqual(normalizeRuntimeSettingValue(field, input, []), expected);
  assert.deepEqual(normalizeRuntimeSettingValue(field, null, input), expected);
  assert.deepEqual(normalizeRuntimeSettings({ fields: [field] }, { values: input }), { values: expected });
});

test("normalization applies schema defaults, ignores unknown keys, and rejects array maps", () => {
  const schema = {
    defaults: { enabled: true, amount: "4", args: "-a, -b", unknown: "drop" },
    fields: [
      { key: "enabled", type: "boolean", default: false },
      { key: "amount", type: "number", default: 2 },
      { key: "args", type: "list" },
      { key: "0", default: "field fallback" },
      null, [], { type: "string" }
    ]
  };
  const expected = { enabled: true, amount: 4, args: ["-a", "-b"], "0": "field fallback" };
  assert.deepEqual(buildRuntimeSettingsDefaults(schema), expected);
  assert.deepEqual(normalizeRuntimeSettings(schema, ["array entry"], ["array default"]), expected);
  assert.deepEqual(normalizeRuntimeSettings(schema, { amount: "invalid", unknown: true }), expected);
  assert.deepEqual(buildRuntimeSettingsDefaults({ fields: [{ key: "0", default: "field" }], defaults: ["bad"] }),
    { "0": "field" });
  assert.deepEqual(normalizeRuntimeSettings(null, { enabled: true }), {});
});

test("select-field migrations preserve explicit legacy preferences when automatic mode is added", () => {
  const field = { key: "fallback", type: "select", options: [
    { value: "auto" }, { value: "enabled" }, { value: "disabled" } ],
    legacyValues: [{ value: true, replacement: "enabled" }, { value: false, replacement: "disabled" },
      { value: "invalid", replacement: "not-an-option" }] };
  const schema = { defaults: { fallback: "auto" }, fields: [field] };
  assert.deepEqual(buildRuntimeSettingsDefaults(schema), { fallback: "auto" });
  assert.deepEqual(normalizeRuntimeSettings(schema, { fallback: false }), { fallback: "disabled" });
  assert.deepEqual(normalizeRuntimeSettings(schema, { fallback: true }), { fallback: "enabled" });
  assert.deepEqual(normalizeRuntimeSettings(schema, { fallback: "auto" }), { fallback: "auto" });
  assert.deepEqual(normalizeRuntimeSettings(schema, { fallback: "false" }), { fallback: "auto" });
  assert.deepEqual(normalizeRuntimeSettings(schema, { fallback: "invalid" }), { fallback: "auto" });
});

test("runtime settings maps merge per runtime without spreading array overrides", () => {
  const base = { shared: { enabled: true, args: ["-a"] }, invalid: ["bad"] };
  const incoming = { shared: { enabled: false }, other: { amount: 2 }, invalid: ["also bad"] };
  assert.deepEqual(mergeRuntimeSettingsMap(base, incoming), {
    shared: { enabled: false, args: ["-a"] }, other: { amount: 2 }
  });
  assert.deepEqual(mergeRuntimeSettingsMap([{ enabled: true }], [{ enabled: false }]), {});
  assert.deepEqual(base.shared, { enabled: true, args: ["-a"] });
});

test("store resolves schema, disk, module, and game precedence field by field", t => {
  const fields = [
    { key: "schemaOnly", default: "schema" },
    { key: "diskOnly", default: "schema" },
    { key: "moduleOnly", default: "schema" },
    { key: "gameWins", default: "schema" },
    { key: "amount", type: "number", default: 1 },
    { key: "enabled", type: "boolean", default: true },
    { key: "args", type: "list", default: ["schema"] }
  ];
  const moduleInfo = moduleWithSchema("one", fields);
  const stored = {
    diskOnly: "disk", moduleOnly: "disk", gameWins: "disk", amount: 2,
    enabled: true, args: ["disk"], unknown: "preserved on disk"
  };
  const { store, settingsPath } = makeStore(t, stored);
  const settings = {
    modules: { one: { runtimeSettings: { shared: {
      moduleOnly: "module", gameWins: "module", amount: 3, enabled: false, args: "module, arg"
    } } } },
    runtimes: { shared: { managerOption: "not a runtime setting" } }
  };
  const entry = { moduleId: "one", runtimeSettings: { shared: {
    gameWins: "game", amount: "invalid", enabled: "invalid", args: null, unknown: "drop"
  } } };
  assert.deepEqual(store.resolveForEntry(entry, settings, moduleInfo, "shared"), {
    schemaOnly: "schema", diskOnly: "disk", moduleOnly: "module", gameWins: "game",
    amount: 3, enabled: false, args: ["module", "arg"]
  });
  assert.equal(store.resolveForModule(settings, "one", moduleInfo, "shared").gameWins, "module");
  assert.equal(store.resolveForEntry({ moduleId: "one" }, settings, moduleInfo, "shared").gameWins, "module");
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), stored);
});

test("pure resolution uses supplied defaults and canonical module metadata for legacy entries", () => {
  const moduleInfo = moduleWithSchema("one", [{ key: "value", default: "schema" }]);
  const settings = { modules: { one: { runtimeSettings: { shared: { value: "module" } } } } };
  const entry = { moduleId: "web", engine: "one" };
  assert.deepEqual(resolveRuntimeSettingsForEntry(entry, settings, moduleInfo, "shared", { value: "disk" }),
    { value: "module" });
  assert.deepEqual(resolveModuleRuntimeSettings({}, "one", moduleInfo, "shared", { value: "disk" }),
    { value: "disk" });
  assert.equal(resolveRuntimeSettingsForEntry(entry, settings, moduleInfo, "missing"), null);
});

test("store ignores arrays at module and game override layers", t => {
  const moduleInfo = moduleWithSchema("0", [{ key: "0", default: "schema" }]);
  const { store } = makeStore(t, { "0": "disk" });
  const settings = { modules: [{ runtimeSettings: { shared: { "0": "bad module" } } }] };
  const entry = { moduleId: "0", runtimeSettings: { shared: ["bad game"] } };
  assert.deepEqual(store.resolveForEntry(entry, settings, moduleInfo, "shared"), { "0": "disk" });
  const badModuleSettings = { modules: { "0": Object.assign([], {
    runtimeSettings: { shared: { "0": "bad module" } }
  }) } };
  assert.deepEqual(store.resolveForEntry(entry, badModuleSettings, moduleInfo, "shared"), { "0": "disk" });
  const arrayMap = Object.assign([], { shared: { "0": "bad map" } });
  assert.deepEqual(store.resolveForEntry({ runtimeSettings: arrayMap }, {
    modules: { "0": { runtimeSettings: arrayMap } }
  }, moduleInfo, "shared"), { "0": "disk" });
});

test("cache separates module schemas sharing a runtime, including conflicting field types", t => {
  const one = moduleWithSchema("one", [
    { key: "value", type: "boolean", default: true }, { key: "oneOnly", default: "one" }
  ]);
  const two = moduleWithSchema("two", [
    { key: "value", type: "number", default: 8 }, { key: "twoOnly", default: "two" }
  ]);
  const { store } = makeStore(t, { value: "7" });
  assert.deepEqual(store.readDefaults("shared", one), { value: true, oneOnly: "one" });
  assert.deepEqual(store.readDefaults("shared", two), { value: 7, twoOnly: "two" });
  assert.deepEqual(store.readDefaults("shared", one), { value: true, oneOnly: "one" });
  one.runtime.entries.shared.settings = { fields: [{ key: "replacement", default: "new" }] };
  assert.deepEqual(store.readDefaults("shared", one), { replacement: "new" });
});

test("cache separates runtime IDs and stores and protects returned lists from mutation", t => {
  const moduleInfo = moduleWithSchema("one", [{ key: "args", type: "list", default: ["schema"] }]);
  moduleInfo.runtime.entries.other = { settings: moduleInfo.runtime.entries.shared.settings };
  const first = makeStore(t, { args: ["first"] });
  const second = makeStore(t, { args: ["second"] });
  const returned = first.store.readDefaults("shared", moduleInfo);
  returned.args.push("mutation");
  returned.extra = true;
  assert.deepEqual(first.store.readDefaults("shared", moduleInfo), { args: ["first"] });
  assert.deepEqual(second.store.readDefaults("shared", moduleInfo), { args: ["second"] });
  assert.deepEqual(first.store.readDefaults("other", moduleInfo), { args: ["schema"] });
});

test("transient default reads recover on the next request without poisoning the cache or rewriting settings", t => {
  const moduleInfo = moduleWithSchema("one", [{key: "value", default: "schema"}]);
  for (const failure of ["read", "parse", "shape"]) {
    const {store, settingsPath} = makeStore(t, failure === "parse" ? "{" : failure === "shape" ? "[]" : {value: "saved"});
    const originalRead = fs.readFileSync;let reads = 0;
    const mock = t.mock.method(fs, "readFileSync", function(file, ...args) {
      if (file === settingsPath) {
        reads++;
        if (failure === "read" && reads === 1) throw Object.assign(new Error("Temporary read failure"), {code: "EIO"});
      }
      return originalRead.call(this, file, ...args);
    });
    assert.deepEqual(store.readDefaults("shared", moduleInfo), {value: "schema"});
    fs.writeFileSync(settingsPath, JSON.stringify({value: "saved"}));
    assert.deepEqual(store.readDefaults("shared", moduleInfo), {value: "saved"}, failure);
    assert.deepEqual(store.readDefaults("shared", moduleInfo), {value: "saved"});
    assert.equal(reads, 2, "successful recovery restores ordinary cache reuse");
    assert.deepEqual(JSON.parse(originalRead(settingsPath, "utf8")), {value: "saved"});
    mock.mock.restore();
  }
});

test("missing, malformed, and array disk defaults fall back without writing during reads", t => {
  const moduleInfo = moduleWithSchema("one", [{ key: "0", default: "schema" }]);
  for (const stored of [undefined, "{broken", ["array value"], null, 7]) {
    const { store, settingsPath } = makeStore(t, stored);
    const before = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : null;
    assert.deepEqual(store.readDefaults("shared", moduleInfo), { "0": "schema" });
    assert.equal(fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : null, before);
    assert.equal(store.readDefaults("missing", moduleInfo), null);
  }
});

test("explicit writes persist normalized values, preserve other schema keys, and invalidate caches", t => {
  const one = moduleWithSchema("one", [{ key: "value", type: "number", default: 1 }]);
  const two = moduleWithSchema("two", [
    { key: "value", type: "number", default: 2 }, { key: "other", default: "two" }
  ]);
  const { store, settingsPath, userDataDir } = makeStore(t, { value: 3, other: "stored" });
  assert.deepEqual(store.readDefaults("shared", one), { value: 3 });
  assert.deepEqual(store.readDefaults("shared", two), { value: 3, other: "stored" });
  assert.deepEqual(store.writeDefaults("shared", one, { value: "9", unknown: "drop" }), { value: 9 });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), { value: 9, other: "stored" });
  assert.deepEqual(store.readDefaults("shared", two), { value: 9, other: "stored" });
  assert.deepEqual(createRuntimeSettingsStore({ userDataDir }).readDefaults("shared", one), { value: 9 });
  assert.equal(store.writeDefaults("missing", one, {}), null);
});

test("explicit writes create missing runtime settings directories", t => {
  const moduleInfo = moduleWithSchema("one", [{ key: "args", type: "list", default: ["schema"] }]);
  const { store, settingsPath } = makeStore(t);
  assert.deepEqual(store.writeDefaults("shared", moduleInfo, { args: " a , b " }), { args: ["a", "b"] });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), { args: ["a", "b"] });
  assert.throws(() => createRuntimeSettingsStore(), /Missing userDataDir/);
});
