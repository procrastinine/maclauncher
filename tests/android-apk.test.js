const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), zlib = require("node:zlib");
const { parseBinaryManifest, INSPECTION_VERSION } = require("../src/modules/android/binary-manifest");
const { inspectApk, withApk } = require("../src/modules/android/apk");
const { prepareApk, describePayload, extractInputs, retainPrepared } = require("../src/modules/android/prepare");
const ANDROID = "http://schemas.android.com/apk/res/android", NONE = 0xffffffff;
const node = (name, attrs = {}, children = []) => ({ name, attrs, children });
const activity = (name = ".Main", extra = {}) => node("activity", { name, ...extra }, [node("intent-filter", {}, [
  node("action", { name: "android.intent.action.MAIN" }), node("category", { name: "android.intent.category.LAUNCHER" })])]);
function manifest(appChildren = [activity()], app = {}, root = {}) {
  return node("manifest", { ":package": "org.example.game", versionName: "1.2.3", versionCode: 7, ...root }, [
    node("uses-sdk", { minSdkVersion: 21, targetSdkVersion: 36 }), node("uses-permission", { name: "android.permission.INTERNET" }),
    node("application", { label: "Example ゲーム", ...app }, appChildren)]);
}
function binaryXml(tree, utf8 = true) {
  const strings = [], index = value => { if (!strings.includes(value)) strings.push(value); return strings.indexOf(value); };
  function visit(item) { index(item.name); if (item.namespace) index(item.namespace); if (item.endNamespace) index(item.endNamespace); for (const [key, value] of Object.entries(item.attrs)) {
    if (!key.startsWith(":")) index(ANDROID); index(key.replace(/^:/, "")); if (typeof value === "string") index(value);
  } item.children.forEach(visit); }
  visit(tree);
  function chunk(type, headerSize, body) { const head = Buffer.alloc(headerSize); head.writeUInt16LE(type); head.writeUInt16LE(headerSize, 2); head.writeUInt32LE(headerSize + body.length, 4); return Buffer.concat([head, body]); }
  function length8(size) { return size > 127 ? Buffer.from([0x80 | size >> 8, size & 255]) : Buffer.from([size]); }
  const pieces = strings.map(value => { const data = Buffer.from(value, utf8 ? "utf8" : "utf16le");
    if (utf8) return Buffer.concat([length8(value.length), length8(data.length), data, Buffer.alloc(1)]);
    const size = Buffer.alloc(2); size.writeUInt16LE(value.length); return Buffer.concat([size, data, Buffer.alloc(2)]);
  });
  const table = Buffer.alloc(strings.length * 4); let offset = 0;
  pieces.forEach((piece, i) => { table.writeUInt32LE(offset, i * 4); offset += piece.length; });
  const pool = chunk(1, 28, Buffer.concat([table, ...pieces])); pool.writeUInt32LE(strings.length, 8);
  pool.writeUInt32LE(utf8 ? 0x100 : 0, 16); pool.writeUInt32LE(28 + table.length, 20);
  const xml = [pool];
  function emit(item) {
    const ext = Buffer.alloc(20), attrs = Object.entries(item.attrs);
    ext.writeUInt32LE(item.namespace ? index(item.namespace) : NONE); ext.writeUInt32LE(index(item.name), 4); ext.writeUInt16LE(20, 8); ext.writeUInt16LE(20, 10); ext.writeUInt16LE(attrs.length, 12);
    const data = attrs.map(([key, value]) => { const a = Buffer.alloc(20); a.writeUInt32LE(key.startsWith(":") ? NONE : index(ANDROID));
      a.writeUInt32LE(index(key.replace(/^:/, "")), 4); a.writeUInt32LE(NONE, 8); a.writeUInt16LE(8, 12);
      a[15] = typeof value === "object" ? value.type : typeof value === "string" ? 3 : typeof value === "boolean" ? 0x12 : 0x10;
      a.writeUInt32LE(typeof value === "object" ? value.data : typeof value === "string" ? index(value) : typeof value === "boolean" ? Number(value) : value, 16); return a;
    });
    xml.push(chunk(0x102, 16, Buffer.concat([ext, ...data]))); item.children.forEach(emit);
    const end = Buffer.alloc(8), endNamespace = item.endNamespace ?? item.namespace;
    end.writeUInt32LE(endNamespace ? index(endNamespace) : NONE); end.writeUInt32LE(index(item.name), 4); xml.push(chunk(0x103, 16, end));
  }
  emit(tree); return chunk(3, 8, Buffer.concat(xml));
}
function zip(entries, { descriptor = false, method = 8 } = {}) {
  const locals = [], central = []; let offset = 0;
  for (const [name, data] of entries) {
    const filename = Buffer.from(name), compressed = method === 8 ? zlib.deflateRawSync(data) : data;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(descriptor ? 8 : 0, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(descriptor ? 0 : zlib.crc32(data), 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(descriptor ? 8 : 0, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(zlib.crc32(data), 16); cd.writeUInt32LE(compressed.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(filename.length, 28); cd.writeUInt32LE(offset, 42); central.push(cd, filename);
    locals.push(local, filename, compressed); offset += 30 + filename.length + compressed.length;
    if (descriptor) { const dd = Buffer.alloc(16); dd.writeUInt32LE(0x08074b50); dd.writeUInt32LE(zlib.crc32(data), 4); dd.writeUInt32LE(compressed.length, 8); dd.writeUInt32LE(data.length, 12); locals.push(dd); offset += dd.length; }
  }
  const cd = Buffer.concat(central), footer = Buffer.alloc(22); footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(entries.length, 8);
  footer.writeUInt16LE(entries.length, 10); footer.writeUInt32LE(cd.length, 12); footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, footer]);
}
function directory(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-apk-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test("Android activity inventory preserves declared aliases, disabled entries and typed metadata", () => {
  const declarations=[activity(".Main",{process:":ui",permission:"org.example.ACCESS",directBootAware:true}),
    node("activity",{name:"com.facebook.FacebookActivity",enabled:false},[node("meta-data",{name:"value",value:7})]),
    node("activity-alias",{name:".Alias",targetActivity:".Main",exported:true})];
  const inspected=parseBinaryManifest(binaryXml(manifest(declarations)));
  assert.equal(inspected.applicationActivitiesInspected,true);
  assert.equal(inspected.applicationActivities.length,3);
  const [main,facebook,alias]=inspected.applicationActivities;
  assert.equal(main.processName,"org.example.game:ui");
  assert.equal(facebook.enabled,false);assert.equal(facebook.metadata.value.value,7);
  assert.equal(alias.targetActivity,main.name);assert.equal(alias.permission,main.permission);
  assert.equal(alias.directBootAware,true);assert.equal(alias.processName,main.processName);
  const unknown=parseBinaryManifest(binaryXml(manifest([activity('.Main',{process:{type:1,data:0x7f010001}})])));
  assert.equal(unknown.applicationActivitiesInspected,false);
  const noActivities=parseBinaryManifest(binaryXml(manifest([])));
  assert.deepEqual(noActivities.applicationActivities,[]);
});

test("Android UTF8 and UTF16 binary manifests preserve launcher identity and package metadata", () => {
  for (const encoding of [true, false]) {
    const result = parseBinaryManifest(binaryXml(manifest(), encoding));
    assert.equal(result.packageName, "org.example.game"); assert.equal(result.label, "Example ゲーム");
    assert.equal(result.versionName, "1.2.3"); assert.equal(result.versionCode, 7); assert.equal(result.minSdk, 21);
    assert.deepEqual(result.launchers, [{ name: "org.example.game.Main", activity: "org.example.game.Main" }]);
    assert.deepEqual(result.permissions, ["android.permission.INTERNET"]);
  }
});
test("Android required GLES versions preserve minor versions and optional feature semantics", () => {
  for (const encoding of [true, false]) {
    const tree = manifest();
    assert.equal(parseBinaryManifest(binaryXml(tree, encoding)).requiredGlEsVersion, 0);
    tree.children.push(node("uses-feature", { glEsVersion: 0x30000 }),
      node("uses-feature", { glEsVersion: 0x30001, required: true }),
      node("uses-feature", { glEsVersion: 0x30002, required: false }),
      { ...node("uses-feature", { glEsVersion: 0x40000 }), namespace: "https://example.org/extension" });
    assert.equal(parseBinaryManifest(binaryXml(tree, encoding)).requiredGlEsVersion, 0x30001);
    const optional = manifest(); optional.children.push(node("uses-feature", { glEsVersion: 0x30002, required: false }));
    assert.equal(parseBinaryManifest(binaryXml(optional, encoding)).requiredGlEsVersion, 0);
  }
});
test("Android manifest character-data chunks preserve declarations in both string encodings", () => {
  for (const encoding of [true, false]) {
    const original=binaryXml(manifest(),encoding),text=Buffer.alloc(28);
    text.writeUInt16LE(0x104);text.writeUInt16LE(16,2);text.writeUInt32LE(28,4);
    text.writeUInt32LE(0,16);text.writeUInt16LE(8,20);text[23]=3;text.writeUInt32LE(0,24);
    const manifestEnd=original.length-24,withText=Buffer.concat([original.subarray(0,manifestEnd),text,original.subarray(manifestEnd)]);
    withText.writeUInt32LE(withText.length,4);
    assert.deepEqual(parseBinaryManifest(withText),parseBinaryManifest(original));
    const untyped=Buffer.from(withText);untyped.fill(0,manifestEnd+20,manifestEnd+28);
    assert.deepEqual(parseBinaryManifest(untyped),parseBinaryManifest(original),'Original Android permits absent typed character data');
    const extension=Buffer.from(withText);extension.writeUInt16LE(0x107,manifestEnd);
    assert.deepEqual(parseBinaryManifest(extension),parseBinaryManifest(original),'Original Android skips structurally valid extension events');
    const shortExtension=Buffer.from(extension);shortExtension.writeUInt16LE(8,manifestEnd+2);
    assert.throws(()=>parseBinaryManifest(shortExtension),/invalid Android manifest/);
    const truncated=Buffer.from(withText);truncated.writeUInt16LE(20,manifestEnd+2);
    assert.throws(()=>parseBinaryManifest(truncated),/invalid Android manifest/);
  }
});
test("Android manifests accept namespaced extensions without confusing their declaration identity", () => {
  const distribution = "http://schemas.android.com/apk/distribution", horizon = "http://schemas.horizonos/sdk";
  const extension = (name, namespace, attrs = {}, children = []) => ({ ...node(name, attrs, children), namespace });
  for (const utf8 of [true, false]) {
    const tree = manifest([activity(), node("meta-data", { name: "actual", value: "kept" }),
      extension("meta-data", distribution, { name: "actual", value: "foreign" }),
      extension("activity", horizon, { name: ".Other" }, activity().children)]);
    tree.children.push(extension("module", distribution, {}, [node("application")]));
    tree.children.push(extension("uses-horizonos-sdk", horizon, { minSdkVersion: 77 }));
    tree.children.push(extension("uses-sdk", horizon, { minSdkVersion: 999 }));
    tree.children.push(extension("application", distribution));
    const parsed = parseBinaryManifest(binaryXml(tree, utf8));
    assert.equal(parsed.packageName, "org.example.game"); assert.equal(parsed.minSdk, 21);
    assert.deepEqual(parsed.launchers, [{ name: "org.example.game.Main", activity: "org.example.game.Main" }]);
    assert.deepEqual({ ...parsed.applicationMetadata }, { actual: { type: "string", value: "kept" } });
    tree.children.at(-1).endNamespace = horizon;
    assert.throws(() => parseBinaryManifest(binaryXml(tree, utf8)), /invalid Android manifest/);
    assert.throws(() => parseBinaryManifest(binaryXml({ ...manifest(), namespace: distribution }, utf8)), /invalid Android manifest/);
  }
});
test("Android manifest icon identity preserves resource bits and inspected absence", () => {
  for (const encoding of [true, false]) {
    const absent = parseBinaryManifest(binaryXml(manifest(), encoding));
    assert.equal(absent.applicationIconInspected, true); assert.equal(absent.applicationIcon, 0);
    for (const value of [0, 0x7f080001, 0xff010001]) {
      const parsed = parseBinaryManifest(binaryXml(manifest([], { icon: { type: 1, data: value } }), encoding));
      assert.equal(parsed.applicationIconInspected, true); assert.equal(parsed.applicationIcon, value);
    }
    const unsupported = parseBinaryManifest(binaryXml(manifest([], { icon: "unresolved" }), encoding));
    assert.equal(unsupported.applicationIconInspected, false); assert.equal(Object.hasOwn(unsupported, "applicationIcon"), false);
  }
});
test("Android selected Activity metadata follows the actual alias target and retains typed references", () => {
  const meta = (name, value) => node("meta-data", { name, value });
  const target = node("activity", { name: ".Native" }, [meta("android.app.lib_name", { type: 1, data: 0x7f010001 }),
    meta("android.app.func_name", "OwnedActivity_onCreate")]);
  const alias = activity(".Alias", { targetActivity: ".Native" }); alias.name = "activity-alias";
  alias.children.push(meta("android.app.lib_name", "unrelatedAlias"));
  const parsed = parseBinaryManifest(binaryXml(manifest([target, alias])));
  assert.deepEqual(parsed.activityMetadata["org.example.game.Native"], { inspected: true, entries: Object.assign(Object.create(null), {
    "android.app.lib_name": { type: "reference", value: 0x7f010001 }, "android.app.func_name": { type: "string", value: "OwnedActivity_onCreate" }
  }) });
  assert.deepEqual(parseBinaryManifest(binaryXml(manifest())).activityMetadata["org.example.game.Main"], { inspected: true, entries: null });
  target.children.push(meta("unknown", { type: 5, data: 1 }));
  assert.deepEqual(parseBinaryManifest(binaryXml(manifest([target, alias]))).activityMetadata["org.example.game.Native"], { inspected: false });
});
test("Android launch filters, disabled components and aliases retain actual target semantics", () => {
  const splitFilters = node("activity", { name: ".Wrong" }, [node("intent-filter", {}, [node("action", { name: "android.intent.action.MAIN" })]),
    node("intent-filter", {}, [node("category", { name: "android.intent.category.LAUNCHER" })])]);
  const alias = activity(".Alias"); alias.name = "activity-alias"; alias.attrs.targetActivity = ".Target";
  const result = parseBinaryManifest(binaryXml(manifest([activity(".Disabled", { enabled: false }), splitFilters, node("activity", { name: ".Target" }), alias])));
  assert.deepEqual(result.launchers, [{ name: "org.example.game.Alias", activity: "org.example.game.Target" }]);
  assert.deepEqual(parseBinaryManifest(binaryXml(manifest([activity()], { enabled: false }))).launchers, []);
  assert.throws(() => parseBinaryManifest(binaryXml(manifest([alias]))), /invalid Android manifest/);
});
test("Android split identity preserves major versions and root split requirements", () => {
  for (const encoding of [true, false]) {
    const ordinary = parseBinaryManifest(binaryXml(manifest(), encoding));
    assert.equal(ordinary.versionCodeMajor, 0); assert.equal(ordinary.configForSplit, null);
    assert.equal(ordinary.requiresSplitInstallation, false);
    const result = parseBinaryManifest(binaryXml(manifest([], { hasCode: false }, {
      versionCodeMajor: 0xffffffff, isSplitRequired: true, ":split": "feature.en", ":configForSplit": "feature"
    }), encoding));
    assert.equal(result.versionCodeMajor, 0xffffffff); assert.equal(result.configForSplit, "feature");
    assert.equal(result.split, "feature.en"); assert.equal(result.requiresSplitInstallation, true);
    assert.equal(parseBinaryManifest(binaryXml(manifest([], {}, { ":isSplitRequired": true }))).requiresSplitInstallation, false);
    assert.equal(parseBinaryManifest(binaryXml(manifest([], {}, { configForSplit: "wrongNamespace" }))).configForSplit, null);
  }
});
test("Android application metadata preserves scalar types, resource meaning and inspected absence", () => {
  const meta = (name, value, extra = {}) => node("meta-data", { name, value, ...extra });
  for (const encoding of [true, false]) {
    const absent = parseBinaryManifest(binaryXml(manifest(), encoding));
    assert.equal(absent.applicationMetadataInspected, true); assert.equal(absent.applicationMetadata, null);
    const children = [activity(), meta("text", "Hello 🙂"), meta("enabled", true),
      meta("negative", { type: 0x10, data: 0xfffffff9 }), meta("color", { type: 0x1c, data: 0xff112233 }),
      meta("fraction", { type: 4, data: 0x3fa00000 }), meta("negativeZero", { type: 4, data: 0x80000000 }),
      meta("reference", { type: 1, data: 0x7f010001 }),
      meta("resource", "ignored", { resource: { type: 1, data: 0x7f020001 } }),
      meta("text", "last value"), meta("__proto__", "ordinary Bundle key")];
    const result = parseBinaryManifest(binaryXml(manifest(children), encoding));
    assert.equal(result.applicationMetadataInspected, true);
    assert.deepEqual(JSON.parse(JSON.stringify(result.applicationMetadata)), JSON.parse(JSON.stringify({
      text: { type: "string", value: "last value" }, enabled: { type: "boolean", value: true },
      negative: { type: "int", value: -7 }, color: { type: "int", value: 0xff112233 | 0 },
      fraction: { type: "float", value: 1.25 }, negativeZero: { type: "float", value: "-0" },
      reference: { type: "reference", value: 0x7f010001 }, resource: { type: "resource", value: 0x7f020001 },
      ["__proto__"]: { type: "string", value: "ordinary Bundle key" }
    })));
    for (const unsupported of [meta("dimension", { type: 5, data: 1 }), meta("nonfinite", { type: 4, data: 0x7fc00000 }),
      meta({ type: 1, data: 0x7f010001 }, "indirect name"), node("meta-data", { name: "missing" })]) {
      const unknown = parseBinaryManifest(binaryXml(manifest([meta("valid", true), unsupported]), encoding));
      assert.equal(unknown.applicationMetadataInspected, false);
      assert.equal(Object.hasOwn(unknown, "applicationMetadata"), false);
    }
  }
});
test("Android component inspection preserves provider order, processes, permissions and typed metadata", () => {
  const alias = activity(".Alias"); alias.name = "activity-alias"; alias.attrs.targetActivity = ".Target";
  const children = [node("activity", { name: ".Target", process: ":game" }), alias,
    node("provider", { name: ".First", authorities: "org.example.first;org.example.alias", initOrder: 0xfffffff9 }, [
      node("meta-data", { name: "paths", resource: { type: 1, data: 0x7f020001 } }),
      node("meta-data", { name: "label", value: { type: 1, data: 0x7f010001 } })]),
    node("provider", { name: "Second", authorities: "org.example.second", process: ":remote", exported: true,
      initOrder: 100, permission: "", readPermission: "org.example.READ", multiprocess: true }),
    node("service", { name: ".Local", directBootAware: true }, [node("intent-filter")]),
    node("service", { name: ".Disabled", enabled: false, exported: false, permission: "" })];
  for (const encoding of [true, false]) {
    const result = parseBinaryManifest(binaryXml(manifest(children, { process: ":app", permission: "org.example.ACCESS" }), encoding));
    assert.equal(result.applicationComponentsInspected, true);
    assert.equal(result.applicationProcessName, "org.example.game:app");
    assert.equal(result.applicationProcessesInspected, true);
    assert.deepEqual(result.applicationProcesses, ["org.example.game:app", "org.example.game:game", "org.example.game:remote"]);
    assert.equal(result.launcherProcesses["org.example.game.Alias"], "org.example.game:game");
    assert.deepEqual(result.applicationProviders.map(p => p.name), ["org.example.game.First", "org.example.game.Second"]);
    const [first, second] = result.applicationProviders;
    assert.equal(first.initOrder, -7); assert.equal(second.initOrder, 100, "Inspection retains declaration order");
    assert.equal(first.processName, "org.example.game:app"); assert.equal(second.processName, "org.example.game:remote");
    assert.equal(first.exported, false); assert.equal(second.exported, true);
    assert.equal(first.readPermission, "org.example.ACCESS"); assert.equal(first.writePermission, "org.example.ACCESS");
    assert.equal(second.readPermission, "org.example.READ"); assert.equal(second.writePermission, null);
    assert.equal(second.multiprocess, true);
    assert.deepEqual(first.metadata.paths, { type: "resource", value: 0x7f020001 });
    assert.deepEqual(first.metadata.label, { type: "reference", value: 0x7f010001 });
    assert.equal(result.applicationServices[0].exported, true);
    assert.equal(result.applicationServices[0].permission, "org.example.ACCESS");
    assert.equal(result.applicationServices[0].directBootAware, true);
    assert.equal(result.applicationServices[1].enabled, false); assert.equal(result.applicationServices[1].permission, null);
    const legacy = manifest([node("provider", { name: ".P", authorities: "p" })]);
    legacy.children[0].attrs = { minSdkVersion: 16 };
    assert.equal(parseBinaryManifest(binaryXml(legacy, encoding)).applicationProviders[0].exported, true);
    assert.equal(parseBinaryManifest(binaryXml(manifest(children, { enabled: false }), encoding)).applicationProviders[0].enabled, false);
  }
});
test("Android component inspection never turns unknown or malformed declarations into an empty list", () => {
  const empty = parseBinaryManifest(binaryXml(manifest()));
  assert.equal(empty.applicationComponentsInspected, true);
  assert.deepEqual(empty.applicationProviders, []); assert.deepEqual(empty.applicationServices, []);
  const provider = (attrs = {}, children = []) => node("provider", { name: ".P", authorities: "a", ...attrs }, children);
  const reference = { type: 1, data: 0x7f050001 };
  const indirect = parseBinaryManifest(binaryXml(manifest([provider({ enabled: reference, exported: reference })])));
  assert.equal(indirect.applicationComponentsInspected, true);
  assert.deepEqual(indirect.applicationProviders[0].enabled, { resource: 0x7f050001 });
  assert.deepEqual(indirect.applicationProviders[0].exported, { resource: 0x7f050001 });
  const authorities = parseBinaryManifest(binaryXml(manifest([provider({ authorities: reference }),provider({ name: ".Q", authorities: "a;a" }),provider({ name: ".R", authorities: "a" })])));
  assert.equal(authorities.applicationComponentsInspected, true);
  assert.deepEqual(authorities.applicationProviders[0].authority, { resource: 0x7f050001 });
  assert.equal(authorities.applicationProviders[1].authority, "a;a", "Authority claims resolve in manifest order in the host");
  assert.equal(parseBinaryManifest(binaryXml(manifest([provider()], { enabled: reference }))).applicationComponentsInspected, false);
  for (const children of [[provider({ enabled: { type: 1, data: 0 } })], [provider({ enabled: "true" })],
    [provider({ process: { type: 1, data: 0x7f010001 } })], [provider({ process: ":" })],
    [provider({ initOrder: "high" })], [provider({ initOrder: { type: 4, data: 0x3f800000 } })],
    [provider({ authorities: "a;;b" })], [provider({ authorities: { type: 1, data: 0 } })],
    [provider({ authorities: "x".repeat(1025) })], [provider({ authorities: Array.from({ length: 65 }, (_, i) => "a" + i).join(";") })],
    [provider(), provider({ authorities: "b" })],
    [provider({}, [node("meta-data", { name: "size", value: { type: 5, data: 1 } })])],
    [provider({}, [node("path-permission", { path: "/data", readPermission: "org.example.READ" })])],
    [provider({}, [node("grant-uri-permission", { path: "/data" })])],
    [node("service", { name: ".S", permission: { type: 1, data: 0x7f010001 } })],
    Array.from({ length: 129 }, (_, i) => node("service", { name: ".S" + i }))]) {
    const result = parseBinaryManifest(binaryXml(manifest(children)));
    assert.equal(result.applicationComponentsInspected, false, JSON.stringify(children).slice(0, 120));
    assert.equal(Object.hasOwn(result, "applicationProviders"), false);
    assert.equal(Object.hasOwn(result, "applicationServices"), false);
  }
  for (const flag of ["isolatedProcess", "stopWithTask", "externalService", "useAppZygote", "singleUser", "allowSharedIsolatedProcess"]) {
    for (const value of [true, { type: 1, data: 0x7f050001 }])
      assert.equal(parseBinaryManifest(binaryXml(manifest([node("service", { name: ".S", [flag]: value })]))).applicationComponentsInspected, false);
    assert.equal(parseBinaryManifest(binaryXml(manifest([node("service", { name: ".S", [flag]: false })]))).applicationComponentsInspected, true);
  }
});
test("Android manifest parser rejects malformed bounds and nesting without accepting partial metadata", () => {
  const original = binaryXml(manifest());
  for (const cut of [0, 4, 20, original.length - 1]) assert.throws(() => parseBinaryManifest(original.subarray(0, cut)));
  const strings = Buffer.from(original); strings.writeUInt32LE(0xffffffff, 16); assert.throws(() => parseBinaryManifest(strings));
  const offsets = Buffer.from(original); offsets.writeUInt32LE(0xffffffff, 28); assert.throws(() => parseBinaryManifest(offsets));
  const close = Buffer.from(original); close.writeUInt32LE(0xffffffff, close.length - 4); assert.throws(() => parseBinaryManifest(close));
  const long = "a".repeat(140) + "🙂"; assert.equal(parseBinaryManifest(binaryXml(manifest([], { label: long }))).label, long);
  assert.equal(parseBinaryManifest(binaryXml(manifest())).debuggable, false);
  assert.equal(parseBinaryManifest(binaryXml(manifest([], { debuggable: true }))).debuggable, true);
  assert.equal(parseBinaryManifest(binaryXml(manifest())).hasCode, true);
  assert.equal(parseBinaryManifest(binaryXml(manifest([], { hasCode: true }))).hasCode, true);
  assert.equal(parseBinaryManifest(binaryXml(manifest([], { hasCode: false }))).hasCode, false);
});
test("APK inspection reads metadata offline and reports ARM64, split and launcher limits", t => {
  const root = directory(t), file = path.join(root, "game.apk");
  const values = [["AndroidManifest.xml", binaryXml(manifest())], ["classes.dex", Buffer.from("dex\n039\0")], ["classes2.dex", Buffer.from("dex\n039\0")],
    ["lib/arm64-v8a/libgame.so", Buffer.from("original")], ["lib/x86/libgame.so", Buffer.from("original")]];
  fs.writeFileSync(file, zip(values, { descriptor: true })); const original = fs.readFileSync(file);
  const result = inspectApk(file); assert.deepEqual(result.architectures, ["arm64-v8a", "x86"]); assert.equal(result.dex.length, 2); assert.deepEqual(result.limitations, []);
  const { detectGame } = require("../src/modules/android/detect");
  const detected = detectGame({ inputPath: file, rootDir: root });
  assert.equal(detected.gamePath, file); assert.equal(detected.name, "Example ゲーム");
  assert.equal(detected.moduleData.launcherActivity, "org.example.game.Main");
  assert.equal(detectGame({ inputPath: root }).moduleData.packageSet, true);
  assert.deepEqual(fs.readFileSync(file), original);
  fs.writeFileSync(file, zip([["AndroidManifest.xml", binaryXml(manifest([], {}, { ":split": "config.en" }))], ["lib/armeabi-v7a/libgame.so", Buffer.from("old")]]));
  const unsupported = inspectApk(file); assert.equal(unsupported.limitations.length, 4);
});
test("APK reads refuse path ambiguity, invalid CRC, symlink input and expansion beyond the caller limit", t => {
  const root = directory(t), file = path.join(root, "game.apk"), bytes = binaryXml(manifest());
  for (const name of ["../escape", "/escape", "a\\b", "a//b", "a/./b", "C:/escape"]) {
    fs.writeFileSync(file, zip([["AndroidManifest.xml", bytes], [name, Buffer.from("x")]])); assert.throws(() => inspectApk(file), /file paths/);
  }
  fs.writeFileSync(file, zip([["AndroidManifest.xml", bytes], ["AndroidManifest.xml", bytes]])); assert.throws(() => inspectApk(file), /file paths/);
  const corrupt = zip([["AndroidManifest.xml", bytes]], { method: 0, descriptor: true }); corrupt[30 + "AndroidManifest.xml".length + 20] ^= 1;
  fs.writeFileSync(file, corrupt); assert.throws(() => inspectApk(file), /checksum/);
  fs.writeFileSync(file, zip([["AndroidManifest.xml", bytes], ["large", Buffer.alloc(4096)]]));
  assert.throws(() => withApk(file, apk => apk.read("large", 32)), /size limit/);
  const link = path.join(root, "link.apk"); fs.symlinkSync(file, link); assert.throws(() => inspectApk(link));
});

function preparationFixture(t) {
  const root = directory(t), runtime = path.join(root, "runtime"), gamePath = path.join(root, "game.apk");
  fs.mkdirSync(runtime);
  for (const file of ["converter.jar", "metadata.jar"]) fs.writeFileSync(path.join(runtime, file), file);
  fs.writeFileSync(gamePath, zip([["AndroidManifest.xml", binaryXml(manifest())], ["classes.dex", Buffer.from("dex\n039\0")],
    ["assets/text.txt", Buffer.from("original asset")], ["lib/arm64-v8a/libgame.so", Buffer.from("arm64")], ["lib/x86/libgame.so", Buffer.from("x86")]]));
  return { root, entry: { gameId: "game1", gamePath }, options: { userDataDir: path.join(root, "profile"),
    java: { javaPath: "/runtime/bin/java", variant: "arm64", line: 21 },
    payload: { root: runtime, profile: { id: "libgdx-jvm-v1", javaMajor: 21, nativeLoadTarget: "maclauncher.android.GuestNativeLoader" },
      converterClasspath: [path.join(runtime, "converter.jar")], metadataClasspath: [path.join(runtime, "metadata.jar")] } } };
}
test("Android conversion cache depends on converter inputs rather than unrelated service capabilities", async t => {
  const { entry, options } = preparationFixture(t);let calls=0;
  const execute=async(_command,args)=>{calls++;fs.writeFileSync(args[args.indexOf("io.github.kksimp.dex2jvm.ConvertApkSet")+2],zip([["Game.class",Buffer.from("class")]]));};
  const first=await prepareApk(entry,{...options,execute});
  const changed={...options.payload,profile:{...options.payload.profile,id:"new-service-profile",platformServicesVersion:1}};
  const same=await prepareApk(entry,{...options,payload:changed,execute});
  assert.equal(same.root,first.root);assert.equal(calls,1,"Native service changes reuse converted classes");
  const target={...changed,profile:{...changed.profile,nativeLoadTarget:"maclauncher.android.OtherLoader"}};
  const different=await prepareApk(entry,{...options,payload:target,execute});
  assert.notEqual(different.root,first.root);assert.equal(calls,2,"Changed converter arguments invalidate generated classes");
  fs.writeFileSync(options.payload.metadataClasspath[0],"new hierarchy declarations");
  await prepareApk(entry,{...options,payload:target,execute});assert.equal(calls,3,"Changed hierarchy bytes invalidate generated classes");
});
test("Android installs retain canonical base paths without repeating conversion", async t => {
  const { entry, options } = preparationFixture(t); let calls = 0;
  const execute = async (_command, args) => { calls++; fs.writeFileSync(args[args.indexOf("io.github.kksimp.dex2jvm.ConvertApkSet") + 2], zip([["Game.class", Buffer.from("class")]])); };
  const first = await prepareApk(entry, { ...options, execute });
  assert.equal(path.basename(first.sourceApk), "base.apk");
  const converted = fs.readFileSync(first.convertedJar);
  const receiptPath = path.join(first.root, "prepared.json"), old = JSON.parse(fs.readFileSync(receiptPath));
  fs.renameSync(first.sourceApk, path.join(first.root, "source.apk")); delete old.sourceName;
  fs.writeFileSync(receiptPath, JSON.stringify(old));
  const release = await retainPrepared(first); t.after(release);
  const [migrated, concurrent] = await Promise.all([prepareApk(entry, { ...options, execute }), prepareApk(entry, { ...options, execute })]);
  assert.equal(concurrent.root, migrated.root, "concurrent consumers share the newly published generation");
  assert.equal(calls, 1); assert.notEqual(migrated.root, first.root);
  assert.deepEqual(fs.readFileSync(migrated.convertedJar), converted);
  assert.deepEqual(fs.readFileSync(migrated.sourceApk), fs.readFileSync(entry.gamePath));
  assert.equal(fs.existsSync(path.join(first.root, "source.apk")), true, "live readers retain their original pathname");
  assert.equal(fs.existsSync(path.join(migrated.root, "source.apk")), false, "new generation contains only canonical names");
  assert.deepEqual(JSON.parse(fs.readFileSync(receiptPath)), old);
  fs.writeFileSync(path.join(first.assetsRoot, "text.txt"), "old generation changed");
  assert.equal(fs.readFileSync(path.join(migrated.assetsRoot, "text.txt"), "utf8"), "original asset", "COW generations do not share writable inodes");
  await prepareApk(entry, { ...options, execute }); assert.equal(calls, 1);
  assert.equal(fs.readdirSync(path.dirname(first.root)).filter(name => fs.existsSync(path.join(path.dirname(first.root), name, "prepared.json"))).length, 2);
});

test("Android installs native helpers as executable while retaining private asset modes and cached code", async t => {
  const { entry, options } = preparationFixture(t); let calls = 0;
  const execute = async (_command, args) => { calls++; fs.writeFileSync(args[args.indexOf("io.github.kksimp.dex2jvm.ConvertApkSet") + 2], zip([["Game.class", Buffer.from("class")]])); };
  const first = await prepareApk(entry, { ...options, execute });
  const library = path.join(first.nativeRoot, "libgame.so"), asset = path.join(first.assetsRoot, "text.txt");
  assert.equal(fs.statSync(library).mode & 0o777, 0o700);
  assert.equal(fs.statSync(asset).mode & 0o777, 0o600);
  const converted = fs.statSync(first.convertedJar).mtimeMs;
  const receiptPath = path.join(first.root, "prepared.json"), receipt = JSON.parse(fs.readFileSync(receiptPath));
  delete receipt.nativeInstallVersion; fs.chmodSync(library, 0o600); fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  const [a, b] = await Promise.all([prepareApk(entry, { ...options, execute }), prepareApk(entry, { ...options, execute })]);
  assert.equal(a.root, first.root); assert.equal(b.root, first.root); assert.equal(calls, 1);
  assert.equal(fs.statSync(library).mode & 0o777, 0o700);
  assert.equal(fs.statSync(asset).mode & 0o777, 0o600);
  assert.equal(fs.statSync(first.convertedJar).mtimeMs, converted);
});
test("Android package verification checks real signing blocks and converts selected DEX together", t => {
  const { spawnSync } = require("node:child_process"), crypto = require("node:crypto");
  const home = process.env.JAVA_HOME || (process.platform === "darwin" ? spawnSync("/usr/libexec/java_home", ["-v", "21"], { encoding: "utf8" }).stdout.trim() : "");
  const runtime = require("../src/modules/android/runtime").runtimeRoot(), native = path.resolve(__dirname, "../src/modules/android/native");
  if (!home || !fs.existsSync(path.join(runtime, "dex2jvm.jar"))) return t.skip("Requires Java 21 and the included converter");
  const root = directory(t), tool = path.join(native, "tools/apksig.jar"), classes = path.join(root, "classes");
  const env = { ...process.env }; for (const name of Object.keys(env)) if (/^(DYLD_|DEX2JVM_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$|CLASSPATH$)/.test(name)) delete env[name];
  const run = (tool, args, ok = true) => {
    const out = spawnSync(path.join(home, "bin", tool), args, { env, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.equal(out.error, undefined, out.error?.message); if (ok) assert.equal(out.status, 0, out.stdout + out.stderr); else assert.notEqual(out.status, 0);
    return out;
  };
  run("javac", ["--release", "21", "-cp", tool + path.delimiter + path.join(runtime, "dex2jvm.jar"), "-d", classes,
    path.join(native, "converter/VerifyApkSet.java"), path.join(native, "converter/ConvertApkSet.java"), path.join(__dirname, "fixtures/android-framework-services/SignApkSet.java")]);
  run("keytool", ["-genkeypair", "-alias", "owned", "-keystore", path.join(root, "key.p12"), "-storetype", "PKCS12", "-storepass", "test-only-password", "-keyalg", "RSA", "-keysize", "2048", "-validity", "1", "-dname", "CN=Owned APK test", "-noprompt"]);
  const dex = require("./fixtures/android-dynamic-dex/make-dex.cjs")(), other = Buffer.from(dex);
  Buffer.from("Other").copy(other, other.indexOf(Buffer.from("Value")));
  crypto.createHash("sha1").update(other.subarray(32)).digest().copy(other, 12);
  let a = 1, b = 0; for (const byte of other.subarray(12)) { a = (a + byte) % 65521; b = (b + a) % 65521; } other.writeUInt32LE(((b << 16) | a) >>> 0, 8);
  const unsigned = path.join(root, "unsigned.apk"), split = path.join(root, "feature-unsigned.apk");
  fs.writeFileSync(unsigned, zip([["AndroidManifest.xml", binaryXml(manifest())], ["classes.dex", dex]], { method: 0 }));
  fs.writeFileSync(split, zip([["AndroidManifest.xml", binaryXml(manifest([], {}, { ":split": "feature" }))], ["classes.dex", other]], { method: 0 }));
  const signed = path.join(root, "base.apk"), signedSplit = path.join(root, "feature.apk"), cp = [classes, tool, path.join(runtime, "dex2jvm.jar")].join(path.delimiter);
  run("java", ["-cp", cp, "SignApkSet", path.join(root, "key.p12"), unsigned, signed, split, signedSplit]);
  run("java", ["-cp", cp, "io.github.kksimp.dex2jvm.VerifyApkSet", path.join(root, "unsigned.tsv"), unsigned], false);
  const report = path.join(root, "verified.tsv"); run("java", ["-cp", cp, "io.github.kksimp.dex2jvm.VerifyApkSet", report, signed, signedSplit]);
  const lines = fs.readFileSync(report, "utf8").trim().split("\n").map(s => s.split("\t"));
  assert.equal(lines.length, 2); assert.equal(lines[0][2], lines[1][2]);
  for (const [i, file] of [signed, signedSplit].entries()) assert.equal(lines[i][1], crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
  const output = path.join(root, "converted.jar");
  run("java", ["-cp", cp, "io.github.kksimp.dex2jvm.ConvertApkSet", path.join(runtime, "android-api-metadata.jar"), output, signed, signedSplit]);
  const entries = require("../src/modules/shared/runtime/zip").readZipEntries(output).entries.map(e => e.name);
  assert.deepEqual(entries.filter(name => name.endsWith(".class")).sort(), ["fixture/Other.class", "fixture/Value.class"]);
  assert.ok(entries.includes("META-INF/maclauncher/apk-classes"));
  assert.ok(entries.includes("META-INF/maclauncher/parent-classes"));
  const duplicate = path.join(root, "duplicate.jar");
  const duplicateSource = path.join(root, "duplicate.apk"); fs.copyFileSync(signed, duplicateSource);
  run("java", ["-cp", cp, "io.github.kksimp.dex2jvm.ConvertApkSet", path.join(runtime, "android-api-metadata.jar"), duplicate, signed, duplicateSource]);
  assert.deepEqual(require("../src/modules/shared/runtime/zip").readZipEntries(duplicate).entries.map(e => e.name).filter(name => name.endsWith(".class")), ["fixture/Value.class"]);
  const bytes = fs.readFileSync(signed), at = bytes.indexOf(Buffer.from("dex\n035\0")); assert.ok(at > 0); bytes[at + 12] ^= 1; fs.writeFileSync(signed, bytes);
  run("java", ["-cp", cp, "io.github.kksimp.dex2jvm.VerifyApkSet", path.join(root, "tampered.tsv"), signed], false);
  assert.equal(fs.existsSync(path.join(root, "tampered.tsv")), false);
});
test("Android split sets select matching ARM64 originals, verify before conversion, and retain ordered resources", async t => {
  const { root, entry, options } = preparationFixture(t), Package = require("../src/modules/android/package-set");
  for (let index = 0; index < 12; index++) {
    const metadata = path.join(options.payload.root, "framework-" + index + ".jar");
    fs.writeFileSync(metadata, "framework hierarchy " + index);
    options.payload.metadataClasspath.push(metadata);
  }
  const folder = path.join(root, "package set"); fs.mkdirSync(folder);
  const make = (name, tree, extra = []) => {
    const file = path.join(folder, name); fs.writeFileSync(file, zip([["AndroidManifest.xml", binaryXml(tree)], ...extra])); return file;
  };
  const base = make("base.apk", manifest([activity()], { isSplitRequired: true }), [["classes.dex", Buffer.from("owned dex")], ["assets/base.txt", Buffer.from("base")]]);
  const arm = make("config.arm64.apk", manifest([], { hasCode: false }, { ":split": "config.arm64_v8a" }), [["lib/arm64-v8a/libgame.so", Buffer.from("arm64")]]);
  make("config.x86.apk", manifest([], { hasCode: false }, { ":split": "config.x86_64" }), [["lib/x86_64/libgame.so", Buffer.from("x64")]]);
  make("download-asset.apk", manifest([], { hasCode: false }, { ":split": "UnityDataAssetPack" }), [["assets/english.txt", Buffer.from("English")]]);
  const detected = require("../src/modules/android/detect").detectGame({ inputPath: arm });
  assert.equal(detected.gamePath, base); assert.equal(detected.moduleData.packageSet, true);
  assert.equal(require("../src/modules/android/detect").detectGame({ inputPath: base }).gamePath, base, "base and split drops select the same game");
  const otherVersion = make("other-base.apk", manifest([activity()], {}, { versionCode: 99 }), [["classes.dex", Buffer.from("other dex")]]);
  assert.equal(require("../src/modules/android/detect").detectGame({ inputPath: arm }).gamePath, base,
    "A selected split belongs to its exact version even when another version shares the folder");
  assert.equal(require("../src/modules/android/detect").detectGame({ inputPath: otherVersion }).gamePath, otherVersion,
    "A standalone version does not inherit another version's splits");
  fs.unlinkSync(otherVersion);
  const inspected = Package.inspectFiles(Package.directFiles(folder));
  assert.deepEqual(inspected.selected.map(r => r.metadata.split), [null, "config.arm64_v8a", "UnityDataAssetPack"]);
  assert.equal(inspected.excluded.length, 1);
  const records = inspected.selected.map(item => ({ ...item, signers: ["a".repeat(64)] }));
  assert.equal(Package.plan(records, { verified: true }).selected.length, 3);
  assert.equal(Package.plan(records.map((item, index) => ({ ...item,
    metadata: { ...item.metadata, requiredGlEsVersion: index === 1 ? 0x30001 : 0x20000 }
  })), { verified: true }).metadata.requiredGlEsVersion, 0x30001);
  assert.throws(() => Package.plan(records.map((r, i) => i ? { ...r, signers: ["b".repeat(64)] } : r), { verified: true }), /signing certificates/);
  assert.throws(() => Package.plan(records.map((r, i) => i ? { ...r, metadata: { ...r.metadata, versionCode: 99 } } : r)), /package and version/);
  assert.throws(() => Package.plan([...records, records[1]]), /same file/);
  assert.throws(() => Package.plan(records.map((r, i) => i === 1 ? { ...r, metadata: { ...r.metadata, requiredSplits: ["missing"] } } : r)), /required Android split/);
  const linked = path.join(folder, "linked.apk"); fs.linkSync(arm, linked);
  assert.throws(() => Package.inspectFiles(Package.directFiles(folder)), /same file/); fs.unlinkSync(linked);
  let calls = 0;
  const execute = async (_command, args) => {
    calls++;
    if (args.includes("io.github.kksimp.dex2jvm.VerifyApkSet")) {
      const at = args.indexOf("io.github.kksimp.dex2jvm.VerifyApkSet"), files = args.slice(at + 2);
      const lines = await Promise.all(files.map(async (file, i) => i + "\t" + await require("../src/modules/android/prepare").fileHash(file) + "\t" + "a".repeat(64)));
      fs.writeFileSync(args[at + 1], lines.join("\n") + "\n");
    } else {
      const at = args.indexOf("io.github.kksimp.dex2jvm.ConvertApkSet"); assert.ok(at > 0);
      assert.equal(args[at + 1], options.payload.metadataClasspath.join(path.delimiter), "every framework hierarchy entry reaches split conversion");
      assert.equal(args.slice(at + 3).length, 3); fs.writeFileSync(args[at + 2], zip([["Owned.class", Buffer.from("converted")]]));
    }
  };
  const splitEntry = { ...entry, gamePath: folder, moduleData: { packageSet: true } };
  const splitOptions = { ...options, payload: { ...options.payload, profile: { ...options.payload.profile, splitApksVersion: 1 } }, execute };
  const prepared = await prepareApk(splitEntry, splitOptions);
  assert.equal(calls, 2); assert.equal(prepared.sourceApks.length, 3);
  assert.equal(fs.readFileSync(path.join(prepared.nativeRoot, "libgame.so"), "utf8"), "arm64");
  assert.equal(fs.readFileSync(path.join(prepared.assetsRoot, "english.txt"), "utf8"), "English");
  assert.deepEqual(fs.readFileSync(prepared.sourceApk), fs.readFileSync(base));
  const config = require("../src/modules/android/host").launchConfig(splitEntry, prepared, splitOptions.payload, {});
  assert.deepEqual(config.sourceApks, ["base.apk", "split_config.arm64_v8a.apk", "split_UnityDataAssetPack.apk"]);
  await prepareApk(splitEntry, splitOptions); assert.equal(calls, 2, "unchanged verified conversion is reused");
  const receiptPath = path.join(prepared.root, "prepared.json"), old = JSON.parse(fs.readFileSync(receiptPath));
  const convertedIdentity = fs.statSync(prepared.convertedJar), nativeIdentity = fs.statSync(path.join(prepared.nativeRoot, "libgame.so"));
  const splitBytes = old.sources.map(source => fs.readFileSync(path.join(prepared.root, source.name)));
  old.packageSetVersion = 1;
  for (const [index, source] of old.sources.entries()) {
    const name = index ? "split-" + index + ".apk" : "source.apk";
    fs.renameSync(path.join(prepared.root, source.name), path.join(prepared.root, name)); source.name = name;
  }
  fs.writeFileSync(receiptPath, JSON.stringify(old));
  const release = await retainPrepared(prepared); t.after(release);
  const migrated = await prepareApk(splitEntry, splitOptions);
  assert.equal(calls, 2, "installed path migration reuses verified DEX conversion");
  assert.deepEqual(migrated.sourceApks.map(file => path.basename(file)), config.sourceApks);
  assert.deepEqual(migrated.sourceApks.map(file => fs.readFileSync(file)), splitBytes, "original signed APK bytes are retained without conversion");
  assert.equal(fs.statSync(prepared.convertedJar).ino, convertedIdentity.ino);
  assert.equal(fs.statSync(path.join(prepared.nativeRoot, "libgame.so")).ino, nativeIdentity.ino);
  for (const name of ["split-1.apk", "split-2.apk", "source.apk"]) {
    assert.equal(fs.existsSync(path.join(prepared.root, name)), true, "live readers keep their old split paths");
    assert.equal(fs.existsSync(path.join(migrated.root, name)), false, "new generation has no obsolete aliases");
  }
  const migratedReceipt = path.join(migrated.root, "prepared.json"), prior = JSON.parse(fs.readFileSync(migratedReceipt)); prior.packageSetVersion = 2;
  fs.renameSync(migrated.sourceApk, path.join(migrated.root, "source.apk")); prior.sources[0].name = "source.apk";
  fs.writeFileSync(migratedReceipt, JSON.stringify(prior));
  const canonical = await prepareApk(splitEntry, splitOptions); assert.equal(calls, 2, "canonical split paths also migrate the old base name without conversion");
  assert.deepEqual(fs.readFileSync(canonical.sourceApk), splitBytes[0]);
  await release();
  for (const obsolete of [prepared.root, migrated.root]) fs.rmSync(obsolete, {recursive:true,force:true});
  fs.writeFileSync(canonical.sourceApks[1], "damaged");
  await prepareApk(splitEntry, splitOptions); assert.equal(calls, 4, "damaged cached split is repaired");
  const archive = path.join(root, "game.xapk");
  fs.writeFileSync(archive, zip(Package.directFiles(folder).map(file => [path.basename(file), fs.readFileSync(file)])));
  const packed = await require("../src/modules/android/detect").detectGameAsync({ inputPath: archive });
  assert.equal(packed.moduleData.packageSet, true);
  const fromArchive = await prepareApk({ ...splitEntry, gamePath: archive }, splitOptions);
  assert.equal(fromArchive.sourceApks.length, 3); assert.equal(calls, 6);
  let artVerifications=0;
  const art=await prepareApk({...splitEntry,gameId:'artSignedSplits',gamePath:archive},{...splitOptions,execution:'art',execute:async(command,args)=>{
    assert.ok(args.includes('io.github.kksimp.dex2jvm.VerifyApkSet'),'ART verifies the original APK set without converting its DEX');
    assert.equal(args[args.indexOf('-cp')+1],splitOptions.payload.converterClasspath.join(path.delimiter));
    artVerifications++;return execute(command,args);
  }});
  assert.equal(artVerifications,1);assert.equal(art.execution,'art');assert.equal(art.sourceApks.length,3);
  assert.equal(art.convertedJar,undefined);assert.equal(fs.existsSync(path.join(art.root,'converted.jar')),false);
  assert.equal(art.assetStorage,'apk');assert.deepEqual(fs.readdirSync(art.assetsRoot),[]);
  assert.equal(withApk(art.sourceApks[2],apk=>apk.read('assets/english.txt').toString()),'English');
  assert.equal(fs.readFileSync(path.join(art.nativeRoot,'libgame.so'),'utf8'),'arm64');
  await prepareApk({...splitEntry,gameId:'artSignedSplits',gamePath:archive},{...splitOptions,execution:'art',execute:async()=>assert.fail('Verified ART package cache should be reused')});
  const denied = { ...splitEntry, gameId: "invalidSignatures" };
  await assert.rejects(prepareApk(denied, { ...splitOptions, execute: async () => { throw Error("signature rejected"); } }), /signature rejected/);
  const leftovers = fs.readdirSync(require("../src/modules/android/storage").storagePaths(options.userDataDir, denied.gameId).preparedRoot);
  assert.deepEqual(leftovers, [], "failed verification retires all temporary inputs");
});
test("Android expansion assets import once from XAPK and adjacent files while preserving application updates",async t=>{
  const {root,entry,options}=preparationFixture(t),packageName="org.example.game",main="main.3."+packageName+".obb",patch="patch.2."+packageName+".obb";
  const mainBytes=Buffer.from("original opaque expansion bytes"),patchBytes=Buffer.from("original patch bytes"),archive=path.join(root,"expansions.xapk");
  fs.writeFileSync(archive,zip([["base.apk",fs.readFileSync(entry.gamePath)],["Android/obb/"+packageName+"/"+main,mainBytes],[patch,patchBytes]]));
  const original=fs.readFileSync(archive);let calls=0;
  const execute=async(_command,args)=>{
    calls++;const verify=args.indexOf("io.github.kksimp.dex2jvm.VerifyApkSet");
    if(verify>=0){const lines=await Promise.all(args.slice(verify+2).map(async(file,i)=>i+"\t"+await require("../src/modules/android/prepare").fileHash(file)+"\t"+"a".repeat(64)));fs.writeFileSync(args[verify+1],lines.join("\n")+"\n");}
    else fs.writeFileSync(args[args.indexOf("io.github.kksimp.dex2jvm.ConvertApkSet")+2],zip([["Game.class",Buffer.from("class")]]));
  };
  const configured={...options,payload:{...options.payload,profile:{...options.payload.profile,splitApksVersion:1}},execute},selected={...entry,gamePath:archive};
  const first=await prepareApk(selected,configured),obb=path.join(path.dirname(first.filesRoot),"obb");
  assert.equal(calls,2);assert.deepEqual(fs.readFileSync(path.join(obb,main)),mainBytes);assert.deepEqual(fs.readFileSync(path.join(obb,patch)),patchBytes);
  assert.equal(first.expansions.find(item=>item.name===main).sha256,require("node:crypto").createHash("sha256").update(mainBytes).digest("hex"));
  fs.writeFileSync(path.join(obb,main),"application updated expansion");fs.unlinkSync(path.join(obb,patch));
  await prepareApk(selected,configured);assert.equal(calls,2,"missing expansion restoration reuses converted code");
  assert.equal(fs.readFileSync(path.join(obb,main),"utf8"),"application updated expansion");assert.deepEqual(fs.readFileSync(path.join(obb,patch)),patchBytes);
  assert.deepEqual(fs.readFileSync(archive),original);assert.deepEqual(fs.readdirSync(obb).sort(),[main,patch].sort(),"no extraction directories or duplicate copies remain");
  fs.writeFileSync(path.join(root,main),mainBytes);fs.writeFileSync(path.join(root,"main.1.other.package.obb"),"unrelated");
  const direct=await prepareApk({...entry,gameId:"adjacentExpansion"},configured),directObb=path.join(path.dirname(direct.filesRoot),"obb");
  assert.deepEqual(fs.readdirSync(directObb),[main]);assert.deepEqual(fs.readFileSync(path.join(directObb,main)),mainBytes);
  const bad=path.join(root,"wrong-package.xapk");fs.writeFileSync(bad,zip([["Android/obb/other.package/main.1.other.package.obb",mainBytes]]));
  await assert.rejects(require("../src/modules/android/expansions").installExpansions(bad,packageName,path.dirname(direct.filesRoot),{archive:true}),/different package/);
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(require("../src/modules/android/expansions").installExpansions(archive,packageName,path.dirname(direct.filesRoot),{archive:true,signal:cancelled.signal}),/abort/i);
  const providerRoot=path.join(root,"provider-private"),providerObb=path.join(providerRoot,"android","sdcard","Android","obb",packageName);
  const install=require("../src/modules/android/expansions").installExpansions;
  await install(entry.gamePath,packageName,providerRoot,{destination:providerObb});
  const installed=path.join(providerObb,main),source=path.join(root,main);
  assert.deepEqual(fs.readdirSync(providerObb),[main],"provider layout seeds only its own package expansion");
  assert.notEqual(fs.statSync(installed).ino,fs.statSync(source).ino,"writable expansion has independent ownership");
  fs.writeFileSync(source,"changed source expansion");
  assert.deepEqual(fs.readFileSync(installed),mainBytes,"source edits do not alter private application data");
  fs.writeFileSync(installed,"provider downloaded replacement");
  await install(entry.gamePath,packageName,providerRoot,{destination:providerObb});
  assert.equal(fs.readFileSync(installed,"utf8"),"provider downloaded replacement");
  await assert.rejects(install(entry.gamePath,packageName,providerRoot,{destination:path.join(root,"outside-provider")}),/escapes/);
  const alias=path.join(providerRoot,"alias");fs.symlinkSync(path.dirname(providerRoot),alias,"dir");
  await assert.rejects(install(entry.gamePath,packageName,providerRoot,{destination:path.join(alias,"escaped")}),/aliases/);
});
test("Pure NDK NativeActivity APKs prepare in the same JVM host without a DEX conversion", async t => {
  const { entry, options } = preparationFixture(t);
  const entries = [["AndroidManifest.xml", binaryXml(manifest([activity("android.app.NativeActivity")], { hasCode: false }))],
    ["assets/text.txt", Buffer.from("native asset")], ["lib/arm64-v8a/libmain.so", Buffer.from("native library")]];
  const original = zip(entries); fs.writeFileSync(entry.gamePath, original);
  assert.deepEqual(inspectApk(entry.gamePath).limitations, []);
  const prepared = await prepareApk(entry, { ...options, execute: async () => { throw new Error("No DEX conversion should run"); } });
  const archive = fs.readFileSync(prepared.convertedJar);
  assert.equal(archive.length, 22); assert.equal(archive.readUInt32LE(), 0x06054b50);
  assert.equal(fs.readFileSync(path.join(prepared.assetsRoot, "text.txt"), "utf8"), "native asset");
  assert.equal(fs.readFileSync(path.join(prepared.nativeRoot, "libmain.so"), "utf8"), "native library");
  assert.deepEqual(fs.readFileSync(entry.gamePath), original);
  entries[0][1] = binaryXml(manifest([], { hasCode: false }));
  fs.writeFileSync(entry.gamePath, zip(entries));
  assert.deepEqual(inspectApk(entry.gamePath,{requireLauncher:false}).limitations,[]);
  const resources=await prepareApk(entry,{...options,requireLauncher:false,execute:async()=>{throw Error("Resource package has no DEX");}});
  assert.equal(fs.readFileSync(resources.convertedJar).length,22);
  await assert.rejects(prepareApk(entry,options),/no enabled launcher/,'A service preparation does not grant a later game launch');
  entries[0][1] = binaryXml(manifest([activity(".MissingJava")], { hasCode: true }));
  fs.writeFileSync(entry.gamePath, zip(entries));
  assert.match(inspectApk(entry.gamePath).limitations.join(" "), /missing application bytecode/);
});

test("APK preparation converts once, verifies cache content and keeps saves across runtime changes", async t => {
  const { root, entry, options } = preparationFixture(t), original = fs.readFileSync(entry.gamePath);
  let calls = 0;
  const execute = async (command, args, settings) => {
    calls++; assert.equal(command, options.java.javaPath);
    assert.ok(args.includes("-Dmaclauncher.dex.nativeLoadTarget=maclauncher.android.GuestNativeLoader"));
    const converter = args.indexOf("io.github.kksimp.dex2jvm.ConvertApkSet");assert.ok(converter>0);
    assert.equal(args[converter + 1], options.payload.metadataClasspath.join(path.delimiter));
    assert.equal(settings.env.DYLD_INSERT_LIBRARIES, undefined);
    await fs.promises.writeFile(args[converter + 2], zip([["org/example/game/Main.class", Buffer.from("converted class")]]));
  };
  const first = await prepareApk(entry, { ...options, execute });
  assert.equal(calls, 1); assert.equal(first.metadata.packageName, "org.example.game");
  assert.equal(fs.readFileSync(path.join(first.assetsRoot, "text.txt"), "utf8"), "original asset");
  assert.equal(fs.existsSync(path.join(first.root, "input/lib/x86")), false);
  fs.writeFileSync(path.join(first.filesRoot, "save"), "preserved save");
  const second = await prepareApk(entry, { ...options, execute });
  assert.equal(calls, 1); assert.equal(second.root, first.root);
  const receiptPath = path.join(first.root, "prepared.json"), older = JSON.parse(fs.readFileSync(receiptPath));
  delete older.metadata.hasCode;
  older.metadata.debuggable = true;
  fs.writeFileSync(receiptPath, JSON.stringify(older));
  const refreshed = await prepareApk(entry, { ...options, execute });
  assert.equal(calls, 1, "Missing manifest flags must not force another bytecode conversion");
  assert.equal(refreshed.metadata.hasCode, true);
  assert.equal(refreshed.metadata.debuggable, false, "Restore flags from the verified original APK");
  const uninspected = JSON.parse(fs.readFileSync(receiptPath));
  delete uninspected.metadata.applicationMetadataInspected;
  uninspected.metadata.applicationMetadata = { fabricated: { type: "boolean", value: true } };
  fs.writeFileSync(receiptPath, JSON.stringify(uninspected));
  const inspected = await prepareApk(entry, { ...options, execute });
  assert.equal(calls, 1, "Metadata inspection must reuse the verified conversion");
  assert.equal(inspected.metadata.applicationMetadataInspected, true);
  assert.equal(inspected.metadata.applicationMetadata, null, "Verified APK absence replaces stale uninspected metadata");
  const oldComponents = { ...inspected, metadata: { ...inspected.metadata } };
  delete oldComponents.metadata.applicationComponentsInspected;
  oldComponents.metadata.applicationProviders = [{ name: "fabricated" }];
  fs.writeFileSync(receiptPath, JSON.stringify(oldComponents));
  const components = await prepareApk(entry, { ...options, execute });
  assert.equal(calls, 1, "Component inspection must reuse the verified conversion");
  assert.equal(components.metadata.applicationComponentsInspected, true);
  assert.deepEqual(components.metadata.applicationProviders, []);
  assert.deepEqual(components.metadata.applicationServices, []);
  const staleInspection = JSON.parse(fs.readFileSync(receiptPath));
  staleInspection.metadata.manifestInspectionVersion = INSPECTION_VERSION - 1;
  staleInspection.metadata.applicationComponentsInspected = false;
  fs.writeFileSync(receiptPath, JSON.stringify(staleInspection));
  const reinspected = await prepareApk(entry, { ...options, execute });
  assert.equal(calls, 1, "A new inspection revision must reuse converted bytecode");
  assert.equal(reinspected.metadata.applicationComponentsInspected, true);
  const persisted = fs.readFileSync(receiptPath, "utf8"), updatedReceipt = JSON.parse(persisted);
  const persistedStat = fs.statSync(receiptPath, { bigint: true });
  assert.equal(updatedReceipt.metadata.manifestInspectionVersion, INSPECTION_VERSION);
  assert.equal(updatedReceipt.metadata.applicationComponentsInspected, true);
  await prepareApk(entry, { ...options, execute });
  assert.equal(fs.readFileSync(receiptPath, "utf8"), persisted, "An up-to-date cache does not rewrite inspection metadata");
  const unchangedStat = fs.statSync(receiptPath, { bigint: true });
  for (const key of ["ino", "mtimeNs", "ctimeNs"]) assert.equal(unchangedStat[key], persistedStat[key]);
  fs.writeFileSync(path.join(first.assetsRoot, "text.txt"), "corrupt cache");
  const repaired = await prepareApk(entry, { ...options, execute });
  assert.equal(calls, 2); assert.equal(repaired.key, first.key);
  assert.equal(fs.readFileSync(path.join(repaired.assetsRoot, "text.txt"), "utf8"), "original asset");
  fs.writeFileSync(options.payload.converterClasspath[0], "new converter");
  const updated = await prepareApk(entry, { ...options, execute });
  assert.equal(calls, 3); assert.notEqual(updated.key, first.key);
  assert.equal(updated.filesRoot, first.filesRoot); assert.equal(fs.readFileSync(path.join(updated.filesRoot, "save"), "utf8"), "preserved save");
  assert.deepEqual(fs.readFileSync(entry.gamePath), original);
  assert.ok(fs.existsSync(root));
});
test("APK failed or cancelled preparation publishes no cache and never accepts a foreign Java ABI", async t => {
  const { entry, options } = preparationFixture(t), controller = new AbortController();
  await assert.rejects(prepareApk(entry, { ...options, java: { ...options.java, variant: "x64" } }), /Apple Silicon Java 21/);
  const execute = async () => { controller.abort(); controller.signal.throwIfAborted(); };
  await assert.rejects(prepareApk(entry, { ...options, signal: controller.signal, execute }), { name: "AbortError" });
  const prepared = require("../src/modules/android/storage").storagePaths(options.userDataDir, entry.gameId).preparedRoot;
  assert.deepEqual(fs.readdirSync(prepared), []);
  await assert.rejects(prepareApk(entry, { ...options, execute: async (_command, args) => {
    fs.writeFileSync(args[args.indexOf("io.github.kksimp.dex2jvm.ConvertApkSet") + 2], zip([["README", Buffer.from("no classes")]]));
  } }), /no Java classes/);
  assert.deepEqual(fs.readdirSync(prepared), []);
});
test("Prepared digest reuse never accepts a replaced directory alias",async t=>{
  const {entry,options,root}=preparationFixture(t);let calls=0;
  const execute=async(_command,args)=>{calls++;fs.writeFileSync(args[args.indexOf("io.github.kksimp.dex2jvm.ConvertApkSet")+2],zip([["Game.class",Buffer.from("class")]]));};
  const first=await prepareApk(entry,{...options,execute});
  await prepareApk(entry,{...options,execute});
  const moved=path.join(root,"moved-assets");fs.renameSync(first.assetsRoot,moved);fs.symlinkSync(moved,first.assetsRoot);
  const repaired=await prepareApk(entry,{...options,execute});
  assert.equal(calls,2);assert.notEqual(repaired.root,first.root);
  assert.equal(fs.lstatSync(repaired.assetsRoot).isSymbolicLink(),false);
  assert.equal(fs.readFileSync(path.join(repaired.assetsRoot,"text.txt"),"utf8"),"original asset");
  const storage=require("../src/modules/android/storage").storagePaths(options.userDataDir,entry.gameId);
  assert.equal(fs.existsSync(path.join(storage.root,".preparation-digests.json")),true);
  assert.equal(fs.existsSync(path.join(storage.dataRoot,".preparation-digests.json")),false,"games cannot write the validation index");
});
test("Android conversion retention protects running games and preserves unrelated files and saves", async t => {
  const { entry, options } = preparationFixture(t);
  const execute = async (_command, args) => fs.writeFileSync(args[args.indexOf("io.github.kksimp.dex2jvm.ConvertApkSet") + 2], zip([["Game.class", Buffer.from("class")]]));
  const first = await prepareApk(entry, { ...options, execute }), release = await retainPrepared(first);
  fs.writeFileSync(path.join(first.assetsRoot, "text.txt"), "changed while in use");
  const repaired = await prepareApk(entry, { ...options, execute });
  assert.notEqual(repaired.root, first.root); assert.equal(repaired.key, first.key);
  assert.equal(fs.readFileSync(path.join(first.assetsRoot, "text.txt"), "utf8"), "changed while in use");
  assert.equal(fs.readFileSync(path.join(repaired.assetsRoot, "text.txt"), "utf8"), "original asset");
  assert.ok(fs.existsSync(first.convertedJar));
  fs.writeFileSync(path.join(first.assetsRoot, "text.txt"), "original asset");
  const parent = path.dirname(first.root), foreign = path.join(parent, "a".repeat(64));
  fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, "unrelated"), "keep");
  fs.writeFileSync(path.join(first.filesRoot, "save"), "saved game");
  let latest;
  for (let n = 0; n < 5; n++) {
    fs.writeFileSync(options.payload.converterClasspath[0], "converter version " + n);
    latest = await prepareApk(entry, { ...options, execute });
  }
  const owned = () => fs.readdirSync(parent).filter(name => fs.existsSync(path.join(parent, name, "prepared.json")));
  assert.equal(owned().length, 2); assert.ok(fs.existsSync(first.convertedJar));
  await release(); await release();
  assert.equal(owned().length, 1); assert.ok(fs.existsSync(latest.convertedJar));
  assert.equal(fs.existsSync(first.root), false);
  assert.equal(fs.readFileSync(path.join(foreign, "unrelated"), "utf8"), "keep");
  assert.equal(fs.readFileSync(path.join(latest.filesRoot, "save"), "utf8"), "saved game");
});
test("Android independent preparation processes share publication and retain live generations", async t => {
  const { fork }=require("node:child_process"),{ once }=require("node:events");
  const { entry,options,root }=preparationFixture(t);
  const converted=path.join(root,"converted-fixture.jar"),conversions=path.join(root,"conversions");
  fs.writeFileSync(converted,zip([["Game.class",Buffer.from("class")]]));
  const children=Array.from({length:3},()=>fork(path.join(__dirname,"fixtures/android-prepared-cache/worker.cjs"),[],{stdio:["ignore","ignore","pipe","ipc"]}));
  t.after(async()=>{for(const child of children)if(child.exitCode==null&&child.signalCode==null){const exited=once(child,"exit");child.kill();await exited;}});
  const request=async(child,message)=>{const result=once(child,"message");child.send(message);const [value]=await result;assert.equal(value.error,undefined,value.error);return value;};
  const prepared=await Promise.all(children.map(child=>request(child,{op:"prepare",entry,options,converted,conversions})));
  assert.equal(new Set(prepared.map(value=>value.root)).size,1,"independent publishers share the same verified generation");
  assert.equal(fs.readFileSync(conversions,"utf8").trim().split("\n").length,1,"one conversion across independent processes");
  assert.ok(prepared.some(value=>value.hashReads.length===0),"a fresh worker reuses already verified bytes without rereading them");
  const first=prepared[0],parent=path.dirname(first.root);
  const execute=async(_command,args)=>fs.copyFileSync(converted,args[args.indexOf("io.github.kksimp.dex2jvm.ConvertApkSet")+2]);
  for(let i=0;i<4;i++){fs.writeFileSync(options.payload.converterClasspath[0],"new converter "+i);await prepareApk(entry,{...options,execute});}
  assert.ok(fs.existsSync(first.sourceApk),"live foreign readers retain original source and converted files");
  await Promise.all(children.slice(0,2).map(child=>request(child,{op:"release"})));
  assert.ok(fs.existsSync(first.convertedJar),"last reader owns the generation independently");
  const stopped=once(children[2],"exit");children[2].kill();await stopped;
  await require("../src/modules/android/prepare").prunePrepared(parent,require("../src/modules/android/prepared-cache").generationPaths(parent)[0]);
  assert.equal(fs.existsSync(first.root),false,"dead-owner leases retire without accumulating generations");
  assert.equal(fs.readdirSync(parent).filter(name=>fs.existsSync(path.join(parent,name,"prepared.json"))).length,1);
});
test("Installed Android services pin actual generations and recover verified legacy catalog references", async t => {
  const Catalog=require("../src/modules/android/service-packages"),Cache=require("../src/modules/android/prepared-cache");
  const {entry,options}=preparationFixture(t);entry.gameId=Catalog.codeId("org.example.game");
  const execute=async(_command,args)=>fs.writeFileSync(args[args.indexOf("io.github.kksimp.dex2jvm.ConvertApkSet")+2],zip([["Game.class",Buffer.from("class")]]));
  const install=prepared=>Catalog.installServicePackage(entry.gamePath,{userDataDir:options.userDataDir},options.payload,options.java,
    {prepare:async()=>prepared,inspect:()=>prepared.metadata});
  const first=await prepareApk(entry,{...options,execute});await install(first);
  fs.writeFileSync(path.join(first.assetsRoot,"text.txt"),"repair this generation");
  const repaired=await prepareApk(entry,{...options,execute});
  assert.equal(repaired.key,first.key);assert.notEqual(repaired.root,first.root);
  const record=await install(repaired);
  assert.equal(record.preparedGeneration,path.basename(repaired.root));
  const borrowed=await Catalog.retainSource(options.userDataDir,"org.example.game");
  assert.equal(borrowed.sources[0],repaired.sourceApk);
  for(let i=0;i<4;i++){fs.writeFileSync(options.payload.converterClasspath[0],"service converter "+i);await prepareApk(entry,{...options,execute});}
  assert.ok(fs.existsSync(repaired.sourceApk),"catalog-selected source survives unrelated conversion eviction");
  await borrowed.release();assert.ok(fs.existsSync(repaired.sourceApk),"installed source remains owned without a running caller");
  const catalogFile=path.join(options.userDataDir,"android/services/catalog.json"),catalog=JSON.parse(fs.readFileSync(catalogFile));
  delete catalog.packages[0].preparedGeneration;fs.writeFileSync(catalogFile,JSON.stringify(catalog));
  assert.equal(fs.existsSync(first.root),false,"legacy logical pathname is no longer present");
  const recovered=await Catalog.retainSource(options.userDataDir,"org.example.game");
  assert.deepEqual(fs.readFileSync(recovered.sources[0]),fs.readFileSync(entry.gamePath));
  const current=Catalog.read(options.userDataDir).packages[0];
  assert.equal(current.preparedGeneration,path.basename(recovered.root));
  assert.equal(Cache.generationKey(current.preparedGeneration),current.preparedKey);
  await recovered.release();
});
test("Android selected saves are imported once into private storage without changing originals", async t => {
  const { entry, options, root } = preparationFixture(t);
  const execute = async (_command, args) => fs.writeFileSync(args[args.indexOf("io.github.kksimp.dex2jvm.ConvertApkSet") + 2], zip([["Game.class", Buffer.from("class")]]));
  const saveDirOverride = path.join(root, "selected-saves");
  fs.mkdirSync(saveDirOverride); fs.writeFileSync(path.join(saveDirOverride,"save"),"original");
  const selected = { ...entry, saveDirOverride };
  const first = await prepareApk(selected, { ...options, execute });
  assert.notEqual(first.filesRoot, saveDirOverride);
  assert.match(first.filesRoot, /android\/apps\/game1\/data\/files$/);
  assert.equal(fs.readFileSync(path.join(first.filesRoot, "save"), "utf8"), "original");
  fs.writeFileSync(path.join(first.filesRoot, "save"), "new progress");
  const second = await prepareApk(selected, { ...options, execute });
  assert.equal(second.root, first.root); assert.equal(second.filesRoot, first.filesRoot);
  assert.equal(fs.readFileSync(path.join(first.filesRoot,"save"),"utf8"),"new progress");
  assert.equal(fs.readFileSync(path.join(saveDirOverride,"save"),"utf8"),"original");
  await assert.rejects(prepareApk({ ...entry, saveDirOverride: "relative" }, { ...options, execute }), /absolute folder/);
});
test("Android retries remove abandoned owned extraction directories while preserving active and unknown work", async t => {
  const { entry, options } = preparationFixture(t), parent = require('../src/modules/android/storage').storagePaths(options.userDataDir,entry.gameId).preparedRoot;
  await require('../src/modules/android/storage').prepareStorage(entry,options.userDataDir,{payloadRoot:options.payload.root});
  fs.mkdirSync(parent, { recursive: true });
  for (const [name, pid] of [["stale1", 2147483647], ["active", process.pid], ["custom", null]]) {
    const root = path.join(parent, ".prepare-" + name); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "partial.apk"), "partial");
    if (pid) fs.writeFileSync(path.join(root, ".preparing.json"), JSON.stringify({ owner: "maclauncher-android", schemaVersion: 1, pid, key: "a".repeat(64) }));
  }
  const execute = async (_command, args) => fs.writeFileSync(args[args.indexOf("io.github.kksimp.dex2jvm.ConvertApkSet") + 2], zip([["Game.class", Buffer.from("class")]]));
  const result = await prepareApk(entry, { ...options, execute });
  assert.equal(fs.existsSync(path.join(path.dirname(result.root), ".prepare-stale1")), false);
  assert.equal(fs.existsSync(path.join(parent, ".prepare-stale1/partial.apk")),false);
  assert.ok(fs.existsSync(path.join(parent, ".prepare-active/partial.apk")));
  assert.ok(fs.existsSync(path.join(parent, ".prepare-custom/partial.apk")));
  assert.equal(fs.existsSync(path.join(result.root, ".preparing.json")), false);
});
test("APK extraction rejects macOS case collisions and runtime metadata cannot escape its installation", async t => {
  const { root, options } = preparationFixture(t), file = path.join(root, "collision.apk"), dest = path.join(root, "unpacked");
  fs.mkdirSync(dest); fs.writeFileSync(file, zip([["assets/Names/a", Buffer.from("a")], ["assets/names/b", Buffer.from("b")]]));
  await assert.rejects(extractInputs(file, dest), /colliding asset names/); assert.deepEqual(fs.readdirSync(dest), []);
  const outside = path.join(root, "outside.jar"), link = path.join(options.payload.root, "linked.jar");
  fs.writeFileSync(outside, "foreign"); fs.symlinkSync(outside, link);
  await assert.rejects(describePayload({ ...options.payload, metadataClasspath: [link] }), /installed runtime/);
});
test("compiled Android resources retain their case-sensitive APK names without extraction", async t => {
  const root = directory(t), file = path.join(root, "resources.apk"), destination = path.join(root, "input");
  fs.mkdirSync(destination);
  fs.writeFileSync(file, zip([["res/GW.png", Buffer.from("first")], ["res/gW.png", Buffer.from("second")],
    ["assets/ordinary.txt", Buffer.from("asset")]]));
  const files = await extractInputs(file, destination);
  assert.deepEqual(files.map(item => item.name), ["assets/ordinary.txt"]);
  assert.equal(fs.existsSync(path.join(destination, "res")), false);
  withApk(file, apk => {
    assert.equal(apk.read("res/GW.png").toString(), "first");
    assert.equal(apk.read("res/gW.png").toString(), "second");
  });
});

test("APK streaming copies stored and compressed assets with exact hashes and preserves existing files", async t => {
  const root = directory(t), crypto = require("node:crypto"), data = crypto.randomBytes(512 * 1024);
  for (const method of [0, 8]) {
    const file = path.join(root, `stream-${method}.apk`), output = path.join(root, `asset-${method}`);
    fs.writeFileSync(file, zip([["assets/data", data], ["assets/empty", Buffer.alloc(0)]], { method, descriptor: true }));
    await withApk(file, async apk => {
      const copied = await apk.copy("assets/data", output);
      assert.deepEqual(copied, { bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") });
      assert.deepEqual(fs.readFileSync(output), data);
      await assert.rejects(apk.copy("assets/data", output), { code: "EEXIST" });
      assert.deepEqual(fs.readFileSync(output), data);
      const empty = path.join(root, `empty-${method}`);
      assert.equal((await apk.copy("assets/empty", empty)).bytes, 0); assert.equal(fs.statSync(empty).size, 0);
    });
  }
});

test("APK small copies preserve bounded decoding, private output and cancellation cleanup", async t => {
  const root=directory(t),crypto=require('node:crypto');
  for(const method of [0,8]){
    const file=path.join(root,'small-'+method+'.apk'),values=[0,31,65536,65537].map(size=>['asset-'+size,Buffer.alloc(size,7)]);
    fs.writeFileSync(file,zip(values,{method,descriptor:true}));
    await withApk(file,async apk=>{
      for(const [name,data]of values){
        const output=path.join(root,name+'-'+method),copied=await apk.copy(name,output);
        assert.deepEqual(copied,{bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')});
        assert.deepEqual(fs.readFileSync(output),data);assert.equal(fs.statSync(output).mode&0o777,0o600);
        await assert.rejects(apk.copy(name,output),{code:'EEXIST'});
      }
    });
  }
  const file=path.join(root,'corrupt-small.apk'),output=path.join(root,'partial');
  const damaged=zip([['asset',Buffer.from('original')]],{method:0,descriptor:true});damaged[35]^=1;fs.writeFileSync(file,damaged);
  await assert.rejects(withApk(file,apk=>apk.copy('asset',output)),/checksum/);assert.equal(fs.existsSync(output),false);
  fs.writeFileSync(file,zip([['asset',Buffer.from('original')]]));
  const controller=new AbortController(),open=fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises,'open',async(...args)=>{
    const handle=await open(...args),write=handle.writeFile.bind(handle);
    handle.writeFile=async(...values)=>{await write(...values);controller.abort();};return handle;
  });
  await assert.rejects(withApk(file,apk=>apk.copy('asset',output,{signal:controller.signal})),{name:'AbortError'});
  assert.equal(fs.existsSync(output),false);
});

test("APK streaming removes corrupt or over-expanding output and checks limits before creating files", async t => {
  const root = directory(t), file = path.join(root, "corrupt.apk"), output = path.join(root, "asset"), data = Buffer.alloc(512 * 1024, 7);
  const corrupt = zip([["assets/data", data]], { method: 0, descriptor: true }); corrupt[30 + "assets/data".length + 10] ^= 1;
  fs.writeFileSync(file, corrupt);
  await assert.rejects(withApk(file, apk => apk.copy("assets/data", output)), /checksum/);
  assert.equal(fs.existsSync(output), false);
  const expanding = zip([["assets/data", data]], { descriptor: true });
  const directoryOffset = expanding.readUInt32LE(expanding.length - 22 + 16); expanding.writeUInt32LE(16, directoryOffset + 24);
  fs.writeFileSync(file, expanding);
  await assert.rejects(withApk(file, apk => apk.copy("assets/data", output)), /size limit/); assert.equal(fs.existsSync(output), false);
  fs.writeFileSync(file, zip([["assets/data", data]]));
  await assert.rejects(withApk(file, apk => apk.copy("assets/data", output, { maximum: 32 })), /size limit/);
  assert.equal(fs.existsSync(output), false);
});

test("APK streaming cancellation releases pending reads and removes only its own partial output", async t => {
  const root = directory(t), file = path.join(root, "cancel.apk"), output = path.join(root, "partial"), controller = new AbortController();
  fs.writeFileSync(file, zip([["assets/data", Buffer.alloc(512 * 1024, 3)], ["assets/empty", Buffer.alloc(0)]], { method: 0 }));
  const originalRead = fs.read; let reads = 0, maximumRead = 0;
  t.mock.method(fs, "read", (fd, buffer, offset, length, position, callback) => {
    reads++; maximumRead = Math.max(maximumRead, length);
    return originalRead(fd, buffer, offset, length, position, (error, count, result) => {
      if (reads === 1) controller.abort(); callback(error, count, result);
    });
  });
  await withApk(file, async apk => {
    await assert.rejects(apk.copy("assets/data", output, { signal: controller.signal }), { name: "AbortError" });
    assert.equal(fs.existsSync(output), false);
    assert.equal(apk.read("assets/empty").length, 0);
    assert.equal((await apk.copy("assets/empty", output)).bytes, 0);
  });
  assert.ok(reads >= 1); assert.ok(maximumRead <= 64 * 1024);
});

 test("Android themes preserve application default, activity override and real alias target",()=>{
 for(const encoding of [true,false]){
  const parsed=parseBinaryManifest(binaryXml(manifest([activity('.Main'),activity('.Other',{theme:{type:1,data:0x7f140002}}),node('activity-alias',{name:'.Alias',targetActivity:'.Other'},[])],{theme:{type:1,data:0x7f140001}}),encoding));
  assert.deepEqual(parsed.applicationTheme,{inspected:true,resource:0x7f140001});
  assert.deepEqual(parsed.activityThemes['org.example.game.Main'],{inspected:true,resource:0});
  assert.deepEqual(parsed.activityThemes['org.example.game.Other'],{inspected:true,resource:0x7f140002});
  assert.equal(parsed.activityThemes['org.example.game.Alias'],undefined);
  const none=parseBinaryManifest(binaryXml(manifest()));assert.deepEqual(none.applicationTheme,{inspected:true,resource:0});
  const unknown=parseBinaryManifest(binaryXml(manifest([], {theme:'unsupported'})));assert.deepEqual(unknown.applicationTheme,{inspected:false});
 }
});

test("ART preparation retains original DEX in the shared APK cache without invoking conversion", async t => {
  const {entry,options}=preparationFixture(t),original=fs.readFileSync(entry.gamePath);
  const artPayload={...options.payload};delete artPayload.converterClasspath;
  const art={...options,payload:artPayload,execution:"art",execute:async()=>{throw Error("ART must not invoke dex2jvm");}};
  const first=await prepareApk(entry,{...art,retain:true});t.after(await retainPrepared(first));
  assert.equal(first.execution,"art");assert.equal(first.convertedJar,undefined);
  assert.equal(first.assetStorage,"apk");assert.deepEqual(fs.readdirSync(first.assetsRoot),[]);
  assert.equal(first.files.some(file=>file.name.startsWith('assets/')),false);
  assert.equal(withApk(first.sourceApk,apk=>apk.read('assets/text.txt').toString()),'original asset');
  assert.equal(fs.existsSync(path.join(first.root,"converted.jar")),false);
  assert.deepEqual(fs.readFileSync(first.sourceApk),original);
  fs.writeFileSync(path.join(first.filesRoot,"save"),"same app data");
  const next=await prepareApk(entry,art);assert.equal(next.root,first.root);
  const irrelevant=await prepareApk(entry,{...art,payload:{...artPayload,converterClasspath:[path.join(options.payload.root,"absent-converter.jar")]}});
  assert.equal(irrelevant.root,first.root,"ART does not open or hash unused converter inputs");
  await assert.rejects(describePayload(artPayload),/conversion libraries are incomplete/);
  const jvm=await prepareApk(entry,{...options,execute:async(_command,args)=>{
    const at=args.indexOf("io.github.kksimp.dex2jvm.ConvertApkSet");assert.ok(at>=0);
    fs.writeFileSync(args[at+2],zip([["Main.class",Buffer.from("converted")]]));
  }});
  assert.notEqual(jvm.root,first.root);assert.equal(jvm.filesRoot,first.filesRoot);
  assert.equal(fs.readFileSync(path.join(jvm.assetsRoot,'text.txt'),'utf8'),'original asset','JVM filesystem consumers retain their complete extracted assets');
  assert.equal(fs.readFileSync(path.join(jvm.filesRoot,"save"),"utf8"),"same app data");
  fs.writeFileSync(first.sourceApk,"corrupt");
  const repaired=await prepareApk(entry,art);assert.deepEqual(fs.readFileSync(repaired.sourceApk),original);
  assert.equal(repaired.convertedJar,undefined);
});

test('ART retires legacy extracted assets after its generation readers release without copying APKs',async t=>{
  const {entry,options}=preparationFixture(t),Cache=require('../src/modules/android/prepared-cache'),crypto=require('node:crypto');
  const art={...options,execution:'art',execute:async()=>assert.fail('ART does not convert')};
  const first=await prepareApk(entry,{...art,retain:true}),release=await retainPrepared(first);t.after(release);
  const native=path.join(first.nativeRoot,'libgame.so'),sourceIdentity=fs.statSync(first.sourceApk).ino,nativeIdentity=fs.statSync(native).ino;
  const receiptPath=path.join(first.root,'prepared.json'),legacy=JSON.parse(fs.readFileSync(receiptPath));delete legacy.assetStorage;
  const bytes=Buffer.from('original asset');fs.writeFileSync(path.join(first.assetsRoot,'text.txt'),bytes);
  legacy.files.push({name:'assets/text.txt',bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
  fs.writeFileSync(receiptPath,JSON.stringify(legacy));
  const held=await prepareApk(entry,art);
  assert.equal(held.root,first.root);assert.equal(held.assetStorage,undefined);assert.deepEqual(fs.readFileSync(path.join(held.assetsRoot,'text.txt')),bytes);
  fs.writeFileSync(path.join(held.assetsRoot,'text.txt'),'unused extracted copy');
  assert.equal((await prepareApk(entry,art)).root,first.root,'Unused legacy assets cannot force an APK copy or a new generation');
  await release();
  const retired=await prepareApk(entry,art);
  assert.equal(retired.root,first.root);assert.equal(retired.key,first.key);assert.equal(retired.assetStorage,'apk');
  assert.deepEqual(fs.readdirSync(retired.assetsRoot),[]);assert.equal(retired.files.some(file=>file.name.startsWith('assets/')),false);
  assert.equal(fs.statSync(retired.sourceApk).ino,sourceIdentity);assert.equal(fs.statSync(native).ino,nativeIdentity);
  assert.equal(withApk(retired.sourceApk,apk=>apk.read('assets/text.txt').toString()),'original asset');
  assert.equal((await prepareApk(entry,art)).root,first.root,'Reduced receipt remains a complete warm preparation');
  assert.deepEqual(Cache.generationPaths(path.dirname(first.root)),[first.root]);
});

test('ART retains case-sensitive ZIP assets without imposing a Mac extraction namespace',async t=>{
  const {entry,options}=preparationFixture(t);
  fs.writeFileSync(entry.gamePath,zip([['AndroidManifest.xml',binaryXml(manifest())],['classes.dex',Buffer.from('dex')],
    ['assets/Icon.png',Buffer.from('upper')],['assets/icon.png',Buffer.from('lower')]]));
  const prepared=await prepareApk(entry,{...options,execution:'art',execute:async()=>assert.fail('ART does not convert')});
  assert.deepEqual(fs.readdirSync(prepared.assetsRoot),[]);
  assert.equal(withApk(prepared.sourceApk,apk=>apk.read('assets/Icon.png').toString()),'upper');
  assert.equal(withApk(prepared.sourceApk,apk=>apk.read('assets/icon.png').toString()),'lower');
  await assert.rejects(prepareApk(entry,options),/colliding asset names/);
});
