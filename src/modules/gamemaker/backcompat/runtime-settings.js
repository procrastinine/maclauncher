// App v0.5.1 official-studio stored this choice as a boolean. The raw profile,
// game-record and runtime-settings migrations consume these facts once before
// current select normalization. No normal getter or Play path loads this file.
// Remove when upgrades from the boolean settings layout are no longer supported.
module.exports = {
  runtimeSettingAliases: [{
    runtimeId: "official-studio",
    key: "softwareOpenGLFallback",
    values: [
      { value: true, replacement: "enabled" },
      { value: false, replacement: "disabled" }
    ]
  }]
};
