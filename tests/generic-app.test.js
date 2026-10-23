const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const mod = require("../src/modules/generic-app/main");
const { resolveEntryApp, removeQuarantine } = require("../src/modules/shared/runtime/app-maintenance");
const { ARM64, X64, image, universal } = require("./fixtures/macho-image");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-app-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, "Test Space;$(command).app");
  fs.mkdirSync(path.join(appPath, "Contents/MacOS"), { recursive: true });
  fs.writeFileSync(path.join(appPath, "Contents/MacOS/runner"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(appPath, "Contents/Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>runner</string><key>CFBundleShortVersionString</key><string>1.2.3</string></dict></plist>');
  return appPath;
}

test("generic app recognizes a declared executable and records app version", t => {
  const appPath = fixture(t);
  const detected = mod.detectGame({ rootDir: appPath, isAppBundle: true });
  assert.equal(detected.moduleId, "generic-app");
  assert.equal(detected.nativeAppPath, appPath);
  assert.equal(detected.moduleData.bundleVersion, "1.2.3");
  assert.equal(mod.detectGame({ rootDir: appPath, isAppBundle: false }), null);
  fs.rmSync(path.join(appPath, "Contents/MacOS/runner"));
  assert.equal(mod.detectGame({ rootDir: appPath, isAppBundle: true }), null);
});

test("explicit shell entrypoints retain their selected file and do not require executable permission", t => {
  const root = path.dirname(fixture(t));
  for (const extension of [".sh", ".command", ".bash", ".zsh"]) {
    const executablePath = path.join(root, `Game Space;$(command)${extension}`);
    const source = "printf '%s\\n' 'launch'\n";
    fs.writeFileSync(executablePath, source, { mode: 0o644 });
    const detected = mod.detectGame({ inputPath: executablePath, rootDir: root, stat: fs.statSync(executablePath) });
    assert.equal(detected.moduleId, "generic-app");
    assert.equal(detected.name, "Game Space;$(command)");
    assert.equal(detected.gamePath, executablePath);
    assert.equal(detected.contentRootDir, root);
    assert.equal(detected.nativeAppPath, undefined);
    assert.deepEqual(detected.moduleData, { executablePath, launchKind: "script" });
    assert.equal(mod.resolveNativeLaunchPath(detected), executablePath);
    assert.equal(fs.readFileSync(executablePath, "utf8"), source);
    assert.equal(fs.statSync(executablePath).mode & 0o111, 0);
  }
  const binary = path.join(root, "binary.sh");
  fs.writeFileSync(binary, Buffer.from([127, 69, 76, 70, 0]));
  assert.equal(mod.detectGame({ inputPath: binary }), null);
  assert.equal(mod.detectGame({ inputPath: root, stat: fs.statSync(root) }), null);
  assert.equal(mod.resolveNativeLaunchPath({ gamePath: root, moduleData: { launchKind: "script" } }), null);
  assert.equal(mod.resolveNativeLaunchPath({ gamePath: path.join(root, "missing.sh"), moduleData: { launchKind: "script" } }), null);
  assert.equal(mod.resolveNativeLaunchPath({ nativeAppPath: "App.app" }, { resolveNativeLaunchPath: entry => entry.nativeAppPath }), "App.app");
});

test("Make executable changes only the selected script's permission bits and preserves content", t => {
  const root = path.dirname(fixture(t)), executablePath = path.join(root, "Game Space;$(command).sh");
  const otherPath = path.join(root, "other.sh"), source = "#!/bin/sh\nprintf '%s\\n' launch\n";
  fs.writeFileSync(executablePath, source, { mode: 0o640 });
  fs.writeFileSync(otherPath, source, { mode: 0o640 });
  const entry = mod.detectGame({ inputPath: executablePath });
  const before = fs.statSync(executablePath).mode & 0o7777;
  const result = mod.actions.makeExecutable(entry);
  assert.deepEqual(result, { executable: true, executablePath });
  assert.equal(fs.statSync(executablePath).mode & 0o7777, before | 0o111);
  assert.equal(fs.readFileSync(executablePath, "utf8"), source);
  assert.equal(fs.statSync(otherPath).mode & 0o111, 0);
  assert.deepEqual(mod.actions.makeExecutable(entry), result);
  assert.throws(() => mod.actions.makeExecutable({ ...entry, moduleData: { ...entry.moduleData, executablePath: otherPath } }), /imported script/);
  assert.throws(() => mod.actions.makeExecutable({ ...entry, moduleData: { ...entry.moduleData, launchKind: "executable" } }), /imported script/);
  assert.throws(() => mod.actions.makeExecutable({ gamePath: root, moduleData: { launchKind: "script", executablePath: root } }), /regular file/);
  const action = mod.manifest.ui.actions.find(action => action.id === "makeExecutable");
  assert.equal(action.label, "Make executable");
  assert.equal(action.kind, "primary");
  assert.ok(mod.manifest.ui.actionGroups.some(group => group.actions.includes(action.id)));
});

test("other executable shebang files are recognized from a bounded prefix without executing them", t => {
  const root = path.dirname(fixture(t)), executablePath = path.join(root, "launch");
  const source = "#!/usr/bin/env -S python3 -u\nraise RuntimeError('must not execute during detection')\n";
  fs.writeFileSync(executablePath, source, { mode: 0o755 });
  let reads = 0;
  const detected = mod.detectGame({ inputPath: executablePath, detection: {
    stat: fs.statSync,
    readBytes: (file, start, length) => {
      reads++;
      assert.equal(start, 0);
      assert.ok(length <= 4096);
      return fs.readFileSync(file).subarray(start, start + length);
    }
  } });
  assert.equal(reads, 1);
  assert.equal(detected.moduleData.launchKind, "script");
  assert.equal(detected.moduleData.executablePath, executablePath);
  fs.chmodSync(executablePath, 0o644);
  assert.equal(mod.detectGame({ inputPath: executablePath }), null);
  fs.writeFileSync(executablePath, "ordinary text");
  fs.chmodSync(executablePath, 0o755);
  assert.equal(mod.detectGame({ inputPath: executablePath }), null);
});

test("standalone Mach-O recognition requires an executable image and permission, excluding libraries and ELF files", t => {
  const root = path.dirname(fixture(t)), executablePath = path.join(root, "native-game");
  fs.writeFileSync(executablePath, image({ cpu: ARM64, fileType: 2, installName: null }), { mode: 0o755 });
  const detected = mod.detectGame({ inputPath: executablePath });
  assert.equal(detected.moduleData.launchKind, "executable");
  assert.deepEqual(detected.moduleData.executableArchitectures, ["arm64"]);
  assert.equal(detected.gamePath, executablePath);
  fs.chmodSync(executablePath, 0o644);
  assert.equal(mod.detectGame({ inputPath: executablePath }), null);
  fs.chmodSync(executablePath, 0o755);
  fs.writeFileSync(executablePath, image({ cpu: ARM64, fileType: 6 }));
  assert.equal(mod.detectGame({ inputPath: executablePath }), null);
  fs.writeFileSync(executablePath, Buffer.from([127, 69, 76, 70, 0, 0, 0, 0]));
  assert.equal(mod.detectGame({ inputPath: executablePath }), null);
});

test("extensionless Mach-O files require a Mac executable in every thin or universal slice", t => {
  const root = path.dirname(fixture(t)), executablePath = path.join(root, "native-game");
  const detect = bytes => {
    fs.writeFileSync(executablePath, bytes, { mode: 0o755 });
    return mod.detectGame({ inputPath: executablePath });
  };
  for (const [cpu, platform] of [[ARM64, 1], [X64, 1], [ARM64, 6], [X64, 6]]) {
    const detected = detect(image({ cpu, platform, fileType: 2, installName: null }));
    assert.equal(detected?.moduleData.launchKind, "executable", `CPU ${cpu}, platform ${platform}`);
    assert.equal(detected.gamePath, executablePath);
  }
  const slice = (cpu, platform, fileType = 2) => ({ cpu, bytes: image({ cpu, platform, fileType, installName: null }) });
  const mac = detect(universal([slice(ARM64, 1), slice(X64, 1)]));
  assert.deepEqual(mac?.moduleData.executableArchitectures, ["arm64", "x86_64"]);
  for (const platform of [0, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 15, 0xffffffff]) {
    assert.equal(detect(image({ cpu: ARM64, platform, fileType: 2 })), null, `non-Mac platform ${platform}`);
    assert.equal(detect(universal([slice(X64, 1), slice(ARM64, platform)])), null, `mixed universal platform ${platform}`);
  }
  for (const command of [0x25, 0x2f, 0x30]) {
    const legacy = image({ cpu: ARM64, fileType: 2, legacyVersion: true });
    legacy.writeUInt32LE(command, 32);
    assert.equal(detect(legacy), null, `legacy non-Mac deployment command ${command}`);
  }
  assert.equal(detect(universal([slice(X64, 1), slice(ARM64, 1, 6)])), null, "universal library slice");
  for (const cpu of [12, 0x01000012 + 1]) {
    assert.equal(detect(image({ cpu, platform: 1, fileType: 2 })), null, `non-Mac CPU ${cpu}`);
  }
});

test("legacy and static Mac executables can omit deployment or dynamic-loader commands", t => {
  const root = path.dirname(fixture(t)), executablePath = path.join(root, "legacy-game");
  for (const cpu of [ARM64, X64, 7, 18, 0x01000012]) {
    const options = { cpu, little: ![18, 0x01000012].includes(cpu), fileType: 2, installName: null, dependencies: [] };
    for (const version of [{ platform: null }, { legacyVersion: true }]) {
      fs.writeFileSync(executablePath, image({ ...options, ...version }), { mode: 0o755 });
      const detected = mod.detectGame({ inputPath: executablePath });
      assert.equal(detected?.moduleData.launchKind, "executable", `CPU ${cpu}, ${JSON.stringify(version)}`);
    }
  }
  const legacy = { cpu: X64, bytes: image({ cpu: X64, fileType: 2, platform: null, installName: null, dependencies: [] }) };
  const modern = { cpu: ARM64, bytes: image({ cpu: ARM64, fileType: 2, platform: 1, installName: null }) };
  fs.writeFileSync(executablePath, universal([legacy, modern]));
  assert.deepEqual(mod.detectGame({ inputPath: executablePath })?.moduleData.executableArchitectures, ["x86_64", "arm64"]);
  fs.writeFileSync(executablePath, image({ cpu: 12, fileType: 2, platform: null }));
  assert.equal(mod.detectGame({ inputPath: executablePath }), null, "legacy ARM32 is not a Mac target");
});

test("an executable bit never makes arbitrary extensionless data a native Mac game", t => {
  const root = path.dirname(fixture(t)), executablePath = path.join(root, "unmarked");
  const invalid = [
    ["text", Buffer.from("ordinary executable-bit text\n")],
    ["data", Buffer.from([1, 2, 3, 4, 0, 0])],
    ["ELF", Buffer.from([127, 69, 76, 70, 2, 1, 1, 0])],
    ["PE", Buffer.concat([Buffer.from("MZ"), Buffer.alloc(128)])],
    ["Java class magic", Buffer.from("cafebabe000000410001", "hex")],
    ["truncated Mach-O", image({ fileType: 2 }).subarray(0, 24)],
    ["truncated universal", universal([{ cpu: ARM64, bytes: image({ fileType: 2 }) }]).subarray(0, 24)],
    ...[1, 4, 6, 7, 8].map(fileType => [`Mach-O type ${fileType}`, image({ fileType })])
  ];
  for (const [label, bytes] of invalid) {
    fs.writeFileSync(executablePath, bytes, { mode: 0o755 });
    assert.equal(mod.detectGame({ inputPath: executablePath }), null, label);
  }
});

test("32-bit Intel apps select mac32 while native 64-bit apps and scripts retain native playback", t => {
  const appPath = fixture(t), executable = path.join(appPath, "Contents/MacOS/runner");
  for (const cpus of [[7], [7, 18], [7, X64], [ARM64], [18]]) {
    const slices = cpus.map(cpu => ({ cpu, bytes: image({ cpu, fileType: 2, installName: null, little: cpu !== 18 }) }));
    fs.writeFileSync(executable, slices.length === 1 ? slices[0].bytes : universal(slices));
    const detected = mod.detectGame({ rootDir: appPath, isAppBundle: true });
    assert.equal(detected.runtimeData.mac32.detectionComplete, true);
    assert.equal(detected.runtimeData.mac32.executablePath, executable);
    const legacy = cpus.includes(7) && !cpus.includes(X64) && !cpus.includes(ARM64);
    assert.equal(mod.resolveDefaultRuntime(detected), legacy ? "mac32" : "native");
    assert.deepEqual(mod.filterRuntimeSupport(detected, ["native"]), legacy ? [] : ["native"]);
    assert.equal(mod.mergeEntry(null, { ...detected, runtimeId: "native" }).runtimeId, legacy ? "mac32" : "native");
  }
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  const script = mod.detectGame({ rootDir: appPath, isAppBundle: true });
  assert.deepEqual(script.runtimeData.mac32.executableArchitectures, []);
  assert.equal(mod.resolveDefaultRuntime(script), "native");
});

test("a specific engine keeps precedence over the 32-bit app fallback", t => {
  const appPath = fixture(t);
  fs.writeFileSync(path.join(appPath, "Contents/MacOS/runner"), image({ cpu: 7, fileType: 2 }));
  const engine = { id: "specific-engine", manifest: { id: "specific-engine", label: "Specific engine",
    detection: { inputKinds: ["app"] } }, detectGame: () => ({ engine: "specific-engine",
    moduleId: "specific-engine", gamePath: appPath, name: "Specific game", runtimeId: "engine-player" }) };
  const report = require("../src/modules/detection").explainDetection(appPath, [engine, mod]);
  assert.equal(report.detected.moduleId, "specific-engine");
  assert.equal(report.detected.runtimeId, "engine-player");
});

test("extensionless application repair resolves the original publisher folder", t => {
  const named = fixture(t), appPath = path.join(path.dirname(named), "Publisher Game");
  fs.renameSync(named, appPath);
  const plist = path.join(appPath, "Contents/Info.plist");
  fs.writeFileSync(plist, fs.readFileSync(plist, "utf8").replace("<dict>", "<dict><key>CFBundlePackageType</key><string>APPL</string>"));
  assert.equal(resolveEntryApp({ nativeAppPath: appPath }), appPath);
  fs.unlinkSync(path.join(appPath, "Contents/MacOS/runner"));
  assert.equal(resolveEntryApp({ nativeAppPath: appPath }), null);
});

test("quarantine removal is an explicit exact-argv backend operation on the game's app", async t => {
  const appPath = fixture(t);
  const entry = { gamePath: "/game/data", nativeAppPath: appPath };
  assert.equal(resolveEntryApp(entry), appPath);
  let calls = 0;
  const result = await removeQuarantine(entry, { platform: "darwin", execute: (command, args, options, callback) => {
    calls++;
    assert.equal(command, "/usr/bin/xattr");
    assert.deepEqual(args, ["-dr", "com.apple.quarantine", appPath]);
    assert.equal(options.shell, false);
    callback(null, "", "");
  } });
  assert.equal(calls, 1);
  assert.equal(result.quarantineRemoved, true);
  await assert.rejects(removeQuarantine(entry, { platform: "linux" }), /macOS/);
  await assert.rejects(removeQuarantine({ gamePath: "/missing.app" }, { platform: "darwin" }), /not found/);
});

test("xattr failures are reported and removal leaves unrelated attributes intact", async t => {
  const appPath = fixture(t);
  await assert.rejects(removeQuarantine({ gamePath: appPath }, { platform: "darwin", execute: (_cmd, _args, _opts, cb) => cb(new Error("failed"), "", "Permission denied") }), /Permission denied/);
  if (process.platform !== "darwin") return;
  execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;MacLauncher;test", appPath]);
  execFileSync("/usr/bin/xattr", ["-w", "org.maclauncher.test", "keep", appPath]);
  await removeQuarantine({ gamePath: appPath });
  const attributes = execFileSync("/usr/bin/xattr", [appPath], { encoding: "utf8" });
  assert.equal(attributes.includes("com.apple.quarantine"), false);
  assert.match(attributes, /org.maclauncher.test/);
});
