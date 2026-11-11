const fs = require("node:fs");
const Translators = require("../shared/runtime/wine-translators");
const Sources = require("./sources");
const manifest = Translators.withSettings(require("../shared/runtime/wine-settings-ui").withSettings(require("./temporal/catalog").withSettingsOptions(
  require("./sources/settings").withSources(require("./manifest.json")))));
const Detection = require("./detect");
const manager = require("./runtime/manager");
const Launch = require("./runtime/launch");
const { versionChoices } = require("../shared/runtime/version-choices");
function graphicsBridgeVersions(runtimeId, context) {
  const support = require("./temporal/support-manager").forRuntime(runtimeId);
  if (!support) throw new Error("Choose a Windows runtime.");
  const field = manifest.runtime.entries[runtimeId]?.settings?.fields?.find(field => field.optionsAction === "listGraphicsBridgeVersions");
  return { graphicsBridgeVersions: [{ value: "auto", label: "Automatic" },
    ...versionChoices(support, { ...context, selectedVersion: field?.key ? context.runtimeSettings?.[field.key] : undefined })] };
}
function wineSettingInheritance(entry, payload, context) {
  const runtimeId = context.runtimeId || payload?.runtimeId || entry.runtimeId;
  return require('../shared/runtime/wine-setting-inheritance').choices(context.runtimeSettings || {}, manifest.runtime.entries[runtimeId].settings,
    { reference: payload?.environmentReference || context.runtimeSettings?.environmentReference });
}
async function translatorOptions(entry, payload, context, dependencies = {}) {
  const runtime = context.runtimeId || payload?.runtimeId || entry.runtimeId || manifest.runtime.default;
  const draft = { ...context, runtimeSettings: { ...context.runtimeSettings, ...payload?.runtimeSettings } };
  const preparedContext = Translators.environmentContext(draft);
  const runtimeManager = dependencies.runtimeManager || Sources.get(runtime).manager();
  const selected = preparedContext.wineEnvironment?.install ? { ready: true, install: preparedContext.wineEnvironment.install } : runtimeManager.resolveSelection(entry, draft.settings, draft.userDataDir, draft.runtimeSettings);
  const install = selected.ready === false ? null : selected.install;
  const consumerArchitecture = selected.architecture;
  const input = await Translators.optionsInventory(install, runtime, preparedContext, { ...dependencies, entry, consumerArchitecture, reuse: true });
  const plan = Translators.optionsPlan(input, preparedContext);
  const executableArchitecture = Detection.cachedWindowsExecutable(entry)?.executableArchitecture;
  return { ...Translators.optionLists(install, runtime, preparedContext, { ...dependencies, plan, inventory: input, consumerArchitecture, executableArchitecture }),
    ...(!install ? { notice: 'Included choices appear when the selected runtime is installed.' +
      (typeof runtimeManager.installRuntime === 'function' ? ' Play installs it after confirmation.' : '') } : {}), effectiveSettings: [
    { value: 'graphicsBackend', label: Translators.engines(plan)['d3d-renderer'] || 'auto' },
    { value: 'vulkanBackend', label: plan.components['vulkan-driver'].used?.engine || 'auto' }
  ], translatorEnvironments: Translators.environmentIds(plan, runtime) };
}
// What the last Play recorded applies while the translator settings and the
// Wine installation are unchanged.
function recordedLaunch(entry, runtimeId, context, install) {
  const record = entry.runtimeData?.[runtimeId];
  return record?.translatorRows?.length && Translators.samePlanInputs(record.translatorPlanInputs, context.runtimeSettings, install) ? record : null;
}
// The plan for the current settings from installed descriptions, without
// Play's file checks.
async function currentPlan(entry, runtimeId, context, install) {
  return Translators.optionsPlan(await Translators.optionsInventory(install, runtimeId, context, { entry, reuse: true }), context);
}
// A spare backend lane reads the installed default Wine runtimes' translator
// choices before a game is assigned to it; the game's first inspector request
// then reuses them.
async function warmBackendLane(context) {
  for (const source of Sources.all()) {
    const selected = source.manager().resolveSelection({}, context.settings, context.userDataDir, {});
    if (selected?.ready === false || !selected?.install) continue;
    await Translators.optionsInventory(selected.install, source.id, { ...context, runtimeSettings: {} }, { reuse: true });
  }
}
// An existing environment of a source that runs its own Wine loader carries
// that Wine; a CrossOver bottle runs with the selected CrossOver application.
function existingWine(source, context) {
  if (source?.invocation !== "wine" || !source.environmentKind) return null;
  const reference = Environments.environmentReference(context.runtimeSettings?.environmentReference);
  return reference?.kind === source.environmentKind ? Environments.readEnvironment(reference) : null;
}
async function runtimeStatus(entry, _payload, context) {
  const runtime = providerForEntry(entry, context)?.runtimeId;
  const selectedManager = Sources.get(runtime).manager();
  const existing = existingWine(Sources.get(runtime), context);
  const selected = existing ? { ready: true, install: existing.install, version: existing.path, versionLabel: existing.install.engineVersion } :
    selectedManager.resolveSelection(entry, context.settings, context.userDataDir, context.runtimeSettings);
  const preparedContext = selected.install ? Translators.environmentContext(context, selected.install) : context;
  const install = preparedContext.wineEnvironment?.install || selected.install;
  // Rows recorded at the last Play describe unchanged settings; otherwise the
  // rows describe what the current settings load. Without an installed
  // runtime, the recorded rows remain.
  const recorded = install ? recordedLaunch(entry, runtime, preparedContext, install)?.translatorRows
    : entry.runtimeData?.[runtime]?.translatorRows?.length ? entry.runtimeData[runtime].translatorRows : null;
  const plan = !recorded && install ? await currentPlan(entry, runtime, preparedContext, install) : null;
  const rows = recorded ? Translators.presentInspectorRows(recorded) : plan ? Translators.inspectorRows(plan) : [];
  const details = rows.map(row => ({ label: row.label, value: row.used,
    detail: row.selected !== row.used && row.reason ? 'Selected ' + row.selected + '. ' + row.reason : '' }));
  const cameraNotice = entry.runtimeData?.[runtime]?.cameraAdapterNotice;
  if (cameraNotice) details.push({ label: 'Camera adapter', value: 'Unavailable', detail: cameraNotice });
  const steamBridge = require('./runtime/steam-bridge').inspectorDetail(entry.runtimeData?.[runtime], context.userDataDir);
  if (steamBridge) details.push(steamBridge);
  const { install: _install, ...displaySelection } = selected;
  return { ...displaySelection, translatorRows: rows, details, graphicsInputs: await resolveGraphicsInputs(entry, preparedContext, selected, plan),
    versionLabel: selected.versionLabel || selected.install?.versionLabel || selected.install?.upstreamVersion || selected.install?.engineVersion || selected.version };
}
const graphicsBridgeActions = { runtimeStatus, listWineSettingInheritance: wineSettingInheritance, listTranslatorOptions: (entry, payload, context) => translatorOptions(entry, payload, context), listGraphicsBridgeVersions: (entry, _payload, context) => graphicsBridgeVersions(context.runtimeId || entry.runtimeId, context) };
const graphicsBridgeSettingsActions = { listWineSettingInheritance: (payload, context) => wineSettingInheritance({}, payload, context), listTranslatorOptions: (payload, context) => translatorOptions({runtimeId:payload?.runtimeId}, payload, context), listGraphicsBridgeVersions: (payload, context) => graphicsBridgeVersions(payload?.runtimeId, context) };

