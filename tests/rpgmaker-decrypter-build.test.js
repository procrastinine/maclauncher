const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const Build = require("../src/modules/rgss/runtime/decrypter-build");

test("build inputs reject changed archives and symlink aliases before creating output", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "decrypter-input-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, "archive"), bytes = Buffer.from("reviewed archive");
  const pin = { sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  fs.writeFileSync(archive, bytes); Build.assertArchive(archive, pin);
  const alias = path.join(root, "alias"); fs.symlinkSync(archive, alias);
  assert.throws(() => Build.assertArchive(alias, pin), /reviewed checksum/);
  fs.writeFileSync(archive, "changed archive");
  assert.throws(() => Build.assertArchive(archive, pin), /reviewed checksum/);
  const output = path.join(root, "output");
  assert.throws(() => Build.buildTool({ sourceArchive: archive, sdkArchive: archive, outputDir: output }), /reviewed checksum/);
  assert.equal(fs.existsSync(output), false);
});

test("owned outputs cannot overwrite inputs through a symlinked parent or existing path", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "decrypter-owned-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); fs.mkdirSync(source);
  const alias = path.join(root, "source-alias"); fs.symlinkSync(source, alias, "dir");
  assert.throws(() => Build.assertNewOutput(source, [source]), /new absolute/);
  assert.throws(() => Build.assertNewOutput(path.join(alias, "build"), [source]), /separate/);
  assert.equal(fs.readdirSync(source).length, 0);
});

test("publish pins upstream identity and omits private debug records independently of parent Git", () => {
  const args = Build.publishArguments("/owned/source/project.csproj", "/owned/publish");
  for (const value of ["--no-restore", "-p:MinVerSkip=true", "-p:DebugType=none", "-p:DebugSymbols=false",
    "-p:Deterministic=true", "-p:InformationalVersion=" + Build.PIN.informationalVersion]) assert.ok(args.includes(value));
  const props = fs.readFileSync(require.resolve("../src/modules/rgss/runtime/decrypter-build.props"), "utf8");
  assert.match(props, /<PathMap>\$\(MSBuildThisFileDirectory\)=\/_\/RPGMakerDecrypter<\/PathMap>/);
  assert.match(props, /<SourceRevisionId>465c88c304cac0b1516a3fbfb0b2a87fb0517736<\/SourceRevisionId>/);
  assert.equal(args.some(arg => /--(?:self-contained|no-restore)/.test(arg)), true);
  assert.equal(Build.PIN.sdk.runtimeVersion, "8.0.32");
  const targets = fs.readFileSync(require.resolve("../src/modules/rgss/runtime/decrypter-build.targets"), "utf8");
  assert.match(targets, /<PackageReference Update="Newtonsoft.Json" Version="13\.0\.4"/);
});

test("NuGet compiler/runtime archives have explicit versions and hashes beyond project locks", () => {
  for (const item of Build.PIN.packages) {
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert.ok(item.url.endsWith(item.name + "." + item.version + ".nupkg"));
  }
  assert.ok(Build.PIN.packages.some(item => item.name === "microsoft.netcore.app.runtime.osx-arm64" && item.version === "8.0.32"));
  for (const project of Build.PROJECTS) {
    const lock = require("../src/modules/rgss/runtime/decrypter-locks/" + project + ".json");
    for (const packages of Object.values(lock.dependencies))
      for (const item of Object.values(packages)) if (item.type !== "Project") {
        assert.ok(item.resolved); assert.ok(item.contentHash);
      }
  }
});
