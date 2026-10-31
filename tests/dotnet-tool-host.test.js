// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Host = require("../src/modules/shared/runtime/dotnet-tool-host");
const Native = require("../src/modules/shared/runtime/local-native");
const Pinned = require("../src/modules/shared/runtime/pinned-native-manager");
const { DownloadManager } = require("../src/modules/shared/runtime/download-manager");
const HOST = { version: "10.0.42", architecture: "arm64", minimumMacOS: "14.0",
  url: "https://builds.dotnet.microsoft.com/dotnet/Runtime/10.0.42/dotnet-runtime-10.0.42-osx-arm64.tar.gz",
  sha512: require("node:crypto").createHash("sha512").update("archive fixture").digest("hex") };
const nativeHost = process.platform === "darwin" && process.arch === "arm64";
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-dotnet-tool-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function image(architecture = "arm64", floor = 14) {
  const data = Buffer.alloc(56);
  data.writeUInt32LE(0xfeedfacf); data.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
  data.writeUInt32LE(2, 12); data.writeUInt32LE(1, 16); data.writeUInt32LE(24, 20);
  data.writeUInt32LE(0x32, 32); data.writeUInt32LE(24, 36); data.writeUInt32LE(1, 40); data.writeUInt32LE(floor << 16, 44);
  return data;
}
function payload(root, pin = HOST, architecture = "arm64", floor = 14) {
  const native = ["dotnet", "host/fxr/" + pin.version + "/libhostfxr.dylib",
    "shared/Microsoft.NETCore.App/" + pin.version + "/libhostpolicy.dylib",
    "shared/Microsoft.NETCore.App/" + pin.version + "/libcoreclr.dylib"];
  for (const name of native) {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, image(architecture, floor), { mode: 0o755 });
  }
  fs.writeFileSync(path.join(root, "shared/Microsoft.NETCore.App/" + pin.version + "/System.Private.CoreLib.dll"), "managed runtime");
}
const requirement = { framework: "net10.0", minimumVersion: HOST.version };
const METADATA = major => `https://builds.dotnet.microsoft.com/dotnet/release-metadata/${major}/releases.json`;
// Microsoft's release metadata listing one runtime, and its archive's bytes.
function online(t, routes) {
  Harness.network.routes = routes; t.after(() => { Harness.network.routes = null; });
}
const releaseMetadata = (archive = "archive fixture", pin = HOST) => ({ [METADATA("10.0")]: { releases: [{ runtime: {
  version: pin.version, files: [{ name: "dotnet-runtime-osx-arm64.tar.gz", rid: "osx-arm64", url: pin.url, hash: pin.sha512 || "a".repeat(128) }]
} }] }, [pin.url]: archive });
test("declared tool-host requirements retain framework compatibility", () => {
  assert.equal(Host.supported("net10.0"), true); assert.equal(Host.supported("net6.0"), false);
  assert.equal(Host.matchingVersion("net10.0", "8.0.32"), false);
  assert.equal(HOST.sha512.length, 128);
});
test("native closure checks reject a wrong CPU and read the deployment floor from the package", t => {
  const root = directory(t); payload(root, HOST, "arm64", 12);
  assert.equal(Host.__test.validateNative(root, HOST, Host.__test.inventory(root)), "12.0.0");
  payload(root);
  assert.equal(Host.__test.validateNative(root, HOST, Host.__test.inventory(root)), "14.0.0");
  payload(root, HOST, "x64");
  assert.throws(() => Host.__test.validateNative(root, HOST, Host.__test.inventory(root)), /CPU or macOS/);
  payload(root, HOST, "arm64", 15);
  assert.equal(Host.__test.validateNative(root, HOST, Host.__test.inventory(root)), "15.0.0");
});
test("the tool's declared framework and minimum constrain compatible publisher runtime rows", async t => {
  const version = "10.0.20", hash = "a".repeat(128);
  const asset = { name: "dotnet-runtime-osx-arm64.tar.gz", rid: "osx-arm64", hash,
    url: "https://builds.dotnet.microsoft.com/dotnet/Runtime/" + version + "/dotnet-runtime-" + version + "-osx-arm64.tar.gz" };
  const metadata = () => ({ releases: [{ runtime: { version: HOST.version, files: [{ ...asset, url: HOST.url, hash: HOST.sha512 }] } },
    { runtime: { version, files: [asset] } }, { runtime: { version: "10.0.99-preview1", files: [asset] } }] });
  online(t, { [METADATA("10.0")]: metadata });
  const selected = await Host.__test.selectPin({ framework: "net10.0", minimumVersion: version, architecture: "arm64" });
  assert.equal(selected.version, HOST.version); assert.equal(selected.sha512, HOST.sha512);
  asset.url = "https://other.test/runtime.tar.gz";
  await assert.rejects(Host.__test.selectPin({ framework: "net10.0", minimumVersion: "10.0.99", architecture: "arm64" }), /No compatible published/);
});
test("both CPUs choose the newest published host for .NET 8 and .NET 10", async t => {
  for (const [framework, versions] of [["net8.0", ["8.0.31", "8.0.40", "8.0.32"]], ["net10.0", ["10.0.13", "10.0.20"]]]) {
    const major = framework.slice(3);
    for (const architecture of ["arm64", "x64"]) {
      online(t, { [METADATA(major)]: { releases: versions.map(version => ({ runtime: { version, files: [{
        name: `dotnet-runtime-osx-${architecture}.tar.gz`, rid: `osx-${architecture}`, hash: "c".repeat(128),
        url: `https://builds.dotnet.microsoft.com/dotnet/Runtime/${version}/dotnet-runtime-${version}-osx-${architecture}.tar.gz` }] } })) } });
      const selected = await Host.__test.selectPin({ framework, minimumVersion: major + ".0", architecture });
      assert.equal(selected.version, versions.slice().sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]);
      assert.equal(selected.architecture, architecture); assert.equal(selected.sha512, "c".repeat(128));
    }
  }
});
test("an installed host recorded with SHA-256 stays usable without discovery", async t => {
  const userDataDir = directory(t), version = "8.0.32", target = path.join(Host.__test.root(userDataDir), version, "arm64"), files = path.join(target, "files");
  fs.mkdirSync(files, { recursive: true }); payload(files, { ...HOST, version });
  fs.writeFileSync(path.join(target, "host.json"), JSON.stringify({ version, architecture: "arm64", minimumMacOS: "14.0",
    archiveSha256: "d".repeat(64), files: Host.__test.inventory(files) }));
  const requests = Harness.network.requests.length;
  const selected = await Host.ensure({ userDataDir }, { framework: "net8.0", minimumVersion: "8.0.0" }, { architecture: "arm64", systemVersionSync: () => "15.0" });
  assert.equal(Harness.network.requests.length, requests, "An installed host needs no release metadata or download");
  assert.equal(selected.version, version); assert.equal(selected.install.installDir, target);
});
test("multiple verified installed hosts reuse the newest compatible receipt offline", t => {
  const userDataDir = directory(t);
  for (const version of ["10.0.40", "10.0.42"]) {
    const target = path.join(Host.__test.root(userDataDir), version, "arm64"), files = path.join(target, "files");
    fs.mkdirSync(files, { recursive: true }); payload(files, { ...HOST, version });
    fs.writeFileSync(path.join(target, "host.json"), JSON.stringify({ version, architecture: "arm64", minimumMacOS: "14.0",
      archiveSha512: "a".repeat(128), files: Host.__test.inventory(files) }));
  }
  const selected = Host.resolve({ userDataDir, framework: "net10.0", minimumVersion: "10.0.39" });
  assert.equal(selected.version, "10.0.42");
  assert.equal(Host.resolve({ userDataDir, framework: "net10.0", minimumVersion: "10.0.43" }), null);
});
test("missing host consent can be declined without creating a runtime directory", { skip: !nativeHost }, async t => {
  const userDataDir = directory(t), plans = [], requests = Harness.network.requests.length;
  await assert.rejects(Host.ensure({ userDataDir, confirmRuntimeInstall: async plan => { plans.push(plan); return false; } }, requirement), { code: "ABORT_ERR" });
  assert.equal(plans[0].label, ".NET tool host"); assert.equal(plans[0].version, null);
  await assert.rejects(Host.ensure({ userDataDir }, requirement), { code: "ABORT_ERR" });
  assert.equal(Harness.network.requests.length, requests, "Without consent nothing is discovered or downloaded");
  assert.equal(fs.existsSync(path.join(userDataDir, "runtimes")), false);
});
test("host acquisition checks digests before extraction and removes interrupted staging", { skip: !nativeHost }, async t => {
  const userDataDir = directory(t);
  online(t, releaseMetadata("wrong archive"));
  await assert.rejects(Host.ensure({ userDataDir, confirmRuntimeInstall: async () => true }, requirement, {
    extractArchive: () => assert.fail("An unverified CLR cannot extract")
  }), /checksum/);
  assert.deepEqual(fs.readdirSync(path.join(Host.__test.root(userDataDir), HOST.version)), []);
});
test("concurrent tools share one verified host and warm resolution avoids repeated hashes", { skip: !nativeHost }, async t => {
  const userDataDir = directory(t), originalHash = Native.hashFile, hash = Pinned.hashFile;
  let prompts = 0, downloads = 0;
  const context = { userDataDir, downloads: new DownloadManager(), confirmRuntimeInstall: async () => { prompts++; return true; } };
  online(t, { ...releaseMetadata(), [HOST.url]: () => { downloads++; return "archive fixture"; } });
  const dependencies = {
    extractArchive: async (_archive, files) => payload(files),
    run: async (_command, args) => { assert.deepEqual(args, ["--list-runtimes"]); return { stdout: "Microsoft.NETCore.App 10.0.42 [runtime]" }; }
  };
  const [first, second] = await Promise.all([Host.ensure(context, requirement, dependencies),
    Host.ensure({ ...context, downloads: new DownloadManager() }, requirement, dependencies)]);
  assert.equal(first.install.executablePath, second.install.executablePath); assert.equal(prompts, 1); assert.equal(downloads, 1);
  assert.equal(first.runtimeIdentity.managerId, "dotnet-tools");
  const calls = t.mock.method(Native, "hashFile", originalHash);
  Host.resolve({ userDataDir, ...requirement, verification: "status" }); assert.equal(calls.mock.callCount(), 0);
  Host.resolve({ userDataDir, ...requirement }); assert.equal(calls.mock.callCount(), 0);
  fs.writeFileSync(first.install.executablePath, image("x64"));
  assert.equal(Host.resolve({ userDataDir, ...requirement }), null);
});
test("host cancellation publishes neither files nor a ready version", { skip: !nativeHost }, async t => {
  const userDataDir = directory(t), abort = new AbortController();
  online(t, releaseMetadata(() => { abort.abort(); return "archive"; }));
  await assert.rejects(Host.ensure({ userDataDir, signal: abort.signal, confirmRuntimeInstall: async () => true }, requirement), { code: "ABORT_ERR" });
  assert.equal(Host.resolve({ userDataDir, ...requirement }), null);
  assert.deepEqual(fs.readdirSync(path.join(Host.__test.root(userDataDir), HOST.version)), []);
});
test("a host whose binaries need a later macOS stops with that requirement and publishes nothing", async t => {
  const userDataDir = directory(t);
  online(t, releaseMetadata());
  await assert.rejects(Host.ensure({ userDataDir, confirmRuntimeInstall: async () => true }, requirement, {
    architecture: "arm64", systemVersionSync: () => "13.0", extractArchive: async (_archive, files) => payload(files, HOST, "arm64", 15),
    run: () => assert.fail("A host that cannot run here is not started")
  }), /requires macOS 15\.0\.0 or later/);
  assert.equal(Host.resolve({ userDataDir, ...requirement, architecture: "arm64" }), null);
});
