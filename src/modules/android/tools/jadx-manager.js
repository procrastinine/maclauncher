const { createManagedJavaTool } = require("../../shared/runtime/managed-java-tool");

module.exports = createManagedJavaTool({
  id: "jadx", label: "JADX", owner: "skylot", repo: "jadx", order: 240,
  jarName: version => `lib/jadx-${version}-all.jar`, mainClass: "jadx.cli.JadxCLI",
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
