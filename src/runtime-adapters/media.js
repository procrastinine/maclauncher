'use strict';
const path = require('node:path');

// The plan supplies the selected library view and its plugin/scanner paths.
// Preparation and compatibility belong to the shared native-library owner.
function apply({ parts, environment = {} }) {
  const result = { ...environment }, plugins = parts?.plugins || [];
  if (plugins.length) {
    result.GST_PLUGIN_PATH = plugins.join(path.delimiter);
    result.GST_PLUGIN_PATH_1_0 = result.GST_PLUGIN_PATH;
  }
  if (parts?.scanner) result.GST_PLUGIN_SCANNER_1_0 = parts.scanner;
  return { environment: result, nativeLibrary: parts?.core || null };
}
// GStreamer's Darwin library version is minor * 100 + micro + 1.
// Decode only a consistent core-library identity; framework plist versions
// (including their nano field) retain precedence in the shared reader.
function libraryVersion(description) {
  const versions = new Set();
  for (const file of description?.files || []) {
    const abi = /^libgstreamer-(\d+)\./.exec(path.basename(file.path));
    if (!abi) continue;
    for (const slice of file.slices || []) {
      const [current, minor, patch] = String(slice.installName?.currentVersion || "").split(".").map(Number);
      if (!Number.isSafeInteger(current) || current < 1 || minor !== 0 || patch !== 0) return "";
      const release = current - 1;
      versions.add(`${abi[1]}.${Math.floor(release / 100)}.${release % 100}`);
    }
  }
  return versions.size === 1 ? [...versions][0] : "";
}
module.exports = { apply, libraryVersion };
