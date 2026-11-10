// Explicit Play preparation shared by the launcher and headless callers.
// Engine compatibility and exact version selection remain module-owned.
const { selectRuntimeVersion, installedRuntimeVersion, managerDefaultVersion } = require("../modules/shared/runtime/version-choices");
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

// The version a manager's runtime line gives Play: the game's choice, the
// saved default or the manager's own default, resolved against compatible
// installed copies. Play and the inspector's Automatic entry both use it.
function managerSelection(entry, info, context, manager, { runtimeId, sectionId }) {
  sectionId ??= sectionIdFor(entry, info, runtimeId);
  const state = manager.getState({ settings: context.settings.runtimes?.[manager.id], runtimeSettings: context.settings.runtimes, userDataDir: context.userDataDir });
  const sections = state.sections || [{ ...state, id: state.id || "default" }];
  const section = (sectionId ? sections.find(section => section.id === sectionId) : sections[0]) || null;
  if (!section) return null;
  const override = entry.runtimeData?.[runtimeId] || {};
  const variant = override.variant || section.defaultVariant;
  const selection = selectRuntimeVersion({ manual: override.version,
    defaultVersion: section.defaultVersion,
    fallback: managerDefaultVersion({
      listed: (section.catalog?.installableVersions || section.catalog?.versions || []).filter(version =>
        !section.catalog?.versionRequirements?.[version]?.installReason && section.availabilityByVersion?.[version]?.unavailable !== true),
      installed: (section.installed || []).filter(install => install.ready !== false && install.status !== "damaged" &&
        (!variant || install.variant === variant)).map(install => install.version)
    }) });
  const version = installedRuntimeVersion({ ...selection, compatibility: manager.versionCompatibility,
    installed: (section.installed || []).filter(install => !variant || install.variant === variant) }) || selection.version;
  // Only the manager's own default, with no game choice or saved default,
  // is an automatic choice; see runtime-install-origins.js.
  const automatic = !selectRuntimeVersion({ manual: override.version, defaultVersion: section.defaultVersion }).version;
  return { section, sectionId, variant, version, automatic };
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
  const selected = managerSelection(entry, info, context, manager, { runtimeId, sectionId });
  if (!selected) throw new Error("The detected game does not identify a compatible runtime line.");
  const { section, variant, version, automatic } = selected;
  sectionId = selected.sectionId;
  const installed = () => version && section.installed?.find(install => install.version === version && install.ready !== false && install.status !== "damaged" && (!variant || install.variant === variant));
  function useInstalled(install) {
    if (!install) return false;
    if (!automatic) require("./runtime-install-origins").clearRecord(context.userDataDir, { managerId, version: install.version });
    context.recordRuntimeUse?.({ managerId, version: install.version, sectionId: sectionId || section.id || "default",
      ...(install.variant ? { variant: install.variant } : {}),
      ...(install.installDir || install.appPath || install.executablePath ? { sourcePath: install.installDir || install.appPath || install.executablePath } : {}) });
    return true;
  }
  if (useInstalled(installed())) return null;
  if (!version && typeof manager.refreshCatalog !== "function") throw new Error("No compatible runtime version is available for this game.");
  return { managerId, version: version || null, ...(!version ? { discoveryRequired: true } : {}), ...(automatic ? { automatic: true } : {}),
    installOptions: { sectionId: sectionId || section.id || "default", ...(variant ? { variant } : {}) } };
}

/** The version Play uses for the game's selected runtime when the game has
 * no version choice: a compatible installed version when there is one,
 * otherwise the version Play would install. A runtime owner that selects its
 * version itself reports it through `automaticRuntimeVersion`; managers with
 * `resolveSelection` report theirs; other managers use managerSelection.
 * Null when the version is not known before Play reads a catalog. */
async function automaticRuntimeVersion(entry, mod, info, context, managers) {
  const runtimeId = context.runtimeId, manager = managers.find(manager => manager.id === info.runtime?.manager?.[runtimeId]);
  if (!manager) return null;
  const automatic = { ...entry, runtimeId, runtimeData: { ...entry.runtimeData, [runtimeId]: { ...entry.runtimeData?.[runtimeId], version: null } } };
  const owner = mod?.getRuntimeProvider?.(runtimeId) || mod;
  const own = await owner?.automaticRuntimeVersion?.(automatic, context);
  if (typeof own === "string" && own) return own;
  if (typeof manager.resolveSelection === "function") {
    // A status check of installed copies is enough to name the version; Play
    // verifies the copy it uses.
    const selection = await manager.resolveSelection(automatic, context.settings, context.userDataDir, { verification: "status" });
    if (selection) return typeof selection.version === "string" && selection.version ? selection.version : null;
  }
  if (typeof owner?.ensureRuntime === "function") return null;
  return managerSelection(automatic, info, context, manager, { runtimeId })?.version || null;
}

