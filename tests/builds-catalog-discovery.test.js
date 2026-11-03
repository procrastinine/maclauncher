const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), https = require("node:https"), http = require("node:http");
const Downloads = require("../src/modules/shared/runtime/upstream-transport");
const crypto = require("node:crypto"), {execFileSync} = require("node:child_process");

// Every runtime manager is refreshed offline. MacLauncher Builds catalogs answer
// with versions this launcher has never seen, in each package layout; every
// other request fails. A released launcher must list later Builds versions
// without a launcher update.
const BUILDS = "https://raw.githubusercontent.com/procrastinine/maclauncher-builds/main/catalogs/";
const LAYOUTS = ["runtime.json", "manifest.json", "helper.json"], VERSIONS = LAYOUTS.map((_, index) => `99.0.${index}`);
function futureCatalog(projectId) {
  return { schemaVersion: 2, projectId, updatePolicy: "manual", packages: LAYOUTS.map((manifestRelative, index) => {
    const version = VERSIONS[index], tag = `${projectId}/v${version}/${process.arch}`, filename = `${projectId}-${version}-${process.arch}.tar.gz`;
    return { schemaVersion: 2, id: projectId, version, arch: process.arch, launcherArchitectures: [process.arch], minimumMacOS: "13.0",
      manifestRelative, manifestSha256: "a".repeat(64), sourceSha256: "b".repeat(64), updatePolicy: "manual", tag,
      source: { repository: "ExampleOwner/example-runtime", revision: "d".repeat(40) },
      ...(projectId === "fna" ? {launcherContract: 2, capabilities: {originalGamePaths: true}} : {}),
      asset: { filename, sha256: "c".repeat(64), bytes: 1,
        url: `https://github.com/procrastinine/maclauncher-builds/releases/download/${encodeURIComponent(tag)}/${filename}` } };
  }) };
}
const requested = [];
Downloads.fetchUrlBuffer = async url => {
  if (!String(url).startsWith(BUILDS)) return { status: 404, headers: {}, body: Buffer.alloc(0) };
  const projectId = path.basename(new URL(url).pathname, ".json");
  requested.push(projectId);
  return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(futureCatalog(projectId))) };
};
const offline = () => { throw Object.assign(new Error("Offline test"), { code: "ENOTFOUND" }); };
https.request = https.get = http.request = http.get = offline;
globalThis.fetch = async () => offline();

function catalogs(state, found = []) {
  if (!state || typeof state !== "object") return found;
  if (state.catalog && typeof state.catalog === "object") found.push(state.catalog);
  for (const section of state.sections || []) if (section !== state) catalogs(section, found);
  return found;
}

test("every Builds runtime lists later hosted versions after Refresh", { skip: process.platform !== "darwin" }, async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "builds-catalog-discovery-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const registry = require("../src/modules/registry"), managers = new Map();
  for (const info of registry.listModules())
    for (const manager of registry.getModule(info.id)?.runtimeManagers || []) if (manager?.id && !managers.has(manager.id)) managers.set(manager.id, manager);
  for (const manager of registry.listSharedRuntimeManagers()) if (manager?.id && !managers.has(manager.id)) managers.set(manager.id, manager);
  const consulted = [];
  for (const [id, manager] of managers) {
    if (typeof manager.refreshCatalog !== "function") continue;
    const before = requested.length;
    await manager.refreshCatalog({ userDataDir, force: true }).catch(() => {});
    const projects = requested.slice(before), state = manager.getState({ userDataDir, settings: {} });
    if (!projects.length) {
      assert.ok(!JSON.stringify(state).includes("procrastinine/maclauncher-builds"), `${id} names MacLauncher Builds without reading its catalog`);
      continue;
    }
    consulted.push(id);
    const listed = catalogs(state);
    for (const version of VERSIONS)
      assert.ok(listed.some(catalog => catalog.versions?.includes(version)), `${id} does not list hosted ${version} from ${projects.join(", ")}`);
    assert.ok(listed.some(catalog => VERSIONS.some(version => catalog.versions?.includes(version) && !catalog.versionRequirements?.[version]?.installReason)),
      `${id} cannot install a later version in its own package layout`);
  }
  assert.ok(consulted.includes("android") && consulted.length >= 20, `Only ${consulted.length} runtimes read MacLauncher Builds`);
});

