const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Origins = require("../src/core/runtime-install-origins");
const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");

function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-origins-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
// A manager with installed versions in runtimes/<id>/<version>; removal deletes the folder
// and tolerates one already set aside.
function fakeManager(root, id, rows, { resolve = () => null } = {}) {
  const directory = version => path.join(root, "runtimes", id, version);
  for (const row of rows) fs.mkdirSync(directory(row.version), { recursive: true });
  return {
    id,
    getState: () => ({ installed: rows.filter(row => fs.existsSync(directory(row.version))).map(row => ({ installDir: directory(row.version), ready: true, ...row })),
      catalog: { versions: rows.map(row => row.version).sort().reverse() }, defaultVersion: null }),
    resolveSelection: entry => resolve(entry),
    trashFirst: true,
    async uninstallRuntime({ version }) { fs.rmSync(directory(version), { recursive: true, force: true }); return true; }
  };
}
const coordinator = { acquireMutation: async () => "token", extendMutation: async () => {}, release: async () => {} };
const recorded = root => Origins.read(root).map(row => `${row.managerId} ${row.version}`).sort();

test("Play records only versions it chose on its own and explicit actions clear the record", async t => {
  const root = profile(t), manager = fakeManager(root, "player", [{ version: "7" }]);
  const play = (version, { entry = {}, settings = {}, installedBefore = [], automatic = true } = {}) =>
    Origins.recordPlayInstall({ userDataDir: root, manager, plan: { version, automatic, installOptions: { sectionId: "default" } }, result: { version }, entry, settings, installedBefore });
  assert.equal(play("6"), true);
  // A module planner, such as Ren'Py recommending 7.4.11 from a game's 7.4.11.2266, marks nothing automatic.
  assert.equal(play("7.4.11", { automatic: false, entry: { moduleData: { version: "7.4.11.2266" } } }), false, "a module planner's choice is never recorded");
  assert.equal(play("5", { entry: { runtimeData: { player: { version: "5" } } } }), false, "a game's choice is not automatic");
  assert.equal(play("4", { settings: { runtimes: { player: { defaultVersion: "4" } } } }), false, "a saved default is not automatic");
  assert.equal(play("7", { installedBefore: ["7"] }), false, "an existing installation keeps its origin");
  assert.deepEqual(recorded(root), ["player 6"]);
  await runRuntimeManagerAction({ manager: { ...manager, applySettingsUpdate: () => ({ defaultVersion: "6" }) }, action: "setDefault",
    payload: { version: "6" }, userDataDir: root, runtimeCoordinator: coordinator });
  assert.deepEqual(recorded(root), [], "Set default makes the version an explicit choice");
});

test("upkeep removes a superseded automatic version through Runtimes and keeps every version still in use", async t => {
  const root = profile(t), log = [];
  const player = fakeManager(root, "player", [{ version: "7" }, { version: "6" }, { version: "5" }, { version: "4" }, { version: "3" }],
    { resolve: entry => entry.gameId === "recommended" ? { version: "5", ready: true } : { version: "7", ready: true } });
  const other = fakeManager(root, "other", [{ version: "2", ready: false, status: "damaged" }, { version: "1" }]);
  for (const [managerId, version] of [["player", "6"], ["player", "5"], ["player", "4"], ["other", "1"], ["player", "9"]])
    Origins.recordPlayInstall({ userDataDir: root, manager: { id: managerId }, plan: { version, automatic: true }, result: { version } });
  const game = (gameId, record) => {
    fs.mkdirSync(path.join(root, "games", gameId), { recursive: true });
    fs.writeFileSync(path.join(root, "games", gameId, "game.json"), JSON.stringify({ gameId, ...record }));
  };
  game("chosen", { runtimeData: { player: { version: "4" } } });
  game("recommended", {});
  game("ejected", { gamePath: path.join(root, "missing", "Game") });
  const managers = [player, other];
  const remove = ({ managerId, ...payload }) => runRuntimeManagerAction({ manager: managers.find(item => item.id === managerId),
    action: "uninstall", payload, userDataDir: root, runtimeCoordinator: coordinator });
  const options = { userDataDir: root, managers, gameIds: ["chosen", "recommended", "ejected"], remove, logger: { info: message => log.push(message), warn: message => log.push(message) } };

  assert.deepEqual((await Origins.pruneSuperseded({ ...options, isRunning: () => true })).removed, [], "nothing is removed while a game runs");
  assert.ok(fs.existsSync(path.join(root, "runtimes", "player", "6")));

  const { removed } = await Origins.pruneSuperseded(options);
  assert.deepEqual(removed.map(row => `${row.managerId} ${row.version}`), ["player 6"]);
  assert.ok(!fs.existsSync(path.join(root, "runtimes", "player", "6")));
  for (const version of ["7", "5", "4", "3"]) assert.ok(fs.existsSync(path.join(root, "runtimes", "player", version)), version);
  assert.ok(fs.existsSync(path.join(root, "runtimes", "other", "1")), "a damaged newer version supersedes nothing");
  assert.deepEqual(recorded(root), ["other 1", "player 4", "player 5"], "removed and absent versions leave no record");
  assert.match(log.join("\n"), /removed 1 superseded automatic installation\(s\): player 6/);
});

