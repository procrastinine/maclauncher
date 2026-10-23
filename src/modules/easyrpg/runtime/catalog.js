const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");
const HTTP = require("undici");

const SOURCE_URL = "https://github.com/EasyRPG/Player/releases";
const ARCHIVE_URL = "https://easyrpg.org/downloads/player/";
const VERSION = /^\d+\.\d+(?:\.\d+){0,2}$/;

function compareVersions(left, right) {
  const a = String(left).split(".").map(Number), b = String(right).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference) return difference;
  }
  return 0;
}

function archiveIdentity(version) {
  if (!VERSION.test(version)) throw new Error("Invalid EasyRPG release version.");
  const filename = `easyrpg-player-${version}-macos.app.zip`;
  return { filename, artifactId: filename, url: `${ARCHIVE_URL}${version}/${filename}` };
}

function validateRecordedArtifact(asset, entry) {
  if (!VERSION.test(entry?.version || "")) return false;
  const expected = archiveIdentity(entry.version);
  return asset?.integrity === "recorded-local" && asset.url === expected.url &&
    asset.filename === expected.filename && asset.artifactId === expected.artifactId &&
    Number.isSafeInteger(asset.bytes) && asset.bytes > 0;
}

async function headArtifact(url, { signal } = {}) {
  const timeout = AbortSignal.timeout(20000);
  const response = await HTTP.fetch(url, { method: "HEAD", redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`EasyRPG Mac release lookup failed (${response.status}).`);
  const bytes = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("EasyRPG Mac release has no valid archive size.");
  return { bytes };
}

function createDiscovery(dependencies = {}) {
  return options => createGithubReleaseDiscovery({ owner: "EasyRPG", repo: "Player", dependencies,
    mapRelease: async (release, { resolveRevision, sourceUrl }) => {
      const version = String(release.tag_name || "").replace(/^v(?=\d)/, "");
      if (!VERSION.test(version) || compareVersions(version, "0.8") < 0) return null;
      const identity = archiveIdentity(version);
      const metadata = await (dependencies.headArtifact || headArtifact)(identity.url, { signal: options?.signal });
      const revision = await resolveRevision(release);
      return { version, upstreamRevision: revision, upstreamTag: release.tag_name, sourceUrl, localBuild: false,
        ...(metadata ? { asset: { ...identity, bytes: metadata.bytes, integrity: "recorded-local" } }
          : { installReason: "No Mac app bundle is available for this release. Select a newer release or import a compatible local runtime." }) };
    } })(options);
}

module.exports = { SOURCE_URL, ARCHIVE_URL, VERSION, compareVersions, archiveIdentity, validateRecordedArtifact, headArtifact, createDiscovery };
