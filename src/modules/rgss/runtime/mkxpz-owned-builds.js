const Catalog = require("./owned-builds.json");

function pin(version) {
  return Catalog.releases.find(item => item.version === version) || null;
}

function previousVersion(pin) {
  return pin.sourceArtifact?.directoryRelative?.split("/").pop()?.replace(/-source\.tar\.gz$/, "");
}
function forManifest(manifest) {
  return Catalog.releases.find(item => previousVersion(item) === manifest?.version && item.upstreamRevision === manifest?.upstreamRevision &&
    item.adaptationId === manifest?.provenance?.adaptationId) || null;
}

function validate(manifest, selected = pin(manifest?.version) || forManifest(manifest)) {
  const executable = manifest?.files?.find(item => item.path === manifest.executableRelative);
  if (!selected || selected.sourceKind !== "owned-source-adaptation" || !selected.adaptationId ||
      manifest.version !== selected.version && manifest.version !== previousVersion(selected) ||
      manifest.upstreamRevision !== selected.upstreamRevision || manifest.executableRelative !== selected.executableRelative ||
      manifest.arch !== selected.arch || manifest.minimumMacOS !== selected.minimumMacOS ||
      manifest.provenance?.sourceKind !== "owned-source-adaptation" || manifest.provenance.verifiedBuild !== true ||
      manifest.provenance.sourceRevision !== selected.upstreamRevision ||
      manifest.provenance.adaptationId !== selected.adaptationId || manifest.provenance.patchSha256 !== selected.patchSha256 ||
      manifest.provenance.headerSha256 !== selected.headerSha256 ||
      manifest.provenance.implementationSha256 !== selected.implementationSha256 ||
      executable?.sha256 !== selected.executableSha256)
    throw new Error("The MKXP-Z source adaptation differs from its selected build identity.");
  return manifest;
}

module.exports = { releases: Catalog.releases, pin, forManifest, validate,
  defaultVersion: arch => Catalog.defaultVersions?.[arch] || null };
