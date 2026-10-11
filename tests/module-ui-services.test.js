const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Modules = require("../src/modules/registry");
const { getUiServices } = require("../src/modules/shared/ui-services");
const GameData = require("../src/modules/shared/game-data");
const RgssAssets = require("../src/modules/rgss/assets");
const Godot = require("../src/modules/godot/main");
const Renpy = require("../src/modules/renpy/main");

function makeTempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-module-ui-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createGdreTool(userDataDir, version = "1.0.0") {
  const cliPath = path.join(
    userDataDir, "runtimes", "gdsdecomp", version, "GDRE Tools.app", "Contents", "MacOS", "gdre_tools"
  );
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(cliPath, [
    "#!/bin/sh",
    'printf \'%s\\n\' "$@" > "$0.args"',
    'pwd -P > "$0.cwd"',
    ""
  ].join("\n"), { mode: 0o755 });
  return cliPath;
}

test("registry and every module load in plain Node without attempting to require Electron", () => {
  // Use a fresh Node process with no preload. Observe attempted imports because
  // the registry catches errors while discovering modules.
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const path = require("node:path");
    const Module = require("node:module");
    const originalLoad = Module._load;
    const electronAttempts = [];
    Module._load = function(request, parent, isMain) {
      if (request === "electron") {
        electronAttempts.push(parent?.filename);
        throw new Error("Modules must not require Electron.");
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    const registry = require("./src/modules/registry");
    const modulesDir = path.resolve("src/modules");
    const expectedIds = [];
    for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "shared") continue;
      const dir = path.join(modulesDir, entry.name);
      if (!fs.existsSync(path.join(dir, "manifest.json")) || !fs.existsSync(path.join(dir, "main.js"))) continue;
      const mod = require(path.join(dir, "main.js"));
      expectedIds.push(mod.id);
      const composed = registry.getModule(mod.id);
      assert.equal(composed.id, mod.id);
      assert.equal(composed.detectGame, mod.detectGame);
      assert.equal(composed.actions, mod.actions);
      assert.equal(composed.manifest.runtime.default, mod.manifest.runtime.default);
      assert.equal(typeof composed.getRuntimeProvider, "function");
    }
    assert.deepEqual(registry.listModuleIds().sort(), expectedIds.sort());
    for (const id of ["godot", "renpy", "rgss", "java", "love", "flash", "nscripter"]) {
      assert.equal(typeof registry.getModule(id)?.launchRuntime, "function", id);
    }
    assert.equal(typeof require("./src/modules/shared/mvmz/rpgmaker-module").buildRpgmakerModule, "function");
    assert.throws(() => registry.getModule("tyrano").actions.revealBundle({ gamePath: "/Games/Game" }), /context\\.ui\\.shell/);
    assert.deepEqual(electronAttempts, []);
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, NODE_OPTIONS: "" },
    encoding: "utf8",
    timeout: 10000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("UI services remain scoped to the hook context and headless methods give instructions", () => {
  const first = { shell: { showItemInFolder() {} } };
  const second = { dialog: { showOpenDialog() {} } };
  assert.equal(getUiServices({ ui: first }), first);
  assert.equal(getUiServices({ ui: second }), second);
  const headless = getUiServices();
  assert.equal(headless.nativeImage, null);
  assert.throws(() => headless.shell.showItemInFolder("/Games"), /context\.ui\.shell\.showItemInFolder/);
  assert.throws(() => headless.dialog.showOpenDialog(), /payload\.filePaths.*context\.ui\.dialog\.showOpenDialog/);
  assert.throws(() => headless.dialog.showMessageBox(), /Install.*explicitly.*context\.ui\.dialog\.showMessageBox/);
});

const revealActions = [
  ["godot", "revealExtraction"],
  ["renpy", "revealExtraction"],
  ["renpy", "revealBuild"],
  ["java", "revealExtraction"],
  ["rgss", "revealAssets"],
  ["rgss", "revealDecryption"],
  ["mv", "revealDecryption"],
  ["mz", "revealDecryption"],
  ["tyrano", "revealBundle"]
];

for (const [id, action] of revealActions) {
  test(`${id} ${action} requires headless callers to provide a shell and uses the injected shell`, t => {
    const root = makeTempDir(t);
    const userDataDir = path.join(root, "userData");
    const target = action === "revealAssets"
      ? RgssAssets.resolveStagedPaths(userDataDir).assetsRoot
      : action === "revealBuild" ? path.join(root, "Build.app") : path.join(root, "extracted");
    fs.mkdirSync(target, { recursive: true });
    if (action === "revealBuild") {
      fs.mkdirSync(path.join(target, "Contents"));
      const buildsDir = path.join(GameData.resolveGameModuleDir(userDataDir, "game-ui", "renpy"), "builds");
      fs.mkdirSync(buildsDir, { recursive: true });
      fs.writeFileSync(path.join(buildsDir, "builds.json"), JSON.stringify({ builds: [{ appPath: target }] }));
    }
    const entry = {
      gameId: "game-ui",
      gamePath: root,
      moduleData: { extractedRoot: target, decryptedRoot: target, bundleRevealPath: target }
    };
    const handler = Modules.getModule(id).actions[action];
    assert.throws(() => handler(entry, {}, { userDataDir }), /context\.ui\.shell\.showItemInFolder/);
    const calls = [];
    const shell = {
      showItemInFolder(filePath) {
        assert.equal(this, shell);
        calls.push(filePath);
      }
    };
    assert.deepEqual(handler(entry, {}, { userDataDir, ui: { shell } }), { revealed: true });
    assert.deepEqual(calls, [target]);
    assert.throws(() => handler(entry, {}, { userDataDir }), /context\.ui\.shell\.showItemInFolder/);
  });
}

test("GDRE validates the game before discovery and declined consent needs no UI services", async t => {
  const userDataDir = makeTempDir(t);
  const manager = Godot.runtimeManagers[0];
  const refresh = t.mock.method(manager, "refreshCatalog", () => assert.fail("Unexpected network refresh"));
  const install = t.mock.method(manager, "installRuntime", () => assert.fail("Unexpected download"));
  const context = { userDataDir, settings: { runtimes: {} } };
  await assert.rejects(Godot.actions.gdreRecover({ gameId: "game-ui" }, {}, context), /Godot pack or project not found/);
  assert.equal(refresh.mock.callCount(), 0);
  assert.equal(install.mock.callCount(), 0);

  const prompts = [];
  context.confirmRuntimeInstall = async plan => { prompts.push(plan); return false; };
  await assert.rejects(Godot.actions.gdreRecover({ gameId: "game-ui", moduleData: { packPath: "/game.pck" } }, {}, context), { code: "ABORT_ERR" });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].label, "GDRE Tools");
  assert.equal(prompts[0].installOptions.sectionId, "gdsdecomp");
  assert.equal(prompts[0].confirmLabel, "Download and Continue");
  assert.equal(refresh.mock.callCount(), 0);
  assert.equal(install.mock.callCount(), 0);
});

