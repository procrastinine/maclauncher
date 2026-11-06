// Vulkan packages without a Runtimes row; see core/component-service.js.
const { sceneManager } = require("./managed");
module.exports = [
  require("../runtime/runtime-components").fromRuntimeManager(sceneManager, { users: ["Graphics effects in CrossOver and Sikarugir games"],
    description: "A MoltenVK build that records a Windows game's Vulkan scene for temporal upscaling and frame generation, beside the selected Vulkan driver." })
];
