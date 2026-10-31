// Required first: it replaces the network before modules load.
const Fixture = require("./helpers/gamemaker-official.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const Catalog = require("../src/modules/gamemaker/runtime/official-catalog");
const Installer = require("../src/modules/gamemaker/runtime/official-installer");
const Official = require("../src/modules/gamemaker/runtime/official");
const Packages = require("../src/modules/gamemaker/runtime/official-packages");
const Version = require("../src/modules/gamemaker/runtime/official-tool-version");
const Umt = require("../src/modules/gamemaker/runtime/undertale-mod-tool");
const ManagedTools = require("../src/modules/gamemaker/runtime/official-tools");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const signature = "ABCDEFGHIJKLMNOPQRSTUVWX==";
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "gm-official-catalog-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function feed(version = "2024.14.4.268", { filename = "core.zip", arm = true, intel = true } = {}) {
  const tag = (name, file) => `<module name="${name}" url="https://gms.yoyogames.com/${file}" sparkle:version="${version}" length="3" sparkle:dsaSignature="${signature}"/>`;
  return Buffer.from(`<rss><channel><item><pubDate>Thu, 08 Oct 2026 10:00:00 GMT</pubDate><enclosure url="https://gms.yoyogames.com/${filename}" sparkle:version="${version}" length="3" sparkle:dsaSignature="${signature}">${tag("mac", "mac.zip")}${tag("macYYC", "yyc.zip")}${arm ? tag("base-module-osx-arm64", "arm.zip") : ""}${intel ? tag("base-module-osx-x64", "intel.zip") : ""}</enclosure></item></channel></rss>`);
}
const legacyFeed = () => Fixture.legacyFeed("1.4.2900");
const responseBody = (url, body = feed()) => Catalog.FEEDS.find(item => item.url === url)?.family === "studio-1.4" ? legacyFeed() : body;
test("official RSS discovers exact runtime builds and selects the host's native modules", () => {
  const [entry] = Catalog.parseFeed(feed(), Catalog.FEEDS[0]);
  assert.equal(entry.version, "2024.14.4.268");
  assert.equal(entry.gameplayQualified, false);
  assert.equal(entry.vendorSignatureVerified, false);
  assert.equal(Catalog.validateEntry(entry), true);
  assert.deepEqual(Catalog.selectPackages(entry, "arm64").map(item => item.module), ["core", "base-module-osx-arm64", "mac", "macYYC"]);
  assert.deepEqual(Catalog.selectPackages(entry, "x64").map(item => item.module), ["core", "base-module-osx-x64", "mac", "macYYC"]);
  assert.throws(() => Catalog.selectPackages(Catalog.parseFeed(feed("2024.14.4.268", { intel: false }), Catalog.FEEDS[0])[0], "x64"), /does not offer/);
  const old = Catalog.parseFeed(feed("2.2.5.378", { arm: false, intel: false }), Catalog.FEEDS[0])[0];
  assert.deepEqual(Catalog.selectPackages(old, "x64").map(item => item.module), ["core", "mac", "macYYC"]);
});
test("official feed rejects credential URLs, foreign hosts, external XML entities and mismatched modules", () => {
  for (const url of ["https://evil.example/core.zip", "https://user:password@gms.yoyogames.com/core.zip", "https://gms.yoyogames.com/core.zip?token=private", "https://gms.yoyogames.com:8443/core.zip"]) {
    assert.throws(() => Catalog.parseFeed(Buffer.from(feed().toString().replace("https://gms.yoyogames.com/core.zip", url)), Catalog.FEEDS[0]), /official/);
  }
  assert.throws(() => Catalog.parseFeed(Buffer.from("<!DOCTYPE rss [<!ENTITY x SYSTEM 'file:///etc/passwd'>]>" + feed()), Catalog.FEEDS[0]), /external entities/);
  assert.throws(() => Catalog.parseFeed(Buffer.from(feed().toString().replace('name="mac"', 'name="mac" sparkle:version="1.0.0.0"')), Catalog.FEEDS[0]), /Duplicate/);
  assert.throws(() => Catalog.parseFeed(feed("latest"), Catalog.FEEDS[0]), /exact four-part/);
  const legacyHttp = Buffer.from(feed().toString().replaceAll("https://gms.yoyogames.com", "http://gms.yoyogames.com"));
  assert.equal(Catalog.parseFeed(legacyHttp, Catalog.FEEDS[0])[0].packages[0].url.startsWith("https:"), true);
  // An unreadable release is left out; the feed's other releases stay listed.
  const mixed = Buffer.from(feed().toString().replace("</channel>", feed("latest").toString().match(/<item>[\s\S]*<\/item>/)[0] + "</channel>"));
  assert.deepEqual(Catalog.parseFeed(mixed, Catalog.FEEDS[0]).map(entry => entry.version), ["2024.14.4.268"]);
  const universal = Catalog.parseFeed(Buffer.from(feed("2027.0.0.1", { arm: false, intel: false }).toString()
    .replace("</enclosure>", `<module name="base-module-osx-universal" url="https://gms.yoyogames.com/runtimes/universal.zip" sparkle:version="2027.0.0.1" length="3" sparkle:dsaSignature="${signature}" future="1"/><module name="linux" url="https://gms.yoyogames.com/linux.zip"/></enclosure>`)), Catalog.FEEDS[0])[0];
  assert.deepEqual(Catalog.selectPackages(universal, "x64").map(item => item.module), ["core", "base-module-osx-universal", "mac", "macYYC"]);
});
test("explicit Refresh persists shared catalog, reports loading and preserves selections after failures or rebinding", async t => {
  const userDataDir = temporary(t);
  let requests = 0;
  const refreshed = await Fixture.withFeeds(url => { requests++; return { status: 200, body: responseBody(url) }; }, () => {
    const pending = Catalog.refreshCatalog({ userDataDir });
    assert.equal(Catalog.stateFor(userDataDir).status, "loading");
    return pending;
  });
  assert.equal(requests, 4); assert.equal(refreshed.entries.length, 2);
  assert.equal(Catalog.cachedCatalog(userDataDir).entries[0].version, "2024.14.4.268");
  assert.ok(Official.manager.getState({ userDataDir }).catalog.versions.includes("2024.14.4.268"));
  assert.equal(Installer.resolveBuild({ userDataDir, version: "2024.14.4.268", arch: "x64" }).hostArchitecture, "x64");
  await assert.rejects(Fixture.refresh({ userDataDir }, () => ({ status: 503 })), /503/);
  assert.equal(Catalog.stateFor(userDataDir).status, "error");
  assert.equal(Catalog.cachedCatalog(userDataDir).entries[0].version, "2024.14.4.268");
  // A package YoYo Games replaced follows the feed's new identity.
  await Fixture.refresh({ userDataDir }, url => ({ status: 200, body: responseBody(url, feed("2024.14.4.268", { filename: "changed.zip" })) }));
  assert.equal(Catalog.cachedCatalog(userDataDir).entries[0].packages[0].filename, "changed.zip");
  // A failing channel does not block the releases the other channels returned.
  const partial = await Fixture.refresh({ userDataDir }, url => url === Catalog.FEEDS[1].url ? { status: 404 } : { status: 200, body: responseBody(url, feed("2024.14.5.1")) });
  assert.ok(partial.entries.some(entry => entry.version === "2024.14.5.1"));
});