async function runtimePlans(entry, mod, info, context, managers) {
  // Module compatibility checks run before planning or downloading another host.
  const managerId = info.runtime?.manager?.[context.runtimeId];
  const runtimeOwner = mod?.getRuntimeProvider?.(context.runtimeId) || mod;
  const manager = managers.find(manager => manager.id === managerId);
  if (manager) {
    const Custom = require("../modules/shared/runtime/custom-runtime");
    const sectionId = sectionIdFor(entry, info, context.runtimeId);
    const selected = Custom.forManager(manager).select(
      { ...entry, runtimeId: context.runtimeId }, context.settings, context.userDataDir, sectionId ? { sectionId } : {});
    const replacement = typeof selected?.version === "string" && selected.version && !Custom.isPath(selected.version) ||
      selected?.discoveryRequired === true && typeof manager.refreshCatalog === "function";
    if (selected && !selected.ready && !replacement) throw new Error(selected.reason);
    const requested = selectRuntimeVersion({ manual: entry.runtimeData?.[context.runtimeId]?.version }).version;
    if (requested && typeof manager.resolveSelection === "function") {
      const selection = await manager.resolveSelection({ ...entry, runtimeId: context.runtimeId }, context.settings,
        context.userDataDir, { version: requested, verification: "status" });
      if (selection?.ready === false && selection.discoveryRequired && !selection.install) {
        const label = info.runtime?.labels?.[context.runtimeId] || info.runtime?.entries?.[context.runtimeId]?.label || manager.label || context.runtimeId;
        throw Object.assign(new Error(`The ${label} version setting ${JSON.stringify(requested)} cannot be resolved. ${selection.reason || "Choose a version listed in Runtimes."}`),
          { code: "RUNTIME_VERSION_UNRESOLVED" });
      }
    }
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
    if (!unique.has(key) || unique.get(key).optional && !plan.optional) unique.set(key, plan);
  }
  return [...unique.values()];
}

