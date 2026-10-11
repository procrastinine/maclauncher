const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { readJsonObject } = require("./json-files");
const { coordinatorFor, coordinationError, conflicts, containsPath, runtimeIdentity } = require("./runtime-coordinator");

const operations = new AsyncLocalStorage();
const instrumented = new WeakSet();
const methods = { installRuntime: "install", importRuntime: "import", uninstallRuntime: "uninstall",
  performInstalledAction: "installedAction", performSetupAction: "setup" };
function canonical(file) { try { return fs.realpathSync(file); } catch { return path.resolve(file); } }
function sourcePath(install) {
  return [install?.installDir, install?.appPath, install?.runtimePath, install?.executablePath, install?.javaPath]
    .find(value => typeof value === "string" && path.isAbsolute(value));
}
function installedRows(manager, userDataDir, settings) {
  if (typeof manager.getState !== "function") return [];
  const state = manager.getState({ userDataDir, settings });
  const sections = state.sections?.length ? state.sections : [{ ...state, id: "default" }];
  return sections.flatMap(section => (section.installed || []).map(install => ({ ...install, sectionId: section.id || "default" })));
}
function identityFor(manager, install) {
  return { managerId: manager.id, version: install.version, sectionId: install.sectionId || "default",
    ...(install.variant ? { variant: install.variant } : {}), ...(sourcePath(install) ? { sourcePath: canonical(sourcePath(install)) } : {}) };
}
function managerVersion(manager, version) {
  if (version == null) return undefined;
  const normalize = manager.normalizeVersion || manager.core?.normalizeVersion || manager.core?.normalizeVersionOrNull;
  return typeof normalize === "function" ? normalize(version) : String(version).trim().replace(/^v(?=\d)/i, "");
}
function selectInstalled(rows, data, manager) {
  const version = managerVersion(manager, data.version);
  const matches = rows.filter(row => managerVersion(manager, row.version) === version && (!data.sectionId || row.sectionId === data.sectionId) &&
    (!data.variant || row.variant === data.variant) && (!data.platformKey || row.platformKey === data.platformKey));
  if (matches.length === 1) return matches[0];
  return null;
}
function readManagerSettings(userDataDir, manager) { return readJsonObject(path.join(userDataDir, "settings.json"))?.runtimes?.[manager.id]; }

async function withRuntimeMutation(identity, fn, { coordinator, userDataDir } = {}) {
  identity = runtimeIdentity(identity);
  const operation = operations.getStore();
  coordinator ||= operation?.coordinator || coordinatorFor(userDataDir || operation?.userDataDir).client();
  userDataDir ||= operation?.userDataDir;
  const held = operation?.mutations || [];
  const allowedUses = await operation?.runtimeUseScope?.preparationLeaseTokens?.() || [];
  const parent = held.find(mutation => mutation.identity.managerId === identity.managerId);
  if (parent) {
    const target = parent.identity;
    const covers = ["version", "sectionId", "variant"].every(key => !target[key] || target[key] === identity[key]) &&
      (!target.sourcePath || (identity.sourcePath && containsPath(target.sourcePath, identity.sourcePath)));
    if (!covers) {
      const broad = { managerId: identity.managerId };
      for (const key of ["version", "sectionId", "variant"]) if (target[key] && target[key] === identity[key]) broad[key] = target[key];
      if (target.sourcePath && identity.sourcePath) {
        if (containsPath(target.sourcePath, identity.sourcePath)) broad.sourcePath = target.sourcePath;
        else if (containsPath(identity.sourcePath, target.sourcePath)) broad.sourcePath = identity.sourcePath;
      }
      await coordinator.extendMutation(parent.token, broad, allowedUses); parent.identity = broad;
    }
    return fn();
  }
  const token = await coordinator.acquireMutation(identity, allowedUses);
  try {
    return await operations.run({ ...operation, coordinator, userDataDir, mutations: [...held, { identity, token }] }, fn);
  } finally { await coordinator.release(token); }
}

async function withRuntimeUse(identity, fn, { coordinator, userDataDir } = {}) {
  const identities = (Array.isArray(identity) ? identity : [identity]).map(runtimeIdentity);
  const operation = operations.getStore();
  coordinator ||= operation?.coordinator || coordinatorFor(userDataDir || operation?.userDataDir).client();
  const token = await coordinator.acquireUse(identities, (operation?.mutations || []).map(item => item.token));
  const retained = new Set();
  let finished = false, released = false;
  const release = async () => {
    if (released || !finished || retained.size) return;
    released = true;
    await coordinator.release(token);
  };
  async function retainUntilClosed(child) {
    if (!child?.once || !Number.isSafeInteger(child.pid) || child.pid <= 0) throw new TypeError("Runtime use needs an owned tool process.");
    if (retained.has(child) || child.exitCode != null || child.signalCode != null) return;
    retained.add(child);
    const finish = () => {
      if (!retained.delete(child)) return;
      void release().catch(() => {});
    };
    child.once("close", finish);
    child.once("exit", finish);
    child.once("error", () => { if (child.exitCode != null || child.signalCode != null) finish(); });
    try { await coordinator.bindUse(token, child.pid); }
    catch (error) { retained.delete(child); throw error; }
    if (child.exitCode != null || child.signalCode != null) finish();
  }
  try { return await fn({ bind: pid => coordinator.bindUse(token, pid), retainUntilClosed }); }
  finally { finished = true; await release(); }
}

