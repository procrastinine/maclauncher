const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { managerDefaultVersion } = require("./version-choices");

const managers = new Map(), instrumented = new WeakSet(), registrations = new WeakMap();
const providerBindings = new WeakMap();
const descriptorOwners = new WeakMap(), providerMethods = new WeakMap(), managerMethods = new WeakMap();
const executableCache = new Map();
const MAX_REGISTRATIONS = 256;
function isPath(value) { return typeof value === "string" && value.length <= 4096 && path.isAbsolute(value) && !/[\0\r\n]/.test(value); }
function storageKey(version, { prefix = "custom-", length = 24 } = {}) {
  if (!isPath(version)) return version;
  if (!Number.isInteger(length) || length < 1 || length > 64 || typeof prefix !== "string" || /[\0/\\]/.test(prefix))
    throw new Error("Runtime storage key options are invalid.");
  return prefix + crypto.createHash("sha256").update(version).digest("hex").slice(0, length);
}
function fileFor(userDataDir, managerId) {
  if (!userDataDir || !/^[a-z0-9][a-z0-9._-]*$/i.test(managerId || "")) throw new Error("Runtime registration storage is unavailable.");
  return path.join(userDataDir, "runtimes", managerId, "custom-runtimes.json");
}
function records(userDataDir, managerId) {
  if (!userDataDir) return [];
  try {
    const file = fileFor(userDataDir, managerId);
    if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error("Runtime registrations exceed their size limit.");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(value.runtimes) ? value.runtimes.slice(0, MAX_REGISTRATIONS).filter(row => isPath(row.path) &&
      typeof row.sectionId === "string" && row.sectionId.length <= 128) : [];
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
function write(userDataDir, managerId, runtimes) {
  const file = fileFor(userDataDir, managerId), temporary = file + "." + crypto.randomUUID() + ".tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, runtimes }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function configure(manager, descriptor = {}) {
  const inherited = manager.customRuntime || {}, owner = descriptorOwners.get(inherited);
  // A composed manager inherits the provider contract, while its inspector and
  // provider wrappers belong to that manager. Shared base objects keep their
  // original behavior, including when more than one derived manager exists.
  if (owner && owner !== manager) {
    if (manager.core && manager.core === owner.core)
      manager.core = Object.create(Object.getPrototypeOf(manager.core), Object.getOwnPropertyDescriptors(manager.core));
    for (const key of Object.keys(manager)) {
      const method = managerMethods.get(manager[key]);
      if (method && method.manager !== manager) {
        if (method.original) manager[key] = method.original;
        else delete manager[key];
      }
    }
  }
  const providers = [...new Set([...(inherited.providers || []), ...(descriptor.providers || [])])]
    .map(provider => owner && owner !== manager && provider.core === owner.core ? { ...provider, core: manager.core } : provider);
  manager.customRuntime = { ...inherited, ...descriptor, ...(providers.length ? { providers } : {}) };
  descriptorOwners.set(manager.customRuntime, manager);
  managers.set(manager.id, manager);
  const registration = forManager(manager);
  for (const provider of providers) registration.bindProvider(provider.core, provider);
  if (owner && owner !== manager && instrumented.has(owner)) instrumentManagers([manager]);
  return manager;
}
function defaults(settings) {
  const source = settings?.customDefaults;
  return source && typeof source === "object" && !Array.isArray(source)
    ? Object.fromEntries(Object.entries(source).filter(([section, value]) => section.length <= 128 && isPath(value))) : {};
}
function defaultVersion(settings, managerId, sectionId = "default") {
  const configured = settings?.runtimes?.[managerId];
  return defaults(configured)[sectionId] || configured?.defaultVersion || null;
}
function withoutDefault(manager, settings, sectionId, version) {
  const next = { ...settings, customDefaults: { ...defaults(settings) } };
  delete next.customDefaults[sectionId];
  const parts = manager.customRuntime?.defaultsPath?.(sectionId);
  if (Array.isArray(parts) && parts.length) {
    let target = next;
    for (const part of parts.slice(0, -1)) target = target[part] = { ...target[part] };
    if (isPath(target[parts.at(-1)]) && (!version || target[parts.at(-1)] === version)) target[parts.at(-1)] = null;
  }
  return next;
}
function metadata(row, install = {}) {
  return { ...install, version: row.path, runtimePath: install.runtimePath || install.executablePath || row.path, sectionId: row.sectionId,
    source: "custom", custom: true, external: true, imported: true, readOnly: false, removable: true,
    registeredAt: row.registeredAt, versionLabel: install.versionLabel || path.basename(row.path),
    removalLabel: "Remove registration", removalConfirm: "Remove this runtime from the list? The selected files remain in their original location." };
}
function inspect(manager, row, userDataDir, verification = "status") {
  const inspector = manager.customRuntime?.inspect || inspectNative;
  const install = inspector(row.path, { managerId: manager.id, sectionId: row.sectionId, userDataDir, verification, data: row.data });
  if (!install || install.then) throw new Error("Custom runtime inspection must return a local runtime synchronously.");
  return metadata(row, { ...install, ready: install.ready !== false, status: install.ready === false ? "unavailable" : "ready" });
}
function listFor(manager, { sectionId, userDataDir } = {}) {
  if (!manager) return [];
  return records(userDataDir, manager.id).filter(row => !sectionId || row.sectionId === sectionId).map(row => {
    try { return inspect(manager, row, userDataDir); }
    catch (error) { return metadata(row, { installDir: row.path, ready: false, status: "unavailable", reason: error.message, error: error.message }); }
  });
}
function list({ managerId, ...options } = {}) { return listFor(managers.get(managerId), options); }
function resolveFor(manager, { sectionId, userDataDir, version, allowInstallable = false } = {}) {
  if (!isPath(version)) return null;
  if (!manager) return null;
  const row = records(userDataDir, manager.id).find(row => row.path === version && (!sectionId || row.sectionId === sectionId));
  if (!row) return null;
  try { const install = inspect(manager, row, userDataDir, "full"); return install.ready || allowInstallable && install.installable ? install : null; } catch { return null; }
}
function resolve({ managerId, ...options } = {}) { return resolveFor(managers.get(managerId), options); }
function inspectNative(runtimePath, { allowLibrary = false, candidates = [], preferredExecutable } = {}) {
  const Native = require("./local-native"), App = require("./app-bundle");
  if (!isPath(runtimePath)) throw new Error("Select an absolute runtime path.");
  let executablePath = runtimePath;
  const stat = fs.statSync(runtimePath);
  if (stat.isDirectory()) {
    executablePath = runtimePath.toLowerCase().endsWith(".app") ? App.resolveAppBundleExecutablePath(runtimePath, preferredExecutable)
      : candidates.map(relative => path.resolve(runtimePath, relative)).find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
    if (!executablePath) throw new Error("The selected application has no executable.");
  }
  const stamp = file => { const value = fs.statSync(file); return [fs.realpathSync(file), value.dev, value.ino, value.size, value.mode, value.mtimeMs, value.ctimeMs]; };
  const key = JSON.stringify([runtimePath, allowLibrary]), identity = JSON.stringify([stamp(executablePath),
    stat.isDirectory() && runtimePath.toLowerCase().endsWith(".app") ? stamp(path.join(runtimePath, "Contents", "Info.plist")) : null]);
  const cached = executableCache.get(key);
  const native = cached?.identity === identity ? { ...cached.value, architectures: [...cached.value.architectures] }
    : Native.resolveLocalRuntime({ runtimePath: executablePath, runtimeVersion: "custom", upstreamRevision: "custom", allowLibrary });
  if (cached?.identity !== identity) {
    if (executableCache.size >= 128) executableCache.delete(executableCache.keys().next().value);
    executableCache.set(key, { identity, value: native });
  }
  const root = stat.isDirectory() ? runtimePath : path.dirname(runtimePath);
  return { ...native, binarySha256: native.sha256, appPath: runtimePath, installDir: root, root, payloadRoot: root,
    architecture: native.architectures.includes(process.arch === "x64" ? "x86_64" : process.arch) ? process.arch : "x64",
    requiresRosetta: native.needsRosetta };
}
function inspectManifest(runtimePath, { managerId, allowLibrary = false, verification = "full" } = {}) {
  const Bundled = require("./bundled-native");
  let directory = fs.statSync(runtimePath).isDirectory() ? runtimePath : path.dirname(runtimePath);
  for (let depth = 0; depth < 7; depth += 1) {
    for (const relative of ["manifest.json", "bundle-manifest.json", "project-payload/manifest.json"]) {
      const manifestPath = path.join(directory, relative);
      if (!fs.existsSync(manifestPath)) continue;
      let stored, manifest;
      try { stored = Bundled.readRegular(manifestPath, Bundled.LIMITS.manifestBytes); manifest = JSON.parse(stored.bytes); }
      catch { continue; }
      if (manifest.managerId !== managerId || !Array.isArray(manifest.files)) continue;
      Bundled.validateManifest(manifest, { managerId });
      if (!Bundled.versionAtLeast(Bundled.systemVersionSync(), manifest.minimumMacOS)) throw new Error(`This runtime requires macOS ${manifest.minimumMacOS} or later.`);
      const parent = path.dirname(manifestPath), payloadRoot = fs.existsSync(path.join(parent, "files", manifest.executableRelative)) ? path.join(parent, "files") : parent;
      if (verification === "full") Bundled.verifyPayload(payloadRoot, manifest);
      const install = inspectNative(path.join(payloadRoot, manifest.executableRelative), { allowLibrary });
      return { ...install, installDir: payloadRoot, root: payloadRoot, payloadRoot, manifest,
        manifestSha256: stored.sha256, runtimeVersion: manifest.version, upstreamRevision: manifest.upstreamRevision,
        environmentRelative: manifest.environmentRelative, runtimeFiles: manifest.runtimeFiles,
        minimumMacOS: manifest.minimumMacOS };
    }
    if (path.dirname(directory) === directory) break;
    directory = path.dirname(directory);
  }
  return null;
}
async function register(manager, { runtimePath, sectionId = "default", userDataDir, settings } = {}) {
  if (!isPath(runtimePath)) throw new Error("Select a runtime executable, application or directory.");
  const state = manager.getState?.({ userDataDir, settings });
  const sections = state?.sections?.length ? state.sections : [{ ...state, id: "default" }];
  if (!sections.some(section => section.id === sectionId)) throw new Error("The selected runtime list is unavailable.");
  const row = { path: runtimePath, sectionId, registeredAt: new Date().toISOString() };
  if (manager.customRuntime?.prepare) {
    const data = await manager.customRuntime.prepare(runtimePath, { sectionId, userDataDir });
    const serialized = JSON.stringify(data);
    if (!serialized || Buffer.byteLength(serialized) > 65536) throw new Error("The custom runtime metadata exceeds its size limit.");
    row.data = JSON.parse(serialized);
  }
  const installed = inspect(manager, row, userDataDir, "full");
  if (!installed.ready && !(installed.installable && manager.customRuntime?.prepareInstall))
    throw new Error(installed.reason || "The selected runtime is unavailable.");
  const current = records(userDataDir, manager.id).filter(item => item.path !== runtimePath || item.sectionId !== sectionId);
  if (current.length >= MAX_REGISTRATIONS) throw new Error("The custom runtime list is full.");
  write(userDataDir, manager.id, [...current, row]);
  return installed;
}
function remove(manager, { version, sectionId = "default", userDataDir } = {}) {
  const current = records(userDataDir, manager.id), next = current.filter(row => row.path !== version || row.sectionId !== sectionId);
  if (next.length === current.length) throw new Error("The runtime registration was not found.");
  write(userDataDir, manager.id, next);
  return true;
}
function selectionPath(manager, entry, settings, options = {}) {
  const explicit = [options.version, entry?.runtimeData?.[entry?.runtimeId || manager.id]?.version,
    entry?.runtimeData?.[manager.id]?.version].find(value => typeof value === "string" && value.trim() && value.trim() !== "auto");
  if (explicit && explicit !== "auto") return isPath(explicit) ? explicit : null;
  // A game's own recommendation precedes a custom default runtime.
  const recommendation = options.recommendedVersion ?? options.recommended;
  const recommended = typeof recommendation === "function" ? recommendation() : recommendation;
  if (typeof recommended === "string" && recommended.trim() && recommended !== "auto") return isPath(recommended) ? recommended : null;
  const section = options.sectionId || manager.customRuntime?.sectionForEntry?.(entry, settings) || "default";
  const saved = defaults(settings?.runtimes?.[manager.id])[section];
  if (saved) return saved;
  if (!options.userDataDir) return null;
  const state = manager.getState?.({ userDataDir: options.userDataDir, settings: settings?.runtimes?.[manager.id] });
  const effective = state?.sections?.find(row => row.id === section) || state;
  return isPath(effective?.defaultVersion) ? effective.defaultVersion : null;
}
function selection(manager, entry, settings, userDataDir, options = {}) {
  const version = selectionPath(manager, entry, settings, { ...options, userDataDir });
  if (!version) return null;
  const registered = records(userDataDir, manager.id).find(row => row.path === version);
  const sectionId = options.sectionId || manager.customRuntime?.sectionForEntry?.(entry, settings) || registered?.sectionId || "default";
  const install = resolveFor(manager, { sectionId, userDataDir, version, allowInstallable: Boolean(manager.customRuntime?.prepareInstall) });
  let extra = {};
  try { if (install) extra = manager.customRuntime?.selection?.(install, { entry, settings, userDataDir, options }) || {}; }
  catch (error) { return { version, sectionId, install: null, ready: false, reason: error.message }; }
  return { version, sectionId, install, ready: Boolean(install), reason: install ? null : "The selected custom runtime is unavailable. Check its path in Runtimes.", ...extra };
}
function createSelector(manager, original, descriptor = {}) {
  return function registeredRuntimeSelector(...args) {
    const async = original?.constructor?.name === "AsyncFunction";
    try {
      const context = descriptor.context ? descriptor.context(args) : { entry: args[0], settings: args[1], userDataDir: args[2], options: args[3] };
      const sectionId = typeof descriptor.sectionId === "function" ? descriptor.sectionId(context) : descriptor.sectionId;
      const selected = selection(manager, context.entry, context.settings, context.userDataDir, { ...context.options, ...(sectionId ? { sectionId } : {}) });
      if (selected && !selected.ready && descriptor.required) throw new Error(selected.reason);
      const result = selected ? descriptor.result ? descriptor.result(selected, context, args) : selected : original?.apply(this, args) ?? null;
      return async ? Promise.resolve(result) : result;
    } catch (error) { if (async) return Promise.reject(error); throw error; }
  };
}

/** Registration is shared by runtime managers and their installed providers.
 * Providers declare their existing list, resolver and compatibility sections;
 * their ordinary version/catalog behavior remains the underlying implementation. */
class RuntimeRegistration {
  constructor(manager) { this.manager = manager; }
  list(userDataDir, sectionId) { return listFor(this.manager, { userDataDir }).filter(row =>
    !sectionId || sectionId === "*" || (Array.isArray(sectionId) ? sectionId : [sectionId]).includes(row.sectionId)); }
  resolve(userDataDir, version, sectionId) { return resolveFor(this.manager, { userDataDir, version,
    ...(!Array.isArray(sectionId) && sectionId && sectionId !== "*" ? { sectionId } : {}) }); }
  select(...args) { return selection(this.manager, ...args); }
  register(options) { return register(this.manager, options); }
  remove(options) { return remove(this.manager, options); }
  bindProvider(core, descriptor = {}) {
    if (!core || typeof core !== "object") throw new TypeError("A runtime registration provider must be an object.");
    let bound = providerBindings.get(core); if (!bound) providerBindings.set(core, bound = new Map());
    const methods = (value, fallback = []) => Array.isArray(value) ? Object.fromEntries(value.map(method => [method, {}]))
      : value || Object.fromEntries(fallback.filter(method => typeof core[method] === "function").map(method => [method, {}]));
    const groups = {
      list: methods(descriptor.lists), resolve: methods(descriptor.resolves),
      version: methods(descriptor.versions), directory: methods(descriptor.directories), comparator: methods(descriptor.comparators)
    };
    for (const [kind, entries] of Object.entries(groups)) for (const [method, declaration] of Object.entries(entries)) {
      if (typeof core[method] !== "function") continue;
      const key = this.manager.id + ":" + method;
      const detail = typeof declaration === "number" ? { direction: declaration }
        : typeof declaration === "string" || Array.isArray(declaration) || typeof declaration === "function" ? { section: declaration } : declaration || {};
      if (bound.has(key)) { Object.assign(bound.get(key), { detail, descriptor, registration: this }); continue; }
      const binding = { original: providerMethods.get(core[method])?.original || core[method], detail, descriptor, registration: this }; bound.set(key, binding);
      core[method] = function registeredRuntimeProvider(...args) {
        const registration = binding.registration;
        if (kind === "comparator") {
          const [left, right] = args, a = isPath(left), b = isPath(right), direction = binding.detail.direction || 1;
          return !a && !b ? binding.original.apply(this, args) : a && b ? String(left).localeCompare(String(right)) * direction : a ? direction : -direction;
        }
        const query = args[0] && typeof args[0] === "object" ? args[0] : {};
        const options = { method, args, query };
        const setting = key => binding.detail[key] ?? binding.descriptor[key];
        const evaluate = value => typeof value === "function" ? value(options) : value;
        const sectionId = evaluate(setting("section")) || "default";
        const userDataDir = evaluate(setting("userDataDir")) || query.userDataDir || (typeof args[0] === "string" ? args[0] : undefined);
        const version = setting("version") ? evaluate(setting("version")) : query.version ?? (kind === "directory" ? args.at(-1) : undefined);
        if (kind === "version") return isPath(args[0]) ? args[0] : binding.original.apply(this, args);
        if (kind === "directory" && isPath(version)) throw new Error("Custom runtimes remain in their original location.");
        if (kind === "resolve" && isPath(version)) {
          const get = () => {
            const installed = registration.resolve(userDataDir, version, sectionId), compatible = setting("compatible");
            const selected = installed && (sectionId === "*" || (Array.isArray(sectionId) ? sectionId.includes(installed.sectionId) : installed.sectionId === sectionId)) &&
              (!compatible || compatible(installed, options)) ? installed : null;
            const missing = setting("missing");
            if (!selected && missing) throw new Error(typeof missing === "function" ? missing(options) : missing);
            return binding.detail.result ? binding.detail.result(selected, options) : selected;
          };
          return binding.original.constructor.name === "AsyncFunction" ? Promise.resolve().then(get) : get();
        }
        const original = binding.original.apply(this, args);
        if (kind !== "list" && kind !== "resolve") return original;
        const combine = result => {
          let custom = registration.list(userDataDir, sectionId);
          if (binding.detail.filter) custom = custom.filter(row => binding.detail.filter(row, options));
          const compatible = setting("compatible");
          if (compatible) custom = custom.filter(row => compatible(row, options));
          if (kind === "list") {
            const current = result || [], ids = new Set(current.map(row => JSON.stringify([row.version, row.variant || null])));
            return [...current, ...custom.filter(row => !ids.has(JSON.stringify([row.version, row.variant || null])))];
          }
          if (result || version) return result;
          const selected = custom.find(row => row.ready !== false && ["variant", "line", "channel"].every(key => !query[key] || !row[key] || row[key] === query[key])) || null;
          return binding.detail.result ? binding.detail.result(selected, options) : selected;
        };
        return original?.then ? original.then(combine) : combine(original);
      };
      providerMethods.set(core[method], binding);
    }
    return core;
  }
}
function forManager(manager) {
  let registration = registrations.get(manager);
  if (!registration) registrations.set(manager, registration = new RuntimeRegistration(manager));
  return registration;
}
function bindProvider(manager, core, descriptor) { return forManager(manager).bindProvider(core, descriptor); }
function instrumentManagers(values) {
  for (const manager of values) {
    if (!manager?.id) continue;
    const owner = descriptorOwners.get(manager.customRuntime);
    if (owner && owner !== manager) configure(manager);
    managers.set(manager.id, manager);
    if (instrumented.has(manager)) continue;
    instrumented.add(manager);
    const methodNames = ["normalizeSettings", "getState", "applySettingsUpdate", "resolveSelection", "uninstallRuntime", "installRuntime", "updateSettingsAfterUninstall", "registerCustomRuntime"];
    const originalMethods = new Map(methodNames.map(key => [key, manager[key]]));
    const normalize = manager.normalizeSettings;
    manager.normalizeSettings = value => {
      const configured = defaults(value), normalized = { ...(normalize ? normalize(value) : value || {}),
        ...(Object.keys(configured).length || Object.hasOwn(value || {}, "customDefaults") ? { customDefaults: configured } : {}) };
      for (const [sectionId, version] of Object.entries(configured)) {
        const parts = manager.customRuntime?.defaultsPath?.(sectionId);
        if (!Array.isArray(parts) || !parts.length || parts.some(part => typeof part !== "string" || ["__proto__", "prototype", "constructor"].includes(part))) continue;
        let target = normalized;
        for (const part of parts.slice(0, -1)) target = target[part] = { ...target[part] };
        target[parts.at(-1)] = version;
      }
      return normalized;
    };
    const getState = manager.getState;
    if (getState) manager.getState = function(options = {}) {
      const state = getState.call(this, options), selectedDefaults = defaults(options.settings);
      const sections = state.sections?.length ? state.sections : [{ ...state, id: "default" }];
      const updated = sections.map(section => {
        const local = listFor(manager, { sectionId: section.id, userDataDir: options.userDataDir });
        const labels = Object.fromEntries(local.map(row => [row.version, row.versionLabel]));
        const customVersions = new Set(local.map(row => row.version));
        const listed = (section.catalog?.installableVersions || section.catalog?.versions || []).filter(version => !section.catalog?.versionRequirements?.[version]?.installReason);
        const ready = [...(section.installed || []).filter(row => row.ready !== false), ...local.filter(row => row.ready).sort((a, b) => String(b.registeredAt).localeCompare(String(a.registeredAt)))];
        return { ...section, customRuntime: true, installed: [...(section.installed || []).filter(row => !customVersions.has(row.version)), ...local],
          defaultVersion: selectedDefaults[section.id] || section.defaultVersion || managerDefaultVersion({ listed, installed: ready.map(row => row.version) }),
          defaultSource: selectedDefaults[section.id] ? "saved" : section.defaultSource || "manager",
          versionLabels: { ...section.versionLabels, ...labels },
          catalog: { ...section.catalog, versionLabels: { ...section.catalog?.versionLabels, ...labels },
            versionRequirements: { ...section.catalog?.versionRequirements, ...Object.fromEntries(local.map(row => [row.version,
              { available: row.ready, requiresDownload: row.requiresDownload === true, requiresBuild: false,
                installLabel: row.installable && !row.ready ? "Install" : "Registered", installReason: row.reason || null }])) } } };
      });
      const top = { ...state, sections: updated };
      if (updated.length === 1) for (const key of ["installed", "catalog", "versionLabels", "defaultVersion", "defaultSource"])
        if (Object.hasOwn(state, key) || key === "defaultVersion" || key === "defaultSource") top[key] = updated[0][key];
      return top;
    };
    const apply = manager.applySettingsUpdate;
    manager.applySettingsUpdate = function(action, payload, settings,...context) {
      if (action !== "setDefault") return apply?.call(this, action, payload, settings,...context) ?? settings;
      // An operation-scoped preference belongs to the manager's declared
      // selection, including registered paths. It is not the section default.
      if (payload?.selectionId !== undefined) return apply?.call(this, action, payload, settings,...context) ?? settings;
      const sectionId = payload.sectionId || "default", current = defaults(settings);
      if (isPath(payload.version)) return { ...manager.normalizeSettings(settings), customDefaults: { ...current, [sectionId]: payload.version } };
      if (!Object.hasOwn(settings || {}, "customDefaults")) return apply?.call(this, action, payload, settings,...context);
      delete current[sectionId];
      const base = Object.hasOwn(settings || {}, "customDefaults") ? withoutDefault(manager, settings, sectionId) : settings;
      const next = apply?.call(this, action, payload, base,...context) ?? base;
      return { ...next, ...(Object.hasOwn(settings || {}, "customDefaults") ? { customDefaults: current } : {}) };
    };
    const select = manager.resolveSelection;
    manager.resolveSelection = createSelector(manager, select);
    const uninstall = manager.uninstallRuntime;
    manager.uninstallRuntime = function(options) { return isPath(options.version) ? remove(manager, options) : uninstall?.call(this, options); };
    const install = manager.installRuntime;
    if (install) manager.installRuntime = function(options = {}, ...args) {
      if (!isPath(options.version)) return install.call(this, options, ...args);
      const selected = resolveFor(manager, { sectionId: options.sectionId, userDataDir: options.userDataDir, version: options.version,
        allowInstallable: Boolean(manager.customRuntime?.prepareInstall) });
      if (!selected) throw new Error("The selected custom runtime is unavailable. Check its path in Runtimes.");
      return manager.customRuntime?.prepareInstall ? manager.customRuntime.prepareInstall(selected, options, ...args) : selected;
    };
    const afterRemove = manager.updateSettingsAfterUninstall;
    manager.updateSettingsAfterUninstall = function(settings, payload, context) {
      if (!isPath(payload.version)) return afterRemove?.call(this, settings, payload, context);
      return manager.normalizeSettings(withoutDefault(manager, settings, payload.sectionId || "default", payload.version));
    };
    manager.registerCustomRuntime = options => register(manager, options);
    for (const key of methodNames) if (typeof manager[key] === "function" && manager[key] !== originalMethods.get(key))
      managerMethods.set(manager[key], { manager, original: originalMethods.get(key) });
  }
  return values;
}

module.exports = { RuntimeRegistration, forManager, bindProvider, createSelector, selection, isPath, storageKey, configure, instrumentManagers, inspectNative, inspectExecutable: inspectNative, inspectManifest, list, resolve, register, selectionPath, defaultVersion };
