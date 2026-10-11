// Exercises the production backend operations through independent real Workers.
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const { createBackendOperations } = require("../../src/core/backend-operations");
const { remoteRuntimeCoordinator } = require("../../src/core/runtime-coordinator");
const { errorRecord, restoreError } = require("../../src/core/backend-worker-client");
const { withRuntimeUse } = require("../../src/core/coordinated-runtime-managers");
const { runToolCommand } = require("../../src/modules/shared/runtime/tool-command");
const callbacks = new Map();
let nextCallback = 0;
const callHost = (method, ...args) => new Promise((resolve, reject) => {
  const id = ++nextCallback; callbacks.set(id, { resolve, reject });
  parentPort.postMessage({ type: "callback", id, method, args });
});
const emit = (event, payload) => parentPort.postMessage({ type: "event", event, payload });
const root = (id, version) => path.join(workerData.userDataDir, "runtimes", id, version);
const managers = ["fixture-a", "fixture-b"].map(id => ({
  id, label: id,
  normalizeSettings(settings = {}) { return { defaultVersion: null, first: null, second: null, ...settings }; },
  getState() {
    const parent = path.dirname(root(id, "unused"));
    const installed = fs.existsSync(parent) ? fs.readdirSync(parent).flatMap(version => {
      const installDir = root(id, version), executablePath = path.join(installDir, "runner.cjs");
      return fs.existsSync(executablePath) ? [{ version, installDir, executablePath, ready: true }] : [];
    }) : [];
    return { defaultVersion: "1", installed, catalog: { versions: ["3", "2", "1"] } };
  },
  resolveSelection(entry) {
    const version = entry.moduleData?.requestedVersion || "1";
    const install = this.getState().installed.find(row => row.version === version);
    return { version, install, ready: Boolean(install) };
  },
  async installRuntime({ version, userDataDir }) {
    emit("installStarted", { managerId: id, version });
    await callHost("test.downloadGate", id, version);
    const installDir = root(id, version);
    // Deliberately models a runtime installer that replaces a shared directory.
    fs.rmSync(installDir, { force: true, recursive: true }); fs.mkdirSync(installDir, { recursive: true });
    const executablePath = path.join(installDir, "runner.cjs");
    fs.writeFileSync(executablePath, "setInterval(() => {}, 1000);\n");
    fs.appendFileSync(path.join(userDataDir, "install-counts"), `${id}:${version}\n`);
    return { version, installDir, executablePath, ready: true };
  },
  uninstallRuntime({ installDir }) { fs.rmSync(installDir, { force: true, recursive: true }); return true; },
  applySettingsUpdate(_action, payload, settings = {}) { return { ...this.normalizeSettings(settings), [payload.key || "defaultVersion"]: payload.version }; },
  updateSettingsAfterInstall(settings = {}, installed) { return { ...settings, defaultVersion: installed.version }; },
  async performSetupAction({ userDataDir, version = "1" }) {
    return this.installRuntime({ userDataDir, version });
  }
}));
const info = { id: "fixture", label: "Fixture", gameType: "native",
  runtime: { default: "runner", supported: ["runner"], manager: { runner: "fixture-a" }, entries: { runner: {} } } };
