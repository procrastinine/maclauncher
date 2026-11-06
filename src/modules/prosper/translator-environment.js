// Environment variables of Prosper. Locked names are the save, game file,
// configuration and Vulkan values of provider.js and prepare.js.
const saves = "Decides where Prosper keeps saves, which the launcher tracks.";
module.exports = [
  { id: "prosper", label: "Prosper", managerIds: ["prosper"],
    description: "Applies to every PlayStation 5 game that runs with Prosper.",
    keys: [],
    locked: [
      ...["PROSPER_SAVE0", "PROSPER_SAVEDATA_DIR", "HOME", "XDG_DATA_HOME"].map(key => ({ key, reason: saves })),
      { key: "PROSPER_GUEST_FS", reason: "The launcher serves the game's files through Prosper's guest file system." },
      { key: "PROSPER_APP_CONFIG", reason: "Set by Configuration file in Runtime Settings." },
      { key: "PROSPER_VULKAN_LIB", reason: "Names the selected Vulkan library." },
      { prefix: "DYLD_", reason: "The launcher sets the runtime's library paths." }
    ] }
];
