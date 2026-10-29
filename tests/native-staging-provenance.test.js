const assert = require("node:assert/strict");
const test = require("node:test");
const { publicProvenance, sanitizeHomebrewReceipt, reviewedBinaryTree, validateArtifactSource, parseLinkedLibraries } = require("../scripts/stage-native-runtimes.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Native = require("../src/modules/shared/runtime/local-native");

test("universal Mach-O slice headers cannot become dependency paths and repeated libraries are deduplicated", () => {
  const output = ["/runtime/My App.app/libEGL.dylib (architecture x86_64):",
    "\t@rpath/libEGL.dylib (compatibility version 0.0.0, current version 0.0.0)",
    "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1319.0.0)",
    "/runtime/My App.app/libEGL.dylib (architecture arm64):",
    "\t@rpath/libEGL.dylib (compatibility version 0.0.0, current version 0.0.0)",
    "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1319.0.0)",
    "\t@loader_path/lib sound.dylib (compatibility version 1.0.0, current version 1.1.0)"].join("\n");
  assert.deepEqual(parseLinkedLibraries(output), ["@rpath/libEGL.dylib", "/usr/lib/libSystem.B.dylib", "@loader_path/lib sound.dylib"]);
});

test("staging rejects non-executable and special executable mode overrides", async () => {
  const { stagePackage } = require("../scripts/stage-native-runtimes.cjs");
  for (const executableMode of [0o644, 0o4755, "0755", -1]) {
    await assert.rejects(stagePackage({ executableMode }, { arch: "arm64" }), /mode must be 0755/);
  }
});

test("a catalog-reviewed binary stages without Git source, binds every resource, and cannot claim a source build", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-reviewed-binary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "runtime"), resource = path.join(root, "font.dat");
  fs.writeFileSync(executable, "reviewed executable", { mode: 0o755 });
  fs.writeFileSync(resource, "reviewed runtime resource");
  const revision = "a".repeat(40), pin = { publishedBinary: { executableSha256: Native.hashFile(executable), treeSha256: reviewedBinaryTree(root) } };
  const input = { appRoot: root, executable, expectedInputSha256: pin.publishedBinary.executableSha256,
    provenance: { sourceKind: "reviewed-binary", verifiedBuild: false } };
  assert.deepEqual(await validateArtifactSource(input, null, revision, pin), { head: revision, artifactTreeSha256: pin.publishedBinary.treeSha256 });
  await assert.rejects(validateArtifactSource({ ...input, provenance: { ...input.provenance, verifiedBuild: true } }, null, revision, pin), /verified-build claim/);
  await assert.rejects(validateArtifactSource(input, root, revision, pin), /no source checkout/);
  await assert.rejects(validateArtifactSource(input, null, revision, {}), /complete artifact identity/);
  fs.writeFileSync(resource, "changed runtime resource");
  await assert.rejects(validateArtifactSource(input, null, revision, pin), /complete artifact identity/);
  fs.writeFileSync(resource, "reviewed runtime resource");
  fs.symlinkSync(executable, path.join(root, "unreviewed-link"));
  await assert.rejects(validateArtifactSource(input, null, revision, pin), /symlinks/);
});

test("native staging keeps public build evidence and logical compiler options without private receipt locations", () => {
  const revision = "a".repeat(40), hash = "b".repeat(64);
  const original = { sourceRevision: revision, sourceTreeSha256: hash, verifiedBuild: true,
    logPath: "/tmp/private-native/build.log", evidenceSource: ".local/native/receipt.json",
    configureOptions: ["-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0",
      "-DCMAKE_C_FLAGS=-ffile-prefix-map=/tmp/private-native/source=engine-source -fdebug-prefix-map=/tmp/private-native/build=engine-build"],
    dependencies: [{ name: "SDL2", sourceRevision: revision, sourceTreeSha256: hash, logPath: "/tmp/private-native/sdl.log" }] };
  const before = structuredClone(original);
  const projected = publicProvenance(original, [{ from: "/tmp/private-native/source", to: "${SOURCE_ROOT}" },
    { from: "/tmp/private-native/build", to: "${BUILD_ROOT}" }]);
  assert.deepEqual(projected, { sourceRevision: revision, sourceTreeSha256: hash, verifiedBuild: true,
    configureOptions: ["-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0",
      "-DCMAKE_C_FLAGS=-ffile-prefix-map=${SOURCE_ROOT}=engine-source -fdebug-prefix-map=${BUILD_ROOT}=engine-build"],
    dependencies: [{ name: "SDL2", sourceRevision: revision, sourceTreeSha256: hash }] });
  assert.deepEqual(original, before);
});