test("official state starts offline without factory releases and requires discovered acquisition identities", t => {
  const userDataDir = temporary(t);
  t.mock.method(Catalog, "refreshCatalog", () => assert.fail("State inspection cannot query release feeds"));
  const initial = Official.manager.getState({ userDataDir });
  assert.equal(initial.catalog.status, "idle"); assert.deepEqual(initial.catalog.versions, []);
  assert.throws(() => Installer.resolveBuild({ userDataDir, version: "1.4.2900" }), /Refresh/);
});
test("first official HTTPS package download records its own checksum and rejects later cache replacement", async t => {
  const userDataDir = temporary(t), [build] = Catalog.parseFeed(feed(), Catalog.FEEDS[0]);
  await Fixture.refresh({ userDataDir }, url => ({ status: 200, body: responseBody(url) }));
  build.packages = Catalog.selectPackages(build, "arm64");
  const before = Fixture.Harness.network.requests.length, downloads = () => Fixture.Harness.network.requests.slice(before);
  const first = await Fixture.withFiles(Object.fromEntries(build.packages.map(pin => [pin.url, Buffer.from("ZIP")])),
    () => Installer.cacheArtifacts({ userDataDir, build }));
  assert.equal(downloads().length, 4); assert.ok(downloads().every(url => new URL(url).hostname === "gms.yoyogames.com"));
  assert.ok(first.packages.every(item => item.sha256 === hash("ZIP") && item.integrity === "official-https-observed-sha256"));
  await Installer.cacheArtifacts({ userDataDir, build });
  const publicPackages = await Packages.downloadPublicPackages({ userDataDir, version: build.version });
  assert.equal(downloads().length, 4, "Cached packages stay offline");
  assert.deepEqual(publicPackages.packages.map(item => item.module), ["core", "mac"]);
  assert.equal(publicPackages.installed, false); assert.equal(publicPackages.launchReady, false);
  fs.writeFileSync(path.join(first.root, "core.zip"), "BAD");
  await assert.rejects(Installer.cacheArtifacts({ userDataDir, build }), /SHA-256/);
  assert.throws(() => Installer.resolveBuild({ userDataDir, version: "2025.1.0.1" }), /Refresh/);
});
test("format recommendations choose a cached compatible build while exact incompatible overrides remain rejected", async t => {
  const userDataDir = temporary(t);
  await Fixture.refresh({ userDataDir }, url => ({ status: 200, body: responseBody(url, feed("2024.13.1.242")) }));
  const entry = { moduleData: { wadVersion: 17, minimumEngineVersion: "2024.13", maximumOfficialRuntimeExclusive: "2024.14" } };
  const recommended = Official.manager.resolveSelection(entry, {}, userDataDir);
  assert.equal(recommended.version, "2024.13.1.242"); assert.equal(recommended.selectionSource, "catalog");
  entry.runtimeData = { "official-studio": { version: "2026.0.0.23" } };
  const explicit = Official.manager.resolveSelection(entry, {}, userDataDir);
  assert.equal(explicit.version, "2026.0.0.23"); assert.equal(explicit.ready, false); assert.match(explicit.reason, /AGRP/);
});
function versionDll(version = [2024, 0, 0, 32]) {
  const bytes = Buffer.alloc(2048), pe = 0x80, optional = pe + 24, resource = 0x400, info = 0x500;
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(pe, 0x3c); bytes.writeUInt32LE(0x4550, pe);
  bytes.writeUInt16LE(1, pe + 6); bytes.writeUInt16LE(224, pe + 20); bytes.writeUInt16LE(0x10b, optional);
  bytes.writeUInt32LE(0x1000, optional + 112); bytes.writeUInt32LE(0x400, optional + 116);
  const section = optional + 224; bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(0x400, section + 16); bytes.writeUInt32LE(resource, section + 20);
  for (const [offset, id, target] of [[0, 16, 0x80000018], [24, 1, 0x80000030], [48, 1033, 72]]) {
    bytes.writeUInt16LE(1, resource + offset + 14); bytes.writeUInt32LE(id, resource + offset + 16); bytes.writeUInt32LE(target, resource + offset + 20);
  }
  bytes.writeUInt32LE(0x1100, resource + 72); bytes.writeUInt32LE(92, resource + 76);
  bytes.writeUInt16LE(92, info); bytes.writeUInt16LE(52, info + 2);
  Buffer.from("VS_VERSION_INFO\0", "utf16le").copy(bytes, info + 6);
  const fixed = info + 40; bytes.writeUInt32LE(0xfeef04bd, fixed);
  for (const offset of [8, 16]) { bytes.writeUInt32LE(version[0] * 65536 + version[1], fixed + offset); bytes.writeUInt32LE(version[2] * 65536 + version[3], fixed + offset + 4); }
  return bytes;
}
test("Igor version comes from bounded PE fixed metadata and is independent of runtime and archive versions", async t => {
  const bytes = versionDll();
  assert.equal(Version.parseIgorVersion(bytes).version, "2024.0.0.32");
  assert.throws(() => Version.parseIgorVersion(bytes.subarray(0, 100)), /Truncated/);
  const disagreement = Buffer.from(bytes); disagreement.writeUInt32LE(33, 0x500 + 40 + 20);
  assert.equal(Version.parseIgorVersion(disagreement).version, "2024.0.0.32");
  const outside = Buffer.from(bytes); outside.writeUInt32LE(0x7fffffff, 0x400 + 72);
  assert.throws(() => Version.parseIgorVersion(outside), /outside/);
  for (const arch of ["arm64", "x64"]) {
    const bootstrap = Installer.bootstrapForArch(arch);
    assert.equal(bootstrap.kind, "vendor"); assert.equal(bootstrap.location, `https://gms.yoyogames.com/igor_osx-${arch}.zip`);
    assert.equal(bootstrap.teamIdentifier, "C9E7J7HL3D");
  }
  const userDataDir = temporary(t), setup = Official.manager.getState({ userDataDir }).setupActions[0];
  assert.deepEqual(setup.versions, []); assert.equal(setup.installedVersion, null); assert.equal(setup.version, null);
  await assert.rejects(Official.manager.performSetupAction({ setupActionId: "installIgor", userDataDir, toolVersion: "2026.0.0.23" }), /exact Igor/);
});
test("UndertaleModTool releases list each Mac CLI build with its exact tag commit and the publisher's digest", async () => {
  const Harness = require("./helpers/future-upstream.cjs"), repository = "UnderminersTeam/UndertaleModTool";
  const releases = [Harness.githubRelease(repository, "0.9.1.2", ["UTMT_CLI_v0.9.1.2-macOS.zip", "UTMT_CLI_v0.9.1.2-Windows.zip"]),
    Harness.githubRelease(repository, "nightly", [])];
  Harness.network.routes = Harness.githubRoutes(repository, releases);
  let rows;
  try { rows = await Umt.upstream.discover({}); } finally { Harness.network.routes = null; }
  assert.deepEqual(rows.map(row => [row.version, row.architecture]), [["0.9.1.2-native-macos", "arm64"]]);
  assert.equal(rows[0].revision, Harness.githubRoutes(repository, releases)[`https://api.github.com/repos/${repository}/tags`][0].commit.sha);
  assert.equal(rows[0].files[0].digest.value, releases[0].assets[0].digest.slice(7));
});


