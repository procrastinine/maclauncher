// Explicit Play preparation shared by the launcher and headless callers.
// Engine compatibility and exact version selection remain module-owned.
function listRuntimeManagers(registry) {
  const managers = new Map();
  for (const id of registry.listModuleIds?.() || registry.listModules().map(mod => mod.id)) {
    for (const manager of registry.getModule(id)?.runtimeManagers || []) if (manager?.id && !managers.has(manager.id)) managers.set(manager.id, manager);
  }
  for (const manager of registry.listSharedRuntimeManagers?.() || []) if (manager?.id && !managers.has(manager.id)) managers.set(manager.id, manager);
  return [...managers.values()];
}

function valueAt(value, key) { return String(key || "").split(".").reduce((value, part) => value?.[part], value); }
function readyFor(status, declaration) {
  if (!declaration.readyWhen) return Boolean(status);
  const conditions = Array.isArray(declaration.readyWhen) ? declaration.readyWhen : [declaration.readyWhen];
  return conditions.every(condition => {
    const value = valueAt(status, condition.key);
    return (!Object.hasOwn(condition, "equals") || value === condition.equals) &&
      (!Object.hasOwn(condition, "notEquals") || value !== condition.notEquals) &&
      (!condition.truthy || Boolean(value)) && (!condition.falsy || !value);
  });
}

function sectionIdFor(entry, info, runtimeId) {
  const declaration = info.runtime || {}, map = declaration.managerSectionMap?.[runtimeId] || {};
  const overrideKey = declaration.managerSectionOverrideKey?.[runtimeId];
  const key = declaration.managerSectionBy?.[runtimeId];
  const value = (overrideKey && entry.runtimeData?.[runtimeId]?.[overrideKey]) ??
    (key && (key === "runtimeId" ? runtimeId : valueAt(entry.moduleData, key) ?? valueAt(entry, key)));
  return value == null || value === false || value === "" ? null : map[String(value)] || String(value);
}

async function managerPlan(entry, info, context, managers, { managerId, runtimeId, sectionId }) {
  const manager = managers.find(manager => manager.id === managerId);
  if (!manager) throw new Error(`Runtime manager ${managerId} is unavailable.`);
  if (typeof manager.resolveSelection === "function") {
    const selectionEntry = runtimeId === context.runtimeId ? entry : { ...entry, runtimeId };
    const selection = await manager.resolveSelection(selectionEntry, context.settings, context.userDataDir);
    if (selection.ready === true || (selection.install && selection.ready !== false)) return null;
    if (!selection.version) throw new Error(selection.reason || "A compatible runtime version could not be selected.");
    return { managerId, version: selection.version, installOptions: selection.installOptions || {} };
  }
  sectionId ??= sectionIdFor(entry, info, runtimeId);
  const readSection = () => {
    const state = manager.getState({ settings: context.settings.runtimes?.[managerId], userDataDir: context.userDataDir });
    const sections = state.sections || [state];
    return (sectionId ? sections.find(section => section.id === sectionId) : sections[0]) || null;
  };
  let section = readSection();
  if (!section) throw new Error("The detected game does not identify a compatible runtime line.");
  const override = entry.runtimeData?.[runtimeId] || {};
  const versionFor = () => override.version || section.defaultVersion || section.catalog?.latestInstalledVersion || section.catalog?.recommendedVersion ||
    section.catalog?.latestStableVersion || section.catalog?.latestAvailableVersion || section.catalog?.versions?.[0];
  let version = versionFor();
  const variant = override.variant || section.defaultVariant;
  const installed = () => version && section.installed?.find(install => install.version === version && install.ready !== false && (!variant || install.variant === variant));
  function useInstalled(install) {
    if (!install) return false;
    context.recordRuntimeUse?.({ managerId, version: install.version, sectionId: sectionId || section.id || "default",
      ...(install.variant ? { variant: install.variant } : {}),
      ...(install.installDir || install.appPath || install.executablePath ? { sourcePath: install.installDir || install.appPath || install.executablePath } : {}) });
    return true;
  }
  if (useInstalled(installed())) return null;
  if (!version && typeof manager.refreshCatalog === "function") {
    await manager.refreshCatalog({ userDataDir: context.userDataDir, logger: context.logger, sectionId: sectionId || section.id, force: true, latestOnly: false });
    context.onRuntimeStateChange?.();
    section = readSection();
    version = versionFor();
    if (useInstalled(installed())) return null;
  }
  if (!version) throw new Error("No compatible runtime version is available for this game.");
  return { managerId, version, installOptions: { sectionId: sectionId || section.id || "default", ...(variant ? { variant } : {}) } };
}

