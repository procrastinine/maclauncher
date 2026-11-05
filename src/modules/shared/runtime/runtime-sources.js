// Each provider owns a complete catalog view. Installation identities remain
// the manager's exact version keys; sources only organize download choices.
function sourceCatalog(catalog, { id, label, source, description, secondary, delivery, registrationLabel, group, variantLabel, versions = catalog.versions || [], state }) {
  const selected = new Set(versions);
  const pick = values => Object.fromEntries(Object.entries(values || {}).filter(([version]) => selected.has(version)));
  const installableVersions = (catalog.installableVersions || []).filter(version => selected.has(version));
  const provider = state || catalog.sourceStates?.[id] || (catalog.sourceStates ? {} : null);
  // Aggregate refresh fields can describe another provider's last request.
  // An absent field in this provider must not inherit that request's failure.
  const { status, error, failedAt, fetchedAt, mode, ...shared } = catalog;
  const refresh = { status: "idle", error: null, fetchedAt: null, mode: null, ...(provider || catalog) };
  const reasons = [...new Set(versions.map(version => catalog.versionRequirements?.[version]?.installReason).filter(Boolean))];
  const installReason = installableVersions.length ? null : provider?.error || reasons.join(" · ") ||
    (provider ? provider.fetchedAt ? "No compatible download is available from this source." : "Refresh versions to list available downloads." : catalog.installReason);
  return { ...shared, ...refresh, sources: undefined, sourceLinks: undefined, sourceStates: undefined, id, label, source, sourceUrl: source, ...(description ? { description } : {}), ...(secondary ? { secondary: true } : {}),
    ...(delivery ? { delivery } : {}), ...(registrationLabel ? { registrationLabel } : {}), ...(group ? { group } : {}), ...(variantLabel ? { variantLabel } : {}),
    versions, installableVersions, includedVersions: (catalog.includedVersions || []).filter(version => selected.has(version)),
    buildableVersions: (catalog.buildableVersions || []).filter(version => selected.has(version)),
    ...(catalog.versionDetails ? { versionDetails: catalog.versionDetails.filter(row => selected.has(row.version)) } : {}),
    versionRequirements: pick(catalog.versionRequirements), versionLabels: pick(catalog.versionLabels),
    latestAvailableVersion: null, installable: installableVersions.length > 0, installReason,
    supportsLatestOnly: id === "builds" ? false : catalog.supportsLatestOnly };
}

// Groups are display views over the same source/version identities. A variant
// selects an existing source view; it never becomes an installation identity.
function groupSources(catalog, sources) {
  const groups = new Map(), projected = new Set(), result = [];
  for (const source of sources) {
    if (!source.group) { result.push(source); continue; }
    if (!groups.has(source.group.id)) {
      const group = { presentation: source.group, members: [] };
      groups.set(source.group.id, group); projected.add(group); result.push(group);
    }
    groups.get(source.group.id).members.push(source);
  }
  return result.map(item => {
    if (!projected.has(item)) return item;
    const members = item.members, versions = new Set(members.flatMap(source => source.versions));
    const errors = [...new Set(members.map(source => source.error).filter(Boolean))];
    const newestDate = key => Math.max(0, ...members.map(source => Number(source[key]) || 0)) || null;
    const state = { status: members.some(source => source.status === "loading") ? "loading" : errors.length ? "error"
      : members.every(source => source.status === "success") ? "success" : "idle",
      error: errors.join(" · ") || null, fetchedAt: newestDate("fetchedAt"), failedAt: newestDate("failedAt") };
    return { ...sourceCatalog(catalog, { ...item.presentation, source: members[0].source, state,
      versions: catalog.versions.filter(version => versions.has(version)) }),
      variants: members.map(source => ({ id: source.id, label: source.variantLabel || source.label, catalog: source })) };
  });
}

function projectSources(catalog, pins, { projectId, repository = "procrastinine/maclauncher-builds", upstreamUrl, upstreamLabel = "upstream code", upstreamDownloads = false } = {}) {
  const hosted = new Set(pins.filter(pin => pin.projectPackage).map(pin => pin.version));
  const upstream = new Set(pins.filter(pin => !pin.projectPackage && pin.asset).map(pin => pin.version));
  const sources = [sourceCatalog(catalog, { id: "builds", label: "MacLauncher Builds",
    source: repository === "procrastinine/maclauncher-builds" && projectId
      ? `https://procrastinine.github.io/maclauncher-builds/#${projectId}` : `https://github.com/${repository}`,
    versions: catalog.versions.filter(version => hosted.has(version)), entries: pins })];
  const upstreamVersions = catalog.versions.filter(version => upstream.has(version));
  const hasUpstreamDownloads = upstreamDownloads;
  if (hasUpstreamDownloads) sources.push(sourceCatalog(catalog, { id: "upstream", label: "Upstream",
    source: upstreamUrl, versions: upstreamVersions, entries: pins }));
  const versions = [...new Set(sources.flatMap(source => source.versions))];
  return { ...catalog, versions, installableVersions: catalog.installableVersions.filter(version => versions.includes(version)),
    installable: sources.some(source => source.installable),
    latestAvailableVersion: null, source: sources[0].source, sourceUrl: sources[0].source, sources,
    ...(upstreamUrl && upstreamUrl !== sources[0].source && !hasUpstreamDownloads
      ? { sourceLinks: [{ label: upstreamLabel, url: upstreamUrl }] } : {}) };
}

module.exports = { sourceCatalog, projectSources, groupSources };
