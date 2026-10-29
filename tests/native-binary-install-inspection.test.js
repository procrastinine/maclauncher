const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Siglus = require("../src/modules/siglus/runtime/profile");
const Native = require("../src/modules/shared/runtime/local-native");
const MachO = require("../src/modules/shared/runtime/macho-load-commands");
const { inspectMachOExports } = require("../src/modules/shared/runtime/macho-exports");
const KiriKiri = require("../src/modules/kirikiri/catalog");
const Nscripter = require("../src/modules/nscripter/main");
const { ARM64, X64, image, universal } = require("./fixtures/macho-image");

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-binary-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
const symbols = ["game_run_entry", "game_probe_json", "game_string_free"];
const hostBytes = image({ cpu: process.arch === "x64" ? X64 : ARM64, fileType: 2, installName: null });
function fixtureHostIdentity(t) {
  const previous = { sha256: Siglus.HOST.sha256 };
  t.after(() => Object.assign(Siglus.HOST, previous));
  Siglus.HOST.sha256 = require("node:crypto").createHash("sha256").update(hostBytes).digest("hex");
}
function siglusInput(t, bytes, { hostSourceSha256 = Siglus.HOST.sourceSha256, hostContent = hostBytes, version = "managed-fixture-1" } = {}) {
  const installDir = directory(t), root = path.join(installDir, "project-payload/files");
  const original = path.join(root, "lib/libsiglus.dylib"), host = path.join(root, "bin/siglus-host");
  fs.mkdirSync(path.dirname(original), { recursive: true }); fs.mkdirSync(path.dirname(host), { recursive: true });
  fs.writeFileSync(original, bytes); fs.writeFileSync(host, hostContent, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "LICENSE-siglus_rs.txt"), "Fixture license notice");
  const files = Object.fromEntries(["bin/siglus-host", "lib/libsiglus.dylib", "LICENSE-siglus_rs.txt"].map(name => [name, Native.hashFile(path.join(root, name))]));
  const profile = { schema: 1, profile: Siglus.PROFILE, version, upstreamRevision: "a".repeat(40), hostSourceSha256, files };
  const project = { id: "siglus", arch: process.arch, manifestRelative: "manifest.json", capabilities: { nativeApi: "game_run_entry-v1" } };
  const install = { installDir, executablePath: host, version: profile.version, upstreamRevision: profile.upstreamRevision,
    source: "download", binarySha256: files["bin/siglus-host"], catalogEntry: { projectPackage: project }, installationMetadata: {} };
  const seal = value => { fs.writeFileSync(path.join(root, "siglus-profile.json"), JSON.stringify(value));
    install.installationMetadata.profileSha256 = Native.hashFile(path.join(root, "siglus-profile.json")); };
  seal(profile);
  const manifest = { schemaVersion: 1, managerId: "siglus", version, upstreamRevision: profile.upstreamRevision,
    platform: "darwin", arch: process.arch, minimumMacOS: "13.0", executableRelative: "bin/siglus-host",
    runtimeFiles: { siglusProfile: "siglus-profile.json", siglusLibrary: "lib/libsiglus.dylib" },
    provenance: { sourceRevision: profile.upstreamRevision }, dependencies: [],
    notices: [{ name: "Fixture", license: "MIT", sourceUrl: "https://example.com/siglus", path: "LICENSE-siglus_rs.txt" }],
    files: [...Object.keys(files), "siglus-profile.json"].map(name => {
      const file = path.join(root, name), stat = fs.statSync(file);
      return { path: name, sha256: Native.hashFile(file), size: stat.size, mode: stat.mode & 0o777,
        ...(name === "bin/siglus-host" ? { architectures: [process.arch === "x64" ? "x86_64" : "arm64"] } : {}) };
    }) };
  const manifestPath = path.join(installDir, "project-payload/manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest)); project.manifestSha256 = Native.hashFile(manifestPath);
  return { root, original, host, profile, install, seal, manifestPath };
}
function signatureOnly(calls) { return async (command, args) => {
  assert.equal(command, "/usr/bin/codesign", "binary installs use no compiler or developer inspection tool");
  calls.push(args); return { stdout: "" };
}; }

