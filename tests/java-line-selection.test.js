const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { build } = require("vite");
const { writeZipArchive } = require("./helpers/zip-fixture");
const Java = require("../src/modules/java/main");
const Detect = require("../src/modules/java/detect");
const Manager = require("../src/modules/java/runtime/java-runtime-manager");
const JavaCore = Manager.core.java;
const { createLauncher } = require("../src/core/launcher");

let GameDetails, RuntimesView;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(__dirname, "runtime-tabs-components.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, "java-line-components.cjs"), module);
  compiled.paths = module.paths;
  compiled._compile(bundle.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  ({ GameDetails, RuntimesView } = compiled.exports);
});

function fixture(t, minimumJava = 25) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-java-lines-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "data"), jarPath = path.join(root, "Game.jar");
  const bytecode = Buffer.alloc(8);
  bytecode.writeUInt32BE(0xcafebabe); bytecode.writeUInt16BE(minimumJava + 44, 6);
  writeZipArchive(jarPath, [
    { name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\nMain-Class: example.Main\n" },
    { name: "example/Main.class", data: bytecode }
  ]);
  return { root, userDataDir, jarPath, variant: process.arch === "arm64" ? "arm64" : "x64" };
}

function install(userDataDir, line, version, variant) {
  const directory = path.join(userDataDir, "runtimes", "java", String(line), version, variant);
  const javaPath = path.join(directory, "bin", "java");
  fs.mkdirSync(path.dirname(javaPath), { recursive: true });
  fs.writeFileSync(javaPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return javaPath;
}

function forbidNetwork(t) {
  t.mock.method(Manager, "refreshCatalog", () => assert.fail("Installed JVM selection must stay offline"));
  t.mock.method(JavaCore, "fetchAvailableVersionsForLine", () => assert.fail("Installed JVM selection must stay offline"));
  t.mock.method(Manager, "installRuntime", () => assert.fail("Installed JVM selection must not download"));
}

test("Java honors a genuine global patch choice without rewriting the game", async t => {
  const { userDataDir, jarPath, variant } = fixture(t, 8), launches = [];
  const java8 = install(userDataDir, 8, "8.0.504+1", variant);
  install(userDataDir, 8, "8.0.502+1", variant);
  install(userDataDir, 21, "21.0.12.1+1", variant);
  const before = fs.readFileSync(jarPath);
  const settings = { runtimes: { java: { defaultLine: 8, lines: { 8: { defaultVersion: "8.0.504+1", defaultVariant: "x64" } } } } };
  const entry = { gameId: "minimum-eight", runtimeId: "java", gamePath: jarPath, contentRootDir: path.dirname(jarPath),
    moduleData: { jarPath, requiredJava: 8, runtimeLine: 8 }, runtimeData: {} };
  const context = { userDataDir, settings, runtimeSettings: { appArgs: ["--seed=42"] }, gameArguments: ["literal value", ""],
    spawnDetachedChecked(command, args, options) { launches.push({ command, args, options }); return { pid: 42 }; } };
  forbidNetwork(t);
  const status = Java.actions.runtimeStatus(entry, {}, context);
  assert.equal(status.requiredLine, 8); assert.equal(status.requestedLine, 8);
  assert.equal(status.resolvedVersion, "8.0.504+1"); assert.equal(status.resolvedVariant, variant);
  assert.equal(await Java.ensureRuntime(entry, context), null);
  await Java.launchRuntime("java", entry, context);
  assert.equal(launches[0].command, java8);
  assert.deepEqual(launches[0].args, ["-jar", jarPath, "--seed=42", "literal value", ""]);
  assert.equal(launches[0].options.cwd, path.dirname(jarPath));
  assert.deepEqual(fs.readFileSync(jarPath), before);
  assert.deepEqual(entry.runtimeData, {});
});

test("Java inspector and Play preserve exact global and game choices", t => {
  const { userDataDir, jarPath, variant } = fixture(t, 8);
  for (const line of [8, 17, 21, 25]) install(userDataDir, line, `${line}.0.4+1`, variant);
  const manifest = require("../src/modules/java/manifest.json");
  const base = { gameId: "java-auto-minimum", name: "Game", moduleId: "java", runtimeId: "java", gamePath: jarPath,
    moduleRuntimeSupport: ["java"], moduleSupports: manifest.supports, moduleData: { jarPath, runtimeLine: 8, requiredJava: 8 }, runtimeData: {} };
  // The detected line precedes the global default; a manual line or patch precedes both.
  for (const [defaultLine, minimum, selected, runtimeData] of [[21, 8, 8, {}], [17, 8, 8, {}], [21, 25, 25, {}],
    [21, 8, 8, { line: 8, version: "8.0.4+1" }], [21, 8, 8, { version: "8.0.4+1" }],
    [21, 25, 8, { version: "8.0.4+1" }], [21, 8, 8, { version: "9.0.4+1" }]]) {
    const settings = { runtimes: { java: { defaultLine } } };
    const entry = { ...base, moduleData: { ...base.moduleData, runtimeLine: minimum, requiredJava: minimum }, runtimeData: { java: runtimeData } };
    const state = { modules: [manifest], moduleStates: {}, running: {}, runtimeManagers: {
      java: { id: Manager.id, label: Manager.label, ...Manager.getState({ settings: settings.runtimes.java, userDataDir }) }
    } };
    assert.equal(Java.actions.runtimeStatus(entry, {}, { userDataDir, settings }).requestedLine, selected);
    const markup = renderToStaticMarkup(React.createElement(GameDetails, { g: entry, state, moduleInfo: manifest,
      actions: {}, cheatsStatus: null, libsStatus: null, runtimeStatusEntry: null, cheatsPatchBusy: false, libsPatchBusy: false,
      moduleActionResults: {}, moduleActionBusy: {}, moduleActionError: null }));
    const lines = markup.match(/<select aria-label="Line"[^>]*>(.*?)<\/select>/)[1];
    const autoLine = !runtimeData.line && runtimeData.version && JavaCore.LTS_LINES.includes(Number(runtimeData.version.split(".")[0]))
      ? Number(runtimeData.version.split(".")[0]) : minimum;
    assert.match(lines, new RegExp(`Automatic \\(Java ${autoLine}\\)`));
    const versions = markup.match(/<select aria-label="Java version"[^>]*>(.*?)<\/select>/)[1];
    assert.match(versions, new RegExp(`value="${selected}\\.0\\.4\\+1"`));
    for (const other of [8, 17, 21, 25].filter(value => value !== selected))
      assert.doesNotMatch(versions, new RegExp(`value="${other}\\.0\\.4\\+1"`));
  }
});

test("a version-only Java choice remains exact when the detected recommendation changes", async t => {
  const { userDataDir, jarPath, variant } = fixture(t, 8);
  install(userDataDir, 8, "8.0.4+1", variant); install(userDataDir, 21, "21.0.4+1", variant);
  const settings = { runtimes: { java: { defaultLine: 21 } } };
  const entry = { gamePath: jarPath, moduleData: { jarPath, runtimeLine: 8, requiredJava: 8 },
    runtimeData: { java: { version: "8.0.3+1", variant } } };
  const context = { userDataDir, settings };
  forbidNetwork(t);
  const pinned = Java.actions.runtimeStatus(entry, {}, context);
  assert.equal(pinned.requestedLine, 8); assert.equal(pinned.ready, false);
  const plan = await Java.ensureRuntime(entry, context);
  assert.equal(plan.version, "8.0.3+1"); assert.equal(plan.installOptions.line, 8);
  entry.moduleData.runtimeLine = 21; entry.moduleData.requiredJava = 21;
  const advanced = Java.actions.runtimeStatus(entry, {}, context);
  assert.equal(advanced.requestedLine, 8); assert.equal(advanced.ready, false);
  assert.equal((await Java.ensureRuntime(entry, context)).version, "8.0.3+1");
});

const X86_64 = 0x01000007, ARM64 = 0x0100000c;

function classBytes(minimumJava, ...references) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(0xcafebabe); header.writeUInt16BE(minimumJava + 44, 6);
  return Buffer.concat([header, Buffer.from(references.join("\0"), "latin1")]);
}

