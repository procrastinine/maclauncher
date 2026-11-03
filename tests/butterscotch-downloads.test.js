// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Downloads = require("../src/modules/gamemaker/runtime/butterscotch-downloads");
const { createManager } = require("../src/modules/gamemaker/runtime/butterscotch");
const Fixture = require("./helpers/gamemaker-managed.cjs");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const now = Date.parse("2026-10-10T00:00:00Z");
// One published Actions artifact as a catalog row.
function nightly(architecture = "arm64") {
  const id = architecture === "arm64" ? 12551705865 : 12551348357;
  return { version: `2026-10-24-${Fixture.revision.slice(0, 12)}-appkit-${architecture === "x86_64" ? "x64" : architecture}-${id}`, architecture,
    workflow: { id: 40071597289, event: "push", branch: "main", artifactName: `butterscotch-appkit-macos-${architecture}`, artifactId: id },
    asset: { assetId: id, sha256: "8".repeat(64) } };
}
const ACTIONS = "https://api.github.com/repos/ButterscotchRunner/Butterscotch/actions";
function actionsRoutes(runs, artifacts) {
  return { [`${ACTIONS}/workflows/build.yml/runs`]: { workflow_runs: runs },
    ...Object.fromEntries(runs.map(run => [`${ACTIONS}/runs/${run.id}/artifacts`, { artifacts: artifacts(run) }])) };
}
function workflowRun(id, created = "2026-10-09T00:00:00Z") {
  return { id, status: "completed", conclusion: "success", head_branch: "main", event: "push", path: ".github/workflows/build.yml",
    head_sha: Fixture.revision, created_at: created, repository: { full_name: "ButterscotchRunner/Butterscotch" }, head_repository: { full_name: "ButterscotchRunner/Butterscotch" } };
}
function artifact(run, id, name, created = run.created_at) {
  return { id, name, expired: false, size_in_bytes: 991480, digest: `sha256:${"8".repeat(64)}`, created_at: created, expires_at: "2099-01-01T00:00:00Z",
    workflow_run: { id: run.id, head_sha: run.head_sha, head_branch: "main" } };
}
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "butterscotch-download-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function binary({ architecture = "arm64", floor = 0x1a0000, external } = {}) {
  const version = Buffer.alloc(24); version.writeUInt32LE(0x32); version.writeUInt32LE(24, 4); version.writeUInt32LE(1, 8); version.writeUInt32LE(floor, 12);
  const commands = [version];
  if (external) { const text = Buffer.from(external + "\0"), item = Buffer.alloc(Math.ceil((24 + text.length) / 8) * 8); item.writeUInt32LE(0xc); item.writeUInt32LE(item.length, 4); item.writeUInt32LE(24, 8); text.copy(item, 24); commands.push(item); }
  const header = Buffer.alloc(32); header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
  header.writeUInt32LE(2, 12); header.writeUInt32LE(commands.length, 16); header.writeUInt32LE(commands.reduce((sum, part) => sum + part.length, 0), 20);
  return Buffer.concat([header, ...commands]);
}