// `notice` receives a line that stays visible for the rest of this Play, such as
// the runtime used after an optional download was unavailable.
async function prepareForLaunch({ entry, mod, info, context, registry, runAction, install, report = () => {},
  notice = line => report({ phase: "prepare", label: line }) }) {
  const managers = listRuntimeManagers(registry);
  let plans = await runtimePlans(entry, mod, info, context, managers);
  const approved = new Set(), refreshed = new Set(), declined = new Set();
  const consentKey = plan => JSON.stringify([plan.managerId, Object.entries(plan.installOptions || {}).sort(([a], [b]) => a.localeCompare(b))]);
  // A manager may remember an optional download that was declined or failed,
  // so later Plays do not offer it again.
  function skipped(plan) {
    try { managers.find(manager => manager.id === plan.managerId)?.skipOptional?.(plan, { userDataDir: context.userDataDir }); }
    catch (error) { context.logger?.warn?.("[runtimes] The optional download choice could not be kept.", error.message); }
  }
  // Approving a plan can also approve a step of this Play that the plan
  // names, such as starting Steam; that step reads `context.grants`.
  function grant(plan) {
    for (const name of Array.isArray(plan.grants) ? plan.grants : []) if (typeof name === "string") (context.grants ||= new Set()).add(name);
  }
  function useFallback(plan, error) {
    if (!plan.optional || (!plan.fallback && !plan.silentFallback) || context.signal?.aborted) return false;
    declined.add(consentKey(plan));
    skipped(plan);
    if (plan.silentFallback) return true;
    // The line names the runtime from the consent dialog, the reason and the runtime used instead.
    const name = plan.label || managers.find(manager => manager.id === plan.managerId)?.label || plan.managerId;
    const used = plan.fallback.label || managers.find(manager => manager.id === plan.fallback.managerId)?.label || plan.fallback.managerId;
    const reason = String(error?.message || "").split("\n")[0].trim().replace(/([^.!?])$/, "$1.");
    const line = error?.code === "RUNTIME_NO_VERSIONS" ? `No ${name} version is available to download. Using ${used}.`
      : `${name} could not be installed.${reason ? " " + reason : ""} Using ${used}.`;
    context.logger?.warn?.("[runtimes] " + line);
    notice(line);
    return true;
  }
  let installations;
  for (;;) {
    installations = plans.flatMap(plan => plan.optional && declined.has(consentKey(plan))
      ? plan.fallback ? [plan.fallback] : [] : [plan]).map(plan => {
      const manager = managers.find(manager => manager.id === plan.managerId);
      if (require("../modules/shared/runtime/custom-runtime").isPath(plan.version))
        throw new Error("The selected custom runtime is unavailable. Check its path in Runtimes.");
      if (!manager || typeof manager.installRuntime !== "function") throw new Error("The selected runtime cannot be installed automatically.");
      const state = manager.getState?.({ settings: context.settings.runtimes?.[manager.id], runtimeSettings: context.settings.runtimes, userDataDir: context.userDataDir });
      const section = state && ((state.sections || [state]).find(section => section.id === plan.installOptions?.sectionId) || state.sections?.[0] || state);
      const requiresDownload = plan.requiresDownload ?? section?.catalog?.versionRequirements?.[plan.version]?.requiresDownload ?? true;
      const versionLabel = [plan.versionLabel, section?.versionLabels?.[plan.version], section?.catalog?.versionLabels?.[plan.version],
        state?.versionLabels?.[plan.version], state?.catalog?.versionLabels?.[plan.version]].find(value => typeof value === "string" && value.trim());
      const installedBefore = (state?.sections || [state]).flatMap(item => item?.installed || []).map(row => String(row?.version));
      return { manager, plan, requiresDownload, versionLabel, installedBefore };
    });
    // Consent covers discovery and acquisition before either occurs. Each
    // download has its own dialog. An optional companion, such as a package
    // matched to the selected runtime, is listed in the dialog of a required
    // download of the same Play; without one it has its own dialog, and
    // declining it continues Play.
    let fallbackRequired = false;
    const pending = ({ plan, requiresDownload }) => (requiresDownload || !plan.version || plan.discoveryRequired) &&
      !approved.has(consentKey(plan)) && !declined.has(consentKey(plan));
    const host = installations.find(item => !item.plan.optional && pending(item));
    const companions = host ? installations.filter(item => item.plan.optional && item.plan.companion && pending(item)) : [];
    for (const { manager, plan, requiresDownload, versionLabel } of installations) {
      const key = consentKey(plan);
      if (declined.has(key) || companions.some(item => item.plan === plan)) continue;
      if ((requiresDownload || !plan.version || plan.discoveryRequired) && !approved.has(key)) {
        const listed = host?.plan === plan ? companions : [];
        // The dialog shows one companion's checkbox; clearing it declines only that companion.
        const optional = listed.find(item => typeof item.plan.companionCheckbox === "string" && item.plan.companionCheckbox);
        const consent = typeof context.confirmRuntimeInstall === "function" ? await context.confirmRuntimeInstall({ ...plan, ...(versionLabel ? { versionLabel } : {}),
          label: plan.label || manager.label || manager.id, requiresDownload,
          ...(listed.length ? { companions: listed.map(item => ({ label: item.plan.label || item.manager.label || item.manager.id,
            ...(item.versionLabel || item.plan.version ? { versionLabel: item.versionLabel || item.plan.version } : {}),
            ...(item.plan.bytes ? { bytes: item.plan.bytes } : {}), ...(item.plan.summary ? { summary: item.plan.summary } : {}),
            ...(item.plan.companionDetail ? { detail: item.plan.companionDetail } : {}),
            ...(item === optional ? { checkboxLabel: item.plan.companionCheckbox } : {}) })) } : {}) }) : false;
        if (consent !== true && consent?.approved !== true) {
          if (!plan.optional) return false;
          declined.add(key);
          skipped(plan);
          fallbackRequired ||= Boolean(plan.fallback);
          continue;
        }
        approved.add(key);
        grant(plan);
        for (const item of listed) {
          if (item === optional && consent?.companionsDeclined === true) { declined.add(consentKey(item.plan)); skipped(item.plan); }
          else { approved.add(consentKey(item.plan)); grant(item.plan); }
        }
      }
    }
    if (fallbackRequired) continue;
    installations = installations.filter(({ plan }) => !plan.optional || !declined.has(consentKey(plan)));
    const unknown = installations.find(({ plan }) => !plan.version || plan.discoveryRequired);
    if (unknown) {
      const { manager, plan } = unknown, label = plan.label || manager.label || manager.id;
      const key = JSON.stringify([manager.id, plan.installOptions || {}, plan.latestOnly === true]);
      try {
        if (refreshed.has(key) || typeof manager.refreshCatalog !== "function")
          throw Object.assign(new Error(`No ${label} versions are available to download.`), { code: "RUNTIME_NO_VERSIONS" });
        refreshed.add(key);
        report({ phase: "install", label: `Finding ${label} versions…`, managerId: manager.id });
        await manager.refreshCatalog({ userDataDir: context.userDataDir, logger: context.logger, ...plan.installOptions,
          force: true, latestOnly: plan.latestOnly === true });
        context.onRuntimeStateChange?.();
        plans = await runtimePlans(entry, mod, info, context, managers);
      } catch (error) { if (!useFallback(plan, error)) throw error; }
      continue;
    }
    let retry = false;
    for (const { manager, plan, installedBefore } of installations) {
      const label = plan.label || manager.label || manager.id;
      const progressLabel = plan.progressLabel || `Installing ${label}…`;
      report({ phase: "install", label: progressLabel, managerId: manager.id, version: plan.version });
      try {
        const result = await install(manager, { ...plan.installOptions, version: plan.version }, { label, progressLabel });
        // A version Play chose on its own may later be superseded and removed.
        if (plan.automatic === true) require("./runtime-install-origins").recordPlayInstall({ userDataDir: context.userDataDir, manager, plan, result,
          entry, settings: context.settings, installedBefore, logger: context.logger });
      } catch (error) {
        if (!useFallback(plan, error)) throw error;
        retry = true;
        break;
      }
    }
    if (!retry) break;
    plans = await runtimePlans(entry, mod, info, context, managers);
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

module.exports = { automaticRuntimeVersion, listRuntimeManagers, prepareForLaunch, readyFor, sectionIdFor };