test("GDRE installs the selected version and resumes the same headless action", async t => {
  const userDataDir = makeTempDir(t), manager = Godot.runtimeManagers[0], version = "1.1.0";
  const otherCli = createGdreTool(userDataDir, "1.0.0");
  const events = [], packPath = path.join(userDataDir, "game.pck"); fs.writeFileSync(packPath, "pack");
  const context = { userDataDir, settings: { runtimes: { godot: { gdsdecomp: { defaultVersion: version } } } },
    confirmRuntimeInstall: async plan => { events.push("consent"); assert.equal(plan.version, version); return { approved: true }; } };
  const install = t.mock.method(manager, "installRuntime", async options => {
    events.push("install"); assert.equal(options.sectionId, "gdsdecomp"); assert.equal(options.version, version);
    return { version, cliPath: createGdreTool(userDataDir, version) };
  });
  t.mock.method(manager, "refreshCatalog", () => assert.fail("An exact selected version needs no discovery"));
  const entry = { gameId: "game-ui", moduleData: { packPath } };
  assert.deepEqual(await Godot.actions.gdreListFiles(entry, {}, context), { listed: true });
  const selectedCli = createGdreTool(userDataDir, version);
  assert.deepEqual(events, ["consent", "install"]);
  assert.deepEqual(fs.readFileSync(`${selectedCli}.args`, "utf8").trim().split("\n"), ["--headless", `--list-files=${packPath}`]);
  assert.equal(fs.existsSync(`${otherCli}.args`), false);
  context.confirmRuntimeInstall = () => assert.fail("Installed tools need no consent");
  assert.deepEqual(await Godot.actions.gdreListFiles(entry, {}, context), { listed: true });
  assert.equal(install.mock.callCount(), 1);
});