function machO(...cpus) {
  if (cpus.length === 1) {
    const thin = Buffer.alloc(32);
    thin.writeUInt32LE(0xfeedfacf); thin.writeUInt32LE(cpus[0], 4);
    return thin;
  }
  const fat = Buffer.alloc(8 + cpus.length * 20);
  fat.writeUInt32BE(0xcafebabe); fat.writeUInt32BE(cpus.length, 4);
  cpus.forEach((cpu, index) => fat.writeUInt32BE(cpu, 8 + index * 20));
  return fat;
}

test("Automatic runs Java 8 bytecode on Java 21 unless the JAR depends on the Java 8 platform", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-java-automatic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = (minimumJava, ...references) => ({ name: "example/Main.class", data: classBytes(minimumJava, ...references), deflate: true });
  const detect = (name, entries, { classPath = "", libraries = {}, files = {} } = {}) => {
    const directory = path.join(root, name), jarPath = path.join(directory, "Game.jar");
    fs.mkdirSync(directory, { recursive: true });
    for (const [file, libraryEntries] of Object.entries(libraries)) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      writeZipArchive(path.join(directory, file), libraryEntries);
    }
    for (const [file, data] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      fs.writeFileSync(path.join(directory, file), data);
    }
    writeZipArchive(jarPath, [{ name: "META-INF/MANIFEST.MF",
      data: `Manifest-Version: 1.0\nMain-Class: example.Main\n${classPath ? `Class-Path: ${classPath}\n` : ""}` }, ...entries]);
    const { minimumLine, runtimeLine, java8Dependencies } = Detect.detectGame({ inputPath: jarPath, stat: fs.statSync(jarPath) }).moduleData;
    return { minimumLine, runtimeLine, java8Dependencies };
  };
  const java21 = { minimumLine: 8, runtimeLine: 21, java8Dependencies: [] };
  const java8 = dependency => ({ minimumLine: 8, runtimeLine: 8, java8Dependencies: [dependency] });

  // A guarded sun.* lookup (as in bundled logging libraries) is not a Java 8 dependency.
  assert.deepEqual(detect("plain", [main(8, "java/lang/Object", "sun/reflect/Reflection")]), java21);
  assert.deepEqual(detect("jaxb", [main(8, "javax/xml/bind/JAXBContext")]), java8("javax.xml.bind"));
  assert.deepEqual(detect("bundled jaxb", [main(8, "javax/xml/bind/JAXBContext"),
    { name: "javax/xml/bind/JAXBContext.class", data: classBytes(8) }]), java21);
  assert.deepEqual(detect("script", [main(8, "javax/script/ScriptEngineManager")]), java8("javax.script engine"));
  assert.deepEqual(detect("bundled script", [main(8, "javax/script/ScriptEngineManager"),
    { name: "META-INF/services/javax.script.ScriptEngineFactory", data: "org.example.Engine\n" }]), java21);
  assert.deepEqual(detect("system loader cast", [main(8, "java/lang/ClassLoader", "getSystemClassLoader", "java/net/URLClassLoader", "addURL")]),
    java8("system class loader as URLClassLoader"));
  // The system loader call and a URLClassLoader in separate classes do not indicate a cast.
  assert.deepEqual(detect("own loader", [main(8, "getSystemClassLoader"),
    { name: "example/Plugins.class", data: classBytes(8, "java/net/URLClassLoader", "<init>") }]), java21);
  assert.deepEqual(detect("class path", [main(8)], { classPath: "lib/Old%20Library.jar",
    libraries: { "lib/Old Library.jar": [{ name: "old/Dock.class", data: classBytes(6, "com/apple/eawt/Application"), deflate: true }] } }),
  java8("com.apple.eawt"));
  assert.deepEqual(detect("intel natives", [main(8), { name: "libgame.dylib", data: machO(X86_64) }]),
    java8("macOS native libraries without arm64"));
  assert.deepEqual(detect("universal natives", [main(8), { name: "libgame.dylib", data: machO(X86_64, ARM64) }]), java21);
  assert.deepEqual(detect("folder natives", [main(8)], { files: { "lib/natives/macosx/liblwjgl.dylib": machO(X86_64) } }),
    java8("macOS native libraries without arm64"));
  // Newer bytecode keeps its lowest compatible line.
  assert.deepEqual(detect("eleven", [main(11, "javax/xml/bind/JAXBContext")]),
    { minimumLine: 11, runtimeLine: 11, java8Dependencies: ["javax.xml.bind"] });
});

