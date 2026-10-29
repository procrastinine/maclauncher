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
const releaseMetadata = (pin = HOST) => async () => ({ status: 200, body: Buffer.from(JSON.stringify({ releases: [{ runtime: {
  version: pin.version, files: [{ name: "dotnet-runtime-osx-arm64.tar.gz", rid: "osx-arm64", url: pin.url, hash: pin.sha512 || "a".repeat(128) }]
} }] })) });
test("declared tool-host requirements retain framework compatibility and macOS floors", () => {
  assert.equal(HOST.minimumMacOS, "14.0"); assert.equal(Host.minimumMacOS("net8.0"), "14.0");
  assert.equal(Host.supported("net10.0"), true); assert.equal(Host.supported("net6.0"), false);
  assert.equal(Host.matchingVersion("net10.0", "8.0.32"), false);
  assert.equal(Host.PIN.version, "10.0.13"); assert.equal(Host.PIN8.version, "8.0.32");
  assert.equal(Host.PIN.sha512.length, 128); assert.equal(Host.PIN8.sha256.length, 64);
  assert.equal(HOST.sha512.length, 128);
});
test("native closure checks reject a wrong CPU or higher deployment floor", t => {
  const root = directory(t); payload(root);
  Host.__test.validateNative(root, HOST, Host.__test.inventory(root));
  payload(root, HOST, "x64");
  assert.throws(() => Host.__test.validateNative(root, HOST, Host.__test.inventory(root)), /CPU or macOS/);
  payload(root, HOST, "arm64", 15);
  assert.throws(() => Host.__test.validateNative(root, HOST, Host.__test.inventory(root)), /CPU or macOS/);
});
test("the tool's declared framework and minimum constrain compatible publisher runtime rows", async () => {
  const version = "10.0.20", hash = "a".repeat(128);
  const asset = { name: "dotnet-runtime-osx-arm64.tar.gz", rid: "osx-arm64", hash,
    url: "https://builds.dotnet.microsoft.com/dotnet/Runtime/" + version + "/dotnet-runtime-" + version + "-osx-arm64.tar.gz" };
  const request = async url => {
    assert.equal(url, "https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json");
    const older = { ...asset, url: HOST.url, hash: HOST.sha512 };
    return { status: 200, body: Buffer.from(JSON.stringify({ releases: [
      { runtime: { version: HOST.version, files: [older] } }, { runtime: { version, files: [asset] } },
      { runtime: { version: "10.0.99-preview1", files: [asset] } }
    ] })) };
  };
  const selected = await Host.__test.selectPin({ framework: "net10.0", minimumVersion: version }, { request });
  assert.equal(selected.version, HOST.version); assert.equal(selected.sha512, HOST.sha512); assert.equal(selected.minimumMacOS, "14.0");
  asset.url = "https://other.test/runtime.tar.gz";
  await assert.rejects(Host.__test.selectPin({ framework: "net10.0", minimumVersion: "10.0.99" }, { request }), /No compatible published/);
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
  const userDataDir = directory(t), plans = [];
  await assert.rejects(Host.ensure({ userDataDir, confirmRuntimeInstall: async plan => { plans.push(plan); return false; } }, requirement,
    { request: () => assert.fail("A declined CLR cannot discover versions"), downloadToFile: () => assert.fail("A declined CLR cannot download") }), { code: "ABORT_ERR" });
  assert.equal(plans[0].label, ".NET tool host"); assert.equal(plans[0].version, null);
  await assert.rejects(Host.ensure({ userDataDir }, requirement,
    { request: () => assert.fail("A context without consent cannot discover versions"), downloadToFile: () => assert.fail("A context without consent cannot download") }), { code: "ABORT_ERR" });
  assert.equal(fs.existsSync(path.join(userDataDir, "runtimes")), false);
});
test("host acquisition checks digests before extraction and removes interrupted staging", { skip: !nativeHost }, async t => {
  const userDataDir = directory(t);
  await assert.rejects(Host.ensure({ userDataDir, confirmRuntimeInstall: async () => true }, requirement, {
    request: releaseMetadata(),
    downloadToFile: async (_url, target) => fs.writeFileSync(target, "wrong archive"),
    extractArchive: () => assert.fail("An unverified CLR cannot extract")
  }), /checksum/);
  assert.deepEqual(fs.readdirSync(path.join(Host.__test.root(userDataDir), HOST.version)), []);
});
test("concurrent tools share one verified host and warm resolution avoids repeated hashes", { skip: !nativeHost }, async t => {
  const userDataDir = directory(t), originalHash = Native.hashFile, hash = Pinned.hashFile;
  let prompts = 0, downloads = 0;
  const context = { userDataDir, downloads: new DownloadManager(), confirmRuntimeInstall: async () => { prompts++; return true; } };
  const dependencies = {
    request: releaseMetadata(),
    downloadToFile: async (_url, file) => { downloads++; await new Promise(resolve => setImmediate(resolve)); fs.writeFileSync(file, "archive fixture"); },
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
  await assert.rejects(Host.ensure({ userDataDir, signal: abort.signal, confirmRuntimeInstall: async () => true }, requirement, {
    request: releaseMetadata(),
    downloadToFile: async (_url, file) => { fs.writeFileSync(file, "archive"); abort.abort(); }
  }), { code: "ABORT_ERR" });
  assert.equal(Host.resolve({ userDataDir, ...requirement }), null);
  assert.deepEqual(fs.readdirSync(path.join(Host.__test.root(userDataDir), HOST.version)), []);
});
