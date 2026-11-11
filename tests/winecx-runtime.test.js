// Required first: it replaces the network functions before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Catalog = require("../src/modules/crossover/winecx/runtime/catalog");
const Payload = require("../src/modules/crossover/winecx/runtime/payload");
const { createManager, verifyChecksumFile } = require("../src/modules/crossover/winecx/runtime/manager");
const Sources = require("../src/modules/crossover/sources");
const Translators = require("../src/modules/shared/runtime/wine-translators");

const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const REPOSITORY = "dappermint/winecx-gptk";
function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "winecx-runtime-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function command(kind, value) {
  const size = Math.ceil((24 + Buffer.byteLength(value) + 1) / 8) * 8, bytes = Buffer.alloc(size);
  bytes.writeUInt32LE(kind); bytes.writeUInt32LE(size, 4); bytes.writeUInt32LE(24, 8); bytes.write(value, 24); return bytes;
}
function macho(type = 2, { dependency = "/usr/lib/libSystem.B.dylib", minimum = 26, marker = "" } = {}) {
  const build = Buffer.alloc(24); build.writeUInt32LE(0x32); build.writeUInt32LE(24, 4);
  build.writeUInt32LE(1, 8); build.writeUInt32LE(minimum << 16, 12); build.writeUInt32LE(27 << 16, 16);
  const commands = [build, command(0xc, dependency)], body = Buffer.concat(commands), bytes = Buffer.alloc(512);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x01000007, 4); bytes.writeUInt32LE(3, 8);
  bytes.writeUInt32LE(type, 12); bytes.writeUInt32LE(commands.length, 16); bytes.writeUInt32LE(body.length, 20);
  body.copy(bytes, 32); bytes.write(marker, 400); return bytes;
}
function write(file, bytes, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { mode }); return file;
}
const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>gptkCapable</key><true/><key>dxvkVersion</key><string>1.10.3</string>
<key>dxmtVersion</key><string>0.80</string><key>version</key><dict><key>major</key><integer>4</integer>
<key>minor</key><integer>8</integer><key>patch</key><integer>1</integer></dict></dict></plist>`;
// The archive layout of a published release: Libraries/Wine with the loader
// under lib/wine/x86_64-unix, and DXVK and DXMT beside it.
function tree(root, { minimum = 26, dependency } = {}) {
  const wine = path.join(root, "Libraries", "Wine"), unix = path.join(wine, "lib", "wine", "x86_64-unix");
  write(path.join(unix, "wine"), macho(2, { minimum }), 0o755);
  fs.mkdirSync(path.join(wine, "bin"), { recursive: true });
  for (const name of ["wine", "wine64", "wineloader"]) fs.symlinkSync("../lib/wine/x86_64-unix/wine", path.join(wine, "bin", name));
  write(path.join(wine, "bin", "wineserver"), macho(2, { marker: "WINEMSYNC" }), 0o755);
  write(path.join(unix, "ntdll.so"), Buffer.concat([macho(6, { marker: "CX_APPLEGPTK_LIBD3DSHARED_PATH" }), Buffer.from("wine-11.19\0")]));
  write(path.join(unix, "winemac.so"), macho(6));
  write(path.join(unix, "win32u.so"), macho(6, { marker: "CX_LIBVULKAN D3DM_VENDOR_ID" }));
  write(path.join(wine, "lib", "libMoltenVK.dylib"), macho(6, { dependency: dependency || "/usr/lib/libSystem.B.dylib" }));
  write(path.join(wine, "lib", "wine", "x86_64-windows", "kernel32.dll"), "Windows library");
  write(path.join(root, "Libraries", "DXVK", "x64", "d3d11.dll"), "DXVK");
  write(path.join(root, "Libraries", "DXMT", "x64", "d3d11.dll"), "DXMT");
  write(path.join(root, "Libraries", "WhiskyWineVersion.plist"), PLIST);
}
function asset(tag, name, bytes) {
  return { name, size: bytes.length, id: name.length, digest: `sha256:${sha(bytes)}`,
    browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}` };
}
function release(tag, archive = Buffer.from(`archive ${tag}`), { checksum = `${sha(archive)}  Libraries.tar.gz\n` } = {}) {
  const sum = Buffer.from(checksum);
  return { tag_name: tag, prerelease: false, assets: [asset(tag, "Libraries.tar.gz", archive), asset(tag, "Libraries.tar.gz.sha256", sum),
    asset(tag, "WhiskyWineVersion.plist", Buffer.from(PLIST))], bodies: { archive, sum } };
}
function routes(releases) {
  const result = { [`https://api.github.com/repos/${REPOSITORY}/releases`]: releases.map(({ bodies: _bodies, ...row }) => row),
    [`https://api.github.com/repos/${REPOSITORY}/tags`]: releases.map(row => ({ name: row.tag_name, commit: { sha: "a".repeat(40) } })) };
  for (const row of releases) {
    result[`https://api.github.com/repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(row.tag_name)}`] = { object: { type: "commit", sha: "a".repeat(40) } };
    if (row.bodies) { result[row.assets[0].browser_download_url] = row.bodies.archive; result[row.assets[1].browser_download_url] = row.bodies.sum; }
  }
  return result;
}
function fixtureManager(dependencies = {}) {
  return createManager({ dependencies: { systemVersionSync: () => "26.1", extractArchive: async (_archive, root) => tree(root), ...dependencies } });
}