test("Siglus verifies the selected managed profile and rejects changed native code, identity and unsupported CPU", t => {
  fixtureHostIdentity(t);
  const bytes = image({ cpu: process.arch === "x64" ? X64 : ARM64, installName: "@rpath/libsiglus.dylib", symbols });
  const input = siglusInput(t, bytes), originalProfile = fs.readFileSync(path.join(input.root, "siglus-profile.json"));
  assert.equal(Siglus.resolveProfile(input.install).libraryPath, input.original);
  assert.deepEqual(fs.readFileSync(input.original), bytes); assert.deepEqual(fs.readFileSync(path.join(input.root, "siglus-profile.json")), originalProfile);
  for (const change of [{ schema: 2 }, { profile: "unknown-profile" }, { version: "other" }, { upstreamRevision: "b".repeat(40) },
    { hostSourceSha256: "0".repeat(64) }, { files: { ...input.profile.files, "bin/siglus-host": "0".repeat(64) } },
    { files: { ...input.profile.files, unexpected: "0".repeat(64) } }]) {
    input.seal({ ...input.profile, ...change });
    assert.throws(() => Siglus.resolveProfile(input.install), /profile has changed|payload is incomplete|differs from its sealed package/);
  }
  input.seal(input.profile);
  fs.appendFileSync(input.host, "changed");
  assert.throws(() => Siglus.resolveProfile(input.install, { verification: "status" }), /payload has changed/);
  fs.writeFileSync(input.host, hostBytes);
  fs.appendFileSync(input.original, "changed");
  assert.throws(() => Siglus.resolveProfile(input.install), /payload has changed/);
  const unsupported = siglusInput(t, image({ cpu: 7, installName: "@rpath/libsiglus.dylib", symbols }));
  assert.throws(() => Siglus.resolveProfile(unsupported.install), /64-bit|unsupported|does not support/);
});
test("Siglus accepts a later sealed managed host and rejects warm-cache payload, seal and API changes", t => {
  const bytes = image({ cpu: process.arch === "x64" ? X64 : ARM64, installName: "@rpath/libsiglus.dylib", symbols });
  const input = siglusInput(t, bytes, { version: "later-managed-2", hostSourceSha256: "b".repeat(64),
    hostContent: Buffer.concat([hostBytes, Buffer.from("later host revision")]) });
  assert.notEqual(input.profile.hostSourceSha256, Siglus.HOST.sourceSha256);
  assert.notEqual(input.profile.files["bin/siglus-host"], Siglus.HOST.sha256);
  assert.equal(Siglus.resolveProfile(input.install).executablePath, input.host);
  assert.equal(Siglus.resolveProfile(input.install, { verification: "status" }).version, "later-managed-2");
  assert.throws(() => Siglus.resolveProfile({ ...input.install, catalogEntry: {} }), /profile has changed/);
  const originalHost = fs.readFileSync(input.host), originalManifest = fs.readFileSync(input.manifestPath);
  fs.appendFileSync(input.host, "changed");
  assert.throws(() => Siglus.resolveProfile(input.install, { verification: "status" }), /payload has changed/);
  fs.writeFileSync(input.host, originalHost);
  Siglus.resolveProfile(input.install);
  fs.appendFileSync(input.manifestPath, " ");
  assert.throws(() => Siglus.resolveProfile(input.install, { verification: "status" }), /manifest has changed/);
  fs.writeFileSync(input.manifestPath, originalManifest);
  Siglus.resolveProfile(input.install);
  input.install.catalogEntry.projectPackage.capabilities.nativeApi = "game_run_entry-v2";
  assert.throws(() => Siglus.resolveProfile(input.install, { verification: "status" }), /unsupported native API/);
});
test("direct-host native inspection rejects non-Mac images and external loader dependencies without changing bytes", t => {
  for (const spec of [
    { platform: 2, expected: /macOS deployment/ },
    { dependencies: ["/opt/homebrew/lib/libSDL.dylib"], expected: /unbundled/ },
    { runPaths: ["/opt/homebrew/lib"], expected: /search path/ }
  ]) {
    const root = directory(t), file = path.join(root, "libsiglus.dylib"), bytes = image({ installName: "@rpath/libsiglus.dylib", symbols, ...spec });
    fs.writeFileSync(file, bytes);
    assert.throws(() => MachO.assertSystemLibraryClosure(MachO.readMachOLoadCommands(file), { fileType: 6, installName: "@rpath/libsiglus.dylib", maximumMacOS: "13.0" }), spec.expected);
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
});
test("Siglus library export inspection reads the selected CPU instead of combining universal slices", async t => {
  fixtureHostIdentity(t);
  const bytes = universal([{ cpu: X64, bytes: image({ cpu: X64, installName: "@rpath/libsiglus.dylib", symbols: symbols.slice(0, 2) }) },
    { cpu: ARM64, bytes: image({ installName: "@rpath/libsiglus.dylib", symbols }) }]);
  const input = siglusInput(t, bytes);
  assert.deepEqual(new Set(await inspectMachOExports(input.original, { arch: "arm64" })), new Set(symbols));
  assert.deepEqual(new Set(await inspectMachOExports(input.original, { arch: "x64" })), new Set(symbols.slice(0, 2)));
  assert.equal((await inspectMachOExports(input.original, { arch: "x64" })).includes("game_string_free"), false);
  assert.deepEqual(Siglus.resolveProfile(input.install).libraryArchitectures.sort(), ["arm64", "x86_64"]);
});
test("KiriKiri verifies every universal slice before signing the managed executable", async t => {
  const root = directory(t), executable = path.join(root, "krkrsdl2"), calls = [];
  const pin = { asset: { filename: "krkrsdl2-macos.zip" }, executableRelative: "krkrsdl2", version: "development-fixture" };
  const bytes = universal([{ cpu: X64, bytes: image({ cpu: X64, fileType: 2, installName: null }) },
    { cpu: ARM64, bytes: image({ fileType: 2, installName: null }) }]);
  fs.writeFileSync(executable, bytes);
  await KiriKiri.prepareReleaseInstall({ unpacked: root, pin }, { execFile: signatureOnly(calls) });
  assert.deepEqual(calls, [["--force", "--sign", "-", executable], ["--verify", "--strict", executable]]);
  const bad = universal([{ cpu: X64, bytes: image({ cpu: X64, fileType: 2, installName: null, dependencies: ["@rpath/libMissing.dylib"] }) },
    { cpu: ARM64, bytes: image({ fileType: 2, installName: null }) }]);
  fs.writeFileSync(executable, bad); calls.length = 0;
  await assert.rejects(KiriKiri.prepareReleaseInstall({ unpacked: root, pin }, { execFile: signatureOnly(calls) }), /unbundled/);
  assert.equal(calls.length, 0); assert.deepEqual(fs.readFileSync(executable), bad);
});
test("KiriKiri rejects invalid deployment metadata and truncation before signing", async t => {
  const root = directory(t), executable = path.join(root, "krkrsdl2");
  const pin = { asset: { filename: "krkrsdl2-macos.zip" }, executableRelative: "krkrsdl2", version: "development-fixture" };
  for (const bytes of [image({ fileType: 2, installName: null, platform: 2 }), image({ fileType: 2, installName: null, platform: null }),
    image({ fileType: 2, installName: null }).subarray(0, 40)]) {
    fs.writeFileSync(executable, bytes); const calls = [];
    await assert.rejects(KiriKiri.prepareReleaseInstall({ unpacked: root, pin }, { execFile: signatureOnly(calls) }));
    assert.equal(calls.length, 0);
  }
});
test("NScripter missing-library diagnostics retain paths with spaces and need no external inspection", t => {
  const root = directory(t), executable = path.join(root, "onsyuri");
  const missing = "/outside directory/liblua.5.5.dylib";
  fs.writeFileSync(executable, image({ fileType: 2, installName: null,
    dependencies: ["/usr/lib/libSystem.B.dylib", missing, "@rpath/libRelative.dylib"] }));
  const result = Nscripter.__test.listMissingDylibs(executable, { platform: "darwin", existsFn: () => false });
  assert.deepEqual(result, { missing: [missing], brewHints: ["lua"] });
  fs.writeFileSync(executable, Buffer.from("not a Mach-O"));
  assert.equal(Nscripter.__test.listMissingDylibs(executable, { platform: "darwin" }), null);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => Nscripter.__test.listMissingDylibs(executable, { platform: "darwin", signal: controller.signal }), { code: "ABORT_ERR" });
});
