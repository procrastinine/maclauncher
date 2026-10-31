// Required first: it replaces the network functions before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");

const registry = require("../src/modules/registry");
function managers() {
  const found = new Map();
  for (const info of registry.listModules())
    for (const manager of registry.getModule(info.id)?.runtimeManagers || []) if (manager?.id && !found.has(manager.id)) found.set(manager.id, manager);
  for (const manager of registry.listSharedRuntimeManagers()) if (manager?.id && !found.has(manager.id)) found.set(manager.id, manager);
  return found;
}
const directory = path.join(__dirname, "future-upstream");
const fixtures = fs.readdirSync(directory).filter(name => name.endsWith(".cjs")).sort()
  .map(name => ({ name, ...require(path.join(directory, name)) }));
// Managers whose Refresh reads only MacLauncher Builds catalogs are covered by
// builds-catalog-discovery.test.js.
const BUILDS = /^https:\/\/(?:raw\.githubusercontent\.com\/procrastinine\/maclauncher-builds\/|api\.github\.com\/repos\/procrastinine\/maclauncher-builds\/|github\.com\/procrastinine\/maclauncher-builds\/)/;

// A fixture holds the publisher's current routes and derived scenarios, or an
// `exempt` reason when the manager's Refresh needs no upstream checks.
for (const fixture of fixtures.filter(fixture => !fixture.exempt)) for (const id of fixture.managers || []) {
  test(`${id} uses or cleanly skips later upstream releases, renames, replaced files and unknown fields (${fixture.name})`,
    { skip: process.platform !== "darwin" }, async t => {
      const manager = managers().get(id);
      assert.ok(manager, `${id} is not a registered runtime manager`);
      await Harness.checkManager(t, manager, fixture);
    });
}

// Download paths outside runtime catalogs (tool hosts, models, stores) add
// their own checks against the same offline network.
for (const fixture of fixtures) for (const [name, check] of Object.entries(fixture.checks || {})) {
  test(`${name} (${fixture.name})`, { skip: process.platform !== "darwin" }, async t => {
    try { await check(t, Harness); } finally { Harness.network.routes = null; }
  });
}

test("every manager that reads an upstream release list has a future-upstream fixture", { skip: process.platform !== "darwin" }, async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "future-upstream-coverage-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const covered = new Set(fixtures.flatMap(fixture => fixture.managers || [])), missing = [];
  for (const [id, manager] of managers()) {
    if (typeof manager.refreshCatalog !== "function" || covered.has(id)) continue;
    const before = Harness.network.requests.length;
    Harness.network.routes = {};
    await manager.refreshCatalog({ userDataDir, force: true }).catch(() => {});
    Harness.network.routes = null;
    const upstream = Harness.network.requests.slice(before).filter(url => !BUILDS.test(url));
    if (upstream.length) missing.push(`${id}: ${[...new Set(upstream.map(url => new URL(url).host + new URL(url).pathname))].slice(0, 3).join(", ")}`);
  }
  assert.deepEqual(missing, [], "Managers without a future-upstream fixture");
});