test("WineCX releases are recognized by asset role, newest first, with versions from their tags", async t => {
  Harness.network.routes = routes([release("runtime-v4.7.4"), release("runtime-v4.8.1"), release("v4.5.0"),
    { tag_name: "runtime-v9.9.9", assets: [asset("runtime-v9.9.9", "Libraries.tar.gz", Buffer.from("no checksum"))] }]);
  t.after(() => { Harness.network.routes = null; });
  const rows = await Catalog.discover({});
  assert.deepEqual(rows.map(row => row.version), ["4.8.1", "4.7.4", "4.5.0"], "a release without a published checksum file is not a runtime");
  assert.equal(rows[0].asset.filename, "Libraries.tar.gz");
  assert.equal(rows[0].checksum.filename, "Libraries.tar.gz.sha256");
  assert.equal(rows[0].upstreamTag, "runtime-v4.8.1");
  assert.ok(Catalog.validateEntry(rows[0]));
  assert.equal(Catalog.releaseVersion("runtime-v4.8.1"), "4.8.1");
  assert.equal(Catalog.readChecksum(`${"b".repeat(64)}  Libraries.tar.gz\n`, "Libraries.tar.gz"), "b".repeat(64));
  assert.equal(Catalog.readChecksum(`${"b".repeat(64)}  Other.tar.gz\n`, "Libraries.tar.gz"), null);
});

test("WineCX installs only an archive that matches its published checksum file", async t => {
  const root = temporary(t), good = release("runtime-v4.8.1"), bad = release("runtime-v4.8.2", Buffer.from("other"), { checksum: `${"c".repeat(64)}  Libraries.tar.gz\n` });
  Harness.network.routes = routes([good, bad]); t.after(() => { Harness.network.routes = null; });
  const manager = fixtureManager(), userDataDir = path.join(root, "profile");
  await manager.refreshCatalog({ userDataDir, force: true });
  await assert.rejects(manager.installRuntime({ userDataDir, version: "4.8.2" }), /does not match its published SHA-256/);
  assert.equal(manager.core.listInstalled(userDataDir).length, 0, "a mismatched archive installs nothing");
  const installed = await manager.installRuntime({ userDataDir, version: "4.8.1" });
  assert.equal(installed.wineVersion, "11.19", "the Wine version is read from ntdll");
  assert.equal(installed.minimumMacOS, "26.0.0", "the macOS floor is read from the native images");
  assert.deepEqual(installed.componentVersions, { dxvk: "1.10.3", dxmt: "0.80" });
  assert.deepEqual(installed.capabilities, { msync: true, esync: false, graphicsSelector: false, vulkanLibrarySelector: true, d3dMetalBridge: true, adapterIdentity: true });
  assert.equal(installed.executablePath, path.join(installed.installDir, "Libraries/Wine/bin/wine"));
  assert.equal(manager.resolveSelection({}, {}, userDataDir, { version: "4.8.1" }).ready, true);
  // A saved Runtimes default that is not installed yields to the installed
  // version; a version chosen for the game stays exact.
  const saved = { runtimes: { winecx: { defaultVersion: "4.8.2" } } };
  assert.deepEqual((({ version, ready, preferredVersion }) => ({ version, ready, preferredVersion }))(manager.resolveSelection({}, saved, userDataDir)),
    { version: "4.8.1", ready: true, preferredVersion: "4.8.2" });
  assert.equal(manager.resolveSelection({}, saved, userDataDir, { version: "4.8.2" }).ready, false);
  // A record from an earlier inspector is read again from the installed
  // binaries, without a download and without a file in the sealed tree.
  const registration = path.join(installed.installDir, "runtime.json"), record = JSON.parse(fs.readFileSync(registration, "utf8"));
  delete record.installationMetadata.inspectionVersion; record.installationMetadata.capabilities = { msync: true, esync: false, graphicsSelector: false, vulkanLibrarySelector: false };
  fs.writeFileSync(registration, JSON.stringify(record));
  const reread = manager.resolveSelection({}, {}, userDataDir, { version: "4.8.1" });
  assert.equal(reread.ready, true, "the inspection record is not a payload change");
  assert.equal(reread.install.capabilities.adapterIdentity, true);
  assert.equal(installed.installationMetadata.inspectionVersion, 2, "new installations record the current inspection version");
  assert.equal(manager.resolveSelection({}, {}, userDataDir, { version: "4.8.1" }).install.capabilities.vulkanLibrarySelector, true);
  // A changed file makes the installation unusable until it is installed again.
  fs.appendFileSync(path.join(installed.installDir, "Libraries/Wine/lib/wine/x86_64-unix/ntdll.so"), "changed");
  assert.match(manager.resolveSelection({}, {}, userDataDir, { version: "4.8.1" }).reason, /WineCX runtime files changed/);
});

