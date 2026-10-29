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