function graphicsBackendOptions(entry, context, { runtimeId = context.runtimeId || entry?.runtimeId || manifest.runtime.default, runtimeManager = Sources.get(runtimeId).manager(), host } = {}) {
  const selected = runtimeManager.resolveSelection(entry, context.settings, context.userDataDir, context.runtimeSettings);
  const field = manifest.runtime.entries[runtimeId].settings.fields.find(field => field.key === "graphicsBackend");
  const support = require("./runtime/backend-support");
  return { graphicsBackends: field.options.filter(option => !support.reason(selected?.install, option.value, host)) };
}
// The synchronization modes the selected Wine offers: CrossOver by its
// version, a downloaded Wine by the modes its wineserver names.
function wineSynchronizations(entry, context, runtimeId = context.runtimeId || entry?.runtimeId || manifest.runtime.default) {
  const source = Sources.get(runtimeId), existing = existingWine(source, context);
  const install = existing?.install || source.manager().resolveSelection(entry, context.settings, context.userDataDir, context.runtimeSettings).install;
  const options = manifest.runtime.entries[runtimeId].settings.fields.find(field => field.key === 'synchronization').options;
  const offered = mode => source.invocation === "crossover" ? mode !== 'esync' || Number.parseInt(install?.upstreamVersion, 10) < 25
    : !install || install.capabilities?.[mode] === true;
  return { synchronizations: options.filter(option => ['auto', 'off'].includes(option.value) || offered(option.value)) };
}
const Environments = require("../shared/runtime/wine-environment");
// Every source has the same inspector and settings actions; the environment
// picker lists the source's own external environments.
function actionsFor(source) {
  return { ...graphicsBridgeActions, ...(source.environmentKind ? Environments.environmentActions(source.id, source.invocation === "crossover" ? { resolveOptions: context => ({
    crossoverRoot: manager.resolveSelection({}, context.settings, context.userDataDir, context.runtimeSettings)?.install?.crossoverRoot }) } : {}) : {}),
    listWineSynchronizations: (entry, _payload, context) => wineSynchronizations(entry, context, source.id),
    listGraphicsBackends: (entry, _payload, context) => graphicsBackendOptions(entry, context, { runtimeId: source.id }) };
}
function settingsActionsFor(source) {
  return { ...graphicsBridgeSettingsActions, listWineSynchronizations: (_payload, context) => wineSynchronizations({}, context, source.id),
    listGraphicsBackends: (_payload, context) => graphicsBackendOptions({}, context, { runtimeId: source.id }) };
}
const crossoverActions = actionsFor(Sources.get("crossover")), crossoverSettingsActions = settingsActionsFor(Sources.get("crossover"));
const WineProvider = require("./sources/provider");
const wineProviders = Sources.all().filter(source => source.invocation === "wine").map(source => ({ ...WineProvider.createProvider({ source }),
  runtime: manifest.runtime.entries[source.id], supports: manifest.runtime.entries[source.id].supports,
  actions: actionsFor(source), settingsActions: settingsActionsFor(source) }));
