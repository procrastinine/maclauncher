// Each provider owns a complete catalog view. Installation identities remain
// the manager's exact version keys; sources only organize download choices.
function sourceCatalog(catalog, { id, label, source, versions = catalog.versions || [], state }) {
  const selected = new Set(versions);
  const pick = values => Object.fromEntries(Object.entries(values || {}).filter(([version]) => selected.has(version)));
  const installableVersions = (catalog.installableVersions || []).filter(version => selected.has(version));
  const provider = state || catalog.sourceStates?.[id];
  const reasons = [...new Set(versions.map(version => catalog.versionRequirements?.[version]?.installReason).filter(Boolean))];
  const installReason = installableVersions.length ? null : provider?.error || reasons.join(" · ") ||
    (provider ? provider.fetchedAt ? "No compatible download is available from this source." : "Refresh versions to list available downloads." : catalog.installReason);
  return { ...catalog, ...provider, sources: undefined, sourceLinks: undefined, sourceStates: undefined, id, label, source, sourceUrl: source,
    versions, installableVersions, includedVersions: (catalog.includedVersions || []).filter(version => selected.has(version)),
    buildableVersions: (catalog.buildableVersions || []).filter(version => selected.has(version)),
    ...(catalog.versionDetails ? { versionDetails: catalog.versionDetails.filter(row => selected.has(row.version)) } : {}),
    versionRequirements: pick(catalog.versionRequirements), versionLabels: pick(catalog.versionLabels),
    recommendedVersion: selected.has(catalog.recommendedVersion) ? catalog.recommendedVersion : versions[0] || null,
    latestAvailableVersion: versions[0] || null, installable: installableVersions.length > 0, installReason,
    supportsLatestOnly: id === "builds" ? false : catalog.supportsLatestOnly };
}

function projectSources(catalog, pins, { projectId, repository = "procrastinine/maclauncher-builds", upstreamUrl, upstreamLabel = "upstream code", upstreamDownloads = false } = {}) {
  const hosted = new Set(pins.filter(pin => pin.projectPackage).map(pin => pin.version));
  const upstream = new Set(pins.filter(pin => !pin.projectPackage && pin.asset).map(pin => pin.version));
  const sources = [sourceCatalog(catalog, { id: "builds", label: "MacLauncher Builds",
    source: repository === "procrastinine/maclauncher-builds" && projectId
      ? `https://procrastinine.github.io/maclauncher-builds/#${projectId}` : `https://github.com/${repository}`,
    versions: catalog.versions.filter(version => hosted.has(version)) })];
  const upstreamVersions = catalog.versions.filter(version => upstream.has(version));
  const hasUpstreamDownloads = upstreamDownloads;
  if (hasUpstreamDownloads) sources.push(sourceCatalog(catalog, { id: "upstream", label: "Upstream",
    source: upstreamUrl, versions: upstreamVersions }));
  const versions = [...new Set(sources.flatMap(source => source.versions))];
  return { ...catalog, versions, installableVersions: catalog.installableVersions.filter(version => versions.includes(version)),
    installable: sources.some(source => source.installable),
    recommendedVersion: versions.includes(catalog.recommendedVersion) ? catalog.recommendedVersion : versions[0] || null,
    latestAvailableVersion: versions[0] || null, source: sources[0].source, sourceUrl: sources[0].source, sources,
    ...(upstreamUrl && upstreamUrl !== sources[0].source && !hasUpstreamDownloads
      ? { sourceLinks: [{ label: upstreamLabel, url: upstreamUrl }] } : {}) };
}

module.exports = { sourceCatalog, projectSources };
