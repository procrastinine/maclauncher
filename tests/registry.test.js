const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Modules = require("../src/modules/registry");

test("every module declaring Windows executable inputs resolves a launch runtime", t => {
  const { canLaunchEntry, resolveRuntimeSupportForEntry } = require("../src/core/launch-capability");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-windows-input-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "Game.exe");
  const bytes = Buffer.alloc(1024);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(0x14c, 132); bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(2, 150);
  bytes.writeUInt16LE(0x10b, 152); bytes.writeUInt16LE(2, 220);
  fs.writeFileSync(executable, bytes);
  const context = { userDataDir: root, settings: {} };
  for (const info of Modules.listModules()) {
    const detection = info.detection || {};
    const extensions = [...detection.fileExtensions || [], ...detection.directoryFileExtensions || [],
      ...(detection.extensions || []).map(item => item.extension)];
    const formats = [...detection.binaryFormats || [], ...info.runtime?.inputFormats || []];
    if (!extensions.includes(".exe") && !formats.includes("pe")) continue;
    const mod = Modules.getModule(info.id);
    const entry = { moduleId: info.id, gamePath: root, contentRootDir: root, runtimeData: { crossover: {
      detectionComplete: true, windowsExecutablePath: executable, executableArchitecture: "x86", sourceRoot: root
    } } };
    const supported = resolveRuntimeSupportForEntry(mod, info, entry, {}, context);
    assert.ok(supported.some(runtimeId => info.runtime.entries[runtimeId]?.launch !== false), info.id);
    if (process.platform === "darwin") {
      assert.ok(supported.some(runtimeId => canLaunchEntry({ mod, info, entry, runtimeId, context })), info.id);
    }
  }
});

function windowsExecutable(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.alloc(1024);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(0x14c, 132); bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(2, 150);
  bytes.writeUInt16LE(0x10b, 152); bytes.writeUInt16LE(2, 220);
  fs.writeFileSync(file, bytes);
  return file;
}

test("every game type offers the Windows runtimes when its files include a Windows executable", t => {
  const { resolveRuntimeSupportForEntry } = require("../src/core/launch-capability");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-windows-providers-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = windowsExecutable(path.join(root, "Game.exe"));
  const context = { userDataDir: root, settings: {} };
  const crossover = require("../src/modules/crossover/runtime/manager").isAvailable(root);
  for (const info of Modules.listModules()) {
    const mod = Modules.getModule(info.id);
    const entry = { moduleId: info.id, gamePath: root, contentRootDir: root, importPath: root, runtimeData: { crossover: {
      detectionComplete: true, windowsExecutablePath: executable, executableArchitecture: "x86", sourceRoot: root } } };
    const supported = resolveRuntimeSupportForEntry(mod, info, entry, {}, context);
    // Android and native macOS apps limit their providers in their manifests.
    const allowed = info.runtime?.providers;
    for (const runtimeId of ["sikarugir", ...crossover ? ["crossover"] : []]) {
      assert.equal(supported.includes(runtimeId), !Array.isArray(allowed) || allowed.includes(runtimeId), `${info.id}: ${runtimeId}`);
    }
    const none = { ...entry, runtimeData: { crossover: { detectionComplete: true, windowsExecutablePath: null } } };
    assert.equal(resolveRuntimeSupportForEntry(mod, info, none, {}, context).includes("sikarugir"), false, info.id);
  }
});

test("Ren'Py and RPG Maker imports record their Windows executable for the Windows runtimes", t => {
  const { resolveRuntimeSupportForEntry } = require("../src/core/launch-capability");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-windows-engines-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  const renpy = path.join(root, "Novel-1.0-pc");
  write(path.join(renpy, "renpy", "vc_version.py"), "version = '8.3.0'\n");
  write(path.join(renpy, "game", "script.rpy"), "label start:\n    return\n");
  const launcher = windowsExecutable(path.join(renpy, "Novel.exe"));
  windowsExecutable(path.join(renpy, "lib", "py3-windows-x86_64", "pythonw.exe"));
  const script = write(path.join(renpy, "Novel.sh"), "#!/bin/sh\n");
  // Ren'Py PC releases also carry a Mac app next to the Windows executable.
  write(path.join(renpy, "Novel.app", "Contents", "MacOS", "Novel"), "#!/bin/sh\n");
  write(path.join(renpy, "Novel.app", "Contents", "Info.plist"), "<plist version=\"1.0\"><dict/></plist>\n");
  const mv = path.join(root, "Quest");
  write(path.join(mv, "package.json"), '{"name":"Quest","main":"www/index.html"}');
  write(path.join(mv, "www", "index.html"), "<html></html>");
  write(path.join(mv, "www", "js", "rpg_core.js"), "// RPG Maker MV fixture");
  const game = windowsExecutable(path.join(mv, "Game.exe"));
  windowsExecutable(path.join(mv, "notification_helper.exe"));
  for (const [input, moduleId, expected] of [[renpy, "renpy", launcher], [script, "renpy", launcher],
    [path.join(renpy, "Novel.app"), "renpy", launcher], [mv, "mv", game], [path.join(mv, "www"), "mv", game],
    [path.join(mv, "www", "index.html"), "mv", game]]) {
    const report = Modules.explainDetection(input);
    assert.equal(report.error, undefined, report.error?.message);
    assert.equal(report.selectedModuleId, moduleId);
    const entry = { ...report.detected, moduleId, importPath: input };
    assert.equal(entry.runtimeData.crossover.windowsExecutablePath, expected, input);
    const supported = resolveRuntimeSupportForEntry(Modules.getModule(moduleId), Modules.getModuleInfo(moduleId), entry, {}, { userDataDir: root, settings: {} });
    assert.ok(supported.includes("sikarugir"), `${input}: ${supported}`);
    assert.notEqual(supported[0], "sikarugir", "the engine's own runtimes come first");
  }
});

