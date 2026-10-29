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
// One published Actions artifact, mapped as Refresh maps it.
function nightly(architecture = "arm64") {
  const id = architecture === "arm64" ? 12551705865 : 12551348357, revision = Fixture.revision;
  return Downloads.artifactEntry({ id, name: `butterscotch-appkit-macos-${architecture}`, created_at: "2026-10-24T06:49:19Z", expires_at: "2027-01-22T06:47:33Z" },
    { run: { id: 40071597289, head_sha: revision, created_at: "2026-10-24T06:47:33Z" },
      sourceUrl: `https://github.com/ButterscotchRunner/Butterscotch/commit/${revision}`, githubAssetDigest: () => "8".repeat(64),
      nightlyArtifactUrl: () => `https://nightly.link/ButterscotchRunner/Butterscotch/actions/artifacts/${id}.zip` }, Downloads.parseSourceProfile(Fixture.source(architecture === "x86_64" ? "x64" : architecture), architecture === "x86_64" ? "x64" : architecture));
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

test("Butterscotch preserves explicit choices and recommends the argument ABI only for games that need it", t => {
  const root = temporary(t), runtime = createManager({ now: () => now, systemVersionSync: () => "26.0" });
  const automatic = runtime.resolveSelection({}, {}, root);
  assert.equal(automatic.version, "MCLv1-1007");
  assert.equal(automatic.selectionSource, "default");
  assert.deepEqual(runtime.getState({ userDataDir: root }).catalog.versions, [], "The cold fallback does not seed a download");
  assert.equal(runtime.resolveSelection({}, {runtimes:{butterscotch:{defaultVersion:null}}}, root).version, null);
  assert.equal(runtime.getState({ userDataDir: root }).catalog.supportsLatestOnly, true);
  const old = Fixture.legacyVersion;
  assert.deepEqual(runtime.distributionVersions, []);
  assert.equal(runtime.resolveSelection({ runtimeData: { butterscotch: { version: old } } }, {}, root).version, old);
  assert.equal(runtime.resolveSelection({}, { runtimes: { butterscotch: { defaultVersion: old } } }, root).version, old);
  assert.equal(runtime.resolveSelection({ launchArguments: "--example" }, {}, root).version, "MCLv1-1007");
  Fixture.cache(root);
  const unrecommended = runtime.resolveSelection({ launchArguments: "--example" }, {}, root);
  assert.equal(unrecommended.version, "MCLv1-1007", "An argument-bearing game requests its exact ABI recommendation before discovery");
  assert.equal(unrecommended.ready, false); assert.equal(unrecommended.recommendedVersion, "MCLv1-1007");
  assert.equal(runtime.resolveSelection({ launchArguments: "--example" }, { runtimes: { butterscotch: { defaultVersion: old } } }, root).version, "MCLv1-1007");
  assert.equal(runtime.resolveSelection({}, {}, root, { version: old }).version, old);
  for (const dependencies of [{ now: () => now, systemVersionSync: () => "13.0" },
    { now: () => Date.parse("2030-01-01"), systemVersionSync: () => "26.0" }]) {
    const pending = createManager(dependencies).resolveSelection({}, {}, path.join(root,"empty"));
    assert.equal(pending.version, "MCLv1-1007"); assert.equal(pending.ready, false);
  }
});

test("Butterscotch validates actual architecture, deployment floor and portable closure before running help", async t => {
  const root = temporary(t), file = path.join(root, "butterscotch"), pin = nightly();
  fs.writeFileSync(file, binary(), { mode: 0o755 });
  const calls = [], metadata = await Downloads.prepareInstall({ unpacked: root, pin }, { run: async (command, args) => {
    calls.push([command, args]); return { stdout: "--save-folder <directory>\n--renderer <renderer>\n" };
  } });
  assert.equal(metadata.minimumMacOS, "26.0.0"); assert.equal(calls.length, 3); assert.deepEqual(calls.at(-1)[1], ["--help"]);
  for (const bytes of [binary({ architecture: "x86_64" }), binary({ floor: 0x1b0000 }), binary({ external: "/opt/homebrew/lib/libSDL2.dylib" })]) {
    fs.writeFileSync(file, bytes);
    await assert.rejects(Downloads.prepareInstall({ unpacked: root, pin }, { run: () => assert.fail("Invalid native requirements must block execution") }), /architecture|macOS|dependency/);
  }
});

test("Butterscotch source profile derives supported flags and floor without inventing a version command", () => {
  const source = { args: '{"save-folder",required_argument,nullptr,1},{"renderer",required_argument,nullptr,2}; "legacy-gl"; case \'H\': printUsage(argv[0]); exit(0);',
    entry: "parseCommandLineArgs(&args, argc, argv);", cmake: ['14','16','17'].map(v => `option(ENABLE_WAD${v} "support" ON)`).join('\n') + '\noption(ENABLE_LEGACY_GL "renderer" ON)',
    workflow: "  build-appkit-macos:\n    - label: arm64\n      runner: macos-26\n    -DBACKEND=appkit \\\n" };
  const profile = Downloads.parseSourceProfile(source, "arm64"); assert.equal(profile.minimumMacOS, "26.0.0"); assert.equal(profile.versionFlagAvailable, false);
  assert.throws(() => Downloads.parseSourceProfile({ ...source, args: source.args.replace('legacy-gl', 'changed') }, "arm64"), /unsupported/);
  assert.throws(() => Downloads.parseSourceProfile({ ...source, workflow: source.workflow + '-DENABLE_LEGACY_GL=OFF\n' }, "arm64"), /unsupported/);
});

test("Butterscotch shared Actions mapper selects its host artifact and retains publisher digests", async () => {
  const pin = nightly(), sha = Fixture.revision;
  const workflow = { id: pin.workflow.id, status: "completed", conclusion: "success", head_branch: "main", event: "push", path: ".github/workflows/build.yml",
    head_sha: sha, created_at: pin.publishedAt, repository: { full_name: "ButterscotchRunner/Butterscotch" }, head_repository: { full_name: "ButterscotchRunner/Butterscotch" } };
  const artifact = { id: pin.asset.assetId, name: "butterscotch-appkit-macos-arm64", expired: false, size_in_bytes: 991480,
    digest: `sha256:${pin.asset.sha256}`, created_at: pin.publishedAt, expires_at: pin.asset.expiresAt,
    workflow_run: { id: workflow.id, head_sha: sha, head_branch: "main" } };
  const entries = await Downloads.createDownloadDiscovery({ architecture: "arm64", dependencies: { now: () => now,
    request: async url => ({ status: 200, body: Fixture.sourceBody(url) || Buffer.from(JSON.stringify(url.includes('/artifacts?') ? { artifacts: [artifact] } : { workflow_runs: [workflow] })) }) } })();
  assert.equal(entries.length, 1); assert.equal(entries[0].version, pin.version); assert.equal(entries[0].asset.sha256, pin.asset.sha256);
});

test("Butterscotch Reload and All versions use distinct bounded catalog queries", async t => {
  t.mock.method(require("../src/modules/shared/runtime/maclauncher-builds"), "fetchProjectCatalog", async () => ({ packages: [] }));
  const root = temporary(t), pin = nightly(process.arch === "x64" ? "x86_64" : "arm64"), calls = [];
  const label = process.arch === "x64" ? "x86_64" : "arm64";
  const runs = [1, 2, 3].map(id => ({ id, status: "completed", conclusion: "success", head_branch: "main", event: "push",
    path: ".github/workflows/build.yml", head_sha: Fixture.revision, created_at: "2026-10-09T00:00:00Z",
    repository: { full_name: "ButterscotchRunner/Butterscotch" }, head_repository: { full_name: "ButterscotchRunner/Butterscotch" } }));
  const runtime = createManager({ now: () => now, systemVersionSync: () => "26.0", request: async url => {
    calls.push(url); const source = Fixture.sourceBody(url,process.arch); if(source)return {status:200,body:source}; const runId = Number(/actions\/runs\/(\d+)\//.exec(url)?.[1]);
    const body = runId ? { artifacts: [{ id: 100 + runId, name: `butterscotch-appkit-macos-${label}`, expired: false,
      size_in_bytes: 1024, digest: `sha256:${pin.asset.sha256}`, expires_at: "2027-01-01T00:00:00Z", created_at: "2026-10-09T00:00:00Z",
      workflow_run: { id: runId, head_sha: Fixture.revision, head_branch: "main" } }] } : { workflow_runs: runs };
    return { status: 200, body: Buffer.from(JSON.stringify(body)) };
  } });
  const latest = await runtime.refreshCatalog({ userDataDir: root });
  assert.equal(latest.mode, "latest");
  assert.equal(latest.versions.filter(version => /2026-10-09/.test(version)).length, 1);
  assert.equal(calls.length, 6);
  const all = await runtime.refreshCatalog({ userDataDir: root, latestOnly: false });
  assert.equal(all.versions.filter(version => /2026-10-09/.test(version)).length, 3);
  assert.equal(new Set(all.versions).size, all.versions.length);
  assert.equal(calls.length, 22);
});

test("argument-capable Play discovers after consented install and reuses its exact verified archive offline", {skip:process.platform!=="darwin"}, async t => {
  const root=temporary(t),userDataDir=path.join(root,"launcher"),payload=path.join(root,"payload"),archive=path.join(root,"fixture.zip");
  fs.mkdirSync(payload);fs.writeFileSync(path.join(payload,"butterscotch"),binary({floor:0x0d0000,architecture:process.arch==="x64"?"x86_64":"arm64"}),{mode:0o755});
  execFileSync("/usr/bin/ditto",["-c","-k",payload,archive]);
  const recommended="MCLv1-1007",bytes=fs.readFileSync(archive),rows=Fixture.rows().butterscotch.map(row=>({...row,...(row.version===Fixture.argsVersion?{version:recommended}:{}),...Downloads.parseSourceProfile(Fixture.source(process.arch),process.arch),architecture:process.arch==="x64"?"x86_64":"arm64",workflow:{id:1},asset:{...row.asset,sha256:crypto.createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length}}));
  let downloads=0,refreshes=0;
  t.mock.method(require("../src/modules/shared/runtime/maclauncher-builds"),"fetchProjectCatalog",async()=>({packages:[]}));
  t.mock.method(Downloads,"createDownloadDiscovery",()=>async()=>{refreshes++;return rows;});
  const runtime=createManager({systemVersionSync:()=>"26.0",downloadToFile:async(_url,dest)=>{downloads++;fs.writeFileSync(dest,bytes);},run:async()=>({stdout:"--save-folder <directory>\n--renderer <renderer>\n"})});
  assert.equal(runtime.resolveSelection({launchArguments:"--example"},{},userDataDir).version,null);
  assert.equal(refreshes,0);assert.equal(downloads,0);
  const installed=await runtime.installRuntime({userDataDir,gameArgumentsRequired:true});
  assert.equal(installed.version,recommended);assert.ok(refreshes>0);assert.equal(downloads,1);
  const coldRefreshes=refreshes;
  const selected=runtime.resolveSelection({launchArguments:"--example"},{},userDataDir);assert.equal(selected.ready,true);assert.equal(selected.version,recommended);
  await runtime.installRuntime({userDataDir,gameArgumentsRequired:true});assert.equal(refreshes,coldRefreshes);assert.equal(downloads,1);
  await assert.rejects(runtime.installRuntime({userDataDir,version:Fixture.legacyVersion,gameArgumentsRequired:true}),/incompatible runtime profile/);
  assert.equal(downloads,1,"An exact incompatible choice cannot silently substitute another runtime");
  fs.appendFileSync(installed.executablePath,"changed");
  assert.equal(runtime.resolveSelection({launchArguments:"--example"},{},userDataDir).ready,false);
});

test("only games requiring argument transport recommend its exact known build while unset globals keep committed fallbacks", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), runtime = createManager({ systemVersionSync: () => "26.0" });
  const game = { launchArguments: "--game-option" }, cold = runtime.resolveSelection(game, {}, root);
  assert.equal(cold.version, "MCLv1-1007"); assert.equal(cold.recommendedVersion, "MCLv1-1007");
  assert.equal(runtime.resolveSelection({}, {}, root).recommendedVersion, undefined);
  const base = Fixture.rows().butterscotch[1], rows = ["MCLv1-1007", "MCLv2-fixture"].map(version => ({ ...base, version }));
  Fixture.cache(root, { butterscotch: rows });
  assert.equal(runtime.resolveSelection(game, {}, root).version, "MCLv1-1007");
  assert.equal(runtime.resolveSelection({}, {}, root).version, "MCLv1-1007", "The committed catalog fallback remains available");
  assert.equal(runtime.resolveSelection({ ...game, runtimeData: { butterscotch: { version: "MCLv2-fixture" } } }, {}, root).version, "MCLv2-fixture");
  assert.equal(runtime.resolveSelection(game, { runtimes: { butterscotch: { defaultVersion: "MCLv2-fixture" } } }, root).version, "MCLv1-1007", "The game recommendation precedes the Runtimes default");
  assert.equal(runtime.resolveSelection({}, { runtimes: { butterscotch: { defaultVersion: "MCLv2-fixture" } } }, root).version, "MCLv2-fixture");
  const executable = path.join(root, "installed-runner");
  fs.writeFileSync(executable, binary({ floor: 0x0d0000, architecture: process.arch === "x64" ? "x86_64" : "arm64" }), { mode: 0o755 });
  runtime.core.registerLocal({ userDataDir: root, version: "MCLv2-fixture", runtimePath: executable });
  assert.equal(runtime.resolveSelection(game, {}, root).version, "MCLv1-1007", "A compatible installation does not replace the game's exact recommendation");
  assert.equal(runtime.resolveSelection({}, {}, root).version, "MCLv2-fixture", "An unset global retains the committed installed fallback");
  assert.equal(runtime.resolveSelection({}, {runtimes:{butterscotch:{defaultVersion:null}}}, root).version, null);
  runtime.core.registerLocal({ userDataDir: root, version: "MCLv1-1007", runtimePath: executable });
  assert.equal(runtime.resolveSelection(game, {}, root).version, "MCLv1-1007", "The game recommendation ranks compatible installed choices");
});