test("WineCX reads a release's macOS floor from the start of its archive before download", async t => {
  const root = temporary(t), source = path.join(root, "release"); tree(source);
  write(path.join(source, "Libraries/Wine/bin/wineserver"), macho(2, { minimum: 27 }), 0o755);
  write(path.join(source, "Libraries/DXVK/x32/d3d11.dll"), crypto.randomBytes(3 << 20));
  write(path.join(source, "Libraries/Wine/lib/libLarge.dylib"), crypto.randomBytes(4 << 20));
  const archive = path.join(root, "Libraries.tar.gz");
  require("node:child_process").execFileSync("/usr/bin/tar", ["-czf", archive, "-C", source, "Libraries/DXVK", "Libraries/Wine/bin", "Libraries/Wine/lib"]);
  const bytes = fs.readFileSync(archive), reads = [];
  const range = async (_listed, start, length) => { reads.push(start); return { bytes: bytes.subarray(start, start + length), total: bytes.length }; };
  assert.equal(await Catalog.archiveFloor({ filename: "Libraries.tar.gz", url: "https://example.invalid/Libraries.tar.gz" }, { range, step: 1 << 20 }), "27.0.0");
  assert.ok(reads.length > 1 && reads.at(-1) + (1 << 20) < bytes.length, "only the start of the archive is read, in parts");
  // Refresh reads the newest release's floor; Install reads it for another version before downloading.
  Harness.network.routes = routes([release("runtime-v4.8.1"), release("runtime-v4.7.4")]); t.after(() => { Harness.network.routes = null; });
  const floors = [], archiveFloor = async listed => { floors.push(listed.url.split("/").at(-2)); return "27.0"; };
  const manager = createManager({ discoverCatalog: options => Catalog.discover({ ...options, archiveFloor }),
    dependencies: { systemVersionSync: () => "26.1", archiveFloor, extractArchive: async (_archive, target) => tree(target) } });
  const userDataDir = path.join(root, "profile");
  await manager.refreshCatalog({ userDataDir, force: true });
  assert.deepEqual(floors, ["runtime-v4.8.1"], "Refresh reads only the newest release");
  const state = manager.getState({ userDataDir, componentSummaries: false });
  assert.equal(state.catalog.versionRequirements["4.8.1"].installReason, "Requires macOS 27 or later.");
  assert.ok(!state.catalog.installableVersions.includes("4.8.1"));
  await assert.rejects(manager.installRuntime({ userDataDir, version: "4.8.1" }), /^Error: Requires macOS 27 or later\.$/);
  await assert.rejects(manager.installRuntime({ userDataDir, version: "4.7.4" }), /^Error: Requires macOS 27 or later\.$/);
  assert.deepEqual(floors, ["runtime-v4.8.1", "runtime-v4.7.4"], "Install reads an unread version's floor before its download");
  assert.equal(manager.core.listInstalled(userDataDir).length, 0, "nothing was downloaded or installed");
});