test("an imported NW.js content folder keeps its identity and records the release folder around it", t => {
  const { nwjsReleaseRoot } = require("../src/modules/shared/web/release-root");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-release-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  const mv = path.join(root, "Quest"), www = path.join(mv, "www");
  write(path.join(mv, "package.json"), '{"name":"Quest","main":"www/index.html"}');
  write(path.join(www, "index.html"), "<html></html>"); write(path.join(www, "js", "rpg_core.js"), "// RPG Maker MV fixture");
  const game = windowsExecutable(path.join(mv, "Game.exe"));
  for (const input of [www, path.join(www, "index.html")]) {
    const detected = Modules.explainDetection(input).detected;
    // Identity stays the imported content folder; only the release folder is added.
    assert.deepEqual([detected.moduleId ?? "mv", detected.gamePath, detected.contentRootDir, detected.indexDir], ["mv", www, www, www]);
    assert.equal(detected.releaseRootDir, mv);
    assert.equal(detected.runtimeData.crossover.windowsExecutablePath, game);
    assert.equal(detected.runtimeData.crossover.sourceRoot, mv);
  }
  assert.equal(Modules.explainDetection(mv).detected.releaseRootDir, undefined, "a release folder import needs no extra record");
  // Only a layout that proves the release counts.
  const nw = path.join(root, "NW Game", "package.nw"); write(path.join(nw, "index.html"), "<html></html>");
  assert.equal(nwjsReleaseRoot(nw), path.dirname(nw));
  const shared = path.join(root, "Downloads"), other = path.join(shared, "Other");
  write(path.join(other, "index.html"), "<html></html>"); windowsExecutable(path.join(shared, "Unrelated.exe"));
  assert.equal(nwjsReleaseRoot(other), null);
  write(path.join(shared, "package.json"), '{"main":"Elsewhere/index.html"}');
  assert.equal(nwjsReleaseRoot(other), null);
  write(path.join(shared, "package.json"), '{"main":"../Other/index.html"}');
  assert.equal(nwjsReleaseRoot(other), null);
  write(path.join(shared, "package.json"), "not json");
  assert.equal(nwjsReleaseRoot(other), null);
});