// CrossOver cannot be downloaded, so it is offered only while an installed copy is available.
function supportsEntry(entry, _moduleSettings, context = {}) {
  return Detection.supportsWindowsRuntimes(entry) && manager.isAvailable(context.userDataDir);
}
function canLaunchRuntime(runtimeId, entry, moduleSettings, context) {
  return runtimeId === "crossover" && supportsEntry(entry, moduleSettings, context);
}
async function ensureRuntime(entry, context) {
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir, context.runtimeSettings);
  if (!selected.ready) throw new Error(selected.reason);
  const prepared = Translators.environmentContext(context, selected.install);
  if (prepared.wineEnvironment) context.wineEnvironment = prepared.wineEnvironment;
  const plan = await Translators.resolve(prepared.wineEnvironment?.install || selected.install, "crossover", context, { entry, executableArchitecture: Detection.cachedWindowsExecutable(entry)?.executableArchitecture });
  return Translators.requirement(plan, context);
}
async function launchRuntime(runtimeId, entry, context) {
  if (runtimeId !== "crossover") return null;
  if (process.platform !== "darwin") throw new Error("CrossOver requires macOS.");
  const launch = await Launch.prepareLaunch(entry, context);
  const Processes = require("../shared/runtime/wine-processes");
  Processes.installStopHandler(context, launch);
  const args = launch.existingEnvironment ? Processes.externalArguments(launch.install.executablePath, launch.args, launch.environment) :
    ["-c", Launch.SUPERVISOR, "maclauncher-crossover", launch.install.executablePath, launch.install.serverPath, ...launch.args];
  const child = await context.spawnDetachedChecked("/bin/sh", args,
  { cwd: launch.workingDirectory || launch.gameRoot, env: launch.environment, graphicsExecutable: launch.environment.WINELOADER || launch.install.loaderPath }, false);
  require("../shared/runtime/wine-activation").followWineActivation(child, context);
  return child;
}
const resolveSaveLocations = (_entry, context) => ({ primaryDirectory: null, directories: Environments.saveLocations(context?.runtimeSettings) });
const crossoverProvider = { runtimeId: "crossover", runtime: manifest.runtime.entries.crossover, managerId: "crossover",
    actions: crossoverActions, settingsActions: crossoverSettingsActions,
    supports: manifest.supports, decorateEntry: Detection.decorateEntry,
    supportsEntry, canLaunchRuntime, ensureRuntime, launchRuntime, resolveSaveLocations,
    getRuntimeRequirements: async (entry, context) => [
      ...await require("./temporal").requirements(entry, { ...context, runtimeId: "crossover" }),
      ...await Translators.driverRequirements(context),
      ...await require("./temporal/vulkan-dlss").requirements(entry, context),
      ...await require('./runtime/winemac').requirements(entry, { ...context, runtimeId: 'crossover' }),
      ...await require('./runtime/steam-bridge').requirements(entry, { ...context, runtimeId: 'crossover' })
    ],
    resolveGraphicsInputs: (entry, context) => resolveGraphicsInputs(entry, context) };