test("local Igor choices use actual DLL versions, require full dependencies and copy without downloads or source edits", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async t => {
  const root = temporary(t), userDataDir = path.join(root, "launcher"), vendor = path.join(root, "runtime-2025.1.0.12");
  const folder = path.join(vendor, "bin/igor/osx/arm64"), mac = path.join(vendor, "mac/YoYo Runner.app/Contents/MacOS");
  fs.mkdirSync(folder, { recursive: true }); fs.mkdirSync(mac, { recursive: true }); fs.mkdirSync(path.join(vendor, "manifest"));
  fs.writeFileSync(path.join(vendor, "receipt.json"), JSON.stringify({ version: "2025.1.0.12" })); fs.writeFileSync(path.join(vendor, "manifest/mac.json"), "{}\n");
  const binary = Buffer.alloc(64); binary.writeUInt32LE(0xfeedfacf); binary.writeUInt32LE(0x0100000c, 4); binary.writeUInt32LE(2, 12);
  fs.writeFileSync(path.join(mac, "Mac_Runner"), binary, { mode: 0o755 });
  fs.writeFileSync(path.join(folder, "Igor"), binary, { mode: 0o644 });
  fs.writeFileSync(path.join(folder, "Igor.dll"), versionDll([2024, 13, 1, 242]));
  fs.writeFileSync(path.join(folder, "Igor.runtimeconfig.json"), JSON.stringify({ runtimeOptions: { includedFrameworks: [{ name: "Microsoft.NETCore.App", version: "8.0.0" }] } }));
  fs.writeFileSync(path.join(folder, "Igor.deps.json"), JSON.stringify({ runtimeTarget: { name: "net8.0/osx-arm64" }, targets: { "net8.0/osx-arm64": { "Igor/1.0.0": { runtime: { "Igor.dll": {}, "Fake.Core.dll": {} } } } } }));
  assert.throws(() => ManagedTools.inspectIgorDirectory(folder), /dependency Fake.Core.dll is missing/);
  fs.writeFileSync(path.join(folder, "Fake.Core.dll"), "dependency");
  const source = ManagedTools.inspectIgorDirectory(folder);
  assert.equal(source.version, "2024.13.1.242");
  Official.registerOfficialRuntime({ userDataDir, runtimeRoot: vendor });
  const choices = Official.manager.getState({ userDataDir }).setupActions[0];
  assert.ok(choices.versions.includes("2024.13.1.242")); assert.equal(choices.versions.includes("2025.1.0.12"), false);
  const installed = await Official.manager.performSetupAction({ setupActionId: "installIgor", userDataDir, toolVersion: "2024.13.1.242", dependencies: {
    runProcess: async (exe, args) => { assert.equal(exe, "/usr/bin/ditto"); fs.cpSync(args[0], args[1], { recursive: true }); return { stdout: "", stderr: "" }; }
  } });
  assert.equal(installed.version, "2024.13.1.242"); assert.equal(installed.ready, true);
  assert.equal(Installer.getIgorStatus({ userDataDir }).version, "2024.13.1.242");
  assert.equal(ManagedTools.inspectIgorDirectory(folder).dependencyTreeSha256, source.dependencyTreeSha256);
  fs.writeFileSync(path.join(installed.installDir, "files/Fake.Core.dll"), "changed dependency");
  assert.equal(Installer.getIgorStatus({ userDataDir }).ready, false);
  assert.equal(Installer.getIgorStatus({ userDataDir }).status, "damaged");
});