test("canceling file selection never installs GDRE", async t => {
  const userDataDir = makeTempDir(t), manager = Godot.runtimeManagers[0];
  t.mock.method(manager, "installRuntime", () => assert.fail("Canceled selection cannot install"));
  const context = { userDataDir, settings: {}, confirmRuntimeInstall: () => assert.fail("Canceled selection cannot prompt") };
  for (const id of ["gdreDecompile", "gdreBinToTxt", "gdreTxtToBin"]) {
    assert.deepEqual(await Godot.actions[id]({}, { filePaths: [] }, context), { canceled: true });
    await assert.rejects(Godot.actions[id]({}, { filePaths: "invalid" }, context), /array of non-empty/);
  }
});

test("GDRE actions stay available before installation while output controls require extraction", () => {
  const actions = new Map(Godot.manifest.ui.actions.map(action => [action.id, action]));
  for (const id of ["gdreReload", "gdreDetectVersion", "gdreExtract", "gdreRecover"]) {
    assert.equal(actions.get(id).disabledWhen?.some(rule => rule.key === "moduleData.gdreInstalled") || false, false);
  }
  assert.equal(actions.get("revealExtraction").disabledWhen.some(rule => rule.key === "moduleData.extractedReady" && rule.falsy), true);
  assert.equal(actions.get("removeExtraction").hiddenWhen.some(rule => rule.key === "moduleData.extractedReady" && rule.falsy), true);
});

const gdreFileActions = [
  ["gdreDecompile", "decompile", "gdc", "decompiled"],
  ["gdreBinToTxt", "bin-to-txt", "res", "converted"],
  ["gdreTxtToBin", "txt-to-bin", "tres", "converted"]
];

for (const [action, flag, ext, resultKey] of gdreFileActions) {
  test(`${action} uses payload.filePaths headlessly and preserves the dialog flow`, async t => {
    const root = makeTempDir(t);
    const userDataDir = path.join(root, "userData");
    const cliPath = createGdreTool(userDataDir);
    const filePaths = [path.join(root, `first file.${ext}`), path.join(root, `second.${ext}`)];
    filePaths.forEach(filePath => fs.writeFileSync(filePath, "resource"));
    const entry = { gameId: "game-ui", moduleData: {} };
    const context = { userDataDir, settings: { runtimes: {} } };
    const handler = Godot.actions[action];

    await assert.rejects(handler(entry, {}, context), /Pass payload\.filePaths.*context\.ui\.dialog\.showOpenDialog/);
    assert.equal(fs.existsSync(`${cliPath}.args`), false);
    await assert.rejects(handler(entry, { filePaths: "invalid" }, context), /array of non-empty file paths/);
    await assert.rejects(handler(entry, { filePaths: [""] }, context), /array of non-empty file paths/);
    assert.deepEqual(await handler(entry, { filePaths: [] }, context), { canceled: true });
    assert.equal(fs.existsSync(`${cliPath}.args`), false);

    const result = await handler(entry, { filePaths }, context);
    assert.deepEqual(result, { [resultKey]: true, count: 2 });
    assert.deepEqual(fs.readFileSync(`${cliPath}.args`, "utf8").trim().split("\n"),
      ["--headless", ...filePaths.map(filePath => `--${flag}=${filePath}`)]);
    assert.equal(fs.readFileSync(`${cliPath}.cwd`, "utf8").trim(), fs.realpathSync(root));
    assert.equal(entry.moduleData.gdreLastAction, flag);
    assert.equal(entry.moduleData.gdreLastActionTarget, filePaths[0]);

    const selections = [];
    const dialog = { showOpenDialog: async options => {
      selections.push(options);
      return { canceled: false, filePaths: [filePaths[1]] };
    } };
    const uiContext = { ...context, ui: { dialog } };
    assert.deepEqual(await handler(entry, {}, uiContext), { [resultKey]: true, count: 1 });
    assert.equal(selections.length, 1);
    assert.deepEqual(selections[0].properties, ["openFile", "multiSelections"]);
    assert.deepEqual(fs.readFileSync(`${cliPath}.args`, "utf8").trim().split("\n"),
      ["--headless", `--${flag}=${filePaths[1]}`]);
    assert.deepEqual(await handler(entry, { filePaths }, uiContext), { [resultKey]: true, count: 2 });
    assert.equal(selections.length, 1, "Explicit paths must bypass the dialog");
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    assert.deepEqual(await handler(entry, {}, uiContext), { canceled: true });
  });
}

