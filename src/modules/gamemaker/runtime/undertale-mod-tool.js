const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const Upstream = require("../../shared/runtime/upstream");
const { ARCHIVE_FORMATS, archiveFormat, locatePackaged } = require("../../shared/runtime/release-files");
const { isMacName } = require("../../shared/runtime/archive");

// UTMT publishes UTMT_CLI_v<version>-macOS.zip for Apple Silicon and
// -macOS-x86.zip for Intel Macs. A renamed CLI download, another archive
// format or a universal build is used as well; the current names win.
const token = (name, words) => new RegExp(`(?:^|[._-])(?:${words})(?:[._-]|$)`, "i").test(name);
function cpu(name) {
  return token(name, "universal|universal2") ? "universal" : token(name, "x86|x86_64|x64|amd64|intel") ? "x64" : "arm64";
}
function macCliAssets(assets, cliVersion) {
  const preferred = ["", "-x86"].map(suffix => `UTMT_CLI_v${cliVersion}-macOS${suffix}.zip`);
  const rank = asset => preferred.includes(asset.name) ? preferred.indexOf(asset.name) : preferred.length + ARCHIVE_FORMATS.indexOf(archiveFormat(asset.name));
  const selected = new Map();
  for (const asset of (assets || []).filter(asset => token(asset?.name || "", "cli") && isMacName(asset.name) && archiveFormat(asset.name) &&
    !token(asset.name, "linux|windows|win|debug|symbols|dsym|src|source")).sort((a, b) => rank(a) - rank(b))) {
    const key = cpu(asset.name) === "x64" ? "x64" : "native";
    if (!selected.has(key)) selected.set(key, asset);
  }
  return [...selected.values()];
}
// Each CPU build is its own version, named after the release and the CPU.
const upstream = Upstream.github({ repository: "UnderminersTeam/UndertaleModTool", allArchitectures: true,
  recognize: release => {
    const cliVersion = String(release.tag_name || "").replace(/^v(?=\d)/, "");
    if (!/^\d+(?:\.\d+)+$/.test(cliVersion)) return null;
    return macCliAssets(release.assets, cliVersion).map(asset => {
      const architecture = cpu(asset.name);
      return { version: `${cliVersion}-${architecture === "x64" ? "x86_64" : "native-macos"}`, architecture, assets: [asset] };
    });
  } });
// The archive holds UndertaleModCli; a later archive may place it in a folder.
const resolveExecutable = root => locatePackaged(root, "UndertaleModCli") || path.join(root, "UndertaleModCli");

// Architecture is part of each discovered release identity.
const manager = createPinnedNativeManager({
  id: "undertale-mod-cli", label: "UndertaleModTool CLI", supportsDefault: true, upstream,
  importLocal: true,
  sourceUrl: "https://github.com/UnderminersTeam/UndertaleModTool/releases",
  resolveExecutable
});

module.exports = { manager, upstream, resolveExecutable };
