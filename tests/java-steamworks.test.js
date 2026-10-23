const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const Consumer = require("../src/modules/java/runtime/steamworks/consumer");
const Classes = require("../src/modules/java/runtime/steamworks/class-file");
const Runtime = require("../src/modules/java/runtime/steamworks/runtime");
const Java = require("../src/modules/java/main");
const JavaCore = require("../src/modules/java/runtime/java-runtime");
const { jar } = require("../src/modules/java/runtime/steamworks/build-agent.cjs");

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const u2 = value => { const buffer = Buffer.alloc(2); buffer.writeUInt16BE(value); return buffer; };
const u4 = value => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value); return buffer; };
function javaClass({ name = "Game", calls = true, owner = "SteamAPI", method = "init", appId, branchToLiteralCall = false } = {}) {
  const pool = [], add = bytes => { pool.push(bytes); return pool.length; };
  const text = value => add(Buffer.concat([Buffer.from([1]), u2(Buffer.byteLength(value)), Buffer.from(value)]));
  const type = value => add(Buffer.concat([Buffer.from([7]), u2(text(value))]));
  const self = type(name), parent = type("java/lang/Object"), main = text("main"), descriptor = text("([Ljava/lang/String;)V"), codeName = text("Code");
  const target = type("com/codedisaster/steamworks/" + owner), targetName = text(appId ? "restartAppIfNecessary" : method), targetDescriptor = text(appId ? "(I)Z" : "()Z");
  const pair = add(Buffer.concat([Buffer.from([12]), u2(targetName), u2(targetDescriptor)]));
  const reference = add(Buffer.concat([Buffer.from([10]), u2(target), u2(pair)]));
  text("SteamAPI.init and steam_api.dll are ordinary strings");
  const instructions = calls ? [
    ...(appId ? [17, appId >>> 8 & 255, appId & 255] : []), 184, reference >>> 8, reference & 255, 87,
    ...(branchToLiteralCall ? [167, 255, 252] : []), 177
  ] : [177];
  const code = Buffer.concat([u2(4), u2(1), u4(instructions.length), Buffer.from(instructions), u2(0), u2(0)]);
  return Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbe]), u2(0), u2(52), u2(pool.length + 1), ...pool,
    u2(0x21), u2(self), u2(parent), u2(0), u2(0), u2(1), u2(9), u2(main), u2(descriptor), u2(1),
    u2(codeName), u4(code.length), code, u2(0)]);
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-java-steam-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wrapper = javaClass({ name: "com/codedisaster/steamworks/SteamAPI", calls: false });
  const wrapperName = "com/codedisaster/steamworks/SteamAPI.class";
  const pin = { ...Runtime.Catalog[0], classes: { [wrapperName]: digest(wrapper) } };
  const jarPath = path.join(root, "Game.jar");
  const entries = [["META-INF/MANIFEST.MF", Buffer.from("Manifest-Version: 1.0\r\nMain-Class: Game\r\n" + (options.classpath ? "Class-Path: " + options.classpath + "\r\n" : "") + "\r\n")],
    ["Game.class", javaClass(options)], ...(options.noWrapper ? [] : [[wrapperName, wrapper]])];
  fs.writeFileSync(jarPath, jar(entries));
  const entry = { gameId: "java-one", gamePath: jarPath, contentRootDir: root, moduleData: { jarPath, requiredJava: 8, runtimeLine: 8 }, runtimeData: {} };
  return { root, jarPath, entry, pin, wrapper, wrapperName, entries, options: { catalog: [pin] } };
}

