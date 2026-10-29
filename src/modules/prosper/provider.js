const fs = require("node:fs");
const path = require("node:path");
const manifest = require("./manifest.json");
const Vulkan = require("../shared/vulkan");
const Native = require("../shared/runtime/local-native");
const Writable = require("../shared/writable-input");
const { spawnForegroundNativeGame } = require("../shared/runtime/native-focus");
const { prepareGame, resolveSaveLocations } = require("./prepare");
const vulkanOptions = Object.freeze({ architecture: "x64", preferredBackend: "kosmickrisp", required: true });
function supportsEntry(entry) {
  return (entry?.moduleId === "anyps5" || entry?.gameType === "ps5") && entry.moduleData?.inspectionOnly !== true &&
    ["elf", "self"].includes(entry.moduleData?.format);
}
function createProvider({ manager = require("./runtime/manager"), spawn = spawnForegroundNativeGame, vulkan = Vulkan } = {}) {
  return { runtimeId: "prosper", managerId: "prosper", runtime: manifest.runtime.entries.prosper, supportsEntry,
    actions: { listVulkanRuntimes: (_entry, _payload, context) => vulkan.choices(context, vulkanOptions) },
    settingsActions: { listVulkanRuntimes: (_payload, context) => vulkan.choices(context, vulkanOptions) },
    supports: { saveLocation: true, saveEditing: false, cheats: false, cheatsPatcher: false }, resolveSaveLocations,
    resolveGraphicsInputs: () => ({ architecture: "x86_64" }),
    ensureRuntime(entry, context) {
      const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
      if (selected.ready) return null;
      throw new Error("Add a local Prosper macOS executable, app or runtime directory in Runtimes.");
    },
    getRuntimeRequirements: (_entry, context) => vulkan.requirements(context, vulkanOptions),
    async launchRuntime(runtimeId, entry, context) {
      if (runtimeId !== "prosper") return null;
      const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
      if (!selected.ready) throw new Error(selected.reason);
      const executable = selected.install.executablePath;
      if (!fs.statSync(executable).isFile() || !Native.readMachOArchitectures(executable).includes("x86_64")) throw new Error("Prosper's Intel macOS executable is unavailable.");
      await context.ensureRosetta?.();
      const prepared = await prepareGame(entry, context), graphics = vulkan.resolve(context, vulkanOptions);
      if (!graphics) throw new Error("A compatible Intel Vulkan 1.4 runtime is required.");
      const libraries = path.join(prepared.root, "vulkan");
      Writable.assertOwnDirectory(prepared.root, libraries);
      const alias = path.join(libraries, "libvulkan.1.dylib");
      let existing; try { existing = fs.lstatSync(alias); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (existing && !existing.isSymbolicLink()) throw new Error("Prosper's private Vulkan path contains an unexpected file.");
      if (existing && fs.readlinkSync(alias) !== graphics.library) { fs.unlinkSync(alias); existing = null; }
      if (!existing) fs.symlinkSync(graphics.library, alias);
      context.recordRuntimeUse?.({ managerId: "prosper", version: selected.version, sectionId: "default", sourcePath: selected.install.installDir });
      const args = ["--dump", prepared.dump, "--guest-executable", prepared.executable, "--no-pick", ...(context.runtimeSettings?.showFps ? ["--fps"] : []), ...(context.gameArguments || [])];
      return spawn({ context, executablePath: executable, args, needsRosetta: true, options: { cwd: prepared.root, gameArguments: false,
        env: { ...process.env, ...prepared.environment, ...vulkan.environment(graphics, prepared.root), PROSPER_VULKAN_LIB: graphics.library,
          DYLD_LIBRARY_PATH: [libraries, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(":") } } });
    }
  };
}
module.exports = { createProvider, supportsEntry };