test("native staging rejects an unprojected private provenance field", () => {
  assert.throws(() => publicProvenance({ configureOptions: ["-I/tmp/private-native/source"] }), /private filesystem/);
  assert.throws(() => publicProvenance({ unexpected: { path: ".local/native/evidence.json" } }), /private filesystem/);
  for (const path of ["SOURCE_ROOT/.local/example/private-build", "SOURCE_ROOT\\.local\\notes\\private.json"]) {
    assert.throws(() => publicProvenance({ configureOptions: { CMAKE_PREFIX_PATH: path } }), /private filesystem/);
    assert.throws(() => require('../scripts/native-supplementals.cjs').validatePublicMetadata({ configureOptions: path }), /private filesystem/);
  }
  assert.throws(() => publicProvenance({ source: "/tmp/private-native/.local/example/source" },
    [{ from: "/tmp/private-native", to: "SOURCE_ROOT" }]), /private filesystem/);
  assert.deepEqual(publicProvenance({ source: "/tmp/private-native/.local/example/source" },
    [{ from: "/tmp/private-native/.local/example/source", to: "SOURCE_ROOT" }]), { source: "SOURCE_ROOT" });
  assert.throws(() => publicProvenance({}, [{ from: "relative/source", to: "source" }]), /absolute build prefixes/);
  assert.throws(() => publicProvenance({}, [{ from: "/tmp/private-native", to: "../private" }]), /logical identities/);
});

test('native staging projects source-indexed object keys without changing supplied identities',()=>{
 const hash='d'.repeat(64),url='https://android.googlesource.com/platform/system/core';
 const original={modules:{'/tmp/native-source/libbase':{url,revision:hash,files:[{'/tmp/native-source/libbase/file.cpp':hash}],logPath:'/tmp/native-source/build.log'}},evidenceSource:'.local/receipt.json'};
 const before=structuredClone(original);
 const projected=publicProvenance(original,[{from:'/tmp/native-source',to:'SOURCE'}]);
 assert.deepEqual(projected,{modules:{'SOURCE/libbase':{url,revision:hash,files:[{'SOURCE/libbase/file.cpp':hash}]}}});
 assert.deepEqual(original,before);
 assert.throws(()=>publicProvenance({'/tmp/native-source/file.cpp':hash}),/private filesystem/);
});

test('native staging rejects key collisions created by path projection',()=>{
 const mapping=[{from:'/tmp/native-source',to:'SOURCE'}];
 assert.throws(()=>publicProvenance({'/tmp/native-source/file.cpp':'first','SOURCE/file.cpp':'second'},mapping),/duplicate metadata key/);
 assert.throws(()=>publicProvenance({nested:{'/tmp/native-one/file.cpp':1,'/tmp/native-two/file.cpp':2}},[
  {from:'/tmp/native-one',to:'SOURCE'},{from:'/tmp/native-two',to:'SOURCE'}]),/duplicate metadata key/);
 // The same logical key in independent objects is not a collision.
 assert.deepEqual(publicProvenance([{ '/tmp/native-source/file.cpp':1 },{ '/tmp/native-source/file.cpp':2 }],mapping),[
  {'SOURCE/file.cpp':1},{'SOURCE/file.cpp':2}]);
});

test("native dependency receipts retain formula and build identities while keeping the original private receipt intact", () => {
  const receipt = { homebrew_version: "test-version", compiler: "clang", arch: "arm64", built_as_bottle: true,
    source: { spec: "stable", versions: { stable: "1.2.3", head: null }, path: "/tmp/private-native/Formula/f/formula.rb", tap: "homebrew/core", tap_git_head: "c".repeat(40) },
    runtime_dependencies: [{ full_name: "dependency", version: "2.0", revision: 1 }],
    built_on: { os: "Macintosh", os_version: "macOS 13" } };
  const before = structuredClone(receipt);
  const sanitized = sanitizeHomebrewReceipt(receipt, { name: "formula@1", version: "1.2.3_1" });
  assert.deepEqual(sanitized, { ...receipt, source: { spec: "stable", versions: receipt.source.versions, tap: "homebrew/core",
    tap_git_head: "c".repeat(40), formula: "homebrew/core/formula@1", pkg_version: "1.2.3_1" } });
  assert.deepEqual(receipt, before);
  assert.throws(() => sanitizeHomebrewReceipt({ ...receipt, extra: "/tmp/private-native/cache" }, { name: "formula", version: "1.2.3" }), /private filesystem/);
  assert.throws(() => sanitizeHomebrewReceipt(receipt, { name: "../formula", version: "1.2.3" }), /formula identity/);
});
