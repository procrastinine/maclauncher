// Required first: it replaces the network functions before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Registry = require("../src/runtime-sources");

const fresh = () => {
  for (const name of ["../src/modules/crossover/sources/index.js", "../src/modules/crossover/sources/settings.js"]) delete require.cache[require.resolve(name)];
  return require("../src/modules/crossover/sources/settings");
};
const entries = () => Object.keys(fresh().withSources(require("../src/modules/crossover/manifest.json")).runtime.entries);

test("every Wine source file is a runtime entry of the Windows module, and removing the file removes the entry", t => {
  const declared = Registry.loadSources(), wines = declared.filter(source => source.kind === "wine").map(source => source.id);
  assert.ok(wines.includes("metalsharp-wine") && wines.includes("highball-wine"));
  assert.deepEqual(entries().sort(), [...wines].sort(), "each Wine JSON file is an entry, with no other list");
  t.mock.method(Registry, "loadSources", () => declared.filter(source => source.id !== "highball-wine"));
  assert.deepEqual(entries().sort(), wines.filter(id => id !== "highball-wine").sort(), "without its file the entry is gone");
  t.mock.restoreAll(); fresh();
});

const REPOSITORY = "gauthierpiarrette/highball-engine";
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function release(tag, name) {
  const archive = Buffer.from(`archive ${tag}`), sum = Buffer.from(`${sha(archive)}  ${name}\n`);
  const asset = (file, bytes) => ({ name: file, size: bytes.length, id: file.length, digest: `sha256:${sha(bytes)}`,
    browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${file}` });
  return { tag_name: tag, prerelease: false, published_at: "2026-11-12T00:00:00Z", assets: [asset(name, archive), asset(`${name}.sha256`, sum)] };
}
function routes(releases) {
  const result = { [`https://api.github.com/repos/${REPOSITORY}/releases`]: releases,
    [`https://api.github.com/repos/${REPOSITORY}/tags`]: releases.map(row => ({ name: row.tag_name, commit: { sha: "a".repeat(40) } })) };
  for (const row of releases) result[`https://api.github.com/repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(row.tag_name)}`] = { object: { type: "commit", sha: "a".repeat(40) } };
  return result;
}

test("a Wine declared only by JSON lists the releases its asset patterns match, and a build needing an application loader waits for it", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wine-json-only-")));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); Harness.network.routes = null; });
  const applications = path.join(root, "Applications"), userDataDir = path.join(root, "profile");
  const manager = require("../src/runtime-adapters/wine-release").createManager("highball-wine", { dependencies: { applicationDirectories: [applications] } });
  Harness.network.routes = routes([release("engine-wine-11.0-20261112T101620Z-gst-rpath-0030", "engine-wine-11.0-20261112T101620Z-gst-rpath-0030.tar.gz"),
    release("engine-arm64-wine-11.18-20261108T132317Z-spatial-0056-0057", "engine-arm64-wine-11.18-20261108T132317Z-spatial-0056-0057.tar.gz"),
    release("renderer-dxmt-0.7", "renderer-dxmt-0.7.tar.gz")]);
  await manager.refreshCatalog({ userDataDir, force: true });
  const catalog = () => manager.getState({ userDataDir, componentSummaries: false }).catalog;
  const intel = "11.0-20261112T101620Z-gst-rpath-0030", arm = "11.18-20261108T132317Z-spatial-0056-0057";
  assert.deepEqual([...catalog().versions].sort(), [intel, arm].sort(), "only assets matching a CPU pattern are releases");
  assert.equal(catalog().versionRequirements[intel].architecture, "x64");
  assert.equal(catalog().versionRequirements[arm].architecture, "arm64");
  assert.deepEqual(catalog().installableVersions, [intel], "the arm64 build needs the application's loader");
  assert.match(catalog().versionRequirements[arm].installReason, /runs through Highball, which is not installed/);
  const loader = path.join(applications, "Highball.app/Contents/Helpers/WineLoader.app/Contents/MacOS/wine");
  fs.mkdirSync(path.dirname(loader), { recursive: true }); fs.writeFileSync(loader, "");
  assert.deepEqual([...catalog().installableVersions].sort(), [intel, arm].sort(), "with the application installed, the arm64 build is offered");
});