const runtimeProviders = [crossoverProvider, ...wineProviders];
const runtimeManagers = [...require("./temporal/vulkan-dlss").managers, ...Sources.all().map(source => source.manager()), require('./runtime/maclauncher-dxvk'), require('./runtime/winemac'), require('./runtime/steam-bridge'), ...Object.values(require("./temporal/support-manager").managers)];
const providerForRuntime = runtimeId => runtimeProviders.find(provider => provider.runtimeId === runtimeId);
const providerForEntry = (entry, context) => providerForRuntime(context?.runtimeId || entry?.runtimeId || manifest.runtime.default);
async function resolveGraphicsInputs(entry, context = {}, resolved, plan) {
  const runtimeId = providerForEntry(entry, context)?.runtimeId;
  const selectedManager = runtimeManagers.find(candidate => candidate.id === providerForEntry(entry, context)?.managerId);
  const existing = existingWine(Sources.get(runtimeId), context);
  if (existing) context.wineEnvironment = existing;
  const selected = resolved || (existing ? { ready: true, install: existing.install, version: existing.path } :
    selectedManager?.resolveSelection(entry, context.settings, context.userDataDir, context.runtimeSettings));
  if (!selected?.ready) return null;
  const prepared = Translators.environmentContext(context, selected.install);
  if (prepared.wineEnvironment) context.wineEnvironment = prepared.wineEnvironment;
  const install = prepared.wineEnvironment?.install || selected.install;
  const fallback = manifest.runtime.entries[runtimeId]?.graphicsArchitecture || null;
  let translatorPlan = plan || context.translatorPlan;
  const recorded = !translatorPlan && recordedLaunch(entry, runtimeId, context, install);
  if (recorded) return require("./graphics-inputs").inputs(install, recorded.graphicsInputs, { fallback });
  translatorPlan ||= await currentPlan(entry, runtimeId, context, install);
  const source = require("./temporal").resolvePlan(entry, context, { install, runtimeId, translatorPlan,
    settings: Translators.settingsForPlan(context.runtimeSettings || {}, translatorPlan), allowDownload: true })?.inputs;
  return require("./graphics-inputs").inputs(install, source, { fallback });
}

module.exports = { id: manifest.id, manifest, detectGame: Detection.detectGame,
  metadataSources: ["sources/provider.js", "../shared/executable-candidates.js", "../shared/runtime/providers.js"],
  graphicsComputeHosts:[require("./runtime/compute-host"),require("./sikarugir/runtime/compute-host")],
  runtimeManagers, runtimeProviders, runtimeProvider: crossoverProvider,
  resolveGraphicsInputs, warmBackendLane,
  getRuntimeRequirements: async (entry, context) => [
    ...await require("./temporal").requirements(entry, context),
    ...await Translators.driverRequirements(context),
    ...await require("./temporal/vulkan-dlss").requirements(entry, context),
    ...await require('./runtime/winemac').requirements(entry, context),
    ...await require('./runtime/steam-bridge').requirements(entry, context)
  ],
  normalizeRuntimeId: runtimeId => providerForRuntime(runtimeId) ? runtimeId : manifest.runtime.default,
  filterRuntimeSupport: (entry, supported, settings, context) => supported.filter(runtimeId =>
    providerForRuntime(runtimeId)?.supportsEntry(entry, settings, context)),
  canLaunchRuntime: (runtimeId, entry, settings, context) => Boolean(providerForRuntime(runtimeId)?.canLaunchRuntime(runtimeId, entry, settings, context)),
  ensureRuntime: (entry, context) => providerForEntry(entry, context)?.ensureRuntime(entry, context),
  launchRuntime: (runtimeId, entry, context) => providerForRuntime(runtimeId)?.launchRuntime(runtimeId, entry, context) || null,
  resolveSaveLocations: (entry, context) => providerForEntry(entry, context)?.resolveSaveLocations?.(entry, context) || resolveSaveLocations(),
  settingsActions: crossoverSettingsActions,
  actions: {
    ...crossoverActions,
    revealWindowsFiles: (entry, _payload, context) => {
      const existing = Environments.readEnvironment(context.runtimeSettings?.environmentReference);
      const directory = existing?.prefixPath || providerForEntry(entry, context)?.runtimeDirectory?.(entry, context) || Launch.runtimeDirectory(entry, context);
      if (!fs.existsSync(directory)) throw new Error("Play the game once to create its Windows files.");
      if (typeof context.ui?.shell?.openPath === "function") return context.ui.shell.openPath(directory);
      if (typeof context.ui?.openPath === "function") return context.ui.openPath(directory);
      return { directory };
    }
  },
  __test: { supportsEntry, graphicsBackendOptions, translatorOptions } };

module.exports = require("../shared/decompilation/native").withTools(module.exports);
