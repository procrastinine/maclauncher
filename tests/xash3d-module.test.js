// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("../src/modules/xash3d/main");
const {legacyGameMirrors} = require("../src/modules/xash3d/backcompat");
const Catalog = require("../src/modules/xash3d/runtime/catalog");
const Manager = require("../src/modules/xash3d/runtime/manager");
const Registry = require("../src/modules/registry");
const Architecture = require("../src/modules/shared/runtime/architecture");
const MachO = require("./fixtures/macho-image");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xash3d-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(file, text = "") { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
// A Half-Life folder as Steam installs it, without real game data.
function halfLife(root) {
  write(path.join(root, "hl.exe"), "MZ");
  write(path.join(root, "valve", "liblist.gam"), 'game "Half-Life"\ngamedll "dlls\\hl.dll"\ngamedll_osx "dlls/hl.dylib"\n');
  write(path.join(root, "valve", "halflife.wad"), "WAD3");
  write(path.join(root, "valve", "dlls", "hl.dll"), "MZ half-life");
  return root;
}
function detect(folder) { return Module.detectGame({ inputPath: folder, rootDir: folder, stat: fs.statSync(folder) }); }
function machO(file, cpu) {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(cpu, 4); bytes.writeUInt32LE(2, 12);
  write(file); fs.writeFileSync(file, bytes, { mode: 0o755 });
}

test("a Half-Life folder or its valve folder selects Half-Life in the folder", t => {
  const root = halfLife(path.join(temporary(t), "Half-Life"));
  for (const selected of [root, path.join(root, "valve")]) {
    const detected = detect(selected);
    assert.equal(detected.moduleId, "xash3d"); assert.equal(detected.runtimeId, "xash3d-fwgs");
    assert.equal(detected.gamePath, root); assert.equal(detected.contentRootDir, root); assert.equal(detected.name, "Half-Life");
    assert.deepEqual(detected.moduleData, { gameFolder: "valve", gameInfo: path.join("valve", "liblist.gam"), gameLibrary: "Half-Life" });
  }
  assert.equal(Registry.explainDetection(root).selectedModuleId, "xash3d");
  assert.notEqual(Registry.explainDetection(path.join(root, "hl.exe")).selectedModuleId, "xash3d", "The Windows executable keeps the Windows route");
  fs.rmSync(path.join(root, "valve", "halflife.wad"));
  assert.equal(detect(root), null, "Game data is required");
});

test("a mod runs natively only with Half-Life's game code or its own library for this engine", t => {
  const root = halfLife(path.join(temporary(t), "Half-Life")), mod = name => path.join(root, name);
  write(path.join(mod("maps"), "liblist.gam"), 'game "Map Pack"\ngamedll "dlls\\hl.dll"\n');
  write(path.join(mod("copied"), "gameinfo.txt"), 'title "Copied"\ngamedll "dlls/hl.dll"\n');
  write(path.join(mod("copied"), "dlls", "hl.dll"), "MZ half-life");
  write(path.join(mod("custom"), "liblist.gam"), 'game "Custom"\ngamedll "dlls\\hl.dll"\n');
  write(path.join(mod("custom"), "dlls", "hl.dll"), "MZ custom code");
  write(path.join(mod("gearbox"), "liblist.gam"), 'game "Opposing Force"\ngamedll "dlls\\opfor.dll"\n');
  write(path.join(mod("ported"), "liblist.gam"), 'game "Ported"\ngamedll "dlls\\ported.dll"\n');
  for (const [cpu, type] of [["arm64", MachO.ARM64], ["amd64", MachO.X64]])
    write(path.join(mod("ported"), "dlls", `ported_${cpu}.dylib`), MachO.image({ cpu: type }));
  assert.deepEqual([detect(mod("maps")).gamePath, detect(mod("maps")).contentRootDir, detect(mod("maps")).name], [mod("maps"), root, "Map Pack"]);
  assert.equal(detect(mod("copied")).moduleData.gameLibrary, "Half-Life");
  assert.equal(detect(mod("custom")), null);
  assert.equal(detect(mod("gearbox")), null);
  assert.match(detect(mod("ported")).moduleData.gameLibrary, /^dlls\/ported_(?:arm64|amd64)\.dylib$/);
});

test("native mod libraries are regular Mach-O files containing the selected CPU", t => {
  const root = halfLife(path.join(temporary(t), "Half-Life"));
  for (const [arch, cpu, other] of [["arm64", MachO.ARM64, MachO.X64], ["x64", MachO.X64, MachO.ARM64]]) {
    const suffix = arch === "x64" ? "amd64" : "arm64";
    const cases = [
      ["directory", false, file => fs.mkdirSync(file)],
      ["wrong-cpu", false, file => write(file, MachO.image({ cpu: other }))],
      ["text", false, file => write(file, "not a Mach-O image")],
      ["truncated", false, file => write(file, MachO.image({ cpu }).subarray(0, 16))],
      ["object", false, file => write(file, MachO.image({ cpu, fileType: 1 }))],
      ["library", true, file => write(file, MachO.image({ cpu }))],
      ["bundle", true, file => write(file, MachO.image({ cpu, fileType: 8, installName: null }))],
      ["no-build-metadata", true, file => write(file, MachO.image({ cpu, platform: null, installName: null, dependencies: [] }))],
      ["universal", true, file => write(file, MachO.universal([MachO.ARM64, MachO.X64]
        .map(cpu => ({ cpu, bytes: MachO.image({ cpu }) }))))],
      ["symlink", true, file => {
        const target = path.join(root, `shared-${arch}.dylib`);
        write(target, MachO.image({ cpu })); fs.symlinkSync(target, file);
      }],
      ["directory-symlink", false, file => fs.symlinkSync(root, file, "dir")]
    ];
    for (const [name, accepted, create] of cases) {
      const mod = path.join(root, `${arch}-${name}`), relative = `dlls/ported_${suffix}.dylib`, file = path.join(mod, relative);
      write(path.join(mod, "liblist.gam"), 'game "Ported"\ngamedll "dlls/ported.dll"\n');
      fs.mkdirSync(path.dirname(file), { recursive: true }); create(file);
      const result = Architecture.withArchitecture(arch, () => detect(mod));
      assert.equal(result?.moduleData.gameLibrary ?? null, accepted ? relative : null, `${arch}: ${name}`);
    }
    const mod = path.join(root, `${arch}-incompatible-hl`);
    write(path.join(mod, "liblist.gam"), 'game "Custom"\ngamedll "dlls/hl.dll"\n');
    write(path.join(mod, "dlls", "hl.dll"), "MZ half-life");
    write(path.join(mod, "dlls", `hl_${suffix}.dylib`), MachO.image({ cpu: other }));
    assert.equal(Architecture.withArchitecture(arch, () => detect(mod)), null,
      "An incompatible native mod library does not become a Half-Life-code mod");
  }
});

test("ordinary Play uses original writable paths and explicit runtime libraries without creating a private root", t => {
  const base = temporary(t), root = halfLife(path.join(base, "Half-Life")), userDataDir = path.join(base, "data");
  write(path.join(root, "mod", "liblist.gam"), 'game "Mod"\n');
  const engine = path.join(base, "runtime"), executablePath = path.join(engine, "xash3d");
  write(executablePath);
  for (const [suffix, cpu] of [["arm64", MachO.ARM64], ["amd64", MachO.X64]]) {
    write(path.join(engine, "valve", "dlls", `hl_${suffix}.dylib`), MachO.image({cpu}));
    write(path.join(engine, "valve", "cl_dlls", `client_${suffix}.dylib`), MachO.image({cpu}));
  }
  write(path.join(engine, "valve", "extras.pk3"));
  const before = fs.readdirSync(root, { recursive: true }).sort();
  const entry = { gameId: "game1", ...detect(path.join(root, "mod")) };
  const launch = Module.__test.prepareLaunch(entry, { userDataDir }, { executablePath });
  assert.equal(launch.gameFolder, "mod");
  assert.equal(launch.environment.XASH3D_RODIR, undefined);
  assert.equal(launch.environment.XASH3D_BASEDIR, root);
  assert.equal(launch.dataRoot, root);
  assert.equal(launch.directory, root);
  assert.equal(launch.environment.XASH3D_EXTRAS_PAK1, path.join(engine, "valve", "extras.pk3"));
  const suffix = Architecture.selectedArchitecture() === 'x64' ? 'amd64' : 'arm64';
  assert.deepEqual(launch.args, ['-game', 'mod', '-dll', path.join(engine, 'valve', 'dlls', `hl_${suffix}.dylib`),
    '-clientlib', path.join(engine, 'valve', 'cl_dlls', `client_${suffix}.dylib`)]);
  assert.equal(launch.saveRoot, path.join(root, 'mod', 'save'));
  assert.equal(fs.existsSync(userDataDir), false, 'Ordinary Play creates no private folders or aliases');
  assert.equal(entry.defaultSaveDir, launch.saveRoot);
  assert.deepEqual(fs.readdirSync(root, { recursive: true }).sort(), before, "Preparation leaves the original folder unchanged");
  const descriptors = legacyGameMirrors(entry, {userDataDir});
  assert.deepEqual(descriptors, [
    {mirrorRoot: path.join(userDataDir, 'games', 'game1', 'modules', 'xash3d', 'saves'), sourceRoot: launch.saveRoot},
    {mirrorRoot: path.join(userDataDir, 'games', 'game1', 'modules', 'xash3d', 'data'), sourceRoot: root}
  ]);
  entry.saveDirOverride = path.join(base, "saves elsewhere");
  write(path.join(launch.saveRoot, "kept.sav"));
  const moved = Module.__test.prepareLaunch(entry, { userDataDir }, { executablePath });
  assert.equal(moved.environment.XASH3D_RODIR, root);
  assert.notEqual(moved.dataRoot, root, 'Only an explicit custom save route needs a writable-root adapter');
  assert.equal(fs.readlinkSync(path.join(moved.dataRoot, "mod", "save")), entry.saveDirOverride);
  assert.ok(fs.existsSync(path.join(launch.saveRoot, "kept.sav")), "Earlier saves stay in place");
  assert.deepEqual(legacyGameMirrors(entry, {userDataDir}), [], 'The explicitly requested adapter remains active');
  fs.unlinkSync(path.join(moved.dataRoot, 'mod', 'save'));
  write(path.join(moved.dataRoot, 'mod', 'save', 'unique.sav'), 'private save');
  assert.doesNotThrow(() => Module.__test.prepareLaunch(entry, {userDataDir}, {executablePath}));
  assert.equal(fs.readFileSync(path.join(moved.dataRoot, 'mod', 'save', 'unique.sav'), 'utf8'), 'private save');
});

test('native mod libraries use original paths and preserve an original client override', t => {
  const base = temporary(t), root = halfLife(path.join(base, 'Half-Life')), game = path.join(root, 'ported');
  write(path.join(game, 'liblist.gam'), 'game "Ported"\ngamedll "dlls/ported.dll"\n');
  const engine = path.join(base, 'runtime'); write(path.join(engine, 'xash3d'));
  for (const [arch, suffix, cpu] of [['arm64', 'arm64', MachO.ARM64], ['x64', 'amd64', MachO.X64]]) {
    const server = path.join(game, 'dlls', `ported_${suffix}.dylib`), client = path.join(game, 'cl_dlls', `client_${suffix}.dylib`);
    write(server, MachO.image({cpu})); write(client, MachO.image({cpu}));
    const launch = Architecture.withArchitecture(arch, () => Module.__test.prepareLaunch({gameId: 'mod', ...detect(game)},
      {userDataDir: path.join(base, 'profile')}, {executablePath: path.join(engine, 'xash3d')}));
    assert.deepEqual(launch.args, ['-game', 'ported', '-dll', server, '-clientlib', client]);
    assert.equal(launch.environment.XASH3D_BASEDIR, root);
  }
  assert.equal(fs.existsSync(path.join(base, 'profile')), false);
});

test("the catalog lists the rolling main-branch Apple builds for each CPU and leaves out branch builds", async t => {
  const repository = "FWGS/xash3d-fwgs", assets = ["xash3d-fwgs-apple-arm64.tar.xz", "xash3d-fwgs-apple-amd64.tar.xz", "xash3d-fwgs-linux-amd64.tar.gz", "xash3d-fwgs-ios-arm64.ipa"];
  const releases = ["continuous", "continuous-unvendoring"].map(tag => Harness.githubRelease(repository, tag, assets, { prerelease: true, published_at: "2026-10-30T16:27:53Z" }));
  Harness.network.routes = Harness.githubRoutes(repository, releases);
  t.after(() => { Harness.network.routes = null; });
  const rows = await Catalog.source.discover({});
  assert.deepEqual(rows.map(row => row.architecture).sort(), ["arm64", "x64"]);
  for (const row of rows) {
    const file = row.files[0], asset = releases[0].assets.find(item => item.name === file.name);
    assert.equal(row.version, Catalog.snapshotVersion("continuous", row.revision, asset.digest.slice(7)));
    assert.equal(file.digest.value, asset.digest.slice(7));
    assert.match(row.label, row.architecture === "x64" ? /^Continuous · 2026-10-30 · [a-f0-9]{8} \(Intel\)$/ : /^Continuous · 2026-10-30 · [a-f0-9]{8}$/);
  }
  assert.throws(() => Catalog.snapshotVersion("continuous", "main"), /identified/);
});

test("installation accepts only an engine built for the selected CPU", t => {
  const root = temporary(t);
  machO(path.join(root, "xash3d"), 0x0100000c);
  assert.equal(Manager.resolveExecutable(root), path.join(root, "xash3d"));
  assert.deepEqual(Manager.prepareInstall({ unpacked: root, pin: { architecture: "arm64" } }), { architectures: ["arm64"] });
  assert.throws(() => Manager.prepareInstall({ unpacked: root, pin: { architecture: "x64" } }), /x64 CPU/);
  assert.throws(() => Manager.prepareInstall({ unpacked: temporary(t), pin: {} }), /no engine executable/);
});
