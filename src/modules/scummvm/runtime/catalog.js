const { fetchUrlBuffer, throwIfAborted } = require("../../shared/runtime/download-utils");
const Github = require("../../shared/runtime/github-releases");

const SOURCE_URL = "https://downloads.scummvm.org/frs/scummvm/";
const DEFAULT_VERSION = "2026.3.0";
const DEFAULT_ENTRY = Object.freeze({
  version: DEFAULT_VERSION,
  upstreamRevision: "fed42f2068dcafc6aafa1c28c77e4c88def74b66",
  upstreamTag: "v2026.3.0",
  minimumMacOS: "11.0",
  hostArchitectures: ["arm64", "x64"],
  localBuild: false,
  sourceUrl: "https://github.com/scummvm/scummvm/tree/v2026.3.0",
  asset: {
    filename: "scummvm-2026.3.0-macosx.dmg",
    url: `${SOURCE_URL}2026.3.0/scummvm-2026.3.0-macosx.dmg`,
    sha256: "d483f41a67d389a3bf50832b9a1a054fbeded56fc148216e4f84a06d330d2172"
  }
});

function compareVersions(left, right) {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
function parseVersions(html, minimumVersion = "2.5.0") {
  return [...new Set([...html.matchAll(/href=["'](\d{1,4}\.\d{1,3}\.\d{1,3})\/["']/gi)].map(match => match[1]))]
    .filter(version => compareVersions(version, minimumVersion) >= 0)
    .sort((a, b) => compareVersions(b, a)).slice(0, 100);
}
function parseDigest(text, filename) {
  const match = /^([a-f0-9]{64})(?:\s+\*?([^\r\n]+))?\s*$/i.exec(text.trim());
  if (!match || match[2] && match[2].trim() !== filename) throw new Error("ScummVM release checksum is invalid.");
  return match[1].toLowerCase();
}

function createDiscovery({ request = fetchUrlBuffer, fetchTags = Github.fetchGithubTags,
  sourceUrl = SOURCE_URL, repository = "scummvm", project = "ScummVM", prefix = "scummvm",
  minimumMacOS = "11.0", unavailableReason = "A universal macOS download with a published SHA-256 is not available for this release." } = {}) {
  return async ({ signal, logger } = {}) => {
    const deadline = AbortSignal.timeout(30000);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    async function text(url, { optional = false, limit = 1024 * 1024 } = {}) {
      const response = await request(url, { signal: requestSignal });
      throwIfAborted(requestSignal);
      if (optional && response.status === 404) return null;
      if (response.status !== 200) throw new Error(`${project} release information could not be loaded (${response.status}).`);
      if (response.body.length > limit) throw new Error("ScummVM release information exceeds its size limit.");
      return response.body.toString("utf8");
    }
    const [html, tags] = await Promise.all([
      text(sourceUrl), fetchTags({ owner: "scummvm", repo: repository, signal: requestSignal, maxPages: 5 })
    ]);
    const versions = parseVersions(html);
    if (!versions.length) throw new Error("No compatible ScummVM releases were found.");
    const commits = new Map(tags.map(tag => [tag.name, tag.commit.sha]));
    const rows = new Array(versions.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, versions.length) }, async () => {
      while (cursor < versions.length) {
        const index = cursor++, version = versions[index], tag = `v${version}`;
        const revision = commits.get(tag);
        if (!revision) continue;
        const filename = `${prefix}-${version}-macosx.dmg`;
        const checksum = await text(`${sourceUrl}${version}/${filename}.sha256`, { optional: true, limit: 4096 });
        rows[index] = { version, upstreamRevision: revision, upstreamTag: tag,
          minimumMacOS, hostArchitectures: ["arm64", "x64"], localBuild: false,
          sourceUrl: `https://github.com/scummvm/${repository}/tree/${encodeURIComponent(tag)}`,
          ...(checksum ? { asset: { filename, url: `${sourceUrl}${version}/${filename}`, sha256: parseDigest(checksum, filename) } }
            : { installReason: unavailableReason }) };
      }
    }));
    const result = rows.filter(Boolean);
    if (!result.length) throw new Error("No ScummVM releases with an identified source version were found.");
    logger?.info?.(`[${prefix}] found ${result.length} release versions`);
    return result;
  };
}

module.exports = { SOURCE_URL, DEFAULT_VERSION, DEFAULT_ENTRY, createDiscovery, parseVersions, parseDigest, compareVersions };