test("Automatic Java 8 bytecode in a folder with a space launches installed Java 21 offline and keeps explicit choices exact", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-java-automatic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const variant = process.arch === "arm64" ? "arm64" : "x64", userDataDir = path.join(root, "data");
  const jarPath = path.join(root, "Game Folder", "game.jar"), launches = [];
  fs.mkdirSync(path.dirname(jarPath));
  writeZipArchive(jarPath, [{ name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\nMain-Class: example.Main\n" },
    { name: "example/Main.class", data: classBytes(8, "java/nio/file/FileSystems"), deflate: true }]);
  const java8 = install(userDataDir, 8, "8.0.504+1", variant), java21 = install(userDataDir, 21, "21.0.12.1+1", variant);
  const detected = Detect.detectGame({ inputPath: jarPath, stat: fs.statSync(jarPath) });
  const manifest = require("../src/modules/java/manifest.json");
  // Installing from Runtimes sets each line's default patch.
  const java = { lines: { 8: { defaultVersion: "8.0.504+1" }, 21: { defaultVersion: "21.0.12.1+1" } } };
  const state = { modules: [manifest], moduleStates: {}, running: {}, runtimeManagers: {
    java: { id: Manager.id, label: Manager.label, ...Manager.getState({ settings: java, userDataDir }) }
  } };
  const context = { userDataDir, settings: { runtimes: { java } },
    spawnDetachedChecked(command, args, options) { launches.push({ command, args, options }); return { pid: 42 }; } };
  forbidNetwork(t);
  const gameEntry = runtimeData => ({ gameId: "java-automatic", name: "Game", moduleId: "java", runtimeId: "java", gamePath: jarPath,
    contentRootDir: path.dirname(jarPath), moduleRuntimeSupport: ["java"], moduleSupports: manifest.supports,
    moduleData: detected.moduleData, runtimeData: { java: runtimeData } });
  // The committed fallback reuses an installed compatible patch when no line default is set.
  const unset = await Java.ensureRuntime(gameEntry({}), { ...context, settings: {} });
  assert.equal(unset, null);
  assert.equal(Java.actions.runtimeStatus(gameEntry({}), {}, { ...context, settings: {} }).resolvedVersion, "21.0.12.1+1");
  const play = async runtimeData => {
    const entry = gameEntry(runtimeData);
    const status = Java.actions.runtimeStatus(entry, {}, context);
    assert.equal(await Java.ensureRuntime(entry, context), null);
    await Java.launchRuntime("java", entry, context);
    const markup = renderToStaticMarkup(React.createElement(GameDetails, { g: entry, state, moduleInfo: manifest,
      actions: {}, cheatsStatus: null, libsStatus: null, runtimeStatusEntry: null, cheatsPatchBusy: false, libsPatchBusy: false,
      moduleActionResults: {}, moduleActionBusy: {}, moduleActionError: null }));
    return { status, command: launches.at(-1).command, lines: markup.match(/<select aria-label="Line"[^>]*>(.*?)<\/select>/)[1],
      versions: markup.match(/<select aria-label="Java version"[^>]*>(.*?)<\/select>/)[1] };
  };

  const automatic = await play({});
  assert.equal(automatic.status.requiredLine, 8); assert.equal(automatic.status.requestedLine, 21);
  assert.equal(automatic.status.resolvedVersion, "21.0.12.1+1"); assert.equal(automatic.command, java21);
  assert.match(automatic.lines, /Automatic \(Java 21\)/);
  assert.match(automatic.versions, /value="21\.0\.12\.1\+1"/); assert.doesNotMatch(automatic.versions, /8\.0\.504\+1/);
  for (const runtimeData of [{ line: 8 }, { version: "8.0.504+1" }]) {
    const chosen = await play(runtimeData);
    assert.equal(chosen.status.requestedLine, 8); assert.equal(chosen.status.resolvedVersion, "8.0.504+1");
    assert.equal(chosen.command, java8);
    assert.match(chosen.versions, /value="8\.0\.504\+1"/); assert.doesNotMatch(chosen.versions, /21\.0\.12\.1\+1/);
  }
  assert.deepEqual(launches.map(launch => launch.args[1]), [jarPath, jarPath, jarPath]);
});