test("Butterscotch preserves explicit choices and selects argument support from the catalog", t => {
  const root = temporary(t), runtime = createManager({ now: () => now, systemVersionSync: () => "26.0" });
  const automatic = runtime.resolveSelection({}, {}, root);
  assert.equal(automatic.version, null);
  assert.equal(automatic.discoveryRequired, true);
  assert.deepEqual(runtime.getState({ userDataDir: root }).catalog.versions, [], "Cold selection does not invent a release or seed a download");
  assert.equal(runtime.resolveSelection({}, {runtimes:{butterscotch:{defaultVersion:null}}}, root).version, null);
  assert.equal(runtime.getState({ userDataDir: root }).catalog.supportsLatestOnly, true);
  const old = Fixture.legacyVersion;
  assert.deepEqual(runtime.distributionVersions, []);
  assert.equal(runtime.resolveSelection({ runtimeData: { butterscotch: { version: old } } }, {}, root).version, old);
  assert.equal(runtime.resolveSelection({}, { runtimes: { butterscotch: { defaultVersion: old } } }, root).version, old);
  const cold = runtime.resolveSelection({ launchArguments: "--example" }, {}, root);
  assert.equal(cold.version, null); assert.equal(cold.discoveryRequired, true);
  Fixture.cache(root);
  const unrecommended = runtime.resolveSelection({ launchArguments: "--example" }, {}, root);
  assert.equal(unrecommended.version, Fixture.argsVersion, "An argument-bearing game selects a capable catalog version");
  assert.equal(unrecommended.ready, false); assert.equal(unrecommended.recommendedVersion, undefined);
  assert.equal(runtime.resolveSelection({ launchArguments: "--example" }, { runtimes: { butterscotch: { defaultVersion: old } } }, root).version, old);
  assert.equal(runtime.resolveSelection({}, {}, root, { version: old }).version, old);
  for (const dependencies of [{ now: () => now, systemVersionSync: () => "13.0" },
    { now: () => Date.parse("2030-01-01"), systemVersionSync: () => "26.0" }]) {
    const pending = createManager(dependencies).resolveSelection({}, {}, path.join(root,"empty"));
    assert.equal(pending.version, null); assert.equal(pending.ready, false); assert.equal(pending.discoveryRequired, true);
  }
});

test("Butterscotch reads CPU, deployment floor and launch options from the executable before running it", async t => {
  const root = temporary(t), file = path.join(root, "butterscotch"), pin = nightly();
  fs.writeFileSync(file, binary(), { mode: 0o755 });
  const calls = [], metadata = await Downloads.prepareInstall({ unpacked: root, pin }, { run: async (command, args) => {
    calls.push([command, args]); return { stdout: "--save-folder <directory>\n--renderer <renderer>\n" };
  } });
  assert.equal(metadata.minimumMacOS, "26.0.0"); assert.equal(calls.length, 3); assert.deepEqual(calls.at(-1)[1], ["--help"]);
  for (const bytes of [binary({ architecture: "x86_64" }), binary({ external: "@executable_path/libSDL2-missing.dylib" })]) {
    fs.writeFileSync(file, bytes);
    await assert.rejects(Downloads.prepareInstall({ unpacked: root, pin }, { run: () => assert.fail("Invalid native requirements must block execution") }), /architecture|library/);
  }
  // A build that bundles its libraries runs as it is.
  fs.writeFileSync(file, binary({ external: "@executable_path/libSDL2.dylib" })); fs.writeFileSync(path.join(root, "libSDL2.dylib"), "library");
  assert.equal((await Downloads.prepareInstall({ unpacked: root, pin }, { run: async () => ({ stdout: "--save-folder <directory>\n--renderer <renderer>\n" }) })).architecture, "arm64");
  fs.rmSync(path.join(root, "libSDL2.dylib"));
  // A later archive that moves the runner into a folder next to other files.
  fs.rmSync(file); fs.mkdirSync(path.join(root, "Butterscotch nightly")); fs.writeFileSync(path.join(root, "README.md"), "notes");
  fs.writeFileSync(path.join(root, "Butterscotch nightly", "butterscotch"), binary({ floor: 0x1b0000 }), { mode: 0o755 });
  const moved = await Downloads.prepareInstall({ unpacked: root, pin }, { run: async () => ({ stdout: "Usage: butterscotch [--save-folder DIR] [--renderer NAME] [--version]\n" }) });
  assert.equal(moved.minimumMacOS, "27.0.0"); assert.equal(moved.versionFlagAvailable, true);
  await assert.rejects(Downloads.prepareInstall({ unpacked: root, pin }, { run: async () => ({ stdout: "Usage: butterscotch DATA\n" }) }), /launch options/);
});