test("a later FNA hosted archive installs its capability-bearing sealed profile at the managed executable path", {skip: process.platform !== "darwin"}, async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "builds-fna-future-")));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const Profile = require("../src/modules/fna/runtime/profile"), Bundled = require("../src/modules/shared/runtime/bundled-native");
  const record = futureCatalog("fna").packages[1], stage = path.join(directory, "archive"), payload = path.join(stage, "files", "files", "fna");
  const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), dotnetVersion = "8.0.42", hashes = {};
  for (const name of Profile.requiredFiles(dotnetVersion)) {
    const file = path.join(payload, name);fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, "structural FNA fixture " + name);hashes[name] = sha(fs.readFileSync(file));
  }
  // Structural Mach-O bytes exercise package routing and integrity, never execution.
  const binary = Buffer.alloc(32);binary.writeUInt32LE(0xfeedfacf);binary.writeUInt32LE(process.arch === "x64" ? 0x01000007 : 0x0100000c, 4);binary.writeUInt32LE(2, 12);
  fs.writeFileSync(path.join(payload, "dotnet"), binary, {mode: 0o755});
  fs.writeFileSync(path.join(payload, "LICENSE.txt"), "Fixture license\n");
  fs.writeFileSync(path.join(payload, "fna-runtime.json"), JSON.stringify({profile: record.version, architecture: process.arch,
    capabilities: {originalGamePaths: true}, upstreamRevision: record.source.revision, frameworkVersion: "26.10.0.0", dotnetVersion, files: hashes}));
  const files = Bundled.fileInventory(path.dirname(payload)).map(name => {
    const file = path.join(path.dirname(payload), name), stat = fs.statSync(file);
    return {path: name, mode: stat.mode & 0o777, size: stat.size, sha256: sha(fs.readFileSync(file)),
      ...(name === "fna/dotnet" ? {architectures: [process.arch === "x64" ? "x86_64" : "arm64"]} : {})};
  });
  const manifest = {schemaVersion: 1, managerId: "fna", version: record.version, arch: process.arch, platform: "darwin", minimumMacOS: "13.0",
    upstreamRevision: record.source.revision, executableRelative: "fna/dotnet", files, dependencies: [], provenance: {sourceRevision: record.source.revision},
    notices: [{name: "Fixture", license: "MIT", sourceUrl: "https://example.com/source", path: "fna/LICENSE.txt"}]};
  const bytes = Buffer.from(JSON.stringify(manifest));record.manifestSha256 = record.sourceSha256 = sha(bytes);
  fs.writeFileSync(path.join(stage, "files", "manifest.json"), bytes);
  fs.writeFileSync(path.join(stage, "runtime-package.json"), JSON.stringify({...record, files: [
    ...files.map(file => ({...file, path: "files/" + file.path})),
    {path: "manifest.json", size: bytes.length, mode: 0o644, sha256: sha(bytes)}]}));
  const archive = path.join(directory, record.asset.filename);
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", stage, "runtime-package.json", "files"]);
  record.asset.sha256 = sha(fs.readFileSync(archive));record.asset.bytes = fs.statSync(archive).size;
  const transfers = [], manager = require("../src/modules/fna/runtime/manager").createManager({dependencies: {manager: {
    systemVersionSync: () => "26.0", hostArch: process.arch,
    projectBuilds: {fetchUrlBuffer: async url => {
      assert.equal(url, BUILDS + "fna.json");
      return {status: 200, body: Buffer.from(JSON.stringify({schemaVersion: 2, projectId: "fna", updatePolicy: "manual", packages: [record]}))};
    }, verifySignatures: async () => {}},
    downloadToFile: async (url, destination) => {assert.equal(url, record.asset.url);transfers.push(url);fs.copyFileSync(archive, destination);}
  }}});
  const userDataDir = path.join(directory, "profile");await manager.refreshCatalog({userDataDir, force: true});
  assert.ok(manager.getState({userDataDir}).catalog.installableVersions.includes(record.version));
  const installed = await manager.installRuntime({userDataDir, version: record.version});
  assert.deepEqual(transfers, [record.asset.url]);assert.equal(installed.archiveSha256, record.asset.sha256);
  assert.equal(installed.executablePath, path.join(installed.installDir, "project-payload", "files", "fna", "dotnet"));
  assert.deepEqual(fs.readFileSync(installed.executablePath), binary);
  assert.equal(installed.catalogEntry.projectPackage.launcherContract, 2);
  assert.equal(installed.catalogEntry.projectPackage.capabilities.originalGamePaths, true);
  const profile = JSON.parse(fs.readFileSync(path.join(path.dirname(installed.executablePath), "fna-runtime.json"), "utf8"));
  assert.equal(profile.capabilities.originalGamePaths, true);
  const selected = manager.resolveSelection({}, {}, userDataDir);
  assert.equal(selected.version, record.version);assert.equal(selected.ready, true);assert.equal(selected.profile.capabilities.originalGamePaths, true);
});