test("explicit Java 17 overrides detected Java 25 while Java 25 and Auto reuse their own installed JVM offline", async t => {
  const { userDataDir, jarPath, variant } = fixture(t), launches = [];
  const java17 = install(userDataDir, 17, "17.0.4+1", variant);
  const java21 = install(userDataDir, 21, "21.0.12+7", variant);
  const java25 = install(userDataDir, 25, "25.0.4.1+1", variant), before = fs.readFileSync(jarPath);
  const settingsPath = path.join(userDataDir, "settings.json");
  const settings = { runtimes: { java: { defaultLine: 25, lines: {
    21: { defaultVersion: "21.0.12+7", defaultVariant: variant },
    25: { defaultVersion: "25.0.4.1+1", defaultVariant: variant }
  } } } };
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  const settingsBytes = fs.readFileSync(settingsPath);
  const core = createLauncher({ userDataDir, logger: { info() {} },
    confirmRuntimeInstall: () => assert.fail("The selected installed Java line needs no download consent"),
    rosetta: { requiresForExecutable: () => false },
    spawn(command, args, options) {
      launches.push({ command, args, options });
      const child = Object.assign(new EventEmitter(), { pid: process.pid, exitCode: null, signalCode: null,
        stdout: new EventEmitter(), stderr: new EventEmitter(), unref() {} });
      process.nextTick(() => child.emit("spawn"));
      t.after(() => { child.exitCode = 0; child.emit("exit", 0); child.emit("close", 0); });
      return child;
    }
  });
  forbidNetwork(t);
  const entry = await core.resolveEntry(jarPath);
  entry.networkAccess = true; // This control observes argv, not native network isolation.
  assert.equal(entry.moduleId, "java"); assert.equal(entry.moduleData.runtimeLine, 25);
  const selections = [
    { data: { line: 17, version: "17.0.4+1" }, line: 17, version: "17.0.4+1", javaPath: java17 },
    { data: { line: 25, version: "17.0.4+1" }, line: 25, version: "25.0.4.1+1", javaPath: java25 },
    { data: { line: null, version: "21.0.12+7" }, line: 21, version: "21.0.12+7", javaPath: java21 }
  ];
  for (const selected of selections) {
    entry.runtimeData.java = selected.data;
    core.persistEntry(entry);
    const status = Java.actions.runtimeStatus(entry, {}, core.getLaunchContext(entry));
    assert.equal(status.ready, true); assert.equal(status.requestedLine, selected.line);
    assert.equal(status.requiredLine, 25); assert.equal(status.resolvedVersion, selected.version);
    const result = await core.launchEntry(entry);
    assert.equal(result.kind, "process"); assert.equal(result.runtimeId, "java");
    assert.equal(launches.at(-1).command, selected.javaPath);
    assert.deepEqual(launches.at(-1).args, ["-jar", jarPath]);
    result.child.exitCode = 0; result.child.emit("exit", 0); result.child.emit("close", 0);
  }
  assert.equal(launches.length, selections.length);
  assert.deepEqual(fs.readFileSync(jarPath), before);
  assert.deepEqual(fs.readFileSync(settingsPath), settingsBytes);
});

