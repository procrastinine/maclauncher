const { createManagedJavaTool, releaseAsset } = require("../../shared/runtime/managed-java-tool");
const Upstream = require("../../shared/runtime/upstream");

module.exports = createManagedJavaTool({ id: "near-infinity", label: "Near Infinity", jarName: "NearInfinity.jar", order: 230,
  upstream: Upstream.github({ repository: "Argent77/NearInfinity", recognize: release => {
    const match = /^v?(\d+(?:\.\d+)+)-(\d{8})$/.exec(release.tag_name || "");
    if (!match) return null;
    const [major, minor] = match[1].split(".").map(Number);
    if (major < 2 || major === 2 && minor < 4) return null;
    const asset = releaseAsset(release, { names: [`NearInfinity-${match[2]}.zip`], pattern: /^NearInfinity[-_.]/i });
    return asset ? { version: `${match[1]}-${match[2]}`, assets: [asset] } : null;
  } }) });
