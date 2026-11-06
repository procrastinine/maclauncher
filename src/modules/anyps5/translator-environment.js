// Environment variables of AnyPS5. Locked names are the input and Vulkan
// selections of main.js and input.js.
module.exports = [
  { id: "anyps5", label: "AnyPS5", managerIds: ["anyps5"],
    description: "Applies to every PlayStation 5 game that runs with AnyPS5.",
    keys: [
      { key: "APS5_PLAYGO_UNLISTED_CHUNKS", description: "PlayGo state of chunks that the package does not list.", launcher: "MacLauncher sets installed." }
    ],
    locked: [
      { key: "ANYPS5_VULKAN_LIBRARY", reason: "Names the selected Vulkan library." },
      { key: "ANYPS5_INPUT_CONFIG", reason: "The launcher writes the controller bindings from Runtime Settings." },
      { key: "ANYPS5_MOUSE_ROUTING", reason: "Set by Mouse input in Runtime Settings." },
      { prefix: "DYLD_", reason: "The launcher sets the runtime's library paths." }
    ] }
];