/** Module methods retain ownership of compatibility, versions and installation. */
function instrumentRuntimeManagers(managers) {
  for (const manager of managers) {
    if (!manager?.id || instrumented.has(manager)) continue;
    instrumented.add(manager);
    if (typeof manager.resolveSelection === "function") {
      const original = manager.resolveSelection;
      manager.resolveSelection = function observedSelection(...args) {
        const scope = operations.getStore()?.runtimeUseScope;
        const observe = selection => {
          if (scope && selection?.version && selection.install && selection.ready !== false) {
            scope.recordSelection(identityFor(manager, { ...selection.install, version: selection.version }));
          }
          return selection;
        };
        const selection = original.apply(this, args);
        return selection?.then ? selection.then(observe) : observe(selection);
      };
    }
    for (const [method, action] of Object.entries(methods)) {
      const original = manager[method];
      if (typeof original !== "function") continue;
      manager[method] = async function coordinatedMutation(data = {}) {
        const userDataDir = data.userDataDir || operations.getStore()?.userDataDir;
        // A manager may also be used as a standalone library without application storage.
        if (!userDataDir) return original.call(this, data);
        const operation = operations.getStore();
        const coordinator = operation?.coordinator || coordinatorFor(userDataDir).client();
        const settings = () => readManagerSettings(userDataDir, manager);
        const rows = () => installedRows(manager, userDataDir, settings());
        const ready = () => {
          const installed = selectInstalled(rows(), data, manager);
          return installed && installed.ready !== false ? installed : null;
        };
        const installedResult = installed => {
          if (installed?.version && installed.ready !== false) operation?.runtimeUseScope?.recordSelection(identityFor(manager,
            { ...installed, sectionId: installed.sectionId || data.sectionId }));
          return installed;
        };
        const version = managerVersion(manager, data.version);
        let identity = { managerId: manager.id, ...(version ? { version } : {}) };
        let payload = { ...data, userDataDir };
        function validateRemoval() {
          if (!version) throw new Error("Select an installed runtime version to remove.");
          const installed = selectInstalled(rows(), data, manager);
          if (!installed) throw new Error("The selected installed runtime was not found or is ambiguous.");
          if (installed.readOnly === true || installed.removable === false) throw new Error("Included runtime resources cannot be removed.");
          if (data.installDir && (!installed.installDir || canonical(data.installDir) !== canonical(installed.installDir))) {
            throw new Error("The runtime directory does not belong to the selected installed version.");
          }
          identity = identityFor(manager, installed);
          // Caller paths never determine the removal target.
          payload = { ...data, userDataDir, version: installed.version, sectionId: installed.sectionId,
            installDir: installed.installDir, platformKey: installed.platformKey, variant: installed.variant };
        }
        if (action === "uninstall") validateRemoval();
        if (action === "install" && version) {
          const installed = ready();
          if (installed) return installedResult(installed);
        }
        // Setup/import may discover their version only after inspection. Installed
        // actions may update shared libraries, so absent versions cover the manager.
        if (action === "setup" || (action === "import" && !version)) identity = { managerId: manager.id };
        try {
          return await withRuntimeMutation(identity, async () => {
            if (action === "install" && version) {
              const installed = ready();
              if (installed) return installedResult(installed);
            }
            if (action === "uninstall") validateRemoval();
            const result = await original.call(this, payload);
            return action === "install" ? installedResult(result) : result;
          }, { coordinator, userDataDir });
        } catch (error) {
          if (action === "install" && error.code === "RUNTIME_IN_USE" && version) {
            const installed = ready();
            if (installed) return installedResult(installed);
          }
          throw error;
        }
      };
    }
  }
}

function withRuntimeCoordinator(coordinator, userDataDir, fn) {
  const previous = operations.getStore();
  return operations.run({ ...previous, coordinator, userDataDir }, fn);
}
function withRuntimeUseScope(runtimeUseScope, fn) {
  return operations.run({ ...operations.getStore(), runtimeUseScope }, fn);
}

