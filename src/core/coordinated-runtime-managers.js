const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { readJsonObject, writeJsonAtomic } = require("./json-files");
const { removeManagedRuntimeQuarantine } = require("../modules/shared/runtime/managed-quarantine");
const { coordinatorFor, coordinationError, conflicts, containsPath, runtimeIdentity } = require("./runtime-coordinator");
const { withoutClearedDefaults } = require("./settings-merge");
const Architecture = require("../modules/shared/runtime/architecture");
const { isAbortError, throwIfAborted } = require("../modules/shared/runtime/download-utils");
const { installedRuntimeAvailability, installedRuntimeReplaceable } = require("./runtime-install-availability.mjs");
const Maintenance = require("./storage-maintenance");

const operations = new AsyncLocalStorage();
const instrumented = new WeakSet();
const methods = { installRuntime: "install", importRuntime: "import", uninstallRuntime: "uninstall",
  registerCustomRuntime: "registerCustom", performInstalledAction: "installedAction", performSetupAction: "setup" };
// A removal in progress: the version's folder, set aside in runtimes/, and its record.
const REMOVING = ".maclauncher-removing-";
const REMOVING_RECORD = /^\.maclauncher-removing-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
function canonical(file) { try { return fs.realpathSync(file); } catch { return path.resolve(file); } }
function sourcePath(install) {
  return [install?.installDir, install?.appPath, install?.runtimePath, install?.executablePath, install?.javaPath]
    .find(value => typeof value === "string" && path.isAbsolute(value));
}
function installedRows(manager, userDataDir, settings, runtimeSettings) {
  if (typeof manager.getState !== "function") return [];
  const state = manager.getState({ userDataDir, settings, runtimeSettings });
  const sections = state.sections?.length ? state.sections : [{ ...state, id: "default" }];
  return sections.flatMap(section => (section.installed || []).map(install => ({ ...install, sectionId: section.id || "default" })));
}
function identityFor(manager, install) {
  return { managerId: manager.id, version: install.version, sectionId: install.sectionId || "default",
    ...(install.variant ? { variant: install.variant } : {}), ...(sourcePath(install) ? { sourcePath: canonical(sourcePath(install)) } : {}) };
}
function managerVersion(manager, version) {
  if (version == null) return undefined;
  if (require("../modules/shared/runtime/custom-runtime").isPath(version)) return version;
  const normalize = manager.normalizeVersion || manager.core?.normalizeVersion || manager.core?.normalizeVersionOrNull;
  return typeof normalize === "function" ? normalize(version) : String(version).trim().replace(/^v(?=\d)/i, "");
}
function recordSelectionUses(scope, manager, selection, install) {
  if (!scope) return;
  if (selection.runtimeUses !== undefined) {
    if (!Array.isArray(selection.runtimeUses) || selection.runtimeUses.length > 32)
      throw new TypeError("Runtime selections need a bounded list of runtime uses.");
    for (const identity of selection.runtimeUses) scope.recordSelection(runtimeIdentity(identity));
  } else scope.recordSelection(identityFor(manager, { ...install, version: selection.version }));
}
function selectInstalled(rows, data, manager) {
  const version = managerVersion(manager, data.version);
  const matches = rows.filter(row => managerVersion(manager, row.version) === version && (!data.sectionId || row.sectionId === data.sectionId) &&
    (!data.variant || row.variant === data.variant) && (!data.platformKey || row.platformKey === data.platformKey));
  if (matches.length === 1) return matches[0];
  return null;
}
// The build an installed row belongs to: its architecture variant, otherwise
// its own architecture.
function buildOf(row) {
  return Architecture.requestedArchitecture({ variant: row.variant }) || Architecture.targetArchitecture(row.architecture);
}
// A damaged or incomplete copy of the version and build being installed. A
// usable copy of that build leaves nothing to replace.
function damagedInstallation(rows, data, manager, build) {
  const version = managerVersion(manager, data.version);
  const copies = rows.filter(row => managerVersion(manager, row.version) === version && (!data.sectionId || row.sectionId === data.sectionId) &&
    (!build || !buildOf(row) || buildOf(row) === build) &&
    (!data.variant || row.variant === data.variant || Architecture.requestedArchitecture({ variant: data.variant })));
  if (copies.some(row => installedRuntimeAvailability(row) === "installed")) return null;
  return copies.find(installedRuntimeReplaceable) || null;
}
// Runs a step at the start of the download task that matches, so the step
// shares that task's progress row and cancellation.
function withTaskStep(downloads, matches, step) {
  return new Proxy(downloads, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key !== "runTask") return typeof value === "function" ? value.bind(target) : value;
    return (meta, runner) => target.runTask(meta, typeof runner !== "function" || !matches(meta) ? runner
      : async task => { await step(task); return runner(task); });
  } });
}
function readRuntimeSettings(userDataDir) { return withoutClearedDefaults(readJsonObject(path.join(userDataDir, "settings.json"))?.runtimes); }