test("Java Steam requires an executable call and exact wrapper bytes, rather than names or presence", t => {
  const source = fixture(t, { calls: false });
  fs.writeFileSync(path.join(source.root, "steam_appid.txt"), "480\n");
  const ordinary = Consumer.inspect(source.entry, source.options);
  assert.equal(ordinary.required, false);
  assert.equal(Consumer.requirement(source.entry, source.options), null);
  fs.writeFileSync(source.jarPath, jar(source.entries.map(([name, bytes]) => [name, name === "Game.class" ? javaClass({ appId: 480 }) : bytes])));
  const required = Consumer.requirement(source.entry, source.options);
  assert.equal(required.pin.version, "1.9.0");
  assert.equal(required.evidence.appId.value, 480);
  assert.deepEqual(required.evidence.architectures, ["x86_64"]);
  fs.writeFileSync(source.jarPath, jar(source.entries.map(([name, bytes]) => [name, name === "Game.class" ? javaClass() : Buffer.concat([bytes, Buffer.from([0])])] )));
  assert.throws(() => Consumer.requirement(source.entry, source.options), { code: "JAVA_STEAM_VERSION_UNKNOWN" });
});

test("Java restart application IDs come from a direct literal, and conflicting metadata is refused", t => {
  const source = fixture(t, { appId: 480 });
  const first = Consumer.requirement(source.entry, source.options);
  assert.equal(first.evidence.appId.value, 480);
  assert.equal(first.evidence.appId.evidence[0].kind, "java-restart-app-literal");
  fs.writeFileSync(path.join(source.root, "steam_appid.txt"), "481\n");
  assert.throws(() => Consumer.requirement(source.entry, source.options), { code: "JAVA_STEAM_APP_ID_UNKNOWN" });
  const branches = Classes.inspectClass(javaClass({ appId: 480, branchToLiteralCall: true }));
  assert.equal(branches.calls.length, 1);
  assert.equal(branches.appIds.length, 0);
});

test("Java qualification is exact for unsupported versions, unprobed native interfaces and missing identity", t => {
  const unknown = fixture(t, { noWrapper: true, appId: 480 });
  assert.throws(() => Consumer.requirement(unknown.entry, unknown.options), { code: "JAVA_STEAM_VERSION_UNKNOWN" });
  const extra = fixture(t, { owner: "SteamRemoteStorage" });
  fs.writeFileSync(path.join(extra.root, "steam_appid.txt"), "480\n");
  assert.throws(() => Consumer.requirement(extra.entry, extra.options), { code: "JAVA_STEAM_API_UNQUALIFIED" });
  const missing = fixture(t);
  assert.throws(() => Consumer.requirement(missing.entry, missing.options), { code: "JAVA_STEAM_APP_ID_UNKNOWN" });
});

test("Java Steam caches source facts and invalidates them when dependency or ID metadata changes", t => {
  const source = fixture(t, { appId: 480 });
  const first = Consumer.inspect(source.entry, source.options);
  const open = fs.openSync;
  let opened = 0;
  fs.openSync = function (...args) { opened++; return Reflect.apply(open, this, args); };
  try { assert.equal(Consumer.inspect(source.entry, source.options), first); assert.equal(opened, 0); }
  finally { fs.openSync = open; }
  fs.writeFileSync(path.join(source.root, "steam_appid.txt"), "480\n");
  const refreshed = Consumer.inspect(source.entry, source.options);
  assert.notEqual(refreshed, first);
  assert.equal(refreshed.appId.evidence.length, 2);
});

test("Java warm facts retain dependency and missing metadata observations for the host cache", async t => {
  const source = fixture(t, { appId: 480, classpath: "wrapper.jar", noWrapper: true });
  fs.writeFileSync(path.join(source.root, "wrapper.jar"), jar([[source.wrapperName, source.wrapper]]));
  Consumer.inspect(source.entry, source.options);
  const root = fs.realpathSync(source.root), Observations = require("../src/core/file-observations");
  const recorded = await Observations.recordReads({ roots: [root] }, () => Consumer.inspect(source.entry, source.options));
  const paths = new Set(recorded.files.map(([file]) => file));
  assert.equal(recorded.cacheable, true);
  assert.ok(paths.has(path.join(root, "wrapper.jar")));
  assert.ok(paths.has(path.join(root, "steam_appid.txt")));
  assert.ok(paths.has(path.join(root, "steam_settings/configs.app.ini")));
});

