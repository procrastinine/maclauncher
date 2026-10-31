const { createManagedJavaTool, releaseAsset } = require("../../shared/runtime/managed-java-tool");
const Upstream = require("../../shared/runtime/upstream");

module.exports = createManagedJavaTool({
  id: "apktool", label: "Apktool", order: 245,
  standaloneJar: true, jarName: version => `apktool_${version}.jar`,
  upstream: Upstream.github({ repository: "iBotPeaches/Apktool", recognize: release => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(release.tag_name || "");
    // Apktool 3.0.2 and later provide the command contract used here.
    if (!match || Number(match[1]) < 3 || Number(match[1]) === 3 && Number(match[2]) === 0 && Number(match[3]) < 2) return null;
    const version = match.slice(1).join(".");
    const asset = releaseAsset(release, { names: [`apktool_${version}.jar`], pattern: /^apktool[-_.]/i, extensions: [".jar"] });
    return asset ? { version, assets: [asset] } : null;
  } })
});