test("the Wine tree of a download is found by its files, in an archive folder or inside an application", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wine-tree-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { findWine } = require("../src/runtime-adapters/wine-release");
  const touch = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ""); };
  touch(path.join(root, "a/engine/bin/wine")); touch(path.join(root, "a/engine/bin/wineserver")); fs.mkdirSync(path.join(root, "a/engine/lib/wine"), { recursive: true });
  assert.deepEqual(findWine(path.join(root, "a")), { root: "engine", entry: "engine/bin/wine", server: "engine/bin/wineserver" });
  touch(path.join(root, "b/MetalSharp Wine.app/Contents/MacOS/wine")); fs.mkdirSync(path.join(root, "b/MetalSharp Wine.app/Contents/lib/wine/aarch64-unix"), { recursive: true });
  fs.symlinkSync("MacOS", path.join(root, "b/MetalSharp Wine.app/Contents/bin"));
  assert.deepEqual(findWine(path.join(root, "b")), { root: "MetalSharp Wine.app/Contents", entry: "MetalSharp Wine.app/Contents/MacOS/wine", server: null });
  fs.mkdirSync(path.join(root, "c"));
  assert.equal(findWine(path.join(root, "c")), null);
});

test("a zip made on macOS extracts without its AppleDouble metadata members and keeps its links", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wine-zip-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const Python = require("../src/modules/shared/runtime/python"), { extractArchive } = require("../src/modules/shared/runtime/safe-archive");
  const archive = path.join(root, "Sample-arm64.zip"), output = path.join(root, "out");
  fs.mkdirSync(output);
  const script = [
    "import sys, zipfile",
    "def add(z, name, data, mode=0o100644):",
    "    info = zipfile.ZipInfo(name); info.external_attr = mode << 16; z.writestr(info, data)",
    "double = b'\\x00\\x05\\x16\\x07\\x00\\x02\\x00\\x00' + bytes(18)",
    "with zipfile.ZipFile(sys.argv[1], 'w') as z:",
    "    add(z, 'Sample.app/Contents/MacOS/wine', b'loader', 0o100755)",
    "    add(z, 'Sample.app/Contents/MacOS/._wine', double)",
    "    add(z, 'Sample.app/Contents/bin', b'MacOS', 0o120755)",
    "    add(z, 'Sample.app/._Contents', double)",
    "    add(z, '__MACOSX/Sample.app/Contents/._Info.plist', double)",
    "    add(z, 'Sample.app/Contents/Resources/._notes', b'plain text')",
  ].join("\n");
  const made = require("node:child_process").spawnSync(Python.resolveEmbeddedPythonBinary(Python.resolveEmbeddedPythonRoot()), ["-I", "-B", "-c", script, archive], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  await extractArchive(archive, output);
  assert.deepEqual(fs.readdirSync(output), ["Sample.app"]);
  assert.deepEqual(fs.readdirSync(path.join(output, "Sample.app")), ["Contents"]);
  assert.deepEqual(fs.readdirSync(path.join(output, "Sample.app/Contents/MacOS")), ["wine"]);
  assert.equal(fs.readlinkSync(path.join(output, "Sample.app/Contents/bin")), "MacOS");
  assert.equal(fs.readFileSync(path.join(output, "Sample.app/Contents/Resources/._notes"), "utf8"), "plain text");
});

test("an application's own native files under share do not decide the CPU of the Wine it carries", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wine-share-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A thin 64-bit Mach-O dylib for macOS 13 with one LC_BUILD_VERSION command.
  const dylib = cpu => {
    const bytes = Buffer.alloc(56);
    bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(cpu, 4); bytes.writeUInt32LE(6, 12);
    bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(24, 20);
    bytes.writeUInt32LE(0x32, 32); bytes.writeUInt32LE(24, 36); bytes.writeUInt32LE(1, 40); bytes.writeUInt32LE(13 << 16, 44);
    return bytes;
  };
  const ARM64 = 0x0100000c, X86_64 = 0x01000007, contents = path.join(root, "Sample.app/Contents");
  for (const [relative, bytes] of [["MacOS/wine", dylib(ARM64)], ["MacOS/wineserver", dylib(ARM64)], ["lib/wine/aarch64-unix/ntdll.so", dylib(ARM64)],
    ["share/assets/shims/libfmod.dylib", dylib(X86_64)]]) {
    fs.mkdirSync(path.dirname(path.join(contents, relative)), { recursive: true });
    fs.writeFileSync(path.join(contents, relative), bytes);
  }
  fs.symlinkSync("MacOS", path.join(contents, "bin"));
  const source = require("../src/runtime-adapters/wine").definition("metalsharp-wine");
  const prepared = await require("../src/runtime-adapters/wine-release").createPayload(source, { systemVersionSync: () => "26.0" })
    .preparePayload({ unpacked: root, pin: { version: "7.0", asset: { filename: "MetalSharp-Wine-7.0-arm64.zip" } } });
  assert.equal(prepared.entry, "Sample.app/Contents/MacOS/wine");
  assert.equal(prepared.server, "Sample.app/Contents/MacOS/wineserver");
  assert.deepEqual(prepared.architectures, ["arm64"]);
});

