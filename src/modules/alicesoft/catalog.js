const { createGithubReleaseDiscovery } = require("../shared/runtime/github-runtime-catalog");

function createCatalogDiscovery(repo, dependencies = {}) {
  if (!["system3-sdl2", "xsystem35-sdl2", "xsystem4", "sys3c", "xsys35c"].includes(repo)) throw new Error("Unknown AliceSoft source catalog.");
  const tool = ["sys3c", "xsys35c"].includes(repo);
  return createGithubReleaseDiscovery({ owner: repo === "xsystem4" ? "nunuhara" : "kichikuou", repo,
    includePrerelease: !tool, dependencies,
    mapRelease: async (release, { resolveRevision, sourceUrl }) => {
      if (tool && !/^v?\d+\.\d+\.\d+$/.test(release.tag_name)) return null;
      const upstreamRevision = await resolveRevision(release);
      return {
      // A leading v is release-tag syntax, not a second backend version. The
      // manager preserves a reviewed bundled build's separate commit identity.
      version: release.tag_name === "nightly" ? `development-${upstreamRevision.slice(0, 12)}` : release.tag_name.replace(/^v(?=\d)/, ""), releaseTag: release.tag_name,
      upstreamRevision, sourceUrl,
      localBuild: false,
      installReason: tool ? "Windows tools only. A matching local Mac tool can be imported; the included Mac version is available."
        : repo === "xsystem4" ? "Windows/Linux builds only. No compatible Mac package is available for this release." : "Windows/Android builds only. No compatible Mac package is available for this release."
    }; } });
}

module.exports = { createCatalogDiscovery };
