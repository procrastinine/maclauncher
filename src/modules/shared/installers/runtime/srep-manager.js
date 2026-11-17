const fs = require("node:fs");
const path = require("node:path");
const Upstream = require("../../runtime/upstream");
const Native = require("../../runtime/local-native");
const { createPinnedNativeManager } = require("../../runtime/pinned-native-manager");
const Zip = require("../../runtime/zip");
const { getHostCapabilities } = require("../../runtime/host-capabilities");

const SOURCE = "https://github.com/KarmSakha/mac-game-porter/releases";
function recognize(release) {
  const asset = release.assets?.find(asset => /^MacGamePorter[.]zip$/i.test(asset.name) && Upstream.githubDigest(asset)?.algorithm === "sha256");
  if (!asset) return null;
  return { version: String(release.tag_name).replace(/^v(?=\d)/, ""), assets: [asset],
    details: { hostArchitectures: ["arm64"], license: "SREP 3.93 — Bulat Ziganshin — all rights reserved", publisherRelease: release.html_url } };
}
const source = Upstream.github({ repository: "KarmSakha/mac-game-porter", allArchitectures: true, recognize });
async function extractSrep(archive, destination, signal) {
  signal?.throwIfAborted();
  const directory = Zip.readZipEntries(archive);
  const entries = directory?.entries.filter(entry => /(?:^|\/)Contents\/Resources\/tools\/srep$/.test(entry.name));
  if (entries?.length !== 1) throw new Error("This publisher release does not contain one SREP executable.");
  const bytes = Zip.readZipEntry(archive, entries[0], { maxOutputBytes: 32 * 1024 ** 2 });
  if (!bytes) throw new Error("The publisher's SREP executable could not be read.");
  const bin = path.join(destination, "bin"); fs.mkdirSync(bin);
  const executable = path.join(bin, "srep"); fs.writeFileSync(executable, bytes, { flag: "wx", mode: 0o755 });
  if (!Native.readMachOArchitectures(executable).includes("arm64")) throw new Error("The publisher's SREP executable has no Apple Silicon code.");
  signal?.throwIfAborted();
}
function inspectRuntime(options) {
  const install = Native.resolveLocalRuntime(options);
  if (!install.architectures.includes("arm64")) throw new Error("SREP requires an Apple Silicon executable.");
  return install;
}
function createManager(dependencies = {}) {
  const manager = createPinnedNativeManager({ id: "srep", label: "SREP", upstream: source, sourceUrl: SOURCE,
    supportsDefault: true, resolveExecutable: root => path.join(root, "bin/srep"), inspectRuntime,
    sourceDescription: "SREP 3.93 by Bulat Ziganshin, all rights reserved; downloaded from mac-game-porter releases.",
    dependencies: { extractArchive: extractSrep, ...dependencies } });
  manager.ui = { groupId: "tools", tabLabel: "Tools", sectionLabel: "SREP", order: 102, memberOrder: 102, management: "managed" };
  manager.selectedForInstaller = context => {
    const host = dependencies.hostCapabilities || getHostCapabilities();
    if (host.hardwareArch !== "arm64" || context.freeArcSrepDisabled) return null;
    const selected = manager.resolveSelection(context.entry, context.settings, context.userDataDir);
    return selected.ready ? selected : null;
  };
  return manager;
}
module.exports = Object.assign(createManager(), { createManager, recognize, extractSrep });