test("Butterscotch follows renamed, added and universal Mac artifacts", () => {
  const hosts = (name, others = []) => Downloads.artifactHosts({ id: 1, name }, [{ id: 1, name }, ...others.map((other, index) => ({ id: index + 2, name: other }))]);
  assert.deepEqual(hosts("butterscotch-appkit-macos-arm64"), ["arm64"]);
  assert.deepEqual(hosts("butterscotch-appkit-macos-x86_64"), ["x64"]);
  assert.deepEqual(hosts("Butterscotch-macOS-universal"), ["arm64", "x64"]);
  assert.deepEqual(hosts("butterscotch-macos-universal", ["butterscotch-appkit-macos-arm64"]), ["x64"]);
  assert.deepEqual(hosts("butterscotch-appkit-macos-arm64", ["butterscotch-sdl-macos-arm64", "butterscotch-linux-x86_64"]), ["arm64"]);
  assert.deepEqual(hosts("butterscotch-sdl-macos-arm64", ["butterscotch-appkit-macos-arm64"]), []);
  for (const name of ["butterscotch-linux-x86_64", "butterscotch-windows-x64", "butterscotch-macos-arm64-debug-symbols", "test-results-macos"]) assert.deepEqual(hosts(name), []);
});

test("Butterscotch lists each Actions artifact for its CPU with GitHub's digest", async () => {
  const run = workflowRun(40071597289, "2026-10-24T06:47:33Z");
  Harness.network.routes = actionsRoutes([run], value => [artifact(value, 12551705865, "butterscotch-appkit-macos-arm64"),
    artifact(value, 12551705866, "butterscotch-appkit-macos-x86_64"), artifact(value, 12551705867, "butterscotch-sdl-linux-x86_64")]);
  try {
    const rows = await Downloads.source.discover({});
    assert.deepEqual(rows.map(row => row.architecture), ["arm64", "x86_64"]);
    assert.equal(rows[0].version, nightly().version);
    assert.equal(rows[0].files[0].digest.value, "8".repeat(64));
    assert.equal(rows[0].files[0].url, "https://nightly.link/ButterscotchRunner/Butterscotch/actions/artifacts/12551705865.zip");
    assert.deepEqual(rows[0].details.workflow, nightly().workflow);
  } finally { Harness.network.routes = null; }
});

test("Butterscotch Reload and All versions use distinct bounded catalog queries", async t => {
  t.mock.method(require("../src/modules/shared/runtime/maclauncher-builds"), "fetchProjectCatalog", async () => ({ packages: [] }));
  const root = temporary(t), label = process.arch === "x64" ? "x86_64" : "arm64";
  const runtime = createManager({ now: () => now, systemVersionSync: () => "26.0" });
  const before = Harness.network.requests.length, calls = () => Harness.network.requests.slice(before).filter(url => url.startsWith(ACTIONS)).length;
  Harness.network.routes = actionsRoutes([1, 2, 3].map(id => workflowRun(id)), value => [artifact(value, 100 + value.id, `butterscotch-appkit-macos-${label}`)]);
  t.after(() => { Harness.network.routes = null; });
  const latest = await runtime.refreshCatalog({ userDataDir: root });
  assert.equal(latest.mode, "latest");
  assert.equal(latest.versions.filter(version => /2026-10-09/.test(version)).length, 1);
  assert.equal(calls(), 2);
  const all = await runtime.refreshCatalog({ userDataDir: root, latestOnly: false });
  assert.equal(all.versions.filter(version => /2026-10-09/.test(version)).length, 3);
  assert.equal(new Set(all.versions).size, all.versions.length);
  assert.equal(calls(), 6);
});

