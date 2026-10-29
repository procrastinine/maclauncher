const { createManagedJavaTool } = require("../../shared/runtime/managed-java-tool");

module.exports = createManagedJavaTool({ id: "ffdec", label: "JPEXS FFDec", owner: "jindrapetrik",
  repo: "jpexs-decompiler", jarName: "ffdec.jar", order: 220,
  releaseArtifact: release => {
    const match = /^version(\d+\.\d+\.\d+)$/.exec(release.tag_name || "");
    if (!match || Number(match[1].split(".")[0]) < 12) return null;
    const asset = release.assets?.find(asset => asset.name === `ffdec_${match[1]}.zip`);
    return asset ? { version: match[1], asset } : null;
  } });