test("removing a runtime moves its folder to trash first, and a refused removal restores it", async t => {
  const root = profile(t), runtimes = path.join(root, "runtimes");
  const player = fakeManager(root, "player", [{ version: "7" }, { version: "6" }]);
  // A sealed subtree, as an extracted package can leave, stopped the earlier recursive removal halfway.
  const sealed = path.join(runtimes, "player", "6", "lib", "translated");
  fs.mkdirSync(sealed, { recursive: true }); fs.writeFileSync(path.join(sealed, "elf"), "x");
  fs.chmodSync(sealed, 0o555); fs.chmodSync(path.dirname(sealed), 0o555);
  // Hooks run in order, so a sealed tree left by a failure is reopened and removed here.
  t.after(() => {
    if (!fs.existsSync(root)) return;
    for (const name of fs.readdirSync(root, { recursive: true })) try { fs.chmodSync(path.join(root, name), 0o755); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  await runRuntimeManagerAction({ manager: player, action: "uninstall", payload: { version: "6" }, userDataDir: root, runtimeCoordinator: coordinator });
  assert.ok(!fs.existsSync(path.join(runtimes, "player", "6")));
  assert.deepEqual(fs.readdirSync(runtimes).filter(name => name.startsWith(".maclauncher-")), [], "nothing partial or hidden remains");
  const refusing = { ...fakeManager(root, "included", [{ version: "1" }]), async uninstallRuntime() { throw new Error("This runtime is included in the app."); } };
  await assert.rejects(runRuntimeManagerAction({ manager: refusing, action: "uninstall", payload: { version: "1" }, userDataDir: root, runtimeCoordinator: coordinator }), /included/);
  assert.ok(fs.existsSync(path.join(runtimes, "included", "1")), "a refused removal keeps the folder in place");
  const declining = { ...fakeManager(root, "declining", [{ version: "1" }]), async uninstallRuntime() { return false; } };
  assert.equal(await runRuntimeManagerAction({ manager: declining, action: "uninstall", payload: { version: "1" }, userDataDir: root, runtimeCoordinator: coordinator }), false);
  assert.ok(fs.existsSync(path.join(runtimes, "declining", "1")), "a declined removal keeps the folder in place");
  // A manager without the capability, such as one that removes a model only while its folder exists, keeps its own removal.
  const own = { ...fakeManager(root, "own", [{ version: "1" }]), trashFirst: undefined,
    async uninstallRuntime({ version }) { const folder = path.join(runtimes, "own", version); if (!fs.existsSync(folder)) return false; fs.rmSync(folder, { recursive: true }); return true; } };
  assert.equal(await runRuntimeManagerAction({ manager: own, action: "uninstall", payload: { version: "1" }, userDataDir: root, runtimeCoordinator: coordinator }), true);
  assert.ok(!fs.existsSync(path.join(runtimes, "own", "1")));
  // Trash that an interrupted removal left is finished by the next upkeep pass.
  const left = path.join(runtimes, ".maclauncher-trash-" + require("node:crypto").randomUUID());
  fs.mkdirSync(path.join(left, "bin"), { recursive: true }); fs.writeFileSync(path.join(left, "bin", "tool"), "x");
  const { maintainStorage } = require("../src/core/storage-maintenance");
  await maintainStorage({ userDataDir: root, stores: require("../src/core/derived-stores") });
  assert.ok(!fs.existsSync(left));
});

test("removing a custom registration keeps the files it points to", async t => {
  const root = profile(t), runtimes = path.join(root, "runtimes");
  // A registration can point into another manager's managed version.
  const target = path.join(runtimes, "unity", "2022.3.10f1");
  fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, "Unity"), "x");
  let registered = true;
  const custom = { id: "custom-player",
    getState: () => ({ installed: registered ? [{ version: target, installDir: target, ready: true, source: "custom", custom: true, external: true, imported: true }] : [] }),
    async uninstallRuntime() { registered = false; return true; } };
  await runRuntimeManagerAction({ manager: custom, action: "uninstall", payload: { version: target }, userDataDir: root, runtimeCoordinator: coordinator });
  assert.equal(registered, false, "the registration is removed");
  assert.ok(fs.existsSync(path.join(target, "Unity")), "the folder it pointed to stays");
  assert.deepEqual(fs.readdirSync(runtimes).filter(name => name.startsWith(".maclauncher-")), []);
});

test("upkeep leaves a removal in progress alone and settles one an exit interrupted", async t => {
  const root = profile(t), runtimes = path.join(root, "runtimes");
  const { maintainStorage } = require("../src/core/storage-maintenance"), stores = require("../src/core/derived-stores");
  const { settleInterruptedRemovals } = require("../src/core/coordinated-runtime-managers");
  let refuse, entered;
  const decided = new Promise(resolve => { refuse = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const slow = { ...fakeManager(root, "slow", [{ version: "2" }]), async uninstallRuntime() { entered(); await decided; throw new Error("Removal refused."); } };
  const removal = runRuntimeManagerAction({ manager: slow, action: "uninstall", payload: { version: "2" }, userDataDir: root, runtimeCoordinator: coordinator });
  await started;
  // A pass while the manager is still deciding takes nothing.
  settleInterruptedRemovals({ userDataDir: root, managers: [slow] });
  await maintainStorage({ userDataDir: root, stores });
  assert.equal(fs.readdirSync(runtimes).filter(name => /^\.maclauncher-removing-[\w-]+$/.test(name)).length, 1, "the folder set aside stays");
  refuse();
  await assert.rejects(removal, /refused/);
  assert.ok(fs.existsSync(path.join(runtimes, "slow", "2")), "the refused removal restores the folder");
  // Removals an exit interrupted: a version its manager still lists returns, and any other is finished.
  const leftover = (version, installDir) => {
    const aside = path.join(runtimes, ".maclauncher-removing-" + require("node:crypto").randomUUID());
    fs.mkdirSync(path.join(aside, "bin"), { recursive: true }); fs.writeFileSync(path.join(aside, "bin", "tool"), "x");
    fs.writeFileSync(`${aside}.json`, JSON.stringify({ schemaVersion: 1, managerId: "listed", version, sectionId: "default", installDir }));
  };
  const listedDir = path.join(runtimes, "listed", "3"), removedDir = path.join(runtimes, "listed", "4");
  const listed = { id: "listed", getState: () => ({ installed: [{ version: "3", installDir: listedDir, ready: true }] }) };
  leftover("3", listedDir); leftover("4", removedDir);
  settleInterruptedRemovals({ userDataDir: root, managers: [listed] });
  await maintainStorage({ userDataDir: root, stores });
  assert.ok(fs.existsSync(path.join(listedDir, "bin", "tool")), "a version its manager still lists returns to its place");
  assert.ok(!fs.existsSync(removedDir));
  assert.deepEqual(fs.readdirSync(runtimes).filter(name => name.startsWith(".maclauncher-")), [], "no record or folder is left aside");
});
