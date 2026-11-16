const path = require("node:path");
const Sources = require("../../crossover/sources");
const Reader = require("./runtime/innoextract-manager");
const Decoders = require("./runtime/freearc-manager");
const Rosetta = require("../runtime/rosetta");
const Architecture = require("../runtime/architecture");
const { createAbortError, throwIfAborted } = require("../runtime/download-utils");
const { installerError } = require("./inno-header");
const defaultWine = () => require("../../crossover/manifest.json").runtime.default;
async function prepareDownloads(context, dependencies = {}) {
  const reader = dependencies.reader || Reader, decoders = dependencies.decoders || Decoders;
  const source = (dependencies.sources || Sources).get(context.runtimeId || defaultWine());
  if (!source) throw installerError("The selected Wine runtime is unavailable for installer decoding.", "INSTALLER_TOOL_MISSING");
  const wineManager = source.manager(), entry = context.entry || { gameId: context.gameId };
  const select = (manager, version) => manager.resolveSelection(entry, context.settings, context.userDataDir, version ? { version } : {});
  const rows = [
    { manager: reader, selection: context.helper ? { ready: true } : select(reader, context.version), version: context.version },
    { manager: decoders, selection: context.freeArcTools ? { ready: true } : select(decoders) },
    { manager: wineManager, selection: select(wineManager), wine: true }
  ];
  if (!rows[2].selection.ready && source.downloads === false) throw installerError("The selected Wine runtime cannot be downloaded by the installer reader.", "INSTALLER_TOOL_MISSING");
  const rosetta = dependencies.rosetta || Rosetta;
  const requiresRosetta = dependencies.requiresRosetta || (selection => selection.requiresRosetta === true || selection.install?.needsRosetta === true || Architecture.requiresRosetta(selection.architecture));
  const needsRosetta = rows.some(row => requiresRosetta(row.selection));
  const status = needsRosetta ? rosetta.getStatus({ includeVersion: false }) : null;
  const ros = status && !status.available ? rosetta.prerequisitePlan(status) : null;
  const missing = rows.filter(row => !row.selection.ready);
  const item = row => {
    const selection = row.selection, pin = row.manager.core?.catalog?.find(pin => pin.version === selection.version);
    const bytes = selection.downloadBytes || selection.bytes || pin?.downloadBytes || pin?.projectPackage?.archiveBytes;
    return { managerId: row.manager.id, label: row.manager.label || row.manager.id,
      ...(selection.versionLabel || selection.version ? { versionLabel: selection.versionLabel || selection.version } : {}),
      ...(Number.isFinite(bytes) && bytes > 0 ? { bytes } : {}) };
  };
  const items = [...missing.map(item), ...(ros ? [ros] : [])];
  let approvedContext = { ...context, confirmRuntimeInstall: async () => { throw createAbortError("The installer download requirements changed."); } };
  if (items.length) {
    const name = entry.name || path.basename(entry.gamePath || context.inputPath || "") || "this game";
    const [first, ...companions] = items;
    const plan = { ...first, kind: "tool", requiresDownload: true, companions,
      message: `Download what ${name} needs?`, confirmLabel: "Download and Continue",
      ...(ros ? { licenseRequired: true, licenseUrl: ros.licenseUrl } : {}) };
    const consent = await context.confirmRuntimeInstall?.(plan);
    throwIfAborted(context.signal);
    if (consent !== true && consent?.approved !== true) throw createAbortError("Installer preparation canceled.");
    const permitted = new Map([...missing.map(row => [row.manager.id, row.selection.version]), ...(ros ? [[ros.managerId, null]] : [])]);
    approvedContext = { ...context, licenseAccepted: consent?.licenseAccepted === true,
      confirmRuntimeInstall: async plan => {
        const id = plan.managerId || plan.prerequisiteId;
        if (!permitted.has(id) || permitted.get(id) && plan.version && permitted.get(id) !== plan.version) throw createAbortError("The installer download requirements changed.");
        return consent;
      } };
    const install = async row => {
      let selected = row.selection;
      if (!selected.version || selected.discoveryRequired) {
        await row.manager.refreshCatalog({ ...approvedContext, force: false }); context.onRuntimeStateChange?.();
        selected = select(row.manager, row.version);
      }
      if (!selected.version) throw installerError("No " + (row.manager.label || row.manager.id) + " versions are available to download.", "INSTALLER_TOOL_MISSING");
      await row.manager.installRuntime({ ...approvedContext, version: selected.version }); context.onRuntimeStateChange?.();
    };
    const results = await Promise.allSettled([...missing.map(install), ...(ros ? [rosetta.ensure(approvedContext)] : [])]);
    const failed = results.find(result => result.status === "rejected"); if (failed) throw failed.reason;
  }
  const selected = select(wineManager);
  if (!selected.ready) throw installerError("The selected Wine runtime is unavailable after preparation.", "INSTALLER_TOOL_MISSING");
  return { context: approvedContext, wine: { source, manager: wineManager, install: selected.install, version: selected.version } };
}
module.exports = { prepareDownloads };
