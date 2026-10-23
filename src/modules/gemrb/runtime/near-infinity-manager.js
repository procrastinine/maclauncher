const { createManagedJavaTool } = require("../../shared/runtime/managed-java-tool");

module.exports = createManagedJavaTool({ id: "near-infinity", label: "Near Infinity", owner: "Argent77",
  repo: "NearInfinity", jarName: "NearInfinity.jar", order: 230,
  pins: [{ version: "2.4-20260616", tag: "v2.4-20260616", bytes: 7945911,
    sha256: "5f090afaab5b4ac6d5b1af552a17aeeeb76a255e27efd42eb8a4b1a50512c1cd",
    url: "https://github.com/Argent77/NearInfinity/releases/download/v2.4-20260616/NearInfinity-20260616.zip",
    sourceUrl: "https://github.com/Argent77/NearInfinity/releases/tag/v2.4-20260616" }],
  releaseArtifact: release => {
    const match = /^v(\d+(?:\.\d+)+)-(\d{8})$/.exec(release.tag_name || "");
    if (!match) return null;
    const [major, minor] = match[1].split(".").map(Number);
    if (major < 2 || major === 2 && minor < 4) return null;
    const asset = release.assets?.find(asset => asset.name === `NearInfinity-${match[2]}.zip`);
    return asset ? { version: `${match[1]}-${match[2]}`, asset } : null;
  } });