test("Java Steam handles a bounded local manifest classpath and rejects escape, duplicate and missing dependencies", t => {
  const source = fixture(t, { appId: 480, classpath: "libs/wrapper.jar", noWrapper: true });
  fs.mkdirSync(path.join(source.root, "libs"));
  fs.writeFileSync(path.join(source.root, "libs/wrapper.jar"), jar([[source.wrapperName, source.wrapper]]));
  assert.equal(Consumer.requirement(source.entry, source.options).pin.version, "1.9.0");
  fs.rmSync(path.join(source.root, "libs/wrapper.jar"));
  assert.throws(() => Consumer.requirement(source.entry, source.options), { code: "JAVA_STEAM_INSPECTION_INCOMPLETE" });
  fs.writeFileSync(path.join(source.root, "libs/wrapper.jar"), jar([[source.wrapperName, source.wrapper]]));
  assert.equal(Consumer.requirement(source.entry, source.options).pin.version, "1.9.0");
  const escaped = fixture(t, { appId: 480, classpath: "../wrapper.jar" });
  assert.throws(() => Consumer.requirement(escaped.entry, escaped.options), { code: "JAVA_STEAM_INSPECTION_INCOMPLETE" });
  const duplicate = fixture(t, { appId: 480 });
  fs.writeFileSync(duplicate.jarPath, jar([...duplicate.entries, ["Game.class", javaClass()]]));
  assert.throws(() => Consumer.inspectArchives(duplicate.jarPath, duplicate.root, duplicate.options), { code: "JAVA_STEAM_ARCHIVE_INVALID" });
});

test("Java Steam class parser refuses truncated instructions and fabricated oversized entries", t => {
  const source = fixture(t);
  assert.throws(() => Classes.inspectClass(javaClass().subarray(0, -3)), { code: "JAVA_STEAM_CLASS_INVALID" });
  const original = Consumer.readArchive(source.jarPath).entries[0];
  const fd = fs.openSync(source.jarPath, "r");
  try { assert.throws(() => Consumer.readEntry(fd, { ...original, uncompressedSize: Consumer.LIMITS.totalBytes + 1 }, 64 * 1024, { bytes: 0 }), { code: "JAVA_STEAM_PROBE_LIMIT" }); }
  finally { fs.closeSync(fd); }
});

test("Java JNI layout shares one native bridge, isolates game paths and verifies warm aliases", t => {
  const source = fixture(t, { calls: false });
  const libraryPath = path.join(source.root, "jni.dylib"), helper = path.join(source.root, "api.dylib");
  fs.writeFileSync(libraryPath, "reviewed JNI"); fs.writeFileSync(helper, "reviewed Steam API");
  const bridge = { bridgeVersion: "exact-jni", jniSha256: digest(fs.readFileSync(libraryPath)), libraryPath };
  const steam = { libraryPath: helper, sha256: digest(fs.readFileSync(helper)) };
  const one = Runtime.prepareNativeLayout(path.join(source.root, "one"), bridge, steam);
  const two = Runtime.prepareNativeLayout(path.join(source.root, "two"), bridge, steam);
  assert.notEqual(one, two);
  assert.equal(fs.statSync(one).ino, fs.statSync(libraryPath).ino);
  assert.equal(fs.statSync(two).ino, fs.statSync(libraryPath).ino);
  assert.equal(Runtime.prepareNativeLayout(path.join(source.root, "one"), bridge, steam), one);
  fs.unlinkSync(path.join(path.dirname(one), "libsteam_api.dylib"));
  fs.symlinkSync(libraryPath, path.join(path.dirname(one), "libsteam_api.dylib"));
  assert.throws(() => Runtime.prepareNativeLayout(path.join(source.root, "one"), bridge, steam), { code: "JAVA_STEAM_LAYOUT_CHANGED" });
});