test("Ren'Py WebP icons return null headlessly and convert with the context nativeImage", t => {
  const root = makeTempDir(t);
  const sourcePath = path.join(root, "window-icon.webp");
  const convertedPath = path.join(root, "window-icon.png");
  fs.writeFileSync(sourcePath, "webp");
  const entry = { gamePath: root, moduleData: { extractedIconPath: sourcePath } };
  assert.equal(Renpy.resolveGameIcon(entry), null);
  assert.equal(Renpy.resolveGameIcon(entry, { ui: {} }), null);
  assert.equal(fs.existsSync(convertedPath), false);

  const png = Buffer.from("converted PNG");
  const calls = [];
  const nativeImage = { createFromPath(filePath) {
    calls.push(filePath);
    return { isEmpty: () => false, toPNG: () => png };
  } };
  assert.equal(Renpy.resolveGameIcon(entry, { ui: { nativeImage } }), convertedPath);
  assert.deepEqual(calls, [sourcePath]);
  assert.deepEqual(fs.readFileSync(convertedPath), png);
  assert.equal(Renpy.resolveGameIcon(entry), convertedPath, "Existing converted icons remain usable headlessly");
  fs.rmSync(convertedPath);
  assert.equal(Renpy.resolveGameIcon(entry), null, "Injected nativeImage must not leak into other contexts");
});

test("Ren'Py extraction status passes nativeImage through to its icon cache", t => {
  const root = makeTempDir(t);
  const userDataDir = path.join(root, "userData");
  const extractedRoot = path.join(root, "extracted");
  fs.mkdirSync(extractedRoot);
  const iconPath = path.join(extractedRoot, "icon.webp");
  fs.writeFileSync(iconPath, "webp");
  fs.writeFileSync(path.join(extractedRoot, "options.rpy"), 'define config.window_icon = "icon.webp"\n');
  require("../src/modules/renpy/extract").writeExtractionMeta(extractedRoot, {
    sourcePath: path.join(root, "game"), extractedAt: 123, state: "complete"
  });
  const entry = { gameId: "game-ui", gamePath: root, moduleData: { extractedRoot } };
  const context = { userDataDir };
  Renpy.actions.refreshExtractionStatus(entry, {}, context);
  assert.equal(entry.iconPath, undefined);
  assert.equal(entry.moduleData.extractedReady, true);

  const png = Buffer.from("converted PNG");
  const calls = [];
  context.ui = { nativeImage: { createFromPath(filePath) {
    calls.push(filePath);
    return { isEmpty: () => false, toPNG: () => png };
  } } };
  Renpy.actions.refreshExtractionStatus(entry, {}, context);
  const cachePath = path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, "renpy"), "icons", "window-icon.png");
  assert.deepEqual(calls, [iconPath]);
  assert.equal(entry.iconPath, cachePath);
  assert.equal(entry.iconSource, "module");
  assert.equal(entry.moduleData.extractedIconPath, cachePath);
  assert.deepEqual(fs.readFileSync(cachePath), png);
});