test("WineCX checksum verification reads the release's checksum file", async () => {
  const pin = { asset: { filename: "Libraries.tar.gz" }, checksum: { filename: "Libraries.tar.gz.sha256", url: "https://example.invalid/Libraries.tar.gz.sha256" } };
  const reply = text => async (_listed, target) => { fs.writeFileSync(target, text); };
  const verify = (archiveSha256, download, row = pin) => verifyChecksumFile({ archiveSha256, pin: row }, { download });
  assert.equal((await verify("d".repeat(64), reply(`${"d".repeat(64)}  Libraries.tar.gz`))).verified, true);
  await assert.rejects(verify("d".repeat(64), reply(`${"e".repeat(64)}  Libraries.tar.gz`)), /does not match/);
  await assert.rejects(verify("d".repeat(64), reply(`${"e".repeat(64)}  Other.tar.gz`)), /names no SHA-256/);
  await assert.rejects(verify("d".repeat(64), async () => { throw new Error("HTTP 404"); }), /could not be read \(HTTP 404\)/);
  await assert.rejects(verify("d".repeat(64), reply(""), { asset: pin.asset }), /no checksum file/);
});

test("WineCX payload preparation refuses an external native library and a newer macOS floor", async t => {
  const root = temporary(t), external = path.join(root, "external"), newer = path.join(root, "newer");
  tree(external, { dependency: "/opt/homebrew/lib/libvulkan.dylib" }); tree(newer, { minimum: 99 });
  await assert.rejects(Payload.preparePayload({ unpacked: external }, { systemVersionSync: () => "26.1" }), /external native library/);
  await assert.rejects(Payload.preparePayload({ unpacked: newer }, { systemVersionSync: () => "26.1" }), /Requires macOS 99 or later\./);
  const wrapped = path.join(root, "wrapped"); tree(path.join(wrapped, "release"));
  const metadata = await Payload.preparePayload({ unpacked: wrapped }, { systemVersionSync: () => "26.1" });
  assert.equal(metadata.root, "Libraries"); assert.ok(fs.existsSync(path.join(wrapped, "Libraries/Wine/bin/wineserver")), "a wrapped Libraries folder moves to its known place");
  assert.equal(metadata.runtimeVersion, "4.8.1");
});

test("the WineCX source lists its included translators through the shared Wine translator reader", async t => {
  const root = temporary(t); tree(root);
  const wineRoot = path.join(root, "Libraries/Wine"), install = { version: "4.8.1", installDir: root, librariesRoot: path.join(root, "Libraries"), wineRoot, engineRoot: wineRoot,
    executablePath: path.join(wineRoot, "bin/wine"), serverPath: path.join(wineRoot, "bin/wineserver"), libraryRoot: path.join(wineRoot, "lib"),
    componentVersions: { dxvk: "1.10.3", dxmt: "0.80" }, capabilities: { vulkanLibrarySelector: true } };
  fs.mkdirSync(path.join(wineRoot, "lib/gstreamer-1.0"), { recursive: true }); fs.writeFileSync(path.join(wineRoot, "lib/libgstreamer-1.0.0.dylib"), "");
  const seen = [];
  const inventory = Translators.includedTranslators(install, "winecx", { describe: (file, selection) => {
    seen.push([path.relative(root, file), selection.engine, selection.component, selection.source.label]);
    // GStreamer's version comes from its core library, the same way as for CrossOver.
    const version = file.endsWith("libgstreamer-1.0.0.dylib") ? "1.26.3" : selection.version || "";
    return { component: selection.component, engine: selection.engine, form: selection.form || "builtin", files: [], version };
  } });
  assert.deepEqual(inventory.included.filter(item => item.engine === "gstreamer").map(item => item.version), ["1.26.3"]);
  assert.ok(seen.some(([file, engine]) => file === "Libraries/Wine/lib/libgstreamer-1.0.0.dylib" && engine === "gstreamer"));
  assert.deepEqual(seen.slice(0, 3), [["Libraries/DXMT", "dxmt", "d3d-renderer", "WineCX"], ["Libraries/DXVK", "dxvk", "d3d-renderer", "WineCX"],
    ["Libraries/Wine/lib/libMoltenVK.dylib", "moltenvk", "vulkan-driver", "WineCX"]]);
  assert.deepEqual(inventory.included.filter(item => item.engine === "dxmt").map(item => item.version), ["0.80"]);
  const source = Sources.get("winecx");
  assert.equal(source.graphicsSelector, false, "MacLauncher places WineCX's included translators");
  assert.equal(source.vulkanLibrarySelector(install), true, "WineCX's win32u reads CX_LIBVULKAN");
  assert.deepEqual(source.nativeLibraries(install).libraries, [path.join(wineRoot, "lib")]);
});

