const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const PlayCover = require("../src/modules/ios/runtime/manager");

test("PlayCover has no package-wide setup version and explicit installation preserves selections", async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "playcover-first-use-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const runtime = PlayCover.createManager({ dependencies: { systemVersionSync: () => "27.0" }, catalogDependencies: {
    fetchGithubTags: async () => { throw new Error("Unexpected catalog request"); },
    fetchGithubReleases: async () => { throw new Error("Unexpected catalog request"); }
  } });
  const state = runtime.getState({ userDataDir });
  assert.deepEqual(state.catalog.versions, [], "recommended setup is separate from the remote release list");
  assert.equal(state.catalog.installReason, null, "first use must not suggest unsupported manual imports");
  assert.match(state.sections[0].description, /MacLauncher handles/);
  assert.equal(runtime.label, "PlayCover");
  assert.equal(state.catalog.sourceUrl, "https://github.com/PlayCover/PlayCover/releases");
  assert.deepEqual(state.sections[0].setupActions, []);
  assert.equal(runtime.resolveSelection({}, {}, userDataDir).version, null);
  let installs = 0;
  runtime.installRuntime = async options => {
    installs++; if (options.version != null) assert.equal(options.version, "4.0.0-prerelease"); assert.equal(options.userDataDir, userDataDir);
    return { version: options.version || "4.0.0-prerelease", source: "download", ready: true };
  };
  const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");
  let settings = { defaultVersion: "3.1.0" };
  const setup = () => runRuntimeManagerAction({ manager: runtime, action: "setup", userDataDir,
    payload: { setupActionId: "installRecommended", toolVersion: "4.0.0-prerelease" },
    readSettings: () => settings, saveSettings: next => { settings = next; } });
  const result = await setup();
  assert.match(result.message, /ready/);
  assert.equal(settings.defaultVersion, "3.1.0");
  settings = {};
  await setup();
  assert.equal(settings.defaultVersion, "4.0.0-prerelease");
  await runtime.performSetupAction({ userDataDir, setupActionId: "installRecommended" });
  assert.equal(installs, 3);
});

test("declining the first PlayCover download leaves the game and runtime untouched", async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "playcover-decline-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const mod = require("../src/modules/ios/main"), { prepareForLaunch } = require("../src/core/runtime-preparation");
  let prompts = 0;
  const ready = await prepareForLaunch({ entry: { gameId: "owned", moduleData: {} }, mod, info: mod.manifest,
    registry: { listModules: () => [mod], getModule: () => mod },
    context: { userDataDir, settings: {}, runtimeId: "playcover", confirmRuntimeInstall: async plan => {
      prompts++; assert.equal(plan.managerId, "playcover"); return false;
    } },
    install: () => { throw new Error("Installation must wait for consent"); },
    runAction: () => { throw new Error("Preparation must wait for consent"); }
  });
  assert.equal(ready, false); assert.equal(prompts, 1);
  assert.deepEqual(fs.readdirSync(userDataDir), []);
});

test("PlayCover discovers labeled prereleases on explicit refresh and preserves stable selections", async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "playcover-catalog-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  let requests = 0;
  const tags = ["v4.0.0-prerelease", "v3.1.0", "v4.0.0-rc.2", "v2.0.0", "nightly"];
  const runtime = PlayCover.createManager({ dependencies: { systemVersionSync: () => "27.0" }, catalogDependencies: {
    fetchGithubTags: async ({ repo }) => {
      assert.equal(repo, "PlayCover");
      return tags.map(name => ({ name, commit: { sha: PlayCover.core.catalog.find(pin => pin.version === name.replace(/^v/, ""))?.upstreamRevision || "a".repeat(40) } }));
    },
    fetchGithubReleases: async ({ repo, includePrerelease }) => {
      requests++; assert.equal(includePrerelease, true); assert.equal(repo, "PlayCover");
      return tags.map(tag_name => ({ tag_name, prerelease: tag_name.includes("-"),
        assets: tag_name === "v2.0.0" ? [] : [{ id: 42, name: `PlayCover_${tag_name}.dmg`,
          browser_download_url: `https://github.com/PlayCover/PlayCover/releases/download/${tag_name}/PlayCover_${tag_name}.dmg`,
          digest: `sha256:${"b".repeat(64)}` }] }));
    },
    fetchUrlBuffer: async () => assert.fail("PlayCover releases do not require PlayTools version matching"),
  } });
  runtime.getState({ userDataDir });
  assert.equal(runtime.resolveSelection({}, {}, userDataDir).version, null);
  assert.equal(requests, 0, "reading Settings and missing selections must stay offline");
  const settings = runtime.applySettingsUpdate("setDefault", { version: "3.1.0" }, {});
  await runtime.refreshCatalog({ userDataDir });
  const state = runtime.getState({ userDataDir, settings });
  assert.deepEqual(state.catalog.versions, ["4.0.0-prerelease", "3.1.0", "4.0.0-rc.2", "2.0.0"]);
  assert.equal(requests, 1);
  assert.ok(state.catalog.installableVersions.includes("4.0.0-rc.2"), "published PlayCover disk images are directly installable");
  assert.ok(!state.catalog.installableVersions.includes("2.0.0"));
  assert.match(state.catalog.versionRequirements["2.0.0"].installReason, /no PlayCover disk image/);
  assert.match(state.versionLabels["4.0.0-prerelease"], /Pre-release/);
  assert.match(state.versionLabels["4.0.0-rc.2"], /Pre-release/);
  assert.equal(state.versionLabels["3.1.0"], "3.1.0");
  assert.equal(Object.hasOwn(state.catalog, "recommendedVersion"), false);
  assert.equal(runtime.resolveSelection({}, { runtimes: { playcover: settings } }, userDataDir).version, "3.1.0");
  const older = PlayCover.createManager({ dependencies: { systemVersionSync: () => "15.7" } });
  assert.equal(older.resolveSelection({}, {}, userDataDir).version, "3.1.0");
  const fresh = PlayCover.createManager({ dependencies: { systemVersionSync: () => "27.0" } });
  assert.deepEqual(fresh.getState({ userDataDir }).catalog.versions, state.catalog.versions, "the PlayCover list persists offline");
});

