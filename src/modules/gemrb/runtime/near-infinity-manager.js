const { createManagedJavaTool } = require("../../shared/runtime/managed-java-tool");

module.exports = createManagedJavaTool({ id: "near-infinity", label: "Near Infinity", owner: "Argent77",
  repo: "NearInfinity", jarName: "NearInfinity.jar", order: 230,
  releaseArtifact: release => {
    const match = /^v(\d+(?:\.\d+)+)-(\d{8})$/.exec(release.tag_name || "");
    if (!match) return null;
    const [major, minor] = match[1].split(".").map(Number);
    if (major < 2 || major === 2 && minor < 4) return null;
    const asset = release.assets?.find(asset => asset.name === `NearInfinity-${match[2]}.zip`);
    return asset ? { version: `${match[1]}-${match[2]}`, asset } : null;
  } });
