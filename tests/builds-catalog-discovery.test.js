const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), https = require("node:https"), http = require("node:http");
const Downloads = require("../src/modules/shared/runtime/download-utils");

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