test("Windows runtimes follow the recorded game location and never read an unavailable game's files", t => {
  const { resolveRuntimeSupportForEntry, canLaunchEntry } = require("../src/core/launch-capability");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-windows-locations-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  const renpyRoot = directory => {
    write(path.join(directory, "renpy", "vc_version.py"), "version = '8.3.0'\n");
    write(path.join(directory, "game", "script.rpy"), "label start:\n    return\n");
  };
  const context = { userDataDir: root, settings: {} };
  const supported = entry => resolveRuntimeSupportForEntry(Modules.getModule(entry.moduleId), Modules.getModuleInfo(entry.moduleId), entry, {}, context);
  const detect = input => {
    const report = Modules.explainDetection(input);
    assert.equal(report.error, undefined, report.error?.message);
    return { ...report.detected, moduleId: report.selectedModuleId, importPath: input };
  };
  // A Mac-only release keeps the game inside the app, even with a Windows executable in it.
  const mac = path.join(root, "Novel-mac", "Novel.app"), autorun = path.join(mac, "Contents", "Resources", "autorun");
  renpyRoot(autorun); windowsExecutable(path.join(autorun, "Novel.exe"));
  const bundled = detect(mac);
  assert.equal(bundled.moduleId, "renpy");
  assert.equal(bundled.contentRootDir, autorun);
  assert.equal(bundled.runtimeData.crossover.windowsExecutablePath, null);
  assert.ok(!supported(bundled).includes("sikarugir"), String(supported(bundled)));
  // The decision comes from the recorded path, even for a record that names an executable.
  const forged = { ...bundled, runtimeData: { crossover: { detectionComplete: true, windowsExecutablePath: path.join(autorun, "Novel.exe"),
    executableArchitecture: "x86", sourceRoot: autorun } } };
  assert.ok(!supported(forged).includes("sikarugir"));
  // A PC release folder with a Windows executable, a Linux script and a Mac app offers both.
  const pc = path.join(root, "Novel-pc");
  renpyRoot(pc);
  const launcher = windowsExecutable(path.join(pc, "Novel.exe"));
  write(path.join(pc, "Novel.sh"), "#!/bin/sh\n");
  write(path.join(pc, "Novel.app", "Contents", "MacOS", "Novel"), "#!/bin/sh\n");
  write(path.join(pc, "Novel.app", "Contents", "Info.plist"), "<plist version=\"1.0\"><dict/></plist>\n");
  const release = detect(pc);
  assert.equal(release.moduleId, "renpy");
  assert.equal(release.runtimeData.crossover.windowsExecutablePath, launcher);
  assert.ok(supported(release).includes("sikarugir"));
  // Its Mac app holds no game of its own, so selecting the app imports the same release folder.
  const viaApp = detect(path.join(pc, "Novel.app"));
  assert.equal(viaApp.gamePath, pc);
  assert.equal(viaApp.contentRootDir, pc);
  assert.equal(viaApp.runtimeData.crossover.windowsExecutablePath, launcher);
  assert.ok(supported(viaApp).includes("sikarugir"));
  // While the folder is unavailable, the runtime choices come from the record alone.
  fs.renameSync(pc, pc + "-disconnected");
  fs.renameSync(path.dirname(mac), path.dirname(mac) + "-disconnected");
  const touched = [];
  for (const name of ["statSync", "lstatSync", "readdirSync", "realpathSync", "openSync", "existsSync", "accessSync", "readFileSync", "readlinkSync"]) {
    const original = fs[name];
    t.mock.method(fs, name, function (file, ...rest) {
      if ([pc, path.dirname(mac)].some(root => String(file).startsWith(root))) touched.push(name + " " + file);
      return original.call(this, file, ...rest);
    });
  }
  const offline = supported(release);
  assert.ok(offline.includes("sikarugir"), String(offline));
  assert.ok(supported(viaApp).includes("sikarugir"));
  assert.ok(!supported(bundled).includes("sikarugir") && !supported(forged).includes("sikarugir"), "an app-bundle game stays without Windows runtimes");
  assert.equal(canLaunchEntry({ mod: Modules.getModule("renpy"), info: Modules.getModuleInfo("renpy"), entry: release, runtimeId: "sikarugir", context }), true);
  assert.deepEqual(touched, [], "building the runtime choices never reads the game's files");
});

test("game dialog includes declared formats as modules are added", () => {
  const extensions = Modules.listSupportedInputExtensions();
  for (const info of Modules.listModules()) {
    for (const extension of info.detection?.fileExtensions || []) {
      if (extension) assert.ok(extensions.includes(extension.slice(1)), `${info.id}: ${extension}`);
    }
  }
  for (const extension of ["app", "x86_64", "pck", "hl", "win", "xp3", "ald", "hcb", "bch"]) {
    assert.ok(extensions.includes(extension), extension);
  }
  assert.equal(new Set(extensions).size, extensions.length);
  assert.equal(extensions.includes(""), false);
});

test("FVP registers its managed RFVP backend through module metadata", () => {
  const module = Modules.getModule("fvp");
  assert.ok(module);
  assert.equal(module.manifest.runtime.default, "rfvp");
  assert.ok(module.manifest.runtime.supported.includes("rfvp"));
  assert.equal(module.manifest.runtime.manager.rfvp, "rfvp");
  assert.ok(module.runtimeManagers.some(manager => manager.id === "rfvp"));
  const ui = Modules.getRuntimeManagerUi("rfvp");
  assert.equal(ui.tabLabel, "RFVP");
  assert.equal(ui.management, "managed");
});

test("runtime group metadata keeps distinct backend IDs while grouping their presentation", () => {
  const first = Modules.getRuntimeManagerUi("system3");
  const second = Modules.getRuntimeManagerUi("xsystem35");
  assert.equal(first.groupId, "alicesoft");
  assert.equal(second.groupId, first.groupId);
  assert.notEqual(first.sectionLabel, second.sectionLabel);
  assert.ok(Modules.getRuntimeManagerUi("nwjs").order < first.order);
  first.tabLabel = "changed";
  assert.equal(Modules.getRuntimeManagerUi("system3").tabLabel, "AliceSoft");
  assert.equal(Modules.getRuntimeManagerUi("not-installed"), null);
});