test("Java selects the successor helper profile while retaining the exact JNI bridge ABI", async t => {
  const source = fixture(t, { appId: 480 }), resourcesRoot = path.join(source.root, "resources"), pin = { ...source.pin };
  const directory = path.join(resourcesRoot, "native-runtimes/java-steamworks", pin.bridgeVersion, "x64");
  fs.mkdirSync(directory, { recursive: true });
  const native = Buffer.alloc(32); native.writeUInt32LE(0xfeedfacf); native.writeUInt32LE(0x01000007, 4); native.writeUInt32LE(6, 12);
  const agent = Buffer.from("fixture loader agent");
  pin.jniSha256 = digest(native); pin.jniSize = native.length; pin.agentSha256 = digest(agent);
  fs.writeFileSync(path.join(directory, "libsteamworks4j.dylib"), native);
  fs.writeFileSync(path.join(directory, "steam-agent.jar"), agent);
  const record = { id: "java-steamworks", version: pin.bridgeVersion, wrapperVersion: pin.version,
    sourceRevision: pin.sourceRevision, librarySha256: pin.jniSha256, abiProfile: pin.abiProfile,
    agentSha256: pin.agentSha256, agentClassMajor: 52,
    files: [{ path: "libsteamworks4j.dylib", size: native.length, sha256: pin.jniSha256, mode: 0o644 },
      { path: "steam-agent.jar", size: agent.length, sha256: pin.agentSha256, mode: 0o644 }] };
  const seal = () => { const bytes = Buffer.from(JSON.stringify(record)); fs.writeFileSync(path.join(directory, "helper.json"), bytes); pin.manifestSha256 = digest(bytes); };
  seal();
  t.mock.method(Consumer, "requirement", () => ({ pin, evidence: { appId: { value: 480 }, gameRoot: source.root } }));
  const helper = path.join(source.root, "api.dylib"); fs.writeFileSync(helper, "independent API fixture");
  let request, calls = 0;
  const context = { resourcesRoot, userDataDir: path.join(source.root, "data"), prepareSteamApi: async value => {
    request = value; calls++; return { mode: "offline", abiProfile: value.abiProfile, version: value.version,
      libraryPath: helper, sha256: digest(fs.readFileSync(helper)), environment: {} };
  } };
  const original = digest(fs.readFileSync(source.jarPath));
  const result = await Runtime.prepareLaunch(source.entry, context, { variant: "x64" }, {});
  assert.equal(request.abiProfile, pin.helperAbiProfile); assert.equal(request.version, pin.helperVersion);
  assert.equal(result.bridge.abiProfile, pin.abiProfile); assert.notEqual(request.abiProfile, result.bridge.abiProfile);
  assert.equal(digest(fs.readFileSync(source.jarPath)), original);
  record.abiProfile = pin.helperAbiProfile; seal();
  await assert.rejects(Runtime.prepareLaunch(source.entry, context, { variant: "x64" }, {}), { code: "JAVA_STEAM_BUNDLE_CHANGED" });
  assert.equal(calls, 1);
});

test("Java JNI cross-volume or protected-source fallback copies only the small native bridge", t => {
  const source = fixture(t, { calls: false }), libraryPath = path.join(source.root, "jni.dylib"), helper = path.join(source.root, "api.dylib");
  fs.writeFileSync(libraryPath, "reviewed JNI"); fs.writeFileSync(helper, "reviewed Steam API");
  const bridge = { bridgeVersion: "exact-jni", jniSha256: digest(fs.readFileSync(libraryPath)), libraryPath };
  const steam = { libraryPath: helper, sha256: digest(fs.readFileSync(helper)) };
  let copies = 0;
  const jni = Runtime.prepareNativeLayout(path.join(source.root, "native-only"), bridge, steam, {
    linkSync: () => { throw Object.assign(new Error("another volume"), { code: "EXDEV" }); },
    copyFileSync: (...args) => { copies++; assert.equal(args[0], libraryPath); return fs.copyFileSync(...args); }
  });
  assert.equal(copies, 1);
  assert.notEqual(fs.statSync(jni).ino, fs.statSync(libraryPath).ino);
  assert.equal(digest(fs.readFileSync(jni)), bridge.jniSha256);
  assert.deepEqual(fs.readdirSync(path.dirname(jni)).sort(), ["libsteam_api.dylib", "libsteamworks4j.dylib"]);
});