const igorArch = process.arch === "x64" ? "x64" : "arm64";
function writeIgorFiles(root, { version = [2025, 2, 0, 7], extra, folder: relative = path.join("osx", igorArch) } = {}) {
  const folder = path.join(root, relative), executable = Buffer.alloc(64);
  executable.writeUInt32LE(0xfeedfacf); executable.writeUInt32LE(igorArch === "x64" ? 0x01000007 : 0x0100000c, 4); executable.writeUInt32LE(2, 12);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "Igor"), executable); fs.writeFileSync(path.join(folder, "Igor.dll"), versionDll(version));
  fs.writeFileSync(path.join(folder, "Igor.pdb"), "symbols"); fs.writeFileSync(path.join(folder, "Igor.dll.config"), "<configuration/>");
  if (extra) fs.writeFileSync(path.join(folder, extra), "unexpected");
}
// ditto materializes the archive's files; codesign reports the vendor signature check.
function publicIgorRunner(calls, { signed = true, ...files } = {}) {
  return async (executable, args) => {
    calls.push([executable, ...args]);
    if (executable === "/usr/bin/ditto") writeIgorFiles(args[3], files);
    else if (executable === "/usr/bin/codesign") { if (!signed) throw Object.assign(new Error("test-requirement: code failed to satisfy specified code requirement(s)"), { code: 3 }); }
    else assert.fail(`unexpected execution of ${executable}`);
    return { stdout: "", stderr: "" };
  };
}
test("a replaced public Igor download installs by its Developer ID signature and records the version in Igor.dll", { skip: process.platform !== "darwin" }, async t => {
  const userDataDir = temporary(t), calls = [], archive = Buffer.from("updated vendor Igor archive");
  const location = Installer.bootstrapForArch(igorArch).location, before = Fixture.Harness.network.requests.length;
  const installed = await Fixture.withFiles({ [location]: archive }, () => Installer.ensureIgor({ userDataDir, arch: igorArch, runProcess: publicIgorRunner(calls) }));
  assert.deepEqual(Fixture.Harness.network.requests.slice(before), [location]); assert.equal(installed.ready, true); assert.equal(installed.version, "2025.2.0.7");
  assert.equal(installed.archiveSha256, hash(archive)); assert.equal(installed.teamIdentifier, "C9E7J7HL3D");
  assert.equal(installed.installDir, path.join(userDataDir, "runtimes/gamemaker-official/tools", hash(archive)));
  assert.deepEqual(calls.map(call => call[0]), ["/usr/bin/ditto", "/usr/bin/codesign"]);
  assert.deepEqual(calls[1].slice(1, 3), ["--verify", "--strict"]);
  assert.match(calls[1][3], /^-R=anchor apple generic and .*certificate leaf\[subject\.OU\] = "C9E7J7HL3D"$/);
  assert.ok(calls[1][4].endsWith(path.join("osx", igorArch, "Igor")));
  assert.equal(ManagedTools.getSelectedIgorVersion({ userDataDir }), "2025.2.0.7");
  assert.equal(Installer.getIgorStatus({ userDataDir, arch: igorArch }).version, "2025.2.0.7");
  assert.deepEqual(Official.manager.getState({ userDataDir }).setupActions[0].installedVersions, ["2025.2.0.7"]);
  assert.deepEqual(fs.readdirSync(path.join(userDataDir, "runtimes/gamemaker-official/tools")).sort(), [hash(archive), "selected.json"].sort());
});
test("a public Igor download with another signer is rejected before it runs", { skip: process.platform !== "darwin" }, async t => {
  const userDataDir = temporary(t), tools = path.join(userDataDir, "runtimes/gamemaker-official/tools");
  const calls = [];
  await assert.rejects(Fixture.withFiles({ [Installer.bootstrapForArch(igorArch).location]: Buffer.from("replaced vendor archive") },
    () => Installer.ensureIgor({ userDataDir, arch: igorArch, runProcess: publicIgorRunner(calls, { signed: false }) })),
    /not validly signed by Developer ID team C9E7J7HL3D/);
  assert.equal(calls.some(call => path.basename(call[0]) === "Igor"), false);
  assert.deepEqual(fs.readdirSync(tools), []);
  assert.equal(ManagedTools.getSelectedIgorVersion({ userDataDir }), null);
});
test("a later Igor download with added files or a deeper folder installs and records every file", { skip: process.platform !== "darwin" }, async t => {
  for (const options of [{ extra: "Igor.dylib" }, { folder: path.join("Igor 2026", "osx", igorArch) }]) {
    const userDataDir = temporary(t), archive = Buffer.from("later vendor archive " + JSON.stringify(options));
    const installed = await Fixture.withFiles({ [Installer.bootstrapForArch(igorArch).location]: archive },
      () => Installer.ensureIgor({ userDataDir, arch: igorArch, runProcess: publicIgorRunner([], options) }));
    assert.equal(installed.ready, true); assert.equal(installed.version, "2025.2.0.7");
    assert.ok(installed.toolPath.endsWith(path.join(options.folder || path.join("osx", igorArch), "Igor")));
    if (options.extra) assert.ok(installed.files.some(file => path.basename(file.relative) === "Igor.dylib"));
    assert.equal(Installer.getIgorStatus({ userDataDir, arch: igorArch }).ready, true);
    fs.appendFileSync(path.join(path.dirname(installed.toolPath), "Igor.dll.config"), "changed");
    assert.equal(Installer.getIgorStatus({ userDataDir, arch: igorArch }).ready, false);
  }
});
test("an Igor installation recorded with the earlier fixed archive SHA-256 keeps resolving offline", { skip: process.platform !== "darwin" }, async t => {
  const userDataDir = temporary(t), tools = path.join(userDataDir, "runtimes/gamemaker-official/tools");
  const archiveSha256 = igorArch === "x64" ? "1a5cadc5e0f2eac5eaf3d1aede08bd220b445bcbc54e19aae32642b3a88d2c18" : "850260ede5f591000533d760a2c0379bd753e5a6ebb0db30e1003c7957ca1599";
  const directory = path.join(tools, archiveSha256);
  writeIgorFiles(directory, { version: [2024, 0, 0, 32] }); fs.chmodSync(path.join(directory, "osx", igorArch, "Igor"), 0o755);
  const files = ["Igor", "Igor.dll", "Igor.pdb", "Igor.dll.config"].map(name => {
    const relative = path.join("osx", igorArch, name), bytes = fs.readFileSync(path.join(directory, relative));
    return { relative, bytes: bytes.length, sha256: hash(bytes) };
  });
  fs.writeFileSync(path.join(directory, "tool.json"), JSON.stringify({ ...Version.readIgorVersion(path.join(directory, "osx", igorArch, "Igor.dll")),
    version: "2024.0.0.32", architecture: igorArch, archiveSha256, binarySha256: files[0].sha256, sourceUrl: Installer.bootstrapForArch(igorArch).location,
    files, installedAt: "2026-01-01T00:00:00.000Z" }, null, 2) + "\n");
  fs.writeFileSync(path.join(tools, "selected.json"), JSON.stringify({ version: "2024.0.0.32" }) + "\n");
  const status = Installer.getIgorStatus({ userDataDir, arch: igorArch });
  assert.equal(status.ready, true); assert.equal(status.version, "2024.0.0.32"); assert.equal(status.archiveSha256, archiveSha256);
  const reused = await Installer.ensureIgor({ userDataDir, arch: igorArch, runProcess: () => assert.fail("an installed Igor must not run tools") });
  assert.equal(reused.installDir, directory); assert.equal(reused.version, "2024.0.0.32");
  assert.deepEqual(Official.manager.getState({ userDataDir }).setupActions[0].installedVersions, ["2024.0.0.32"]);
});