async function withRuntimeMutation(identity, fn, { coordinator, userDataDir } = {}) {
  identity = runtimeIdentity(identity);
  const operation = operations.getStore();
  operation?.runtimeUseScope?.clearResolutions?.();
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
    try { return await fn(); }
    finally { operation?.runtimeUseScope?.clearResolutions?.(); }
  }
  const token = await coordinator.acquireMutation(identity, allowedUses);
  try {
    return await operations.run({ ...operation, coordinator, userDataDir, mutations: [...held, { identity, token }] }, fn);
  } finally { operation?.runtimeUseScope?.clearResolutions?.(); await coordinator.release(token); }
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
            recordSelectionUses(scope, manager, selection, selection.install);
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
      manager[method] = async function coordinatedMutation(data = {}, ...args) {
        const userDataDir = data.userDataDir || operations.getStore()?.userDataDir;
        // A manager may also be used as a standalone library without application storage.
        if (!userDataDir) return original.call(this, data, ...args);
        const operation = operations.getStore();
        const coordinator = operation?.coordinator || coordinatorFor(userDataDir).client();
        const stateContext = () => {
          const runtimeSettings = readRuntimeSettings(userDataDir) || data.settings?.runtimes;
          return { userDataDir, settings: runtimeSettings?.[manager.id], runtimeSettings };
        };
        const rows = () => {
          const context = stateContext();
          return installedRows(manager, userDataDir, context.settings, context.runtimeSettings);
        };
        const ready = () => {
          const installed = selectInstalled(rows(), data, manager);
          return installed && installed.ready !== false ? installed : null;
        };
        const installedResult = installed => {
          if (installed?.version && installed.ready !== false) recordSelectionUses(operation?.runtimeUseScope, manager, installed,
            { ...installed, sectionId: installed.sectionId || data.sectionId });
          return installed;
        };
        // A fresh action worker has not necessarily read its local catalog.
        // Load cached release/installation identities before normalizing an
        // exact version selected by another worker; this inspection is offline.
        if (data.version != null) await manager.getState?.(stateContext());
        const version = managerVersion(manager, data.version);
        let identity = { managerId: manager.id, ...(version ? { version } : {}) };
        let payload = { ...data, userDataDir }, removal = null;
        function validateRemoval() {
          if (!version) throw new Error("Select an installed runtime version to remove.");
          const installed = selectInstalled(rows(), data, manager);
          if (!installed) throw new Error("The selected installed runtime was not found or is ambiguous.");
          if (installed.readOnly === true || installed.removable === false) throw new Error("Included runtime resources cannot be removed.");
          if (data.installDir && (!installed.installDir || canonical(data.installDir) !== canonical(installed.installDir))) {
            throw new Error("The runtime directory does not belong to the selected installed version.");
          }
          identity = identityFor(manager, installed);
          removal = installed;
          // Caller paths never determine the removal target.
          payload = { ...data, userDataDir, version: installed.version, sectionId: installed.sectionId,
            installDir: installed.installDir, platformKey: installed.platformKey, variant: installed.variant };
        }
        // Installing a version again replaces a damaged or incomplete copy of the
        // same build, whether Play, Reinstall in Runtimes or Repair in the
        // inspector asked for it. The copy is removed inside this lease, after
        // consent, as the first step of the installation's own download task.
        // Removal comes before the download because managers install into the
        // version's own directory and either refuse an occupied one or return
        // their existing record without downloading, so no replacement can be
        // verified beside the copy. A row's installDir is not always the whole
        // version directory either, so the copy cannot be set aside generically.
        // Usable, unavailable and included copies stay.
        async function installOverDamaged(self, args) {
          if (typeof manager.uninstallRuntime !== "function" || !rows().some(installedRuntimeReplaceable)) return original.call(self, payload, ...args);
          let build = Architecture.requestedArchitecture(data);
          // Without a build choice, the manager installs the build it chooses.
          if (!build && typeof manager.chooseArchitecture === "function") {
            try { build = Architecture.targetArchitecture(manager.chooseArchitecture(null, data.settings, userDataDir)); } catch { build = null; }
          }
          const damaged = () => damagedInstallation(rows(), data, manager, build);
          let pending = Boolean(damaged());
          const remove = async task => {
            if (!pending) return;
            pending = false;
            throwIfAborted(task?.signal);
            const copy = damaged();
            if (!copy) return;
            task?.onProgress?.({ detail: "Removing damaged installation…" });
            await manager.uninstallRuntime({ userDataDir, settings: data.settings, logger: data.logger, version: copy.version,
              sectionId: copy.sectionId, variant: copy.variant, platformKey: copy.platformKey, installDir: copy.installDir,
              ...(buildOf(copy) ? { architecture: buildOf(copy) } : {}) });
          };
          if (!pending) return original.call(self, payload, ...args);
          const tasks = typeof payload.downloads?.runTask === "function";
          if (!tasks) await remove();
          const ownTask = meta => {
            try { return meta?.managerId === manager.id && (!meta.version || managerVersion(manager, meta.version) === version); }
            catch { return false; }
          };
          try {
            const result = await original.call(self, tasks ? { ...payload, downloads: withTaskStep(payload.downloads, ownTask, remove) } : payload, ...args);
            if (!pending || !damaged()) return result;
          } catch (error) {
            if (!pending || isAbortError(error) || !damaged()) throw error;
          }
          // The manager opened no download task of its own and kept the damaged copy.
          await remove();
          return original.call(self, payload, ...args);
        }
        // For a manager that declares `trashFirst` (its removal tolerates a
        // missing folder), a removal first sets the version's folder aside in
        // runtimes/ under an in-progress name, with a record beside it, so an
        // interrupted removal never leaves a partly deleted version and upkeep
        // never takes a folder whose removal is still running. The manager then removes its own
        // records; only then does the folder take a trash name and get deleted.
        // Upkeep finishes trash that a removal left, and settles an interrupted
        // removal on the next pass (settleInterruptedRemovals). If the manager
        // refuses or declines (false), the folder is restored and the manager
        // decides as before. Other managers, external, custom and imported rows,
        // whose files the manager does not own, and folders outside runtimes/ or
        // on another volume are left to the manager.
        async function uninstallThroughTrash(self, args) {
          const runtimes = path.join(userDataDir, "runtimes"), folder = payload.installDir;
          let aside = null;
          const record = () => `${aside}.json`;
          const forget = () => { try { fs.rmSync(record(), { force: true }); } catch {} };
          try {
            const real = canonical(folder), root = canonical(runtimes), relative = path.relative(root, real);
            if (manager.trashFirst === true && !["external", "custom", "imported"].some(key => removal?.[key] === true) &&
              path.isAbsolute(folder || "") && relative && !relative.startsWith("..") && !path.isAbsolute(relative) && relative.split(path.sep).length >= 2 &&
              !fs.lstatSync(folder).isSymbolicLink() && fs.lstatSync(folder).isDirectory()) {
              aside = path.join(runtimes, REMOVING + crypto.randomUUID());
              writeJsonAtomic(record(), { schemaVersion: 1, pid: process.pid, managerId: manager.id, version: payload.version,
                sectionId: payload.sectionId || "default", installDir: folder });
              Maintenance.moveToTrash(folder, { trashFolder: runtimes, name: path.basename(aside) });
            }
          } catch { if (aside && !fs.existsSync(aside)) { forget(); aside = null; } }
          if (!aside) return original.call(self, payload, ...args);
          let result;
          try { result = await original.call(self, payload, ...args); } catch { result = false; }
          if (result === false) {
            try { if (!fs.existsSync(folder)) fs.renameSync(aside, folder); forget(); } catch {}
            return original.call(self, payload, ...args);
          }
          let trash = null;
          try { trash = Maintenance.moveToTrash(aside); forget(); } catch {}
          if (trash) try { await Maintenance.removeTrash(trash); } catch {}
          return result;
        }
        if (action === "uninstall") validateRemoval();
        if (action === "install" && version) {
          const installed = ready();
          if (installed) return installedResult(installed);
        }
        // Content-addressed importers can coordinate publication after inspection
        // determines the exact version. All other imports keep the broad lock.
        if (action === "import" && typeof manager.coordinateImportRuntime === "function") {
          return operations.run({ ...operation, coordinator, userDataDir }, () => manager.coordinateImportRuntime.call(this, payload, ...args));
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
            const result = action === "install" && version ? await installOverDamaged(this, args)
              : action === "uninstall" ? await uninstallThroughTrash(this, args) : await original.call(this, payload, ...args);
            if (action === "install") await removeManagedRuntimeQuarantine(result, { userDataDir, signal: payload.signal });
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

/** Settles removals that an exit interrupted, from their records in
 * runtimes/: a folder whose version its manager still lists returns to its
 * place, and any other takes a trash name for upkeep to finish. Removals whose
 * process still runs, and unreadable records, are left alone. Never throws. */
function settleInterruptedRemovals({ userDataDir, managers = [] } = {}) {
  const runtimes = path.join(userDataDir || "", "runtimes");
  let names;
  try { names = fs.readdirSync(runtimes).filter(name => REMOVING_RECORD.test(name)); } catch { return; }
  for (const name of names) {
    try {
      const record = path.join(runtimes, name), aside = record.slice(0, -".json".length), row = Maintenance.readJson(record, 64 * 1024);
      if (!row || Maintenance.processAlive(row.pid)) continue;
      if (fs.existsSync(aside)) {
        const manager = managers.find(item => item?.id === row.managerId), target = typeof row.installDir === "string" ? path.resolve(row.installDir) : null;
        const relative = target && path.relative(runtimes, target);
        const settings = manager && readRuntimeSettings(userDataDir);
        const listed = Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative) &&
          installedRows(manager, userDataDir, settings?.[manager.id], settings).some(install => String(install.version) === String(row.version) &&
            (install.sectionId || "default") === (row.sectionId || "default") && install.installDir && path.resolve(install.installDir) === target));
        if (listed && !fs.existsSync(target)) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.renameSync(aside, target);
        } else Maintenance.moveToTrash(aside);
      }
      fs.rmSync(record, { force: true });
    } catch {}
  }
}

