const path = require("node:path");
const { readJsonObject } = require("../../core/json-files");
const Vulkan = require("../shared/vulkan");
const { managers } = require("../shared/vulkan/libraries");
const { confirmToolInstall } = require("../shared/runtime/tool-install");

// The pinned ANGLE Metal provider's mtl_common.h declares GLES 3.0. This is a
// provider-selection ceiling, never a replacement for actual EGL capability
// queries or an application API check. ANGLE's Vulkan backend still runs GLES.
const METAL_GLES_CEILING = 0x30000;

function explicitBackend(entry, context) {
  // A caller that already normalized the entry retains its original overrides
  // separately. Defaults inserted by normalization are not explicit choices.
  const game = Object.hasOwn(context, "runtimeSettingsOverrides")
    ? context.runtimeSettingsOverrides : entry.runtimeSettings?.klepton;
  const moduleSettings = context.settings?.modules?.android?.runtimeSettings?.klepton;
  const stored = context.userDataDir
    ? readJsonObject(path.join(context.userDataDir, "runtimes", "klepton", "settings.json")) : null;
  return game?.angleBackend ?? moduleSettings?.angleBackend ?? stored?.angleBackend;
}

async function moltenVk(context, dependencies) {
  const available = (dependencies.installedVulkan || Vulkan.installed)(context);
  const installed = available.find(provider => provider.backend === "moltenvk");
  const resolve = dependencies.resolveVulkan || Vulkan.resolve;
  const selectedContext = id => ({ ...context, runtimeSettings: { ...context.runtimeSettings, vulkanRuntime: id } });
  if (installed) return resolve(selectedContext(installed.id));
  const manager = dependencies.moltenVkManager || managers.find(provider => provider.backend === "moltenvk");
  const selection = manager.resolveSelection({}, context.settings, context.userDataDir, { verification: "status" });
  await (dependencies.confirmGraphicsInstall || confirmToolInstall)(context, { manager, version: selection.version,
    requiresDownload: true, label: "MoltenVK " + selection.version,
    detail: "Required for this game's OpenGL ES version." });
  await manager.installRuntime({ ...context, version: selection.version });
  context.onRuntimeStateChange?.();
  const result = await resolve(selectedContext("moltenvk:" + selection.version));
  if (!result || result.backend !== "moltenvk") throw new Error("MoltenVK is unavailable after installation.");
  return result;
}

/** Keep the default and saved preferences; adapt only an implicit incompatible
 * Metal choice to the required GLES API using the existing Vulkan supplier. */
async function resolveGraphics(entry, context, payload, metadata, { renderer, vulkan }, dependencies = {}) {
  if (renderer !== "metal" || (metadata.requiredGlEsVersion || 0) <= METAL_GLES_CEILING ||
      explicitBackend(entry, context) === "metal" || payload.profile?.angleVulkanVersion !== 1)
    return { renderer, vulkan };
  const requested = context.runtimeSettings?.vulkanRuntime || "auto";
  const native = context.runtimeSettings?.execution === "art";
  // ART's original gralloc imports need MoltenVK's Metal texture attachment
  // interface. A selected native Vulkan library remains an explicit preference.
  if (native && vulkan?.backend !== "moltenvk" && requested !== "auto")
    throw new Error("This game's OpenGL ES version requires MoltenVK for native Android execution. Select MoltenVK in game Settings.");
  if (!vulkan || native && vulkan.backend !== "moltenvk") vulkan = await moltenVk(context, dependencies);
  const required = metadata.requiredGlEsVersion;
  context.logger?.info?.("[android] OpenGL ES " + (required >>> 16) + "." + (required & 0xffff) +
    " uses ANGLE Vulkan with " + (vulkan.label || vulkan.id) + ".");
  return { renderer: "vulkan", vulkan };
}

module.exports = { METAL_GLES_CEILING, explicitBackend, resolveGraphics };
