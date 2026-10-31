const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Included = require("../src/modules/shared/runtime/included-helpers");
const B = require("../src/modules/shared/runtime/bundled-native");

test("included packages prefer this app's build per version and preserve other versions", () => {
  const universal = { id: "sample", version: "1.0", arch: "universal", launcherArchitectures: ["arm64", "x64"] };
  const intel = { ...universal, arch: "x64", launcherArchitectures: ["x64"] };
  const legacy = { ...intel, version: "0.9", launcherArchitectures: ["arm64", "x64"] };
  const silicon = { ...universal, arch: "arm64", launcherArchitectures: ["arm64"] };
  for (const rows of [[universal, intel, legacy], [intel, universal, legacy]]) {
    assert.equal(Included.declared(rows, { id: "sample", arch: "x64" }), intel);
    assert.equal(Included.declared(rows, { id: "sample", arch: "arm64" }), universal);
    assert.deepEqual(Included.preferredIncludedBuilds(rows, "x64"), [intel, legacy]);
    assert.equal(Included.declared(rows, { id: "sample", arch: "arm64", version: "0.9" }), legacy);
  }
  assert.equal(Included.declared([universal, silicon, intel], { id: "sample", arch: "arm64" }), silicon);
  assert.equal(Included.declared([universal], { id: "sample" }), universal);
});

test("included helpers resolve only declared host versions and reject modified bytes", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "included-helper-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("sealed helper data"), metadata = Buffer.from('{"schemaVersion":1}\n');
  const declaration = { id: "sample", version: "1.0", launcherArchitectures: ["arm64"],
    directoryRelative: "sample/1.0/arm64", manifestRelative: "manifest.json", manifestSha256: B.digest(metadata), files: [
      { path: "data", size: bytes.length, mode: 0o644, sha256: B.digest(bytes) },
      { path: "manifest.json", size: metadata.length, mode: 0o644, sha256: B.digest(metadata) }
    ] };
  const directory = path.join(root, "native-runtimes", declaration.directoryRelative);
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "data"), bytes); fs.writeFileSync(path.join(directory, "manifest.json"), metadata);
  const options = { id: "sample", version: "1.0", arch: "arm64", resourcesRoot: root, verification: "full" };
  assert.equal(Included.resolveIncluded([declaration], options).directory, directory);
  assert.equal(Included.resolveIncluded([], options), null, "an existing staging directory grants no inclusion");
  assert.equal(Included.resolveIncluded([declaration], { ...options, arch: "x64" }), null);
  assert.equal(Included.resolveIncluded([declaration], { ...options, version: "2.0" }), null);
  fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(bytes.length));
  assert.throws(() => Included.resolveIncluded([declaration], options), /checksum|changed|size/i);
});

test("a helper without a build for this Mac reports the Mac it needs instead of a missing installation", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "included-host-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const declaration = { id: "reader", version: "1.0", launcherArchitectures: ["arm64"], directoryRelative: "reader/1.0/arm64",
    manifestRelative: "manifest.json", manifestSha256: "a".repeat(64), files: [] };
  assert.throws(() => Included.requireIncluded([declaration], { id: "reader", arch: "x64", resourcesRoot: root }),
    error => error.code === "HOST_ARCHITECTURE_UNSUPPORTED" && error.message === "Requires a Mac with Apple Silicon.");
  assert.throws(() => Included.requireIncluded([declaration], { id: "reader", arch: "arm64", resourcesRoot: root }), /missing\. Reinstall/);
  assert.throws(() => Included.requireIncluded([declaration], { id: "other", arch: "arm64", resourcesRoot: root }), /included other is missing/);
  assert.equal(Included.hostRequirement([declaration], { id: "reader", arch: "arm64" }), null);
});

test("an unpackaged launcher uses only its included resource root", () => {
  assert.equal(Included.resourcesRoot({ packaged: false, resourcesPath: "/other/resources" }), Included.SOURCE_RESOURCES);
  assert.equal(Included.resourcesRoot({ packaged: true, resourcesPath: "/application/resources" }), "/application/resources");
  assert.throws(() => Included.resourcesRoot({ packaged: true }), /resources/);
});

test("unchanged upstream helper suppliers retain their direct bundled routes", () => {
  const declarations = require("../src/modules/shared/runtime/distribution-supplementals.json");
  for (const id of ["python", "sevenzip", "evbunpack"]) assert.equal(declarations.some(item => item.id === id), false, id);
  const Python = require("../src/modules/shared/runtime/python"), Sevenzip = require("../src/modules/shared/runtime/sevenzip");
  assert.equal(Python.resolveEmbeddedPythonRoot(), path.resolve(__dirname, "../src/resources/python"));
  assert.equal(Python.resolveEvbunpackRoot(), path.resolve(__dirname, "../src/external/evbunpack"));
  const executable = Sevenzip.resolveSevenZipBinary();
  assert.equal(executable, path.resolve(__dirname, "../src/resources/7zip/7zz"));
  assert.equal(B.digest(fs.readFileSync(executable)), require("../src/resources/7zip/source.json").executableSha256);
});

test("the retired Goldberg package is absent from runtime catalogs and cannot resolve as included", () => {
  const Steam = require("../src/modules/shared/runtime/steamworks");
  const catalog = require("../src/modules/shared/runtime/steamworks/versions.json");
  assert.equal(catalog.some(item => item.packageVersion?.startsWith("goldberg")), false);
  const profiles = require("../src/modules/shared/runtime/steamworks/profiles.json");
  assert.equal(profiles.some(item => item.helperVersion?.startsWith("goldberg")), false);
  const pin = { version: "goldberg-mac-1.0.0-ml1-universal",
    packageVersion: "goldberg-mac-1.0.0-ml1-package2-universal",
    sourceRevision: "6aab9c6ff879ceae24891b7930a222829573bddf", architectures: ["arm64", "x86_64"], qualifiedInterfaces: [] };
  const result = Steam.resolveBundledLibrary({ architecture: "arm64", interfaces: [], catalog: [pin] });
  assert.equal(result.ready, false);
  assert.equal(result.present, false);
});