test("argument-capable Play discovers after consented install and reuses its exact verified archive offline", {skip:process.platform!=="darwin"}, async t => {
  const root=temporary(t),userDataDir=path.join(root,"launcher"),payload=path.join(root,"payload"),archive=path.join(root,"fixture.zip");
  fs.mkdirSync(payload);fs.writeFileSync(path.join(payload,"butterscotch"),binary({floor:0x0d0000,architecture:process.arch==="x64"?"x86_64":"arm64"}),{mode:0o755});
  execFileSync("/usr/bin/ditto",["-c","-k",payload,archive]);
  const catalogVersion=Fixture.argsVersion,bytes=fs.readFileSync(archive),rows=Fixture.rows().butterscotch.map(row=>({...row,architecture:process.arch==="x64"?"x86_64":"arm64",workflow:{id:1},asset:{...row.asset,sha256:crypto.createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length}}));
  let downloads=0,refreshes=0;
  t.mock.method(require("../src/modules/shared/runtime/maclauncher-builds"),"fetchProjectCatalog",async()=>({packages:[]}));
  const runtime=createManager({systemVersionSync:()=>"26.0",downloadToFile:async(_url,dest)=>{downloads++;fs.writeFileSync(dest,bytes);},run:async()=>({stdout:"--save-folder <directory>\n--renderer <renderer>\n"})});
  // Discovery lists these rows; the consented install starts it.
  runtime.refreshCatalog=async options=>{refreshes++;Fixture.cache(options.userDataDir,{butterscotch:rows});return runtime.getState({userDataDir:options.userDataDir}).catalog;};
  assert.equal(runtime.resolveSelection({launchArguments:"--example"},{},userDataDir).version,null);
  assert.equal(refreshes,0);assert.equal(downloads,0);
  const installed=await runtime.installRuntime({userDataDir,gameArgumentsRequired:true});
  assert.equal(installed.version,catalogVersion);assert.ok(refreshes>0);assert.equal(downloads,1);
  const coldRefreshes=refreshes;
  const selected=runtime.resolveSelection({launchArguments:"--example"},{},userDataDir);assert.equal(selected.ready,true);assert.equal(selected.version,catalogVersion);
  await runtime.installRuntime({userDataDir,gameArgumentsRequired:true});assert.equal(refreshes,coldRefreshes);assert.equal(downloads,1);
  await assert.rejects(runtime.installRuntime({userDataDir,version:Fixture.legacyVersion,gameArgumentsRequired:true}),/incompatible runtime profile/);
  assert.equal(downloads,1,"An exact incompatible choice cannot silently substitute another runtime");
  fs.appendFileSync(installed.executablePath,"changed");
  assert.equal(runtime.resolveSelection({launchArguments:"--example"},{},userDataDir).ready,false);
});

test("argument transport follows future catalog versions and the shared saved choices", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), runtime = createManager({ systemVersionSync: () => "26.0" });
  const game = { launchArguments: "--game-option" }, cold = runtime.resolveSelection(game, {}, root);
  assert.equal(cold.version, null); assert.equal(cold.discoveryRequired, true); assert.equal(cold.recommendedVersion, undefined);
  assert.equal(runtime.resolveSelection({}, {}, root).recommendedVersion, undefined);
  const base = Fixture.rows().butterscotch[1], rows = ["90.0.0-fixture", "91.0.0-fixture"].map(version => ({ ...base, version }));
  Fixture.cache(root, { butterscotch: rows });
  assert.equal(runtime.resolveSelection(game, {}, root).version, "91.0.0-fixture");
  assert.equal(runtime.resolveSelection({}, {}, root).version, "91.0.0-fixture", "An unset default selects the newest compatible catalog version");
  assert.equal(runtime.resolveSelection({ ...game, runtimeData: { butterscotch: { version: "90.0.0-fixture" } } }, {}, root).version, "90.0.0-fixture");
  assert.equal(runtime.resolveSelection(game, { runtimes: { butterscotch: { defaultVersion: "90.0.0-fixture" } } }, root).version, "90.0.0-fixture", "The shared saved default takes precedence");
  assert.equal(runtime.resolveSelection({}, { runtimes: { butterscotch: { defaultVersion: "91.0.0-fixture" } } }, root).version, "91.0.0-fixture");
  const executable = path.join(root, "installed-runner");
  fs.writeFileSync(executable, binary({ floor: 0x0d0000, architecture: process.arch === "x64" ? "x86_64" : "arm64" }), { mode: 0o755 });
  runtime.core.registerLocal({ userDataDir: root, version: "91.0.0-fixture", runtimePath: executable });
  assert.equal(runtime.resolveSelection(game, {}, root).version, "91.0.0-fixture", "The compatible installed catalog choice works offline");
  assert.equal(runtime.resolveSelection({}, {}, root).version, "91.0.0-fixture");
  assert.equal(runtime.resolveSelection({}, {runtimes:{butterscotch:{defaultVersion:null}}}, root).version, "91.0.0-fixture", "Clearing a saved default retains the manager default");
  runtime.core.registerLocal({ userDataDir: root, version: "90.0.0-fixture", runtimePath: executable });
  assert.equal(runtime.resolveSelection(game, {}, root).version, "91.0.0-fixture", "An older installed build does not replace the shared default");
});
