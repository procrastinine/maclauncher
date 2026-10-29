// Explicit Play preparation shared by the launcher and headless callers.
// Engine compatibility and exact version selection remain module-owned.
const { downloadApproved } = require("../modules/shared/runtime/tool-install");
const { selectRuntimeVersion, managerDefaultVersion } = require("../modules/shared/runtime/version-choices");
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
    if (selection) {
      if (selection.ready === true || (selection.install && selection.ready !== false)) return null;
      if (!selection.version && !selection.discoveryRequired) throw new Error(selection.reason || "A compatible runtime version could not be selected.");
      return { managerId, version: selection.version || null, ...(selection.discoveryRequired ? { discoveryRequired: true } : {}),
        installOptions: selection.installOptions || {} };
    }
  }
  sectionId ??= sectionIdFor(entry, info, runtimeId);
  const readSection = () => {
    const state = manager.getState({ settings: context.settings.runtimes?.[managerId], runtimeSettings: context.settings.runtimes, userDataDir: context.userDataDir });
    const sections = state.sections || [{ ...state, id: state.id || "default" }];
    return (sectionId ? sections.find(section => section.id === sectionId) : sections[0]) || null;
  };
  let section = readSection();
  if (!section) throw new Error("The detected game does not identify a compatible runtime line.");
  const override = entry.runtimeData?.[runtimeId] || {};
  const variant = override.variant || section.defaultVariant;
  const version = selectRuntimeVersion({ manual: override.version,
    defaultVersion: section.defaultVersion,
    fallback: managerDefaultVersion({
      listed: (section.catalog?.installableVersions || section.catalog?.versions || []).filter(version =>
        !section.catalog?.versionRequirements?.[version]?.installReason && section.availabilityByVersion?.[version]?.unavailable !== true),
      installed: (section.installed || []).filter(install => install.ready !== false && install.status !== "damaged" &&
        (!variant || install.variant === variant)).map(install => install.version)
    }) }).version;
  const installed = () => version && section.installed?.find(install => install.version === version && install.ready !== false && install.status !== "damaged" && (!variant || install.variant === variant));
  function useInstalled(install) {
    if (!install) return false;
    context.recordRuntimeUse?.({ managerId, version: install.version, sectionId: sectionId || section.id || "default",
      ...(install.variant ? { variant: install.variant } : {}),
      ...(install.installDir || install.appPath || install.executablePath ? { sourcePath: install.installDir || install.appPath || install.executablePath } : {}) });
    return true;
  }
  if (useInstalled(installed())) return null;
  if (!version && typeof manager.refreshCatalog !== "function") throw new Error("No compatible runtime version is available for this game.");
  return { managerId, version: version || null, ...(!version ? { discoveryRequired: true } : {}),
    installOptions: { sectionId: sectionId || section.id || "default", ...(variant ? { variant } : {}) } };
}

async function runtimePlans(entry, mod, info, context, managers) {
  // Module compatibility checks run before planning or downloading another host.
  const managerId = info.runtime?.manager?.[context.runtimeId];
  const runtimeOwner = mod?.getRuntimeProvider?.(context.runtimeId) || mod;
  const manager = managers.find(manager => manager.id === managerId);
  if (manager) {
    const sectionId = sectionIdFor(entry, info, context.runtimeId);
    const selected = require("../modules/shared/runtime/custom-runtime").forManager(manager).select(
      { ...entry, runtimeId: context.runtimeId }, context.settings, context.userDataDir, sectionId ? { sectionId } : {});
    if (selected && !selected.ready) throw new Error(selected.reason);
  }
  const primary = typeof runtimeOwner?.ensureRuntime === "function"
    ? await runtimeOwner.ensureRuntime(entry, context)
    : managerId && await managerPlan(entry, info, context, managers, { managerId, runtimeId: context.runtimeId });
  const plans = primary ? [primary] : [];
  if (typeof mod?.getRuntimeRequirements === "function") {
    const additional = await mod.getRuntimeRequirements(entry, context, { primary: primary || null });
    if (!Array.isArray(additional) || additional.some(plan => !plan || typeof plan.managerId !== "string" ||
      !plan.managerId || !(typeof plan.version === "string" && plan.version || plan.version == null && (plan.discoveryRequired === true)))) {
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
  let plans = await runtimePlans(entry, mod, info, context, managers);
  const approved = new Set(), refreshed = new Set();
  let installations;
  for (;;) {
    installations = plans.map(plan => {
      const manager = managers.find(manager => manager.id === plan.managerId);
      if (require("../modules/shared/runtime/custom-runtime").isPath(plan.version))
        throw new Error("The selected custom runtime is unavailable. Check its path in Runtimes.");
      if (!manager || typeof manager.installRuntime !== "function") throw new Error("The selected runtime cannot be installed automatically.");
      const state = manager.getState?.({ settings: context.settings.runtimes?.[manager.id], runtimeSettings: context.settings.runtimes, userDataDir: context.userDataDir });
      const section = state && ((state.sections || [state]).find(section => section.id === plan.installOptions?.sectionId) || state.sections?.[0] || state);
      const requiresDownload = plan.requiresDownload ?? section?.catalog?.versionRequirements?.[plan.version]?.requiresDownload ?? true;
      const versionLabel = [plan.versionLabel, section?.versionLabels?.[plan.version], section?.catalog?.versionLabels?.[plan.version],
        state?.versionLabels?.[plan.version], state?.catalog?.versionLabels?.[plan.version]].find(value => typeof value === "string" && value.trim());
      return { manager, plan, requiresDownload, versionLabel };
    });
    // Consent covers discovery and acquisition before either occurs.
    for (const { manager, plan, requiresDownload, versionLabel } of installations) {
      const key = JSON.stringify([manager.id, plan.installOptions?.sectionId, plan.installOptions?.variant]);
      if ((requiresDownload || !plan.version || plan.discoveryRequired) && !approved.has(key)) {
        if (!await downloadApproved(context, { ...plan, ...(versionLabel ? { versionLabel } : {}),
          label: plan.label || manager.label || manager.id, requiresDownload })) return false;
        approved.add(key);
      }
    }
    const unknown = installations.find(({ plan }) => !plan.version || plan.discoveryRequired);
    if (!unknown) break;
    const { manager, plan } = unknown, label = plan.label || manager.label || manager.id;
    const key = JSON.stringify([manager.id, plan.installOptions || {}, plan.latestOnly === true]);
    if (refreshed.has(key) || typeof manager.refreshCatalog !== "function")
      throw new Error(`No ${label} versions are available to download.`);
    refreshed.add(key);
    report({ phase: "install", label: `Finding ${label} versions…`, managerId: manager.id });
    await manager.refreshCatalog({ userDataDir: context.userDataDir, logger: context.logger, ...plan.installOptions,
      force: true, latestOnly: plan.latestOnly === true });
    context.onRuntimeStateChange?.();
    plans = await runtimePlans(entry, mod, info, context, managers);
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