/** Leases identify the actual selected artifact, never a manager's default. */
function createRuntimeUseScope({ coordinator, managers, userDataDir, readSettings = () => ({}) }) {
  const leases = new Map();
  const selected = new Map();
  const selectedLeases = new Map();
  const explicitLeases = new Set();
  let released = false, bound = false;
  function fileIdentity(file) {
    try { const stat = fs.statSync(file); return [stat.dev, stat.ino, stat.size, stat.mtimeMs]; } catch { return null; }
  }
  async function useRuntime(identity, explicit = true) {
    if (released) throw coordinationError("RUNTIME_USE_CLOSED", "The game launch has already finished.");
    if (!identity?.version) throw new TypeError("Runtime use must name the actual selected version.");
    const manager = managers.find(manager => manager.id === identity.managerId);
    if (!manager) throw new Error("Runtime use must identify a registered manager.");
    const normalized = runtimeIdentity({ ...identity, ...(identity.sourcePath ? { sourcePath: canonical(identity.sourcePath) } : {}) });
    const key = JSON.stringify(normalized);
    if (explicit) explicitLeases.add(key);
    if (leases.has(key)) return leases.get(key);
    const before = normalized.sourcePath ? fileIdentity(normalized.sourcePath) : undefined;
    const held = operations.getStore()?.mutations || [];
    const pending = Promise.resolve(coordinator.acquireUse(normalized, held.map(mutation => mutation.token)));
    leases.set(key, pending);
    try {
      const token = await pending;
      if (released) { await coordinator.release(token); throw coordinationError("RUNTIME_USE_CLOSED", "The game launch has already finished."); }
      if (normalized.sourcePath && (!before || JSON.stringify(before) !== JSON.stringify(fileIdentity(normalized.sourcePath)))) {
        await coordinator.release(token); throw coordinationError("RUNTIME_CHANGED", "The selected runtime changed while launching. Try Play again.");
      }
      return token;
    } catch (error) { leases.delete(key); throw error; }
  }
  async function useProcessArtifacts(cmd, args = [], candidates = managers) {
    const paths = [cmd, ...args].filter(value => typeof value === "string" && path.isAbsolute(value)).map(canonical);
    if (!paths.length) return;
    const settings = readSettings();
    for (const manager of candidates) {
      for (const install of installedRows(manager, userDataDir, settings?.runtimes?.[manager.id])) {
        const roots = [install.installDir, install.appPath, install.runtimePath, install.executablePath, install.javaPath]
          .filter(value => typeof value === "string" && path.isAbsolute(value)).map(canonical);
        if (!roots.some(root => paths.some(file => containsPath(root, file)))) continue;
        const before = paths.map(file => { try { const stat = fs.statSync(file); return [file, stat.dev, stat.ino, stat.size, stat.mtimeMs]; } catch { return [file, null]; } });
        await useRuntime(identityFor(manager, install));
        const after = before.map(([file]) => { try { const stat = fs.statSync(file); return [file, stat.dev, stat.ino, stat.size, stat.mtimeMs]; } catch { return [file, null]; } });
        if (JSON.stringify(before) !== JSON.stringify(after)) throw coordinationError("RUNTIME_CHANGED", "The selected runtime changed while launching. Try Play again.");
      }
    }
  }
  return {
    useRuntime, useProcessArtifacts,
    recordSelection(identity) {
      // A module may reject one candidate and resolve a compatible replacement.
      // Keep its last actual selection, independently for each manager section.
      const key = JSON.stringify([identity.managerId, identity.sectionId || "default", identity.variant || null]);
      selected.set(key, identity);
    },
    async flushSelections() {
      for (const [key, identity] of selected) {
        const previous = selectedLeases.get(key);
        const encoded = JSON.stringify(identity);
        if (previous && previous.identity !== encoded && !explicitLeases.has(previous.leaseKey)) {
          await coordinator.release(await previous.token); leases.delete(previous.leaseKey);
        }
        const token = useRuntime(identity, false);
        selectedLeases.set(key, { identity: encoded, token, leaseKey: JSON.stringify(runtimeIdentity({ ...identity,
          ...(identity.sourcePath ? { sourcePath: canonical(identity.sourcePath) } : {}) })) });
        await token;
      }
    },
    async preparationLeaseTokens() { return bound ? [] : Promise.all([...leases.values()]); },
    async withMutablePreparation(identity, fn) {
      if (bound) return fn();
      const suspended = [...leases].filter(([key]) => conflicts(runtimeIdentity(JSON.parse(key)), runtimeIdentity(identity)));
      for (const [key, token] of suspended) { await coordinator.release(await token); leases.delete(key); }
      try { return await fn(); }
      finally {
        // A preparing writer gives up only its own unstarted read reservations.
        // Reclaim the selected shared sources before preparation continues.
        for (const [key] of suspended) await useRuntime(JSON.parse(key), explicitLeases.has(key));
      }
    },
    async bind(pid) { bound = true; await Promise.all([...leases.values()].map(async pending => coordinator.bindUse(await pending, pid))); },
    async release() {
      if (released) return;
      released = true;
      await Promise.all([...leases.values()].map(async pending => {
        try { await coordinator.release(await pending); } catch (error) { if (error.code !== "RUNTIME_USE_CLOSED") throw error; }
      }));
      leases.clear();
    }
  };
}

module.exports = { instrumentRuntimeManagers, withRuntimeCoordinator, withRuntimeUseScope, withRuntimeMutation, withRuntimeUse, createRuntimeUseScope, installedRows, identityFor };