const mod = { id: info.id, manifest: info, runtimeManagers: managers,
  async cleanupGameData(entry) {
    emit("cleanupStarted", { gameId: entry.gameId });
    if (entry.moduleData?.cleanupDelay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, entry.moduleData.cleanupDelay);
    fs.appendFileSync(path.join(workerData.userDataDir, "cleanup-counts"), entry.gameId + "\n");
  },
  async ensureRuntime(entry) {
    const version = entry.moduleData?.requestedVersion || "1";
    if (entry.moduleData?.candidateVersion) managers[0].resolveSelection({ moduleData: { requestedVersion: entry.moduleData.candidateVersion } });
    const installed = entry.moduleData?.automaticSource ? managers[0].resolveSelection(entry).install : managers[0].getState().installed.find(row => row.version === version);
    return installed ? null : { managerId: "fixture-a", version };
  },
  async prepareLaunch(entry, context) {
    if (!entry.moduleData?.libraryMutation) return;
    const version = entry.moduleData.requestedVersion || "1";
    await context.withRuntimeMutation({ managerId: "fixture-a", version }, async () => {
      fs.writeFileSync(path.join(root("fixture-a", version), "library.dat"), "prepared");
    });
  },
  async launchRuntime(_runtime, entry, context) {
    const version = entry.moduleData?.requestedVersion || "1";
    const install = managers[0].getState().installed.find(row => row.version === version);
    let script = install.executablePath;
    if (entry.moduleData?.privateContext) {
      if (!entry.moduleData?.automaticSource) await context.useRuntime({ managerId: "fixture-a", version, sourcePath: install.installDir });
      if (entry.moduleData?.failLaunch) throw new Error("Fixture launch failure");
      const privateRoot = path.join(workerData.userDataDir, "games", entry.gameId);
      fs.mkdirSync(privateRoot, { recursive: true }); script = path.join(privateRoot, "runner.cjs");
      fs.copyFileSync(install.executablePath, script);
    }
    return context.spawnDetachedChecked(process.execPath, [script]);
  },
  actions: {
    async managedExport(entry, _payload, context) {
      const directory = path.join(context.userDataDir, "games", entry.gameId, "tool-export"); fs.mkdirSync(directory, { recursive: true });
      return withRuntimeUse(["fixture-a", "fixture-b"].map(managerId => ({ managerId, version: "1", sourcePath: root(managerId, "1") })),
        use => runToolCommand(process.execPath, [path.join(root("fixture-a", "1"), "runner.cjs")], {
          cwd: directory, logPath: path.join(directory, "export.log"), timeout: 30000,
          onSpawn: async child => {
            await Promise.all([use.bind(child.pid), context.onToolProcessSpawn(child)]);
            emit("toolStarted", { pid: child.pid });
          }
        }), { userDataDir: context.userDataDir });
    },
    async installDirect(_entry, payload, context) { return managers[0].installRuntime({ ...payload, userDataDir: context.userDataDir }); },
    async delayedSetting(_entry, payload, context) {
      emit("settingsEntered", { key: payload.key });
      await callHost("test.settingsGate", payload.key);
      context.settings.launcher[payload.key] = payload.value;
      return true;
    },
    async removeSharedAssets(_entry, _payload, context) {
      return context.withRuntimeMutation({ managerId: "fixture-a" }, async () => true);
    },
    async delayedRuntimeSetting(_entry, payload, context) {
      emit("settingsEntered", {}); await callHost("test.settingsGate");
      context.settings.runtimes ||= {};
      context.settings.runtimes["fixture-a"] = { ...managers[0].normalizeSettings(context.settings.runtimes["fixture-a"]), [payload.key]: payload.value };
      return true;
    }
  }
};
const registry = { listModuleIds: () => [info.id], listModules: () => [info], getModule: () => mod,
  getModuleInfo: () => info, getModuleDir: () => __dirname, listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null,
  detectGameAsync: async gamePath => ({ moduleId: info.id, gamePath, contentRootDir: gamePath, name: "Fixture" }) };
const operations = createBackendOperations({ ...workerData, registry, emit, callHost, runtimeCoordinator: remoteRuntimeCoordinator(callHost) });
parentPort.on("message", async message => {
  if (message.type === "callbackResult") {
    const pending = callbacks.get(message.id); callbacks.delete(message.id);
    if (message.error) pending.reject(restoreError(message.error)); else pending.resolve(message.result);
  } else if (message.type === "request") {
    try { parentPort.postMessage({ type: "result", id: message.id, result: await operations[message.method](...message.args) }); }
    catch (error) { parentPort.postMessage({ type: "result", id: message.id, error: errorRecord(error) }); }
  }
});
