const { createManagedJavaTool } = require("../../shared/runtime/managed-java-tool");

module.exports = createManagedJavaTool({
  id: "apktool", label: "Apktool", owner: "iBotPeaches", repo: "Apktool", order: 245,
  standaloneJar: true, jarName: version => `apktool_${version}.jar`,
  releaseArtifact: release => {
    const match = /^v(3\.\d+\.\d+)$/.exec(release.tag_name || "");
    if (!match || Number(match[1].split(".")[1]) === 0 && Number(match[1].split(".")[2]) < 2) return null;
    const asset = release.assets?.find(row => row.name === `apktool_${match[1]}.jar`);
    return asset ? { version: match[1], asset } : null;
  }
});