test("each explicit Java line uses its own installed versions despite Java 25 detection and global default", async t => {
  const { userDataDir, jarPath, variant } = fixture(t), before = fs.readFileSync(jarPath);
  const settings = { runtimes: { java: { defaultLine: 25 } } };
  forbidNetwork(t);
  for (const line of JavaCore.LTS_LINES) {
    const version = `${line}.0.4+1`, javaPath = install(userDataDir, line, version, variant);
    const entry = { runtimeId: "java", gamePath: jarPath, moduleData: { jarPath, runtimeLine: 25, requiredJava: 25 },
      runtimeData: { java: { line: String(line), version, variant } } };
    const context = { userDataDir, settings, runtimeId: "java", runtimeSettings: {},
      spawnDetachedChecked(command) { assert.equal(command, javaPath); return { pid: 1234 }; } };
    const status = Java.actions.runtimeStatus(entry, {}, context);
    assert.equal(status.ready, true); assert.equal(status.requestedLine, line);
    assert.equal(status.resolvedVersion, version);
    assert.equal(await Java.ensureRuntime(entry, context), null);
    await Java.launchRuntime("java", entry, context);
  }
  const state = Manager.getState({ settings: settings.runtimes.java, userDataDir });
  for (const line of JavaCore.LTS_LINES) {
    assert.deepEqual(state.lines[line].installed.map(row => row.version), [`${line}.0.4+1`]);
    assert.deepEqual(state.lines[line].catalog.versions, []);
  }
  assert.deepEqual(fs.readFileSync(jarPath), before);
});

test("a missing preferred Java 25 patch stays exact instead of substituting another installed patch", async t => {
  const { userDataDir, jarPath, variant } = fixture(t);
  install(userDataDir, 25, "25.0.4.1+1", variant);
  const entry = { runtimeId: "java", gamePath: jarPath, moduleData: { jarPath, runtimeLine: 25, requiredJava: 25 }, runtimeData: {} };
  const context = { userDataDir, settings: { runtimes: { java: { lines: {
    25: { defaultVersion: "25.0.99+1", defaultVariant: variant }
  } } } } };
  forbidNetwork(t);
  assert.equal(Java.actions.runtimeStatus(entry, {}, context).ready, false);
  assert.equal((await Java.ensureRuntime(entry, context)).version, "25.0.99+1");
  entry.runtimeData.java = { version: "25.0.4.1+1" };
  assert.equal(await Java.ensureRuntime(entry, context), null);
});

