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
const Gm8 = require("../src/modules/gamemaker/runtime/gm8-decompiler");
const ManagedTools = require("../src/modules/gamemaker/runtime/official-tools");
const Fixture = require("./helpers/gamemaker-official.cjs");
const { githubAssetDigest } = require("../src/modules/shared/runtime/github-runtime-catalog");
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
});
test("explicit Refresh persists shared catalog, reports loading and preserves selections after failures or rebinding", async t => {
  const userDataDir = temporary(t);
  let requests = 0;
  const pending = Catalog.refreshCatalog({ userDataDir, fetch: async url => {
    requests++; assert.ok(Catalog.FEEDS.some(item => item.url === url));
    await new Promise(resolve => setTimeout(resolve, 2));
    return { status: 200, body: responseBody(url) };
  } });
  assert.equal(Catalog.stateFor(userDataDir).status, "loading");
  const refreshed = await pending;
  assert.equal(requests, 4); assert.equal(refreshed.entries.length, 2);
  assert.equal(Catalog.cachedCatalog(userDataDir).entries[0].version, "2024.14.4.268");
  assert.ok(Official.manager.getState({ userDataDir }).catalog.versions.includes("2024.14.4.268"));
  assert.equal(Installer.resolveBuild({ userDataDir, version: "2024.14.4.268", arch: "x64" }).hostArchitecture, "x64");
  await assert.rejects(Catalog.refreshCatalog({ userDataDir, fetch: async () => ({ status: 503 }) }), /HTTP 503/);
  assert.equal(Catalog.stateFor(userDataDir).status, "error");
  assert.equal(Catalog.cachedCatalog(userDataDir).entries[0].version, "2024.14.4.268");
  await assert.rejects(Catalog.refreshCatalog({ userDataDir, fetch: async url => ({ status: 200, body: responseBody(url, feed("2024.14.4.268", { filename: "changed.zip" })) }) }), /identity changed/);
  assert.equal(Catalog.cachedCatalog(userDataDir).entries[0].packages[0].filename, "core.zip");
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
  await Catalog.refreshCatalog({ userDataDir, fetch: async url => ({ status: 200, body: responseBody(url) }) });
  build.packages = Catalog.selectPackages(build, "arm64");
  let downloads = 0;
  const first = await Installer.cacheArtifacts({ userDataDir, build, download: async (url, destination) => { downloads++; assert.equal(new URL(url).hostname, "gms.yoyogames.com"); fs.writeFileSync(destination, "ZIP"); } });
  assert.equal(downloads, 4);
  assert.ok(first.packages.every(item => item.sha256 === hash("ZIP") && item.integrity === "official-https-observed-sha256"));
  await Installer.cacheArtifacts({ userDataDir, build, download: async () => assert.fail("Cached install must stay offline") });
  const publicPackages = await Packages.downloadPublicPackages({ userDataDir, version: build.version, download: async () => assert.fail("Cached public package action must stay offline") });
  assert.deepEqual(publicPackages.packages.map(item => item.module), ["core", "mac"]);
  assert.equal(publicPackages.installed, false); assert.equal(publicPackages.launchReady, false);
  fs.writeFileSync(path.join(first.root, "core.zip"), "BAD");
  await assert.rejects(Installer.cacheArtifacts({ userDataDir, build }), /SHA-256/);
  assert.throws(() => Installer.resolveBuild({ userDataDir, version: "2025.1.0.1" }), /Refresh/);
});
test("format recommendations choose a cached compatible build while exact incompatible overrides remain rejected", async t => {
  const userDataDir = temporary(t);
  await Catalog.refreshCatalog({ userDataDir, fetch: async url => ({ status: 200, body: responseBody(url, feed("2024.13.1.242")) }) });
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
  assert.throws(() => Version.parseIgorVersion(disagreement), /disagree/);
  const outside = Buffer.from(bytes); outside.writeUInt32LE(0x7fffffff, 0x400 + 72);
  assert.throws(() => Version.parseIgorVersion(outside), /outside/);
  for (const arch of ["arm64", "x64"]) {
    const pin = Installer.bootstrapForArch(arch); assert.equal(pin.version, "2024.0.0.32"); assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  }
  const userDataDir = temporary(t), setup = Official.manager.getState({ userDataDir }).setupActions[0];
  assert.deepEqual(setup.versions, ["2024.0.0.32"]); assert.equal(setup.installedVersion, null);
  assert.equal(setup.version.includes("sha256"), false);
  await assert.rejects(Official.manager.performSetupAction({ setupActionId: "installIgor", userDataDir, toolVersion: "2026.0.0.23" }), /exact Igor/);
});
test("engine release mappers preserve exact tag commits, CLI architecture and truthful unavailable Classic releases", async () => {
  const revision = "a".repeat(40), context = { resolveRevision: async () => revision, githubAssetDigest, sourceUrl: "https://github.com/example/project/releases/tag/0.9.1.2" };
  const [mapped] = await Umt.mapRelease({ tag_name: "0.9.1.2", assets: [{ name: "UTMT_CLI_v0.9.1.2-macOS.zip", id: 12, size: 123, digest: "sha256:" + "b".repeat(64), browser_download_url: "https://github.com/UnderminersTeam/UndertaleModTool/releases/download/0.9.1.2/UTMT_CLI_v0.9.1.2-macOS.zip" }] }, context);
  assert.equal(mapped.cliVersion, "0.9.1.2"); assert.equal(mapped.upstreamRevision, revision); assert.equal(mapped.asset.sha256, "b".repeat(64));
  assert.equal(await Umt.mapRelease({ tag_name: "nightly", assets: [] }, context), null);
  const classic = await Gm8.mapRelease({ tag_name: "v2.1.1" }, context);
  assert.equal(classic.version, "2.1.1"); assert.equal(classic.localBuild, false); assert.equal(classic.asset, undefined); assert.match(classic.installReason, /Windows/);
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
    downloadToFile: () => assert.fail("Local Igor import must not download"),
    runProcess: async (exe, args) => { assert.equal(exe, "/usr/bin/ditto"); fs.cpSync(args[0], args[1], { recursive: true }); return { stdout: "", stderr: "" }; }
  } });
  assert.equal(installed.version, "2024.13.1.242"); assert.equal(installed.ready, true);
  assert.equal(Installer.getIgorStatus({ userDataDir }).version, "2024.13.1.242");
  assert.equal(ManagedTools.inspectIgorDirectory(folder).dependencyTreeSha256, source.dependencyTreeSha256);
  fs.writeFileSync(path.join(installed.installDir, "files/Fake.Core.dll"), "changed dependency");
  assert.equal(Installer.getIgorStatus({ userDataDir }).ready, false);
  assert.equal(Installer.getIgorStatus({ userDataDir }).status, "damaged");
});
