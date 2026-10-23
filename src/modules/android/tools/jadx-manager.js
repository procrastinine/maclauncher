const { createManagedJavaTool } = require("../../shared/runtime/managed-java-tool");

module.exports = createManagedJavaTool({
  id: "jadx", label: "JADX", owner: "skylot", repo: "jadx", order: 240,
  jarName: version => `lib/jadx-${version}-all.jar`, mainClass: "jadx.cli.JadxCLI",
  pins: [{ version: "1.5.6", tag: "v1.5.6", bytes: 72646741,
    sha256: "545ea2be9c242511bc145755cf4bda2485ade42966e096f8b4d3da2a230e8974",
    url: "https://github.com/skylot/jadx/releases/download/v1.5.6/jadx-1.5.6.zip",
    sourceUrl: "https://github.com/skylot/jadx/releases/tag/v1.5.6" }],
  releaseArtifact: release => {
    const match = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name || "");
    if (!match) return null;
    const [major, minor, patch] = match[1].split(".").map(Number);
    // The CLI contract includes --config none and read-only mappings modes.
    if (major < 1 || major === 1 && (minor < 5 || minor === 5 && patch < 6)) return null;
    const asset = release.assets?.find(row => row.name === `jadx-${match[1]}.zip`);
    return asset ? { version: match[1], asset } : null;
  }
});