test("an exact per-game patch on the effective Java line remains exact", async t => {
  const { userDataDir, jarPath, variant } = fixture(t);
  install(userDataDir, 25, "25.0.4.1+1", variant);
  const entry = { runtimeId: "java", gamePath: jarPath, moduleData: { jarPath, runtimeLine: 25, requiredJava: 25 },
    runtimeData: { java: { line: 25, version: "25.0.3+9", variant } } };
  const context = { userDataDir, settings: {} };
  forbidNetwork(t);
  assert.equal(Java.actions.runtimeStatus(entry, {}, context).ready, false);
  const plan = await Java.ensureRuntime(entry, context);
  assert.equal(plan.version, "25.0.3+9"); assert.equal(plan.installOptions.line, 25);
});

test("Java install action reuses the current line offline despite stale status and cross-line patches", async t => {
  const { userDataDir, jarPath, variant } = fixture(t), before = fs.readFileSync(jarPath);
  install(userDataDir, 17, "17.0.4+1", variant);
  install(userDataDir, 25, "25.0.4.1+1", variant);
  const settings = { runtimes: { java: { defaultLine: 25, lines: {
    17: { defaultVersion: "17.0.4+1", defaultVariant: variant },
    25: { defaultVersion: "25.0.4.1+1", defaultVariant: variant }
  } } } }, savedSettings = structuredClone(settings);
  forbidNetwork(t);
  const choices = [
    { data: { line: 17, version: "25.0.4.1+1" }, payload: { status: { requestedLine: 25, requiredLine: 25, resolvedVersion: "25.0.4.1+1" } }, line: 17, version: "17.0.4+1" },
    { data: { line: 25, version: "17.0.4+1" }, payload: { status: { requestedLine: 17, requiredLine: 17, resolvedVersion: "17.0.4+1" } }, line: 25, version: "25.0.4.1+1" },
    { data: { line: null, version: "17.0.4+1" }, payload: { status: { requestedLine: 17, resolvedVersion: "17.0.4+1" } }, line: 17, version: "17.0.4+1" },
    { data: { line: 25, version: "25.0.4.1+1" }, payload: { line: 17, version: "17.0.4+1", status: { requestedLine: 25, resolvedVersion: "25.0.4.1+1" } }, line: 17, version: "17.0.4+1" },
    { data: { line: 17, version: "17.0.4+1" }, payload: { line: 25, version: "17.0.4+1", status: { requestedLine: 17, resolvedVersion: "17.0.4+1" } }, line: 25, version: "25.0.4.1+1" }
  ];
  for (const choice of choices) {
    const entry = { runtimeId: "java", gamePath: jarPath, moduleData: { jarPath, runtimeLine: 25, requiredJava: 25 },
      runtimeData: { java: { ...choice.data, variant } } };
    const result = await Java.actions.installRuntime(entry, choice.payload, { userDataDir, settings });
    assert.deepEqual(result, { line: choice.line, version: choice.version, variant, alreadyInstalled: true });
    assert.deepEqual(entry.runtimeData.java, { line: choice.line, version: choice.version, variant });
  }
  assert.deepEqual(settings, savedSettings);
  assert.deepEqual(fs.readFileSync(jarPath), before);
});

