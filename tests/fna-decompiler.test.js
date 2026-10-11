const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Tool = require("../src/modules/fna/decompiler");
const Native = require("../src/modules/shared/runtime/local-native");
const { inspectGameAssembly } = require("../src/modules/fna/detect");
const { writeAssembly } = require("./helpers/fna-assembly");
const Build = require("../src/modules/fna/runtime/build");
const HostManager = require("../src/modules/fna/runtime/manager");
const { DownloadManager } = require("../src/modules/shared/runtime/download-manager");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-fna-decompiler-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "original.exe"); writeAssembly(source, { flags: 3 });
  return { root, source, entry: { gameId: "test-game", gamePath: source, moduleData: inspectGameAssembly(source) },
    context: { userDataDir: path.join(root, "userData"), settings: {} } };
}

test("FNA decompiler reuses verified tool files offline and rejects tool tampering", async t => {
  const { context } = fixture(t), pin = Tool.TOOLS[Tool.DEFAULT_VERSION];
  const root = path.join(context.userDataDir, "runtimes", "fna-tools", "ilspy", Tool.DEFAULT_VERSION), files = path.join(root, "files");
  fs.mkdirSync(files, { recursive: true });
  for (const name of ["ilspycmd.dll", "ilspycmd.deps.json", "ilspycmd.runtimeconfig.json", "ICSharpCode.Decompiler.dll"]) fs.writeFileSync(path.join(files, name), "reviewed fixture " + name);
  fs.writeFileSync(path.join(root, "tool.json"), JSON.stringify({ version: pin.version, archiveSha256: pin.sha256,
    sourceRevision: pin.sourceRevision, files: Tool.__test.inventory(files), root: "/untrusted", entryPath: "/untrusted.exe" }));
  const installed = await Tool.ensureTool(context, pin.version, { downloadToFile() { throw Error("Unexpected network"); } });
  assert.equal(installed.entryPath, path.join(files, "ilspycmd.dll")); assert.equal(installed.root, root);
  fs.writeFileSync(path.join(files, "ICSharpCode.Decompiler.dll"), "modified");
  assert.equal(Tool.resolveTool({ userDataDir: context.userDataDir }), null);
});

test("FNA decompiler checks package identity before extraction and publishes nothing on failure", async t => {
  const { context } = fixture(t); let extracted = false;
  await assert.rejects(Tool.ensureTool(context, Tool.DEFAULT_VERSION, { downloadToFile: async (_url, file) => { fs.writeFileSync(file, "different package"); },
    extractPackage() { extracted = true; } }), /checksum/);
  assert.equal(extracted, false);
  const parent = path.join(context.userDataDir, "runtimes", "fna-tools", "ilspy");
  assert.deepEqual(fs.readdirSync(parent), []);
});

test("ILSpy download consent precedes installation and cancellation leaves no tool files", async t => {
  const { context } = fixture(t), plans = [];
  context.confirmRuntimeInstall = async plan => { plans.push(plan); return { approved: false }; };
  await assert.rejects(Tool.ensureTool(context, Tool.DEFAULT_VERSION, {
    downloadToFile: () => assert.fail("A declined tool cannot download")
  }), { code: "ABORT_ERR" });
  assert.equal(plans.length, 1); assert.equal(plans[0].label, "ILSpy"); assert.equal(plans[0].version, Tool.DEFAULT_VERSION);
  assert.equal(plans[0].confirmLabel, "Download and Continue");
  assert.equal(fs.existsSync(path.join(context.userDataDir, "runtimes")), false);
});

test("C# decompilation resumes after a managed ILSpy install and reuses it offline", async t => {
  const { root, entry, context } = fixture(t), pin = Tool.TOOLS[Tool.DEFAULT_VERSION], events = [];
  const hashFile = Native.hashFile;
  t.mock.method(Native, "hashFile", file => path.basename(file) === "ilspy.nupkg" ? pin.sha256 : hashFile(file));
  context.confirmRuntimeInstall = async plan => { events.push("consent"); assert.equal(plan.version, pin.version); return true; };
  const toolDependencies = {
    downloadToFile: async (_url, archive) => { events.push("download"); fs.writeFileSync(archive, "package fixture"); },
    extractPackage: (_archive, files) => {
      for (const name of ["ilspycmd.dll", "ilspycmd.deps.json", "ilspycmd.runtimeconfig.json", "ICSharpCode.Decompiler.dll"]) {
        fs.writeFileSync(path.join(files, name), "package fixture " + name);
      }
    }
  };
  const dependencies = {
    ensureHost: async () => ({ install: { executablePath: path.join(root, "dotnet") }, profile: { root, dotnetVersion: Build.DOTNET_VERSION } }),
    ensureTool: (ctx, version) => Tool.ensureTool(ctx, version, toolDependencies),
    runCommand: async (_cmd, args, options) => {
      events.push("decompile"); assert.equal(args[1], Tool.resolveTool({ userDataDir: context.userDataDir }).entryPath);
      fs.writeFileSync(path.join(options.cwd, "Game.cs"), "source");
    }
  };
  const result = await Tool.decompile(entry, {}, context, dependencies);
  assert.deepEqual(events, ["consent", "download", "decompile"]);
  assert.equal(result.toolVersion, pin.version); assert.equal(fs.readFileSync(path.join(result.outputRoot, "Game.cs"), "utf8"), "source");
  context.confirmRuntimeInstall = () => assert.fail("Installed ILSpy cannot prompt");
  toolDependencies.downloadToFile = () => assert.fail("Installed ILSpy cannot download");
  await Tool.decompile(entry, {}, context, dependencies);
  assert.equal(events.at(-1), "decompile");
});