test("current shared management metadata and mixed sections are independent of cached state and callers", () => {
  const shared = Modules.listSharedRuntimeManagers().find(manager => manager.id === "ilspy");
  const ui = Modules.getRuntimeManagerUi(shared.id);
  assert.equal(ui.management, "managed");
  assert.notEqual(ui, shared.ui);
  ui.management = "built-in";
  assert.equal(Modules.getRuntimeManagerUi(shared.id).management, "managed");
  const mixed = Modules.getRuntimeManagerUi("onsyuri");
  assert.equal(mixed.groupId, "nscripter");
  assert.equal(mixed.tabLabel, "NScripter");
  assert.equal(mixed.sectionManagement.mac, "managed");
  assert.equal(mixed.sectionManagement.web, "managed");
  assert.equal(Modules.getRuntimeManagerUi("onscripter-en").management, "managed");
  const choices = Modules.getModule("nscripter").manifest.runtime.entries;
  assert.equal(choices.onsyuri_mac.label, "ONScripter-Yuri");
  assert.equal(choices.onsyuri_web.label, "ONScripter-Yuri Web");
  assert.equal(choices.onscripter_en.label, "ONScripter-EN");
  assert.equal(Modules.getRuntimeManagerUi("ruffle").tabLabel, "Flash");
  assert.equal(Modules.getRuntimeManagerUi("flash-projector").management, "managed");
  assert.equal(Modules.getRuntimeManagerUi("ilspy").groupId, "tools");
  assert.equal(Modules.getRuntimeManagerUi("ilspy").tabLabel, "Tools");
  assert.equal(Modules.getRuntimeManagerUi("ikemen").tabLabel, "Ikemen GO");
  assert.equal(Modules.getRuntimeManagerUi("siglus").tabLabel, "Siglus");
  assert.equal(Modules.getModule("siglus").runtimeManagers[0].label, "siglus_rs");
  mixed.sectionManagement.mac = "built-in";
  assert.equal(Modules.getRuntimeManagerUi("onsyuri").sectionManagement.mac, "managed");
});

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function writeBuffer(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

test("findIndexHtml prefers package.json main", () => {
  const root = makeTempDir("maclauncher-index-");
  try {
    const htmlPath = path.join(root, "app", "index.html");
    writeFile(htmlPath, "<html></html>");
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ main: "app/index.html" })
    );

    const found = Modules.findIndexHtml(root);
    assert.equal(found, htmlPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findIndexHtml falls back to www/index.html", () => {
  const root = makeTempDir("maclauncher-www-");
  try {
    const htmlPath = path.join(root, "www", "index.html");
    writeFile(htmlPath, "<html></html>");

    const found = Modules.findIndexHtml(root);
    assert.equal(found, htmlPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame falls back to Web module for generic index.html", () => {
  const root = makeTempDir("maclauncher-web-");
  try {
    const htmlPath = path.join(root, "index.html");
    writeFile(htmlPath, "<html></html>");

    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "web");
    assert.equal(detected.gameType, "web");
    assert.equal(detected.indexHtml, htmlPath);
    assert.equal(detected.defaultSaveDir, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame preserves a readable folder name beside an executable", () => {
  const root = makeTempDir("maclauncher-web-exe-");
  try {
    writeFile(path.join(root, "index.html"), "<html></html>");
    writeFile(path.join(root, "CoolGame.exe"), "");

    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "web");
    assert.equal(detected.name, path.basename(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame app bundle error lists supported modules", () => {
  const root = makeTempDir("maclauncher-app-");
  const appPath = path.join(root, "Test.app");
  fs.mkdirSync(appPath, { recursive: true });

  try {
    assert.throws(
      () => Modules.detectGame(appPath),
      err => {
        const message = String(err?.message || "");
        if (!message.includes("Unsupported app bundle")) return false;
        const labels = Modules.listSupportedModules();
        return labels.every(label => message.includes(label));
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame routes .love files through the LÖVE module", () => {
  const root = makeTempDir("maclauncher-love-route-");
  try {
    const lovePath = path.join(root, "Broken.love");
    writeBuffer(lovePath, Buffer.from("not-a-zip", "utf8"));

    assert.throws(
      () => Modules.detectGame(lovePath),
      err => String(err?.message || "").includes("Unsupported .love input for LÖVE")
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("getModuleInfo returns an unknown placeholder", () => {
  const info = Modules.getModuleInfo("mystery");
  assert.equal(info.id, "mystery");
  assert.equal(info.label, "Unknown");
  assert.equal(info.supports?.cheats, false);
});