test("a translator set that ships its own DXGI is offered only for the architectures that have it", t => {
  // WineCX 4.8.1's DXVK has dxgi.dll in x32 only; CrossOver's DXVK has none and uses Wine's DXGI.
  const X86 = 0x14c, X64 = 0x8664, pe = (folder, name, machine) => ({ format: "pe", machine, path: `/set/${folder}/${name}`, relative: `${folder}/${name}`,
    apis: name === "dxgi.dll" ? ["DXGI"] : name === "d3d11.dll" ? ["Direct3D 11"] : [] });
  const sets = { dxvk: [pe("x32", "d3d11.dll", X86), pe("x32", "dxgi.dll", X86), pe("x64", "d3d11.dll", X64)],
    dxmt: [pe("x32", "d3d11.dll", X86), pe("x32", "dxgi.dll", X86), pe("x64", "d3d11.dll", X64), pe("x64", "dxgi.dll", X64), pe("x64", "nvngx.dll", X64)] };
  const root = temporary(t);
  for (const folder of ["DXVK", "DXMT", "Wine/lib"]) fs.mkdirSync(path.join(root, folder), { recursive: true });
  const install = { version: "4.8.1", wineRoot: path.join(root, "Wine"), librariesRoot: root, libraryRoot: path.join(root, "Wine/lib"), componentVersions: {} };
  const inventory = Translators.includedTranslators(install, "winecx", { describe: (file, selection) => sets[selection.engine] &&
    { component: selection.component, engine: selection.engine, form: "builtin", files: sets[selection.engine], apis: ["Direct3D 11"], version: "1" } });
  const included = engine => inventory.included.find(item => item.engine === engine);
  assert.deepEqual(included("dxvk").files.map(file => file.relative), ["x32/d3d11.dll", "x32/dxgi.dll"], "the x64 DXVK libraries without their DXGI are left out");
  assert.deepEqual(included("dxvk").incompleteMachines, [X64]);
  assert.equal(included("dxmt").files.length, 5, "a set with DXGI for both architectures stays whole, x64-only helpers included");
  const wineDxgi = require("../src/modules/shared/runtime/translator-pairing").completeSets({ files: [pe("x32", "d3d11.dll", X86), pe("x64", "d3d11.dll", X64)] });
  assert.equal(wineDxgi.files.length, 2, "a set built for Wine's DXGI is complete for every architecture it has");
  const Plan = require("../src/modules/shared/runtime/translator-plan");
  const input = { included: inventory.included.filter(item => sets[item.engine]), choices: [], selections: {}, environment: null };
  const offered = executableArchitecture => Translators.optionLists(install, "winecx", { runtimeSettings: {} },
    { inventory: structuredClone(input), plan: Plan.resolvePlan(input), executableArchitecture }).translatorD3D11Options.map(row => row.value);
  assert.ok(offered("x86").includes("included:d3d-renderer:dxvk"), "32-bit games are offered the complete x32 DXVK set");
  assert.ok(!offered("x86_64").includes("included:d3d-renderer:dxvk"), "64-bit games are not offered a DXVK set without its x64 DXGI");
  assert.ok(offered("x86_64").includes("included:d3d-renderer:dxmt"));
});

test("all three Wine sources share one settings definition", () => {
  const manifest = require("../src/modules/crossover/main").manifest;
  const keys = id => manifest.runtime.entries[id].settings.fields.map(field => field.key);
  assert.deepEqual(manifest.runtime.supported, ["sikarugir", "crossover", "winecx"]);
  const without = (id, ...names) => keys(id).filter(key => !names.includes(key));
  assert.deepEqual(keys("winecx"), without("sikarugir", "environmentReference", "cncDdraw"),
    "WineCX has no external environment kind and includes no CNC-DDraw");
  assert.deepEqual(without("crossover", "bottleTemplate").sort(), without("sikarugir", "cncDdraw").sort(),
    "CrossOver adds only its bottle type, which names the bottle that holds its saves");
  for (const id of Sources.IDS) assert.equal(manifest.runtime.managerUi[id].tabLabel, Sources.get(id).label);
  assert.equal(manifest.runtime.entries.winecx.graphicsArchitecture, "x86_64");
});
