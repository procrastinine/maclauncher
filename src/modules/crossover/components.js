const Components = require("../shared/runtime/runtime-components");

// CrossOver and Sikarugir downloads without a Runtimes row; see
// core/component-service.js. The Steam client bridge and Valve's client files
// have the bridge's own Runtimes row.
module.exports = [
  Components.fromRuntimeManager(require("./runtime/winemac"), { users: ["CrossOver"],
    description: "An optional package matched to one CrossOver release and build. It adds Vulkan external memory, semaphore and fence sharing to CrossOver's Mac driver, and Play offers it, after consent, when that release runs a Vulkan game." }),
  // Their files are Windows libraries, named by their Windows CPU.
  ...Object.values(require("./temporal/support-manager").apiManagers).map(manager => Components.fromRuntimeManager(manager, {
    users: ["Graphics effects in CrossOver and Sikarugir games"], windows: true,
    description: manager.id === "winevulkan-scene"
      ? "Adapted winevulkan modules that record a Windows game's Vulkan scene for graphics effects while forwarding its original calls."
      : "A proxy for a Windows game's FidelityFX library that keeps its exports and the original library's GPU work." }))
];
