const { createManagedJavaTool, releaseAsset } = require("../../shared/runtime/managed-java-tool");
const Upstream = require("../../shared/runtime/upstream");

module.exports = createManagedJavaTool({ id: "ffdec", label: "JPEXS FFDec", jarName: "ffdec.jar", order: 220,
  upstream: Upstream.github({ repository: "jindrapetrik/jpexs-decompiler", recognize: release => {
    const match = /^(?:version|v)?(\d+\.\d+\.\d+)$/.exec(release.tag_name || "");
    if (!match || Number(match[1].split(".")[0]) < 12) return null;
    const asset = releaseAsset(release, { names: [`ffdec_${match[1]}.zip`], pattern: /^ffdec[-_.]/i });
    return asset ? { version: match[1], assets: [asset] } : null;
  } }) });
