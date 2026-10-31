const { createManagedJavaTool, releaseAsset } = require("../../shared/runtime/managed-java-tool");
const Upstream = require("../../shared/runtime/upstream");

module.exports = createManagedJavaTool({
  id: "jadx", label: "JADX", order: 240,
  jarName: version => `lib/jadx-${version}-all.jar`, mainClass: "jadx.cli.JadxCLI",
  upstream: Upstream.github({ repository: "skylot/jadx", recognize: release => {
    const match = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name || "");
    if (!match) return null;
    const [major, minor, patch] = match[1].split(".").map(Number);
    // The CLI contract includes --config none and read-only mappings modes.
    if (major < 1 || major === 1 && (minor < 5 || minor === 5 && patch < 6)) return null;
    const asset = releaseAsset(release, { names: [`jadx-${match[1]}.zip`], pattern: /^jadx[-_.]/i });
    return asset ? { version: match[1], assets: [asset] } : null;
  } })
});
