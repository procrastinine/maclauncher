// Graphics plans for one Wine launch, shared by every source: the translator
// plan and its private files, the MetalFX and DLSS selection, the Vulkan DLSS
// view, the NGX scene connection, the FidelityFX scene plan and the camera
// adapter plan. Packages that the plans use are recorded as in use.
const DLSS = require("../dlss");
const Translators = require("../../shared/runtime/wine-translators");
const TranslatorFiles = require("../../shared/runtime/translator-files");
const TranslatorEnvironment = require("../../shared/runtime/translator-environment-launch");

// `translatorFiles` is "always" when the source's graphics view needs a file
// generation for every plan, or "selected" when a plan without selected
// translator files keeps the engine's own loader.
async function resolve(entry, context, { source, install, settings, executableArchitecture, host, root, translatorFiles = "always",
  resolveTranslators = Translators.resolve, timing } = {}) {
  const translatorPlan = await resolveTranslators(install, source.id, context, { entry, executableArchitecture, host });
  timing?.("translators");
  settings = DLSS.withTemporalSelection(Translators.settingsForPlan(settings, translatorPlan), entry.effects, translatorPlan);
  const translatorEnvironment = TranslatorEnvironment.forLaunch(entry, context, Translators.environmentIds(translatorPlan, source.id)).values;
  const ngxScene = require("../temporal/ngx/connection").resolve({ requested: settings.dlss === true || DLSS.needsSceneInputs(entry.effects),
    runtimeId: source.id, install, translatorPlan, executableArchitecture });
  context.ngxSceneConnection = ngxScene;
  let translatorView = translatorFiles === "always" || TranslatorFiles.selectedDescriptions(translatorPlan).length
    ? await TranslatorFiles.prepareTranslatorFiles(translatorPlan, { userDataDir: context.userDataDir, layout: translatorPlan.layout, signal: context.signal }) : null;
  const vulkanDLSS = await require("../temporal/vulkan-dlss").prepare(entry, context, settings, translatorPlan, executableArchitecture, translatorView);
  translatorView = vulkanDLSS.view;
  const Temporal = require("../temporal");
  const scenePlan = Temporal.resolveScenePlan(entry, context, { settings, translatorPlan, verify: true, root });
  // A FidelityFX scene source requests no other Direct3D renderer.
  if (scenePlan) settings = { ...settings, dlss: context.runtimeSettings?.dlss === true || settings.dlssOptional === true };
  const cameraBridge = Temporal.resolvePlan(entry, context, { install, settings, translatorPlan, host,
    runtimeId: source.id, verify: true, root, automatic: settings.dlss !== true });
  if (cameraBridge) settings = { ...settings, dlss: true };
  if (cameraBridge?.dependency) await context.useRuntime?.(cameraBridge.dependency);
  for (const dependency of scenePlan?.dependencies || []) await context.useRuntime?.(dependency);
  return { settings, translatorPlan, translatorEnvironment, translatorView, vulkanDLSS, ngxScene, scenePlan, cameraBridge };
}

module.exports = { resolve };
