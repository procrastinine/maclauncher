const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const GodotModule = require("../src/modules/godot/main");
const GodotExtract = require("../src/modules/godot/extract");
const GameData = require("../src/modules/shared/game-data");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createGodotApp(appPath) {
  fs.mkdirSync(path.join(appPath, "Contents/MacOS"), { recursive: true });
  fs.writeFileSync(path.join(appPath, "Contents/Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Godot</string></dict></plist>');
  fs.writeFileSync(path.join(appPath, "Contents/MacOS/Godot"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

function buildPckHeader({ packVersion = 3, major = 4, minor = 2, patch = 1 } = {}) {
  const buf = Buffer.alloc(20);
  buf.write("GDPC", 0, 4, "ascii");
  buf.writeUInt32LE(packVersion, 4);
  buf.writeUInt32LE(major, 8);
  buf.writeUInt32LE(minor, 12);
  buf.writeUInt32LE(patch, 16);
  return buf;
}

function buildEmbeddedElfPack(pack) {
  const header = Buffer.alloc(32, 0);
  header[0] = 0x7f;
  header[1] = 0x45;
  header[2] = 0x4c;
  header[3] = 0x46;
  header[4] = 2;
  header[5] = 1;
  const trailer = Buffer.alloc(12);
  trailer.writeBigUInt64LE(BigInt(pack.length), 0);
  trailer.write("GDPC", 8, 4, "ascii");
  return {
    buffer: Buffer.concat([header, pack, trailer]),
    offset: header.length,
    size: pack.length
  };
}

test("runtime prompt suppression stores version bucket", () => {
  const userDataDir = makeTempDir("maclauncher-godot-runtime-");
  try {
    const entry = {
      moduleData: {
        detectedVersion: "4.2.1",
        detectedMajor: 4
      },
      runtimeData: {}
    };
    const status = GodotModule.actions.runtimeStatus(entry, {}, {
      settings: { runtimes: { godot: {} } },
      userDataDir
    });
    assert.equal(status.ready, false);

    GodotModule.actions.suppressRuntimePrompt(entry, { status }, {});
    assert.equal(entry.moduleData.runtimePromptSuppressedFor, "version:4.2.1");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("runtime prompt suppression uses major bucket when version is unknown", () => {
  const userDataDir = makeTempDir("maclauncher-godot-runtime-");
  try {
    const entry = {
      moduleData: {
        detectedVersion: "3.1.x",
        detectedMajor: 3
      },
      runtimeData: {}
    };
    const status = GodotModule.actions.runtimeStatus(entry, {}, {
      settings: { runtimes: { godot: {} } },
      userDataDir
    });
    assert.equal(status.ready, false);

    GodotModule.actions.suppressRuntimePrompt(entry, { status }, {});
    assert.equal(entry.moduleData.runtimePromptSuppressedFor, "major:3");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("recordGdreAction writes metadata", () => {
  const entry = { moduleData: {} };
  GodotModule.__test.recordGdreAction(entry, {
    action: "detect-version",
    status: "success",
    targetPath: "/Games/Example.pck",
    outputPath: "/tmp/godot-extract",
    at: 123
  });
  assert.equal(entry.moduleData.gdreLastAction, "detect-version");
  assert.equal(entry.moduleData.gdreLastActionStatus, "success");
  assert.equal(entry.moduleData.gdreLastActionTarget, "/Games/Example.pck");
  assert.equal(entry.moduleData.gdreLastActionOutput, "/tmp/godot-extract");
  assert.equal(entry.moduleData.gdreLastActionAt, 123);
});

test("selectAvailableVersion picks the latest matching base slug", () => {
  const selected = GodotModule.__test.selectAvailableVersion({
    version: "3.4.1",
    catalog: ["3.4.1-rc2", "3.4.1-stable"],
    installed: []
  });
  assert.equal(selected, "3.4.1-stable");
});

test("selectAvailableVersion falls back to installed versions for majors", () => {
  const selected = GodotModule.__test.selectAvailableVersion({
    major: 3,
    catalog: [],
    installed: ["3.5.2-stable", "4.0-stable"]
  });
  assert.equal(selected, "3.5.2-stable");
});

test("selectAvailableVersion skips major fallback when disabled", () => {
  const selected = GodotModule.__test.selectAvailableVersion({
    version: "3.4.1",
    major: 3,
    catalog: ["3.6.2-stable"],
    installed: [],
    allowMajorFallback: false
  });
  assert.equal(selected, null);
});

test("selectAvailableVersion matches x.y.0 requests to x.y slugs", () => {
  const selected = GodotModule.__test.selectAvailableVersion({
    version: "3.2.0-stable",
    catalog: ["3.2-stable", "3.2.1-stable"],
    installed: []
  });
  assert.equal(selected, "3.2-stable");
});

test("selectAvailableVersion matches x.y.0 rc requests to x.y rc slugs", () => {
  const selected = GodotModule.__test.selectAvailableVersion({
    version: "3.2.0-rc1",
    catalog: ["3.2-rc2", "3.2-stable"],
    installed: []
  });
  assert.equal(selected, "3.2-rc2");
});

test("resolveLaunchTarget prefers extracted project when enabled", () => {
  const userDataDir = makeTempDir("maclauncher-godot-extract-");
  try {
    const gamePath = "/Games/TestGodot";
    const entry = {
      gameId: "game-godot",
      gamePath,
      moduleData: {
        packPath: "/Games/TestGodot.pck"
      }
    };
    const extractRoot = path.join(
      GameData.resolveGameModuleDir(userDataDir, entry.gameId, "godot"),
      "extracted"
    );
    fs.mkdirSync(extractRoot, { recursive: true });
    fs.writeFileSync(path.join(extractRoot, "project.godot"), "[application]\n", "utf8");
    fs.writeFileSync(
      path.join(extractRoot, GodotExtract.EXTRACT_META),
      JSON.stringify({ sourcePath: entry.moduleData.packPath, extractedAt: Date.now() }),
      "utf8"
    );

    const target = GodotModule.__test.resolveLaunchTarget(entry, {
      preferExtracted: true,
      userDataDir
    });
    assert.equal(target.kind, "project");
    assert.equal(target.path, extractRoot);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("resolveLaunchTarget preserves standard embedded pack trailers", () => {
  const userDataDir = makeTempDir("maclauncher-godot-launch-");
  const sourceRoot = makeTempDir("maclauncher-godot-source-");
  try {
    const pack = Buffer.concat([buildPckHeader({ major: 4, minor: 6, patch: 0 }), Buffer.alloc(8, 1)]);
    const embedded = buildEmbeddedElfPack(pack);
    const sourcePath = path.join(sourceRoot, "Game.x86_64");
    fs.writeFileSync(sourcePath, embedded.buffer);

    const entry = {
      gameId: "game-godot",
      gamePath: sourcePath,
      moduleData: {
        packPath: sourcePath,
        packOffset: embedded.offset,
        packSize: embedded.size
      }
    };

    const target = GodotModule.__test.resolveLaunchTarget(entry, { userDataDir });
    assert.equal(target.kind, "pack");
    assert.equal(target.path, sourcePath);
    assert.deepEqual(fs.readFileSync(target.path), embedded.buffer);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test("installRuntime skips download when the version is already installed", async () => {
  const userDataDir = makeTempDir("maclauncher-godot-installed-");
  const manager = GodotModule.runtimeManagers[0];
  const originalInstall = manager.installRuntime;
  try {
    const installDir = path.join(
      userDataDir,
      "runtimes",
      "godot",
      "3.4.1-stable",
      "mono"
    );
    createGodotApp(path.join(installDir, "Godot.app"));

    manager.installRuntime = () => {
      throw new Error("installRuntime should not be called");
    };

    const entry = {
      moduleData: {
        detectedVersion: "3.4.1",
        detectedMajor: 3
      },
      runtimeData: {}
    };
    const result = await GodotModule.actions.installRuntime(entry, { version: "3.4.1-stable" }, {
      settings: { runtimes: { godot: {} } },
      userDataDir
    });
    assert.equal(result.version, "3.4.1-stable");
    assert.equal(entry.runtimeData.godot.version, "3.4.1-stable");
  } finally {
    manager.installRuntime = originalInstall;
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("runtimeStatus resolves installed x.y slugs for x.y.0 detection", () => {
  const userDataDir = makeTempDir("maclauncher-godot-installed-");
  try {
    const installDir = path.join(
      userDataDir,
      "runtimes",
      "godot",
      "4.4-stable",
      "mono",
      "Godot.app"
    );
    createGodotApp(installDir);

    const entry = {
      moduleData: {
        detectedVersion: "4.4.0",
        detectedMajor: 4
      },
      runtimeData: {}
    };
    const status = GodotModule.actions.runtimeStatus(entry, {}, {
      settings: { runtimes: { godot: {} } },
      userDataDir
    });
    assert.equal(status.installed, true);
    assert.equal(status.ready, true);
    assert.equal(status.resolvedVersion, "4.4-stable");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("installRuntime falls back to detected version when payload is empty", async () => {
  const userDataDir = makeTempDir("maclauncher-godot-installed-");
  const manager = GodotModule.runtimeManagers[0];
  const originalInstall = manager.installRuntime;
  try {
    const installDir = path.join(
      userDataDir,
      "runtimes",
      "godot",
      "4.4-stable",
      "mono",
      "Godot.app"
    );
    createGodotApp(installDir);

    manager.installRuntime = () => {
      throw new Error("installRuntime should not be called");
    };

    const entry = {
      moduleData: {
        detectedVersion: "4.4.0",
        detectedMajor: 4
      },
      runtimeData: {}
    };
    const result = await GodotModule.actions.installRuntime(entry, {}, {
      settings: { runtimes: { godot: {} } },
      userDataDir
    });
    assert.equal(result.version, "4.4-stable");
    assert.deepEqual(entry.runtimeData, {});
  } finally {
    manager.installRuntime = originalInstall;
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("parseGdreOutput captures engine and bytecode versions", () => {
  const output = [
    "Detected Engine Version: 3.4.1",
    "Detected Bytecode Revision: 3.2.0-stable (5565f55)",
    "Version: 3.4.1"
  ].join("\n");
  const parsed = GodotModule.__test.parseGdreOutput(output, "");
  assert.equal(parsed.detectedVersion, "3.4.1");
  assert.equal(parsed.detectedMajor, 3);
  assert.equal(parsed.detectedBytecodeVersion, "3.2.0-stable");
  assert.equal(parsed.detectedBytecodeRevision, "5565f55");
});

test("resolveExtractedIconPath prefers root icon.png", () => {
  const root = makeTempDir("maclauncher-godot-icon-");
  try {
    const iconPath = path.join(root, "Icon.png");
    const icoPath = path.join(root, "game.ico");
    fs.writeFileSync(iconPath, "icon");
    fs.writeFileSync(icoPath, "ico");
    const resolved = GodotModule.__test.resolveExtractedIconPath(root);
    assert.equal(resolved, iconPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveExtractedIconPath falls back to root ico", () => {
  const root = makeTempDir("maclauncher-godot-icon-");
  try {
    const icoPath = path.join(root, "game.ico");
    fs.writeFileSync(icoPath, "ico");
    const resolved = GodotModule.__test.resolveExtractedIconPath(root);
    assert.equal(resolved, icoPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveExtractedIconPath recurses for icon.png", () => {
  const root = makeTempDir("maclauncher-godot-icon-");
  try {
    const iconPath = path.join(root, "assets", "ui", "icon.png");
    fs.mkdirSync(path.dirname(iconPath), { recursive: true });
    fs.writeFileSync(iconPath, "icon");
    const resolved = GodotModule.__test.resolveExtractedIconPath(root);
    assert.equal(resolved, iconPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("applyExtractedIcon caches icon into game data", () => {
  const userDataDir = makeTempDir("maclauncher-godot-icon-cache-");
  const extractedRoot = makeTempDir("maclauncher-godot-extracted-");
  try {
    const iconPath = path.join(extractedRoot, "icon.png");
    fs.writeFileSync(iconPath, "icon");
    const entry = { gameId: "game-godot", moduleData: {} };
    const cached = GodotModule.__test.applyExtractedIcon(entry, {
      userDataDir,
      extractedRoot
    });
    const expected = GodotModule.__test.resolveIconCachePath(entry, userDataDir, iconPath);
    assert.equal(cached, expected);
    assert.ok(fs.existsSync(expected));
    assert.equal(entry.moduleData.extractedOverridesFromExtraction, true);
    assert.equal(entry.moduleData.extractedIconPath, expected);
    assert.equal(entry.iconPath, expected);
    assert.equal(entry.iconSource, "module");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(extractedRoot, { recursive: true, force: true });
  }
});

test("Godot major Auto, status and install reuse the selected ready variant without creating a pin", async t => {
  const root = makeTempDir("maclauncher-godot-auto-"); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const core = GodotModule.runtimeManagers[0].core;
  for (const [version, variant, valid] of [["4.4-stable", "standard", true], ["4.5-stable", "mono", true], ["4.6-stable", "standard", false]]) {
    const app = path.join(root, "runtimes/godot", version, variant, "Godot.app");
    if (valid) createGodotApp(app); else fs.mkdirSync(app, { recursive: true });
  }
  t.mock.method(GodotModule.runtimeManagers[0], "refreshCatalog", () => assert.fail("Ready compatible Godot Auto stays offline"));
  t.mock.method(GodotModule.runtimeManagers[0], "installRuntime", () => assert.fail("Ready compatible Godot Auto does not install"));
  const settings = { runtimes: { godot: { defaultVersion: "3.2-stable", defaultVariant: "mono" } } };
  const entry = { moduleData: { detectedMajor: 4 }, runtimeData: { godot: { variant: "standard" } } }, before = structuredClone(entry);
  const context = { userDataDir: root, settings, runtimeId: "godot" };
  assert.equal(GodotModule.onImport, undefined); // Detection is not a per-game version choice.
  const status = GodotModule.actions.runtimeStatus(entry, {}, context);
  assert.equal(status.resolvedVersion, "4.4-stable"); assert.equal(status.requiredVariant, "standard"); assert.equal(status.ready, true);
  assert.equal(await GodotModule.ensureRuntime(entry, context), null);
  assert.equal((await GodotModule.actions.installRuntime(entry, { status }, context)).version, "4.4-stable");
  assert.deepEqual(entry.runtimeData, before.runtimeData);
  assert.equal(core.listInstalled(root).find(item => item.version === "4.6-stable").ready, false);
  const unknown = { moduleData: { detectedMajor: null }, runtimeData: { godot: { variant: "standard" } } };
  assert.equal(await GodotModule.ensureRuntime(unknown, context), null);
  assert.equal(GodotModule.actions.runtimeStatus(unknown, {}, context).resolvedVersion, "4.4-stable");
});