test("a Wine whose publisher signed its loaders in bundles with a provisioning profile runs them from those bundles", async t => {
  const Graphics = require("../src/modules/crossover/sources/wine-graphics");
  const { image, X64 } = require("./fixtures/macho-image"), { peFixture } = require("./helpers/pe-fixture");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wine-signed-loader-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, bytes = "fixture") => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  const builtin = file => { const { bytes, peOffset } = peFixture({ is64: true }); bytes.write("Wine builtin DLL\0", 64); bytes.writeUInt16LE(0x2002, peOffset + 22); return put(file, bytes); };
  async function view(name, signed) {
    // The layout of MetalSharp Wine: an application whose Unix loader has a bundle of its own.
    const contents = path.join(root, name, "Sample.app", "Contents"), unix = path.join(contents, "lib", "wine", "x86_64-unix");
    put(path.join(contents, "MacOS", "wine"), image({ cpu: X64, fileType: 2 })); put(path.join(contents, "MacOS", "wineserver"), image({ cpu: X64, fileType: 2 }));
    put(path.join(unix, "ntdll.so"), image({ cpu: X64 })); put(path.join(unix, "wine.app", "Contents", "MacOS", "wine"), image({ cpu: X64, fileType: 2 }));
    fs.symlinkSync("wine.app/Contents/MacOS/wine", path.join(unix, "wine"));
    for (const dll of ["ntdll", "apisetschema"]) builtin(path.join(contents, "lib", "wine", "x86_64-windows", dll + ".dll"));
    put(path.join(contents, "share", "wine", "nls", "c_932.nls"));
    if (signed) for (const bundle of [contents, path.join(unix, "wine.app", "Contents")]) put(path.join(bundle, "embedded.provisionprofile"));
    const install = { engineRoot: contents, executablePath: path.join(contents, "MacOS", "wine"), serverPath: path.join(contents, "MacOS", "wineserver"), architecture: "x86_64" };
    const loader = await Graphics.__test.prepareLoaderView(contents, path.join(root, name, "view"), install, undefined, require("../src/modules/crossover/sources").get("metalsharp-wine"));
    return { contents, unix, install, loader, viewUnix: path.join(loader.dllRoot, "x86_64-unix") };
  }
  const signed = await view("signed", true);
  assert.equal(fs.realpathSync(signed.loader.executablePath), path.join(signed.contents, "MacOS", "wine"), "the launcher is the publisher's file");
  assert.equal(fs.realpathSync(path.join(signed.viewUnix, "wine")), path.join(signed.unix, "wine.app", "Contents", "MacOS", "wine"));
  assert.equal(fs.realpathSync(path.join(signed.viewUnix, "ntdll.so")), path.join(signed.unix, "ntdll.so"));
  assert.equal(signed.loader.plannedMainExecutablePath, path.join(signed.unix, "wine.app", "Contents", "MacOS", "wine"));
  assert.equal(fs.existsSync(path.join(signed.loader.wineRoot, "MacLauncher Game.app")), false, "no copy of a signed loader in a bundle of ours");
  const plain = await view("plain", false);
  assert.equal(fs.lstatSync(plain.loader.executablePath).isSymbolicLink(), false, "other loaders are copied into the view, as before");
  assert.ok(plain.loader.plannedMainExecutablePath.includes("MacLauncher Game.app"));
  // The view folder of a publisher-signed Wine is its own.
  assert.deepEqual([Graphics.publisherSigned(signed.install), Graphics.publisherSigned(plain.install)], [true, false]);
});
