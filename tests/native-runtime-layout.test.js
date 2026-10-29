const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const test = require("node:test");
const { resolveExecutableRelative, requiresDistribution } = require("../scripts/stage-native-runtimes.cjs");
const { bundleDirectories, distributionArchitectures, verifyPackages } = require("../scripts/verify-native-runtimes.cjs");
const { publishPackages, main: publishMain } = require("../scripts/publish-native-runtimes.cjs");
const B = require("../src/modules/shared/runtime/bundled-native");

test("native staging preserves ordinary defaults and an explicit nested host layout", () => {
  assert.equal(resolveExecutableRelative({}, "/build/dotnet"), "bin/dotnet");
  assert.equal(resolveExecutableRelative({ executableRelative: "fna/dotnet" }, "/build/dotnet"), "fna/dotnet");
});
test("distribution requires explicit inclusion regardless of source or download availability", () => {
  const source = { upstreamRevision: "a".repeat(40) }, asset = { ...source, asset: { url: "https://example.com/runtime" } };
  assert.equal(requiresDistribution({ core: { catalog: [source] } }), false);
  assert.equal(requiresDistribution({ distributionRequired: false, core: { catalog: [source] } }), false);
  assert.equal(requiresDistribution({ distributionRequired: true, core: { catalog: [source] } }), true);
  assert.equal(requiresDistribution({ core: { catalog: [asset] } }), false);
  assert.equal(requiresDistribution({ distributionRequired: true, core: { catalog: [asset] } }), true);
  assert.equal(requiresDistribution({ core: { catalog: [{ ...source, localBuild: false }] } }), false);
  assert.equal(requiresDistribution({ core: { catalog: [{ ...source, deprecated: true }] } }), false);
});
test("native staging rejects unsafe host locations and inconsistent app overrides", () => {
  for (const value of ["../dotnet", "/dotnet", "fna/../dotnet", "fna\\dotnet", "", "fna\0/dotnet"]) assert.throws(() => resolveExecutableRelative({ executableRelative: value }, "/build/dotnet"), /Unsafe/);
  const appRoot = path.resolve("Game.app"), executable = path.join(appRoot, "Contents", "MacOS", "Game");
  assert.equal(resolveExecutableRelative({ appRoot }, executable), "Game.app/Contents/MacOS/Game");
  assert.throws(() => resolveExecutableRelative({ appRoot, executableRelative: "bin/Game" }, executable), /cannot be overridden/);
});

test("distribution architecture metadata preserves Intel artifacts for ARM launchers explicitly", () => {
  assert.deepEqual(distributionArchitectures({}, "arm64"), ["arm64"]);
  assert.deepEqual(distributionArchitectures({ distributionArchitectures: { arm64: ["x64"], x64: ["x64"] } }, "arm64"), ["x64"]);
  const armOnly = { distributionArchitectures: { arm64: ["arm64"], x64: [] } };
  assert.deepEqual(distributionArchitectures(armOnly, "arm64"), ["arm64"]);
  assert.deepEqual(distributionArchitectures(armOnly, "x64"), []);
  for (const mapping of [{}, { arm64: ["universal"] }, { arm64: [] }, { arm64: ["x64", "x64"] }]) assert.throws(() => distributionArchitectures({ distributionArchitectures: mapping }, "arm64"), /explicit supported/);
});

test("selected runtime publication needs an explicit output before reading or changing files", t => {
  let reads = 0, writes = 0, verification = 0;
  const sourceError = new Error('Included source inspection reached');
  t.mock.method(fs, 'realpathSync', () => { reads++; throw sourceError; });
  t.mock.method(fs, 'mkdirSync', () => { writes++; throw new Error('No output may be created'); });
  const sourceRoot = path.resolve('unused-stage'), dependencies = { managers() { verification++; throw new Error('No verification may start'); } };
  for (const resourceRoot of [undefined, '', ' '])
    assert.throws(() => publishPackages({ sourceRoot, resourceRoot, managerIds: ['test'], dependencies }), /explicit output directory/);
  assert.throws(() => publishMain(['--source', sourceRoot, '--only', 'test']), /explicit output directory/);
  assert.deepEqual([reads, writes, verification], [0, 0, 0]);
  assert.throws(() => publishPackages({ sourceRoot, dependencies }), error => error === sourceError);
  assert.throws(() => publishPackages({ sourceRoot, managerIds: [], dependencies }), error => error === sourceError);
  assert.deepEqual([reads, writes, verification], [2, 0, 0], 'The included-set and supplemental-only defaults still enter their normal source inspection');
});