test("Java install action preserves current and explicit same-line exact patches instead of stale status", async t => {
  const { userDataDir, jarPath, variant } = fixture(t);
  install(userDataDir, 17, "17.0.4+1", variant);
  t.mock.method(Manager, "refreshCatalog", () => assert.fail("An exact patch needs no catalog refresh"));
  t.mock.method(JavaCore, "fetchAvailableVersionsForLine", () => assert.fail("An exact patch needs no catalog refresh"));
  const installs = [];
  t.mock.method(Manager, "installRuntime", async options => {
    installs.push(options);
    install(userDataDir, options.line, options.version, options.variant);
    return JavaCore.resolveBestInstalled({ userDataDir, ...options });
  });
  const status = { requestedLine: 25, requiredLine: 25, resolvedVersion: "25.0.4.1+1" };
  const choices = [
    { data: { line: 17, version: "17.0.3+1" }, payload: { status }, version: "17.0.3+1" },
    { data: { line: 25, version: "25.0.4.1+1" }, payload: { line: 17, version: "17.0.2+1", status }, version: "17.0.2+1" }
  ];
  for (const choice of choices) {
    const entry = { runtimeId: "java", gamePath: jarPath, moduleData: { jarPath, runtimeLine: 25, requiredJava: 25 },
      runtimeData: { java: { ...choice.data, variant } } };
    const result = await Java.actions.installRuntime(entry, choice.payload, { userDataDir, settings: {} });
    assert.equal(result.line, 17); assert.equal(result.version, choice.version);
    assert.equal(result.alreadyInstalled, undefined);
    assert.equal(installs.at(-1).sectionId, "17"); assert.equal(installs.at(-1).line, 17);
    assert.equal(installs.at(-1).version, choice.version);
  }
  assert.equal(installs.length, 2);
});

test("Java inspector version options follow each explicit line even below the detected JAR version", t => {
  const { userDataDir, jarPath, variant } = fixture(t);
  for (const line of JavaCore.LTS_LINES) install(userDataDir, line, `${line}.0.4+1`, variant);
  for (const line of [17, 25]) install(userDataDir, line, `${line}.0.3+1`, variant);
  const manifest = require("../src/modules/java/manifest.json");
  const state = { modules: [manifest], moduleStates: {}, running: {}, runtimeManagers: {
    java: { id: Manager.id, label: Manager.label, ...Manager.getState({ settings: { defaultLine: 25 }, userDataDir }) }
  } };
  const render = (game, status = null) => renderToStaticMarkup(React.createElement(GameDetails, { g: game, state, moduleInfo: manifest,
    actions: {}, cheatsStatus: null, libsStatus: null, runtimeStatusEntry: status, cheatsPatchBusy: false, libsPatchBusy: false,
    moduleActionResults: {}, moduleActionBusy: {}, moduleActionError: null }));
  const entry = { gameId: "java-ui", name: "Game", moduleId: "java", runtimeId: "java", gamePath: jarPath,
    moduleRuntimeSupport: ["java"], moduleSupports: manifest.supports, moduleData: { runtimeLine: 25, requiredJava: 25 }, runtimeData: {} };
  for (const line of JavaCore.LTS_LINES) {
    const markup = render({ ...entry, runtimeData: { java: { line: String(line), version: `${line}.0.4+1` } } });
    const versions = markup.match(/<select aria-label="Java version"[^>]*>(.*?)<\/select>/)[1];
    assert.match(versions, new RegExp(`<option value="${line}\\.0\\.4\\+1" selected="">`));
    const lines = markup.match(/<select aria-label="Line"[^>]*>(.*?)<\/select>/)[1];
    assert.match(lines, /<option value="">Automatic \(Java 25\)<\/option>/);
    for (const other of JavaCore.LTS_LINES.filter(value => value !== line)) {
      assert.doesNotMatch(versions, new RegExp(`value="${other}\\.0\\.4\\+1"`));
    }
  }
  for (const line of [17, 25]) {
    const markup = render({ ...entry, runtimeData: { java: { line: String(line), version: `${line}.0.3+1` } } });
    const versions = markup.match(/<select aria-label="Java version"[^>]*>(.*?)<\/select>/)[1];
    assert.match(versions, new RegExp(`<option value="${line}\\.0\\.3\\+1" selected="">`));
    assert.match(versions, new RegExp(`<option value="${line}\\.0\\.4\\+1">`));
    const other = line === 17 ? 25 : 17;
    assert.doesNotMatch(versions, new RegExp(`value="${other}\\.0\\.[34]\\+1"`));
  }
  const upgraded = render({ ...entry,
    runtimeData: { java: { line: "21", version: "21.0.4+1" } } });
  const lines = upgraded.match(/<select aria-label="Line"[^>]*>(.*?)<\/select>/)[1];
  assert.match(lines, /<option value="21" selected="">Java 21<\/option>/);
  for (const line of JavaCore.LTS_LINES) assert.doesNotMatch(lines, new RegExp(`<option value="${line}" disabled="">`));
  const versions = upgraded.match(/<select aria-label="Java version"[^>]*>(.*?)<\/select>/)[1];
  assert.match(versions, /<option value="21\.0\.4\+1" selected="">/);
  assert.doesNotMatch(versions, /25\.0\.4\+1/);
  const staleStatus = render({ ...entry, runtimeData: { java: { line: "17" } } }, {
    runtimeId: "java", status: { requestedLine: 25, resolvedVersion: "25.0.4.1+1", ready: true }
  });
  const staleVersions = staleStatus.match(/<select aria-label="Java version"[^>]*>(.*?)<\/select>/)[1];
  assert.match(staleVersions, /<option value="17\.0\.4\+1">/);
  assert.doesNotMatch(staleVersions, /25\.0\.4\.1\+1/);
});

