const path = require('node:path');
const { usedForApi } = require('../../../shared/runtime/translator-roles');
const { readPeExports } = require('../../../shared/runtime/pe-exports');
const { wineLayout } = require('../../../shared/runtime/wine-layout');
// Inspect the actual used translator and selected Wine environment offline.
// Native context BEGIN still owns device/profile/provider admission; exports
// establish transport only and never advertise RR/FG replacement availability.
const TRANSLATOR = Object.freeze(['MacLauncherVkd3dSceneContext1', 'MacLauncherVkd3dResolveSceneImage1', 'MacLauncherVkd3dRecordScene2']);
const WINE = Object.freeze(['MacLauncherWineVulkanSceneAPI1', 'MacLauncherWineVulkanSceneContext1', 'MacLauncherWineVulkanRecordScene2']);
function exportsMatch(file, names, inspect) {
  let pe;try { pe = inspect(file); } catch { return false; }
  return pe && names.every(name => { const symbol = pe.exports?.get(name);return symbol?.executable && !symbol.forwarded; });
}
function resolve({ runtimeId, install, translatorPlan, executableArchitecture }, { inspect = readPeExports, layoutFor = wineLayout } = {}) {
  if (!['crossover', 'sikarugir'].includes(runtimeId) || !install || executableArchitecture !== 'x86_64') return null;
  const translator = usedForApi(translatorPlan, 'd3d12');
  if (translator?.engine !== 'vkd3d-proton') return null;
  const library = translator.files?.find(file => file.format === 'pe' && file.machine === 0x8664 && exportsMatch(file.path, TRANSLATOR, inspect));
  if (!library) return null;
  const layout = layoutFor(install);
  if (!layout.unixRoot || !layout.primaryWindowsRoot) return null;
  const wine = path.join(layout.primaryWindowsRoot, 'winevulkan.dll');
  if (!exportsMatch(wine, WINE, inspect)) return null;
  return { runtimeId, translatorId: translator.id, translator: library.path, wine,
    nativeWine: path.join(layout.unixRoot, 'winevulkan.so'), nativeMacDriver: path.join(layout.unixRoot, 'winemac.so'), transport: 2,
    originalOutputRetained: true, activationReady: false };
}
function environment(connection, { macDriverPath = connection?.nativeMacDriver } = {}) {
  return { MACLAUNCHER_NGX_SCENE_ENABLE: connection ? '1' : '0', MACLAUNCHER_NGX_WINEMAC_LIBRARY: connection && path.isAbsolute(macDriverPath || '') ? macDriverPath : '' };
}
module.exports = { TRANSLATOR, WINE, resolve, environment };