test("distribution verifies and publishes both exact versions while preserving unrelated resources", t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "native-layout-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), output = path.join(root, "resources");
  const versions = ["1.0", "2.0"], pins = versions.map((version, index) => ({ version, upstreamRevision: String(index + 1).repeat(40) }));
  const manager = { id: "test", distributionRequired: true, distributionVersions: versions, core: { catalog: pins } };
  const dependencies = { managers: () => new Map([["test", manager]]), loadCommands: () => ({ minimumMacOS: "13.0" }), verifySignature: () => {} };
  function write(version, legacy = false) {
    const directory = legacy ? path.join(source, "test", "arm64") : path.join(source, "test", version, "arm64"), payload = path.join(directory, "files"); fs.mkdirSync(payload, { recursive: true });
    const runner = Buffer.alloc(32); runner.writeUInt32LE(0xfeedfacf); runner.writeUInt32LE(0x0100000c, 4); runner.writeUInt32LE(2, 12); fs.writeFileSync(path.join(payload, "runner"), runner, { mode: 0o755 });
    const notice = Buffer.from(version); fs.writeFileSync(path.join(payload, "LICENSE"), notice, { mode: 0o644 });
    const pin = pins.find(pin => pin.version === version);
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, managerId: "test", version, upstreamRevision: pin.upstreamRevision, platform: "darwin", arch: "arm64", minimumMacOS: "13.0", executableRelative: "runner", dependencies: [], provenance: { sourceRevision: pin.upstreamRevision }, notices: [{ name: "test", license: "Test", sourceUrl: "https://example.com", path: "LICENSE" }], files: [{ path: "runner", size: 32, sha256: B.digest(runner), mode: 0o755, architectures: ["arm64"] }, { path: "LICENSE", size: notice.length, sha256: B.digest(notice), mode: 0o644 }] }));
    return directory;
  }
  write("1.0", true); const second = write("2.0");
  const options = { resourceRoot: source, architectures: ["arm64"], managerIds: ["test"], dependencies };
  assert.equal(bundleDirectories(source, "test", "arm64").length, 2);
  assert.deepEqual(verifyPackages(options).map(row => row.version).sort(), versions);
  fs.mkdirSync(path.join(output, "unrelated"), { recursive: true }); fs.writeFileSync(path.join(output, "unrelated", "keep.txt"), "keep");
  const published = publishPackages({ ...options, sourceRoot: source, resourceRoot: output }); assert.equal(published.length, 2);
  for (const version of versions) assert.ok(fs.existsSync(path.join(output, "test", version, "arm64", "manifest.json")));
  assert.equal(fs.readFileSync(path.join(output, "unrelated", "keep.txt"), "utf8"), "keep");
  assert.deepEqual(verifyPackages({ ...options, versions: ["1.0"] }).map(row => row.version), ["1.0"]);
  assert.throws(() => verifyPackages({ ...options, versions: ["../1.0"] }), /safe explicit/);
  const secondManifestFile = path.join(second, "manifest.json"), secondManifest = JSON.parse(fs.readFileSync(secondManifestFile));
  fs.writeFileSync(path.join(second, "files", "LICENSE"), "2.1"); secondManifest.files.find(file => file.path === "LICENSE").sha256 = B.digest(Buffer.from("2.1")); fs.writeFileSync(secondManifestFile, JSON.stringify(secondManifest));
  const finalFailure = { ...dependencies, verifySignature: file => { if (file.startsWith(output + path.sep)) throw Error("Final signature failure"); } };
  assert.throws(() => publishPackages({ ...options, dependencies: finalFailure, sourceRoot: source, resourceRoot: output }), /Final signature failure/);
  assert.equal(fs.readFileSync(path.join(output, "test", "2.0", "arm64", "files", "LICENSE"), "utf8"), "2.0");
  assert.ok(fs.existsSync(path.join(output, "test", "1.0", "arm64", "manifest.json")));
  fs.writeFileSync(path.join(second, "files", "LICENSE"), "bad");
  assert.throws(() => publishPackages({ ...options, sourceRoot: source, resourceRoot: output }), /checksum/);
  assert.equal(fs.readFileSync(path.join(output, "test", "2.0", "arm64", "files", "LICENSE"), "utf8"), "2.0");
});
