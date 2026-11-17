const Origins = require('../core/runtime-install-origins');

// Play and live preparation share Runtimes' setup actions. Keep their automatic
// origin without changing explicit setup actions or their saved preferences.
async function installSetup({ manager, userDataDir, settings, plan, install, logger }) {
  let installedBefore;
  if (plan.automatic === true) {
    const state = manager.getState({ userDataDir, settings: settings?.runtimes?.[manager.id], runtimeSettings: settings?.runtimes });
    installedBefore = (state.sections?.length ? state.sections : [{ ...state, id: 'default' }]).flatMap(section =>
      (section.installed || []).map(row => ({ ...row, sectionId: section.id || 'default' })));
  }
  const result = await install();
  if (installedBefore && result?.version != null && String(result.version) && result.ready !== false)
    Origins.recordPlayInstall({ manager, userDataDir, settings, plan, result, installedBefore, logger });
  return result;
}

module.exports = { installSetup };