// Small real Mach-O load-command tables exercise dependency discovery without
// executing code or relying on a downloaded publisher artifact.
function library(references = []) {
  const build = Buffer.alloc(24); build.writeUInt32LE(0x32); build.writeUInt32LE(24, 4); build.writeUInt32LE(6, 8);
  const commands = [build, ...references.map(name => {
    const string = Buffer.from(name + "\0"), command = Buffer.alloc(Math.ceil((24 + string.length) / 8) * 8);
    command.writeUInt32LE(0x80000018); command.writeUInt32LE(command.length, 4); command.writeUInt32LE(24, 8); string.copy(command, 24); return command;
  })];
  const header = Buffer.alloc(32); header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(6, 12); header.writeUInt32LE(commands.length, 16); header.writeUInt32LE(commands.reduce((sum, b) => sum + b.length, 0), 20);
  return Buffer.concat([header, ...commands]);
}
test("PlayTools records bundled library closure and refuses missing or escaping dependencies", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playcover-libraries-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const frameworks = path.join(root, "PlayCover.app/Contents/Frameworks"), tools = path.join(frameworks, "PlayTools.framework/PlayTools");
  fs.mkdirSync(path.dirname(tools), { recursive: true });
  fs.writeFileSync(tools, library(["@rpath/compat.dylib"]));
  assert.throws(() => PlayCover.inspectPlayTools(root), /ENOENT/);
  const dependency = path.join(frameworks, "compat.dylib"), bytes = library(["/usr/lib/libSystem.B.dylib"]);
  fs.writeFileSync(dependency, bytes);
  assert.deepEqual(PlayCover.inspectPlayTools(root).playToolsDependencies, [{ name: "compat.dylib", sha256: crypto.createHash("sha256").update(bytes).digest("hex") }]);
  assert.deepEqual(PlayCover.inspectPlayTools(frameworks), PlayCover.inspectPlayTools(root), "standalone framework layout retains the dependency inventory");
  assert.equal(PlayCover.framework({ executablePath: path.join(root, "PlayCover.app/Contents/MacOS/PlayCover") }), path.dirname(tools));
  assert.equal(PlayCover.framework({ executablePath: tools }), path.dirname(tools));
  fs.writeFileSync(dependency, library(["@rpath/compat.dylib"]));
  assert.equal(PlayCover.inspectPlayTools(root).playToolsDependencies.length, 1, "cyclic references are bounded");
  fs.writeFileSync(tools, library(["@rpath/../outside.dylib"]));
  assert.throws(() => PlayCover.inspectPlayTools(root), /unsupported bundled library/);
  fs.writeFileSync(tools, library(["@rpath/compat.dylib"]));
  fs.unlinkSync(dependency); fs.symlinkSync(process.execPath, dependency);
  assert.throws(() => PlayCover.inspectPlayTools(root), /invalid or oversized/);
});

test("included PlayTools adapter redirects its container while preserving Foundation file I/O", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playtools-url-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { execFileSync } = require("node:child_process"), executable = path.join(root, "probe");
  execFileSync("/usr/bin/xcrun", ["swiftc", "-target", "arm64-apple-macosx12.0", "-module-cache-path", path.join(root, "modules"),
    path.join(__dirname, "fixtures/ios-playtools-paths.swift"), "-o", executable], { timeout: 60000, stdio: "pipe" });
  const helper = require("../src/modules/ios/runtime/storage-helper").resolveStorageHelper();
  const privateRoot = path.join(root, "home/Library/Containers/io.playcover.PlayCover");
  const output = execFileSync(executable, [privateRoot], { timeout: 10000, encoding: "utf8",
    env: { ...process.env, HOME: path.join(root, "home"), DYLD_INSERT_LIBRARIES: helper, MACLAUNCHER_PLAYTOOLS_ROOT: privateRoot } });
  assert.match(output, /scope and real Foundation persistence passed/);
  assert.equal(fs.readFileSync(path.join(privateRoot, "Keymapping/owned.plist"), "utf8"), "persisted original Foundation I/O");
});