test("Java inspector keeps an exact patch while showing the detected recommendation when unset", async t => {
  const { userDataDir, jarPath, variant } = fixture(t);
  install(userDataDir, 25, "25.0.4.1+1", variant);
  const manifest = require("../src/modules/java/manifest.json");
  const java = { lines: { 25: { defaultVersion: "25.0.4.1+1" } } };
  const state = { modules: [manifest], moduleStates: {}, running: {}, runtimeManagers: {
    java: { id: Manager.id, label: Manager.label, ...Manager.getState({ settings: java, userDataDir }) }
  } };
  forbidNetwork(t);
  for (const runtimeData of [{ version: "21.0.4+1" }, { line: null, version: "21.0.4+1" }]) {
    const entry = { gameId: "java-auto-ui", name: "Game", moduleId: "java", runtimeId: "java", gamePath: jarPath,
      moduleRuntimeSupport: ["java"], moduleSupports: manifest.supports,
      moduleData: { jarPath, runtimeLine: 25, requiredJava: 25 }, runtimeData: { java: runtimeData } };
    const context = { userDataDir, settings: { runtimes: { java } } };
    assert.equal(Java.actions.runtimeStatus(entry, {}, context).ready, false);
    assert.equal((await Java.ensureRuntime(entry, context)).version, "21.0.4+1");
    const markup = renderToStaticMarkup(React.createElement(GameDetails, { g: entry, state, moduleInfo: manifest,
      actions: {}, cheatsStatus: null, libsStatus: null, runtimeStatusEntry: null, cheatsPatchBusy: false, libsPatchBusy: false,
      moduleActionResults: {}, moduleActionBusy: {}, moduleActionError: null }));
    const versions = markup.match(/<select aria-label="Java version"[^>]*>(.*?)<\/select>/)[1];
    assert.match(versions, /value="21\.0\.4\+1" selected/);
    assert.doesNotMatch(versions, /25\.0\.4\.1\+1/);
    entry.runtimeData.java = {};
    assert.equal(Java.actions.runtimeStatus(entry, {}, context).resolvedVersion, "25.0.4.1+1");
    assert.equal(await Java.ensureRuntime(entry, context), null);
  }
});

test("Temurin Runtimes tabs keep distinct refreshed line catalogs without rendering network requests", t => {
  const { userDataDir } = fixture(t);
  const manager = { id: Manager.id, label: Manager.label, ...Manager.getState({ settings: {}, userDataDir }) };
  manager.sections = manager.sections.map(section => section.id === "vineflower" ? section : {
    ...section, catalog: { ...section.catalog, status: "success", versions: [`${section.id}.0.4+1`, `${section.id}.0.3+1`] }
  });
  const offline = () => assert.fail("Changing a Java tab must not fetch or install");
  for (const line of JavaCore.LTS_LINES) {
    const markup = renderToStaticMarkup(React.createElement(RuntimesView, {
      runtimeManagers: [manager], runtimeManagerId: "java", runtimeSectionId: String(line), runtimeUi: {},
      downloadTasks: [], downloadsOpen: false, setDownloadsOpen() {}, setRuntimeManagerId() {}, setRuntimeSectionId() {},
      updateRuntimeUiSection() {}, onRuntimeRefresh: offline, onRuntimeInstall: offline, onRuntimeSetDefault: offline,
      onRuntimeUninstall: offline, onCancelDownload: offline
    }));
    assert.match(markup, new RegExp(`id="runtime-panel-java-${line}"`));
    // The install select lists the line's own catalog and waits for a choice.
    assert.match(markup, new RegExp(`<option value="" disabled="" selected="">Choose version</option><option value="${line}\\.0\\.4\\+1">`));
    for (const other of JavaCore.LTS_LINES.filter(value => value !== line)) {
      assert.doesNotMatch(markup, new RegExp(`value="${other}\\.0\\.4\\+1"`));
    }
  }
});