test("Java Steam loader configuration is immutable per launch identity and refuses foreign paths", t => {
  const source = fixture(t), userDataDir = path.join(source.root, "userData");
  const directory = Runtime.ownedDirectory(userDataDir, path.join(userDataDir, "games/one/runtimes/java"));
  const bridge = { version: "1.9.0" }, steam = { libraryPath: "/bundled/API.dylib" }, jni = "/game/JNI.dylib";
  const one = Runtime.writeConfiguration(directory, bridge, steam, jni, "x64");
  const two = Runtime.writeConfiguration(directory, bridge, steam, jni, "arm64");
  assert.notEqual(one, two);
  assert.equal(Runtime.writeConfiguration(directory, bridge, steam, jni, "x64"), one);
  assert.equal(fs.statSync(one).mode & 0o777, 0o600);
  assert.throws(() => Runtime.ownedDirectory(userDataDir, source.root), { code: "JAVA_STEAM_STATE_INVALID" });
  fs.mkdirSync(path.join(userDataDir, "games/linked"));
  fs.symlinkSync(source.root, path.join(userDataDir, "games/linked/escape"));
  assert.throws(() => Runtime.ownedDirectory(userDataDir, path.join(userDataDir, "games/linked/escape")), { code: "JAVA_STEAM_STATE_INVALID" });
  fs.writeFileSync(one, "other");
  assert.throws(() => Runtime.writeConfiguration(directory, bridge, steam, jni, "x64"), { code: "JAVA_STEAM_CONFIGURATION_CHANGED" });
});

test("Java exact runtime choices and required JNI CPU do not fall back to another installed JRE", t => {
  const source = fixture(t, { calls: false }), userDataDir = path.join(source.root, "userData");
  function install(version, variant) { const file = path.join(userDataDir, "runtimes/java/17", version, variant, "bin/java"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ""); }
  install("17.0.20.1+1", "arm64"); install("17.0.19+7", "x64");
  assert.equal(Java.__test.resolveInstalledRuntime({ userDataDir, line: 17, runtimeData: { version: "17.0.18+1" }, lineConfig: { defaultVersion: "17.0.19+7", defaultVariant: "x64" } }), null);
  assert.equal(JavaCore.resolveBestInstalled({ userDataDir, line: 17, version: "17.0.20.1+1", variant: "x64", hostArch: "arm64", strictVariant: true }), null);
  assert.equal(JavaCore.resolveBestInstalled({ userDataDir, line: 17, version: "17.0.20.1+1", variant: "x64", hostArch: "arm64" }).variant, "arm64");
  const original = Consumer.requirement;
  Consumer.requirement = () => ({ pin: Runtime.Catalog.find(pin => pin.version === "1.9.0") });
  try {
    assert.equal(Runtime.requiredVariant(source.entry, { hostArch: "arm64", preferredVariant: "arm64" }), "x64");
    assert.throws(() => Runtime.requiredVariant(source.entry, { hostArch: "arm64", explicitVariant: "arm64" }), { code: "JAVA_STEAM_CPU_MISMATCH" });
  } finally { Consumer.requirement = original; }
  const catalog = { versions: ["17.0.20.1+1"], entriesByVersion: { "17.0.20.1+1": { arm64: { version: "17.0.20.1+1" } } } };
  assert.equal(JavaCore.selectCatalogAsset({ lineCatalog: catalog, variant: "x64", hostArch: "arm64", strictVariant: true }), null);
});

