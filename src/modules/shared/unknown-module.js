const UNKNOWN_MODULE = {
  id: "unknown",
  manifest: {
    id: "unknown",
    family: "unknown",
    label: "Unknown",
    shortLabel: "Unknown",
    gameType: "web",
    runtime: {
      default: "electron",
      supported: ["electron", "nwjs", "native"],
      entries: {
        electron: {
          label: "Electron",
          settings: {
            defaults: {
              enableProtections: true
            },
            fields: [
              {
                key: "enableProtections",
                type: "boolean",
                label: "Enable protections"
              }
            ]
          }
        },
        nwjs: {
          label: "NW.js",
          settings: {
            defaults: {
              enableProtections: true
            },
            fields: [
              {
                key: "enableProtections",
                type: "boolean",
                label: "Enable protections"
              }
            ]
          }
        },
        native: {
          label: "Native app"
        }
      },
      labels: {
        electron: "Electron",
        nwjs: "NW.js",
        native: "Native app"
      },
      hosted: {
        id: "electron",
        fallback: "nwjs"
      }
    },
    supports: {
      cheats: false,
      cheatsPatcher: false,
      saveEditing: false,
      saveLocation: false
    },
    settingsDefaults: {}
  }
};

module.exports = {
  UNKNOWN_MODULE
};
