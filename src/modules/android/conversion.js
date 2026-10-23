const path = require("node:path");

function payload(root, profile) {
  const converterClasspath = ["converter-overlay.jar", "dex2jvm.jar"].map(file => path.join(root, file));
  if (profile.splitApksVersion === 1) converterClasspath.push(path.join(root, "apksig.jar"));
  const metadataClasspath = (profile.frameworkBaseVersion === 1 && profile.conversionMetadataVersion !== 1 ?
    ["android-host.jar", "android-framework.jar", "android-api-metadata.jar"] : ["android-api-metadata.jar"]).map(file => path.join(root, file));
  return { root, profile, converterClasspath, metadataClasspath };
}

// Single APKs and package sets use the same converter and complete hierarchy.
function argumentsFor(runtime, output, sources) {
  return ["-Xmx1024m", "-Dmaclauncher.dex.nativeLoadTarget=" + runtime.profile.nativeLoadTarget,
    ...(runtime.profile.demandDexVersion === 1 ? ["-Dmaclauncher.dex.demand=true"] : []),
    "-cp", runtime.converterClasspath.map(item => item.file).join(path.delimiter),
    "io.github.kksimp.dex2jvm.ConvertApkSet",
    runtime.metadataClasspath.map(item => item.file).join(path.delimiter), output, ...sources];
}

module.exports = { argumentsFor, payload };