async function runtimePlans(entry, mod, info, context, managers) {
  // Module compatibility checks run before planning or downloading another host.
  const managerId = info.runtime?.manager?.[context.runtimeId];
  const primary = typeof mod?.ensureRuntime === "function"
    ? await mod.ensureRuntime(entry, context)
    : managerId && await managerPlan(entry, info, context, managers, { managerId, runtimeId: context.runtimeId });
  const plans = primary ? [primary] : [];
  if (typeof mod?.getRuntimeRequirements === "function") {
    const additional = await mod.getRuntimeRequirements(entry, context, { primary: primary || null });
    if (!Array.isArray(additional) || additional.some(plan => !plan || typeof plan.managerId !== "string" ||
      !plan.managerId || typeof plan.version !== "string" || !plan.version)) {
      throw new Error("Additional runtime requirements must identify exact manager/version plans.");
    }
    plans.push(...additional);
  }
  const prerequisites = info.runtime?.prerequisites?.[context.runtimeId] || [];
  if (!Array.isArray(prerequisites)) throw new Error("Runtime prerequisites must be a list.");
  for (const prerequisite of prerequisites) {
    if (!prerequisite?.managerId || !prerequisite?.runtimeId) throw new Error("A runtime prerequisite must identify its manager and selection runtime.");
    const plan = await managerPlan(entry, info, context, managers, prerequisite);
    if (plan) plans.push(plan);
  }
  const unique = new Map();
  for (const plan of plans) {
    const options = Object.entries(plan.installOptions || {}).sort(([a], [b]) => a.localeCompare(b));
    const key = JSON.stringify([plan.managerId, plan.version, options]);
    if (!unique.has(key)) unique.set(key, plan);
  }
  return [...unique.values()];
}

async function prepareForLaunch({ entry, mod, info, context, registry, runAction, install, report = () => {} }) {
  const managers = listRuntimeManagers(registry);
  const plans = await runtimePlans(entry, mod, info, context, managers);
  const installations = [];
  // Validate the complete dependency plan before asking for a download.
  for (const plan of plans) {
    const manager = managers.find(manager => manager.id === plan.managerId);
    if (!manager || typeof manager.installRuntime !== "function") throw new Error("The selected runtime cannot be installed automatically.");
    const state = manager.getState?.({ settings: context.settings.runtimes?.[manager.id], userDataDir: context.userDataDir });
    const section = state && ((state.sections || [state]).find(section => section.id === plan.installOptions?.sectionId) || state.sections?.[0] || state);
    const requirements = section?.catalog?.versionRequirements?.[plan.version];
    const requiresDownload = plan.requiresDownload ?? requirements?.requiresDownload ?? true;
    installations.push({ manager, plan, requiresDownload });
  }
  // Obtain every required consent before changing any runtime installation.
  for (const { manager, plan, requiresDownload } of installations) {
    if (requiresDownload && context.confirmRuntimeInstall) {
      const consent = await context.confirmRuntimeInstall({ ...plan, label: plan.label || manager.label || manager.id, requiresDownload });
      if (consent !== true && consent?.approved !== true) return false;
    }
  }
  for (const { manager, plan } of installations) {
    const label = plan.label || manager.label || manager.id;
    const progressLabel = plan.progressLabel || `Installing ${label}…`;
    report({ phase: "install", label: progressLabel, managerId: manager.id, version: plan.version });
    await install(manager, { ...plan.installOptions, version: plan.version }, { label, progressLabel });
  }
  await context.flushRuntimeUses?.();
  const declaration = info.runtime?.preLaunch?.[context.runtimeId];
  if (declaration?.statusAction) {
    const status = await runAction(declaration.statusAction);
    if (!readyFor(status, declaration)) {
      if (!declaration.fixAction) throw new Error(status?.reason || "Game preparation is unavailable.");
      report({ phase: "prepare", label: "Starting game…" });
      await runAction(declaration.fixAction);
      if (!readyFor(await runAction(declaration.statusAction), declaration)) throw new Error("Game preparation did not complete.");
    }
  }
  if (typeof mod?.prepareLaunch === "function") {
    report({ phase: "prepare", label: "Starting game…" });
    await mod.prepareLaunch(entry, context);
  }
  return true;
}

module.exports = { listRuntimeManagers, prepareForLaunch, readyFor, sectionIdFor };