test("Java Play requests the exact missing Intel JVM for a legacy bridge without changing global defaults", async t => {
  const source = fixture(t), userDataDir = path.join(source.root, "userData");
  const version = "17.0.20.1+1", arm = path.join(userDataDir, "runtimes/java/17", version, "arm64/bin/java");
  fs.mkdirSync(path.dirname(arm), { recursive: true }); fs.writeFileSync(arm, "");
  source.entry.runtimeData.java = { line: 17, version };
  const settings = { runtimes: { java: { defaultLine: 17, lines: { 17: { defaultVersion: version, defaultVariant: "arm64" } } } } };
  const before = JSON.stringify(settings), original = Consumer.requirement;
  Consumer.requirement = () => ({ pin: Runtime.Catalog.find(pin => pin.version === "1.9.0") });
  try {
    const plan = await Java.ensureRuntime(source.entry, { userDataDir, settings, runtimeId: "java" });
    assert.deepEqual(plan, { managerId: "java", version, installOptions: { sectionId: "17", line: 17, variant: "x64", strictVariant: true, preserveDefaults: true } });
    const manager = require("../src/modules/java/runtime/java-runtime-manager");
    assert.equal(manager.updateSettingsAfterInstall(settings.runtimes.java,
      { line: 17, version, variant: "x64" }, plan.installOptions), settings.runtimes.java);
    assert.equal(JSON.stringify(settings), before);
  } finally { Consumer.requirement = original; }
});

test("Java native Steam launch keeps the original JAR, application arguments, per-game config and runtime lease", async t => {
  const source = fixture(t), userDataDir = path.join(source.root, "userData"), version = "17.0.20.1+1";
  const installDir = path.join(userDataDir, "runtimes/java/17", version, "x64"), javaPath = path.join(installDir, "bin/java");
  fs.mkdirSync(path.dirname(javaPath), { recursive: true }); fs.writeFileSync(javaPath, "");
  source.entry.runtimeData.java = { line: 17, version };
  const requirement = Consumer.requirement, prepare = Runtime.prepareLaunch, rosetta = JavaCore.isRosettaAvailable;
  const prepared = [], launches = [], leases = [];
  const environment = { SteamAppId: "480", GseSavePath: path.join(userDataDir, "games/java-one/steam"), DYLD_INSERT_LIBRARIES: "/other/helper.dylib" };
  Consumer.requirement = () => ({ pin: Runtime.Catalog.find(pin => pin.version === "1.9.0") });
  Runtime.prepareLaunch = async (entry, _context, install) => { prepared.push({ entry, install }); return { vmArgs: ["-javaagent:/included/agent.jar=/game/loader.properties"], environment }; };
  JavaCore.isRosettaAvailable = () => true;
  try {
    const before = digest(fs.readFileSync(source.jarPath));
    await Java.launchRuntime("java", source.entry, { userDataDir, settings: { runtimes: { java: {} } },
      runtimeSettings: { vmArgs: ["-Xmx1g"], appArgs: ["--seed=42"] },
      useRuntime: async identity => leases.push(identity), spawnDetachedChecked: async (...args) => { launches.push(args); return { pid: 42 }; } });
    assert.equal(prepared[0].install.variant, "x64");
    assert.deepEqual(launches[0].slice(0, 3), [javaPath, ["-javaagent:/included/agent.jar=/game/loader.properties", "-Xmx1g", "-jar", source.jarPath, "--seed=42"], { cwd: source.root, env: environment }]);
    assert.deepEqual(leases, [{ managerId: "java", version, sectionId: "17", variant: "x64", sourcePath: installDir }]);
    assert.equal(digest(fs.readFileSync(source.jarPath)), before);
  } finally { Consumer.requirement = requirement; Runtime.prepareLaunch = prepare; JavaCore.isRosettaAvailable = rosetta; }
});
