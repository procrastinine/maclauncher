function forManifest(manifest) {
  const p = manifest?.provenance;
  if (p?.sourceKind !== "owned-source-adaptation") return null;
  return {version:manifest.version,sourceKind:p.sourceKind,upstreamRevision:p.sourceRevision,
    executableRelative:manifest.executableRelative,arch:manifest.arch,minimumMacOS:manifest.minimumMacOS,
    adaptationId:p.adaptationId,patchSha256:p.patchSha256,headerSha256:p.headerSha256,
    implementationSha256:p.implementationSha256,
    executableSha256:manifest.files?.find(file=>file.path===manifest.executableRelative)?.sha256};
}

function validate(manifest, selected = forManifest(manifest)) {
  const executable = manifest?.files?.find(item => item.path === manifest.executableRelative);
  if (!selected || !/^[a-f0-9]{40}$/.test(selected.upstreamRevision || "") ||
      [selected.patchSha256, selected.headerSha256, selected.implementationSha256, selected.executableSha256].some(value => !/^[a-f0-9]{64}$/.test(value || "")) || selected.sourceKind !== "owned-source-adaptation" || !selected.adaptationId ||
      manifest.version !== selected.version ||
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

module.exports = { forManifest, validate };