test("ILSpy reuses FNA's host and acquires only a CLR when FNA is absent", async t => {
  const { context } = fixture(t), Host = require("../src/modules/shared/runtime/dotnet-tool-host");
  let ready = true;
  t.mock.method(HostManager, "resolveSelection", () => ({ ready, version: Build.PROFILE,
    ...(ready ? { install: { executablePath: "/host/dotnet" }, profile: { root: "/host", dotnetVersion: Build.DOTNET_VERSION } } : {}) }));
  t.mock.method(HostManager, "installRuntime", () => assert.fail("A tool must not build the entire FNA host"));
  const install = t.mock.method(Host, "ensure", async (_context, requirement) => {
    assert.deepEqual(requirement, { framework: "net8.0", minimumVersion: Build.DOTNET_VERSION });
    return { ready: true, version: Build.DOTNET_VERSION };
  });
  assert.equal((await Tool.ensureHost(context)).runtimeIdentity.managerId, "fna");
  assert.equal(install.mock.callCount(), 0);
  ready = false;
  assert.equal((await Tool.ensureHost(context)).version, Build.DOTNET_VERSION);
  assert.equal(install.mock.callCount(), 1);
});

test("concurrent game actions with separate download managers share one ILSpy installation", async t => {
  const { context } = fixture(t), pin = Tool.TOOLS[Tool.DEFAULT_VERSION], hashFile = Native.hashFile;
  t.mock.method(Native, "hashFile", file => path.basename(file) === "ilspy.nupkg" ? pin.sha256 : hashFile(file));
  let prompts = 0, downloads = 0;
  const firstContext = { ...context, downloads: new DownloadManager(), confirmRuntimeInstall: async () => { prompts++; return true; } };
  const secondContext = { ...firstContext, downloads: new DownloadManager() };
  const dependencies = {
    downloadToFile: async (_url, archive) => { downloads++; await new Promise(resolve => setImmediate(resolve)); fs.writeFileSync(archive, "package fixture"); },
    extractPackage: (_archive, files) => {
      for (const name of ["ilspycmd.dll", "ilspycmd.deps.json", "ilspycmd.runtimeconfig.json", "ICSharpCode.Decompiler.dll"]) fs.writeFileSync(path.join(files, name), name);
    }
  };
  const [first, second] = await Promise.all([Tool.ensureTool(firstContext, pin.version, dependencies), Tool.ensureTool(secondContext, pin.version, dependencies)]);
  assert.equal(prompts, 1); assert.equal(downloads, 1); assert.equal(first.entryPath, second.entryPath);
  assert.equal(firstContext.downloads.list().length, 0); assert.equal(secondContext.downloads.list().length, 0);
});

test("FNA decompiles original managed IL independently of its execution architecture", async t => {
  const { root, source, entry, context } = fixture(t), original = Native.hashFile(source); let call;
  const host = { install: { executablePath: path.join(root, "dotnet") }, profile: { root, dotnetVersion: Build.DOTNET_VERSION } };
  const tool = { entryPath: path.join(root, "ilspycmd.dll"), version: Tool.DEFAULT_VERSION, sourceRevision: Tool.TOOLS[Tool.DEFAULT_VERSION].sourceRevision,
    archiveSha256: Tool.TOOLS[Tool.DEFAULT_VERSION].sha256 };
  const dependencies = { ensureHost: async () => host, ensureTool: async () => tool, runCommand: async (...args) => {
    call = args; fs.writeFileSync(path.join(args[2].cwd, "Game.cs"), "decompiled source");
  } };
  const result = await Tool.decompile(entry, {}, context, dependencies);
  assert.equal(call[0], host.install.executablePath); assert.equal(call[1].includes("--disable-updatecheck"), true);
  assert.equal(call[1].at(-1), source); assert.equal(call[2].env.DOTNET_ROOT, root);
  assert.equal(fs.readFileSync(path.join(result.outputRoot, "Game.cs"), "utf8"), "decompiled source");
  assert.equal(result.assemblySha256, original); assert.equal(Native.hashFile(source), original);
  fs.writeFileSync(path.join(result.outputRoot, "Game.cs"), "user edits");
  await Tool.decompile(entry, {}, context, dependencies);
  const history = fs.readdirSync(path.dirname(result.outputRoot)).find(name => name.includes(".previous-"));
  assert.equal(fs.readFileSync(path.join(path.dirname(result.outputRoot), history, "Game.cs"), "utf8"), "user edits");
  assert.equal(Tool.reveal(entry, context).outputRoot, result.outputRoot);
});

test("FNA decompiler validates versions before downloads and retains existing source on failure", async t => {
  const { root, source, entry, context } = fixture(t); let fetched = false;
  await assert.rejects(Tool.decompile(entry, { version: "unknown" }, context, { ensureHost: async () => { fetched = true; } }), /Unsupported ILSpy/);
  assert.equal(fetched, false);
  const output = path.join(context.userDataDir, "games", entry.gameId, "modules", "fna", "decompiled", Tool.DEFAULT_VERSION); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "Game.cs"), "prior source");
  await assert.rejects(Tool.decompile(entry, {}, context, {
    ensureHost: async () => ({ install: { executablePath: path.join(root, "dotnet") }, profile: { root } }),
    ensureTool: async () => ({ entryPath: "tool.dll" }), runCommand: async () => { throw Error("Decompiler failed"); }
  }), /Decompiler failed/);
  assert.equal(fs.readFileSync(path.join(output, "Game.cs"), "utf8"), "prior source");
  assert.deepEqual(fs.readdirSync(path.dirname(output)), [Tool.DEFAULT_VERSION]);
  assert.equal(fs.existsSync(source), true);
});
