const { createManagedJavaTool } = require("../../shared/runtime/managed-java-tool");

module.exports = createManagedJavaTool({ id: "ffdec", label: "JPEXS FFDec", owner: "jindrapetrik",
  repo: "jpexs-decompiler", jarName: "ffdec.jar", order: 220,
  pins: [{ version: "26.4.0", tag: "version26.4.0", bytes: 21917740,
    sha256: "56ce960aeafc7caf034e2052ba49f878a883f7c7ca690da6eeffca9587b5e4b9",
    url: "https://github.com/jindrapetrik/jpexs-decompiler/releases/download/version26.4.0/ffdec_26.4.0.zip",
    sourceUrl: "https://github.com/jindrapetrik/jpexs-decompiler/releases/tag/version26.4.0" },
    { version: "26.3.0", tag: "version26.3.0", bytes: 19871169,
    sha256: "35f4930eb7c380afe66f2117f90b006deac0631473ad7500bb39c78f68645ecd",
    url: "https://github.com/jindrapetrik/jpexs-decompiler/releases/download/version26.3.0/ffdec_26.3.0.zip",
    sourceUrl: "https://github.com/jindrapetrik/jpexs-decompiler/releases/tag/version26.3.0" }],
  releaseArtifact: release => {
    const match = /^version(\d+\.\d+\.\d+)$/.exec(release.tag_name || "");
    if (!match || Number(match[1].split(".")[0]) < 12) return null;
    const asset = release.assets?.find(asset => asset.name === `ffdec_${match[1]}.zip`);
    return asset ? { version: match[1], asset } : null;
  } });
