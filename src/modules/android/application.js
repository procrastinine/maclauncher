const Application = require("../shared/native-application");

// Preserve the existing Android identity, cache keys and exported helpers.
module.exports = {
  prepare(options, execute) {
    return Application.prepare({ nameFallback: "Android", applicationLabel: "Android", identifierPrefix: "com.maclauncher.android.", ...options }, execute);
  },
  isolation: Application.isolation,
  bundleName: title => Application.bundleName(title, "Android"),
  icns: png => Application.icns(png, "Android"),
  plist: Application.plist
};
