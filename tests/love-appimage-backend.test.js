const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const ChildProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

test("backend AppImage launches retain successful extraction through metadata refresh and invalidate changed sources", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "love-appimage-backend-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "profile"), source = path.join(root, "game.AppImage");
  const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  write(source, "original package");
  fs.utimesSync(source, 1700000000, 1700000000);
  const install = path.join(userDataDir, "runtimes/love/stable/11.5"), app = path.join(install, "love.app");
  const executable = path.join(app, "Contents/MacOS/love");
  write(executable, "#!/bin/sh\nexit 0\n"); fs.chmodSync(executable, 0o755);
  write(path.join(app, "Contents/Info.plist"), '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>love</string><key>CFBundleShortVersionString</key><string>11.5</string></dict></plist>');
  write(path.join(install, ".maclauncher-love.json"), JSON.stringify({ channel: "stable", version: "11.5", bundleVersionRaw: "11.5", bundleVersionNormalized: "11.5", source: "GitHub Releases" }));
  const children = [], launches = [];
  t.mock.method(ChildProcess, "spawn", (command, args, options) => {
    assert.equal(command, executable);
    launches.push({ args, cwd: options.cwd });
    const child = Object.assign(new EventEmitter(), { pid: 70000 + children.length, exitCode: null, signalCode: null, unref() {} });
    children.push(child); process.nextTick(() => child.emit("spawn"));
    return child;
  });
  const { createBackendOperations } = require("../src/core/backend-operations");
  const Love = require("../src/modules/love/main"), SevenZip = require("../src/modules/shared/runtime/sevenzip");
  const GameStore = require("../src/core/game-store");
  let detections = 0, extractions = 0, outcome = "success", operations;
  const registry = {
    listModuleIds: () => ["love"], listModules: () => [Love.manifest], getModule: () => Love,
    getModuleInfo: () => Love.manifest, getModuleDir: () => path.resolve(__dirname, "../src/modules/love"),
    listSharedRuntimeManagers: () => [], getLegacyRuntimeSettingAliases: () => [],
    detectGameAsync: async inputPath => {
      detections++;
      return Love.detectGame({ inputPath, rootDir: path.dirname(inputPath), stat: fs.statSync(inputPath) });
    }
  };
  t.mock.method(SevenZip, "listArchiveEntriesSync", () => [{ path: "bin/game" }, { path: "lib/liblove-11.5.so" }]);
  t.mock.method(SevenZip, "extractArchive", async (file, destination) => {
    assert.equal(file, source); extractions++;
    write(path.join(destination, "bin/game"), "extracted game");
    if (outcome === "failure") throw Error("fixture extraction failed");
    if (outcome === "cancel") assert.equal(operations.cancelLaunch(entry), true);
    if (outcome === "changed") fs.appendFileSync(source, "changed during extraction");
  });
  const entry = { gameId: "appimage", moduleId: "love", engine: "love", gameType: "engine", gamePath: source,
    importPath: source, contentRootDir: root, runtimeId: "love", networkAccess: true,
    runtimeData: { love: { channel: "stable", version: "11.5" } }, notes: "preserve notes", moduleData: {} };
  GameStore.writeGameRecord(userDataDir, entry);
  const settings = { modules: { love: {} }, runtimes: { love: {} }, launcher: { startSteamClient: false } };
  operations = createBackendOperations({ userDataDir, registry });
  const launch = async () => {
    const result = await operations.launchEntry(entry, { settings });
    if (result.kind === "process") {
      const child = children.at(-1); child.exitCode = 0; child.emit("exit", 0, null); child.emit("close", 0, null);
      await new Promise(resolve => setImmediate(resolve));
    }
    return { result, saved: GameStore.readGameRecord(userDataDir, entry.gameId) };
  };
  const cold = await launch();
  assert.equal(cold.result.kind, "process"); assert.equal(extractions, 1); assert.ok(detections >= 1);
  assert.equal(cold.saved.moduleData.appImageReady, true);
  const identity = cold.saved.moduleData.appImageSourceIdentity, extractedAt = cold.saved.moduleData.appImageExtractedAt;
  for (const stage of ["warm", "steady"]) {
    const next = await launch();
    assert.equal(next.result.kind, "process", stage); assert.equal(extractions, 1, stage);
    assert.equal(next.saved.moduleData.appImageSourceIdentity, identity);
    assert.equal(next.saved.moduleData.appImageExtractedAt, extractedAt);
    assert.equal(next.saved.moduleData.launchTargetPath, cold.saved.moduleData.launchTargetPath);
    assert.equal(next.saved.notes, entry.notes); assert.equal(next.saved.gamePath, source); assert.equal(next.saved.importPath, source);
  }
  assert.equal(launches.length, 3);
  const beforeRewrite = fs.statSync(source, { bigint: true }), bytes = fs.readFileSync(source);
  bytes[0] ^= 1; fs.writeFileSync(source, bytes);
  fs.utimesSync(source, Number(beforeRewrite.atimeNs) / 1e9, Number(beforeRewrite.mtimeNs) / 1e9);
  const afterRewrite = fs.statSync(source, { bigint: true });
  assert.equal(afterRewrite.ino, beforeRewrite.ino); assert.equal(afterRewrite.size, beforeRewrite.size);
  assert.equal(afterRewrite.mtimeNs, beforeRewrite.mtimeNs, "The source mtime really was restored");
  assert.notEqual(afterRewrite.ctimeNs, beforeRewrite.ctimeNs);
  await launch(); assert.equal(extractions, 2, "Changed ctime invalidates same-size packages with restored mtime");
  fs.appendFileSync(source, "new package bytes"); const beforeChange = detections;
  const changed = await launch();
  assert.ok(detections > beforeChange); assert.equal(extractions, 3);
  assert.notEqual(changed.saved.moduleData.appImageSourceIdentity, identity);
  fs.rmSync(changed.saved.moduleData.launchTargetPath);
  await launch(); assert.equal(extractions, 4, "Missing extracted output is rebuilt");
  for (outcome of ["failure", "cancel", "changed"]) {
    fs.appendFileSync(source, outcome);
    const before = GameStore.readGameRecord(userDataDir, entry.gameId).moduleData;
    if (outcome === "cancel") assert.equal((await launch()).result.kind, "cancelled");
    else await assert.rejects(launch, outcome === "failure" ? /fixture extraction failed/ : /AppImage changed during extraction/);
    const saved = GameStore.readGameRecord(userDataDir, entry.gameId).moduleData;
    assert.equal(saved.appImageReady, false);
    assert.equal(saved.appImageSourceIdentity, before.appImageSourceIdentity, "Failed preparation cannot publish new source identity");
    assert.equal(saved.appImageExtractedAt, before.appImageExtractedAt, "Failed preparation cannot publish extraction time");
  }
  outcome = "success";
  require("./helpers/held-file-times.cjs").holdFileTimes(t, [source]);
  const beforeCoarse = extractions;
  for (const stage of ["coarse", "coarse warm"]) {
    const prepared = await launch();
    assert.equal(prepared.result.kind, "process", stage);
    assert.equal(prepared.saved.moduleData.appImageSourceIdentity, undefined, "Coarse times cannot authorize extraction reuse");
  }
  assert.equal(extractions, beforeCoarse + 2, "Coarse timestamps retain conservative extraction on every launch");
});