function withRuntimeCoordinator(coordinator, userDataDir, fn) {
  const previous = operations.getStore();
  return operations.run({ ...previous, coordinator, userDataDir }, fn);
}
function withRuntimeUseScope(runtimeUseScope, fn) {
  return operations.run({ ...operations.getStore(), runtimeUseScope }, fn);
}

// Reuse only within this launch's preparation; ordinary callers still resolve.
function memoizeRuntimeResolution(owner, key, resolve) {
  const scope = operations.getStore()?.runtimeUseScope;
  return scope?.memoizeResolution ? scope.memoizeResolution(owner, key, resolve) : resolve();
}

/** Leases identify the actual selected artifact, never a manager's default. */
function createRuntimeUseScope({ coordinator, managers, userDataDir, readSettings = () => ({}) }) {
  const leases = new Map();
  const selected = new Map();
  const selectedLeases = new Map();
  const explicitLeases = new Set();
  let released = false, bound = false, mutablePreparations = 0;
  const resolutions = [];
  let resolutionCapture = null;
  const clearResolutions = () => { resolutions.length = 0; };
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
      for (const install of installedRows(manager, userDataDir, settings?.runtimes?.[manager.id], settings?.runtimes)) {
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
    useRuntime, useProcessArtifacts, clearResolutions,
    memoizeResolution(owner, key, resolve) {
      if (released || bound || mutablePreparations || operations.getStore()?.mutations?.length) return resolve();
      const previous = resolutions.find(row => row.owner === owner && row.key === key);
      if (previous) { for (const identity of previous.effects) this.recordSelection(identity); return previous.value; }
      const parent = resolutionCapture, capture = { effects: new Map(), overflow: false };
      let value; resolutionCapture = capture;
      try { value = resolve(); }
      finally {
        resolutionCapture = parent;
        if (parent) { for (const identity of capture.effects.values()) this.recordSelection(identity); parent.overflow ||= capture.overflow; }
      }
      if (!capture.overflow && value && value.ready !== false && typeof value.then !== "function") {
        if (resolutions.length >= 64) resolutions.shift();
        resolutions.push({ owner, key, value, effects: [...capture.effects.values()] });
      }
      return value;
    },
    recordSelection(identity) {
      // A module may reject one candidate and resolve a compatible replacement.
      // Keep its last actual selection, independently for each manager section.
      const key = JSON.stringify([identity.managerId, identity.sectionId || "default", identity.variant || null]);
      selected.set(key, identity);
      if (resolutionCapture) {
        if (resolutionCapture.effects.size < 64 || resolutionCapture.effects.has(key)) resolutionCapture.effects.set(key, identity);
        else resolutionCapture.overflow = true;
      }
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
      clearResolutions();
      const mutate = async () => {
        mutablePreparations++; clearResolutions();
        try { return await fn(); }
        finally { mutablePreparations--; clearResolutions(); }
      };
      if (bound) return mutate();
      const suspended = [...leases].filter(([key]) => conflicts(runtimeIdentity(JSON.parse(key)), runtimeIdentity(identity)));
      for (const [key, token] of suspended) { await coordinator.release(await token); leases.delete(key); }
      try { return await mutate(); }
      finally {
        // A preparing writer gives up only its own unstarted read reservations.
        // Reclaim the selected shared sources before preparation continues.
        for (const [key] of suspended) await useRuntime(JSON.parse(key), explicitLeases.has(key));
      }
    },
    async bind(pid) { bound = true; clearResolutions(); await Promise.all([...leases.values()].map(async pending => coordinator.bindUse(await pending, pid))); },
    async release() {
      if (released) return;
      released = true; clearResolutions();
      await Promise.all([...leases.values()].map(async pending => {
        try { await coordinator.release(await pending); } catch (error) { if (error.code !== "RUNTIME_USE_CLOSED") throw error; }
      }));
      leases.clear();
    }
  };
}

module.exports = { memoizeRuntimeResolution, instrumentRuntimeManagers, settleInterruptedRemovals, withRuntimeCoordinator, withRuntimeUseScope, withRuntimeMutation, withRuntimeUse, createRuntimeUseScope, installedRows, identityFor };
