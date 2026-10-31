const fs = require("node:fs");
const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createSource } = require("./catalog");
const { extractPayload } = require("../../shared/runtime/release-files");

const SOURCE_URL = "https://downloads.scummvm.org/frs/scummvm-tools/";

// The command-line tool and the license files beside it, from any archive format or folder.
async function extractTools(archive, destination, signal) {
  return extractPayload(archive, destination, signal, { payloadName: "scummvm-tools-cli", project: "ScummVM Tools", copy: (source, target) => {
    fs.copyFileSync(source, target); fs.chmodSync(target, fs.statSync(source).mode);
    const folder = path.dirname(source);
    for (const file of fs.readdirSync(folder).filter(name => /^(?:License|ScummVM ReadMe|News)/i.test(name))) {
      const candidate = path.join(folder, file);
      if (fs.lstatSync(candidate).isFile()) fs.copyFileSync(candidate, path.join(destination, file));
    }
  } });
}
const source = createSource({ sourceUrl: SOURCE_URL, prefix: "scummvm-tools", project: "ScummVM Tools" });
function createManager({ dependencies = {} } = {}) {
  return createPinnedNativeManager({ id: "scummvm-tools", label: "ScummVM Tools", supportsDefault: true, sourceUrl: SOURCE_URL,
    upstream: source,
    projectBuilds: { projectId: "scummvm-tools", repository: "procrastinine/maclauncher-builds", upstreamMacDownloads: true },
    resolveExecutable: root => path.join(root, "scummvm-tools-cli"), dependencies: { extractArchive: extractTools, ...dependencies } });
}

module.exports = createManager();
module.exports.createManager = createManager;
