// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Manager = require("../src/modules/unity/tools/cpp2il-manager");
const Tool = require("../src/modules/unity/tools/cpp2il");
const Unity = require("../src/modules/unity/main");
const { game } = require("./helpers/unity-assets");
const fakeUse = async (_ids, work) => work({ bind: async () => {} });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-cpp2il-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = game(root, { il2cpp: true });
  fs.writeFileSync(path.join(root, "GameAssembly.dll"), "original");
  const entry = Unity.detectGame({ rootDir: root, inputPath: root, stat: fs.statSync(root) });
  entry.gameId = "il2cpp-game";
  const context = { userDataDir: path.join(root, "profile"), settings: {} };
  const install = { version: "2026-09-12-example-123", installDir: path.join(root, "tool"), executablePath: path.join(root, "tool", "Cpp2IL") };
  const manager = { id: "cpp2il", label: "Cpp2IL", resolveSelection: () => ({ ready: true, version: install.version, install }) };
  return { root, original, entry, info: entry.moduleData, context, install, manager };
}

test("Cpp2IL is a managed tool and Unity exposes decompilation without enabling IL2CPP playback", t => {
  const { entry, context } = fixture(t);
  const manager = Unity.runtimeManagers.find(item => item.id === "cpp2il");
  assert.equal(manager.ui.groupId, "tools");
  assert.deepEqual(manager.getState(context).catalog.versions, []);
  assert.equal(Unity.manifest.ui.actions.find(item => item.id === "decompile").hiddenWhen[0].key, "moduleData.dataRoot");
  assert.throws(() => require("../src/modules/unity/launch").preflight(entry), /IL2CPP/);
});

test("canceling Cpp2IL acquisition prevents discovery, downloads and execution", async t => {
  const { entry, info, context, manager } = fixture(t);
  manager.resolveSelection = () => ({ ready: false });
  manager.refreshCatalog = () => assert.fail("No discovery after declining");
  manager.installRuntime = () => assert.fail("No download after declining");
  context.confirmRuntimeInstall = async plan => { assert.equal(plan.managerId, "cpp2il"); return false; };
  await assert.rejects(Tool.decompile(entry, info, {}, context, { manager }), { code: "ABORT_ERR" });
  assert.equal(fs.existsSync(context.userDataDir), false);
});

test("IL2CPP recovery exports all game assemblies for ILSpy and preserves originals and previous output on failure", async t => {
  const { root, entry, info, context, manager } = fixture(t);
  const dependencies = { manager, withRuntimeUse: fakeUse,
    runCommand: async (_file, args) => {
      assert.equal(args[args.indexOf("--force-binary-path") + 1], path.join(root, "GameAssembly.dll"));
      assert.equal(args[args.indexOf("--force-unity-version") + 1], info.detectedVersion);
      const directory = args[args.indexOf("--output-to") + 1]; fs.mkdirSync(directory);
      for (const name of ["Assembly-CSharp.dll", "Domain.dll", "Client.dll", "UnityEngine.CoreModule.dll", "mscorlib.dll"])
        fs.writeFileSync(path.join(directory, name), name);
    },
    decompileAssembly: async options => {
      assert.deepEqual(options.assemblyPaths.map(file => path.basename(file)), ["Assembly-CSharp.dll", "Client.dll", "Domain.dll"]);
      assert.equal(fs.existsSync(path.join(path.dirname(options.assemblyPath), "UnityEngine.CoreModule.dll")), true);
      return { outputRoot: "source", toolVersion: "ILSpy" };
    } };
  const result = await Tool.decompile(entry, info, {}, context, dependencies);
  assert.equal(result.toolVersion, "ILSpy");
  assert.equal(fs.readFileSync(path.join(root, "GameAssembly.dll"), "utf8"), "original");
  await assert.rejects(Tool.decompile(entry, info, {}, context, { ...dependencies,
    runCommand: async () => { throw new Error("recovery failed"); } }), /recovery failed/);
  assert.equal(fs.readFileSync(path.join(result.assemblyRoot, "Domain.dll"), "utf8"), "Domain.dll");
});

test("upstream Actions artifacts list each Mac CPU tool with its run commit and the publisher's digest", async t => {
  const repository = "SamboyCoding/Cpp2IL", api = `https://api.github.com/repos/${repository}/actions`, sha = "a".repeat(40);
  const run = { id: 7, status: "completed", conclusion: "success", head_branch: "development", event: "push", path: ".github/workflows/dotnet-core.yml",
    head_sha: sha, created_at: "2026-09-12T12:00:00Z", repository: { full_name: repository }, head_repository: { full_name: repository } };
  const artifact = (id, name) => ({ id, name, size_in_bytes: 100, expired: false, digest: "sha256:" + "b".repeat(64),
    expires_at: "2099-01-01T00:00:00Z", workflow_run: { id: 7, head_sha: sha, head_branch: "development" } });
  Harness.network.routes = { [`${api}/workflows/dotnet-core.yml/runs`]: { workflow_runs: [run] }, [`${api}/runs/7/artifacts`]: { artifacts: [
    artifact(123, "Cpp2IL-net9-osx-arm64"), artifact(124, "Cpp2IL-net9-win-arm64"), artifact(125, "Cpp2IL-net9-osx-arm64-debug")] } };
  t.after(() => { Harness.network.routes = null; });
  const rows = await Manager.__test.upstream.discover({});
  assert.deepEqual(rows.map(row => [row.version, row.revision, row.architecture]), [["2026-09-12-aaaaaaaaaaaa-123", sha, "arm64"]]);
  assert.equal(rows[0].files[0].bytes, 100);
  assert.deepEqual(rows[0].files[0].digest, { algorithm: "sha256", value: "b".repeat(64) });
});


test("batch C# export retains successful assemblies and reports failures from malformed recovered code", async t => {
  const { root, entry, context } = fixture(t);
  const { writeAssembly } = require("./helpers/fna-assembly");
  const paths = ["Good.dll", "Bad.dll"].map(name => path.join(root, name));
  paths.forEach(file => writeAssembly(file, { flags: 3 }));
  const result = await require("../src/modules/shared/runtime/managed-decompiler").decompileAssembly({
    entry, context, moduleId: "unity", assemblyPath: paths[0], assemblyPaths: paths
  }, {
    ensureTool: async () => ({ version: "fixture-ilspy", entryPath: path.join(root, "ilspycmd.dll") }),
    ensureHost: async () => ({ install: { executablePath: path.join(root, "dotnet") }, profile: { root, dotnetVersion: "8.0.32" } }),
    runCommand: async (_file, args) => {
      if (args.at(-1) === paths[1]) throw Object.assign(new Error("invalid recovered code"), { exitCode: 70 });
      fs.writeFileSync(path.join(args[args.indexOf("--outputdir") + 1], "Game.cs"), "class Game {}");
    }
  });
  assert.equal(fs.existsSync(path.join(result.outputRoot, "Good", "Game.cs")), true);
  assert.deepEqual(result.assemblyErrors, [{ assembly: "Bad.dll", exitCode: 70 }]);
  assert.match(result.exportWarning, /1 of 2/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.outputRoot, "decompile.json"))).assemblyErrors, result.assemblyErrors);
});
