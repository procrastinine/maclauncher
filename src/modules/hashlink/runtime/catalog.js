const crypto = require("node:crypto");
const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");
const { fetchUrlBuffer, throwIfAborted } = require("../../shared/runtime/download-utils");

function bytecodeVersions(version) {
  if (Number(version.split(".")[0]) !== 1) return [];
  const minor = Number(version.split(".")[1]);
  return minor <= 1 ? [1] : minor <= 3 ? [2] : minor <= 5 ? [2, 3] : minor <= 8 ? [2, 3, 4] : [2, 3, 4, 5];
}
function sourceEntry(version, upstreamRevision, sourceUrl) {
  const minor = Number(version.split(".")[1]);
  return { version, upstreamRevision, sourceUrl, architecture: "x86_64", requiresRosettaOnArm: true,
    supportedBytecodeVersions: bytecodeVersions(version),
    nativeAbi: { sdlEventLoop: minor >= 10 ? "dynamic" : minor === 9 ? "typed-event" : "unknown" },
    localBuild: false, installReason: "No Mac download is available for this source release. A matching Mac runtime can be imported." };
}

function parseSourceMetadata({ header, code, sdl, workflow }) {
  const version = /^\s*#define\s+HL_VERSION\s+0x([a-f0-9]{6})\s*$/im.exec(header)?.[1];
  const maximum = /\bint\s+max_version\s*=\s*(\d+)\s*;/.exec(code)?.[1];
  const minimum = /\bif\s*\(\s*c->version\s*<=\s*(\d+)\s*\|\|\s*c->version\s*>\s*max_version\s*\)/.exec(code)?.[1];
  const primitive = /\bDEFINE_PRIM\s*\(\s*_BOOL\s*,\s*event_loop\s*,\s*(_DYN|_OBJ\s*\([^)]*\))\s*\)/.exec(sdl)?.[1];
  const deployment = /darwin64\)\s*([\s\S]*?)\n\s*;;/.exec(workflow)?.[1];
  const minimumMacOS = /-DCMAKE_OSX_DEPLOYMENT_TARGET=(\d+\.\d+(?:\.\d+)?)(?:\s|\\)/.exec(deployment || "")?.[1];
  if (!version || !maximum || minimum === undefined || !primitive || !minimumMacOS || Number(minimum) < 0 ||
    Number(maximum) > 32 || Number(maximum) <= Number(minimum)) throw new Error("This HashLink snapshot has unsupported version or native-module metadata.");
  const numeric = Number.parseInt(version, 16);
  return { upstreamVersion: `${numeric >>> 16}.${(numeric >>> 8) & 255}.${numeric & 255}`,
    supportedBytecodeVersions: Array.from({ length: Number(maximum) - Number(minimum) }, (_, i) => i + Number(minimum) + 1).filter(i => i >= 2 && i <= 6),
    nativeAbi: { sdlEventLoop: primitive === "_DYN" ? "dynamic" : "typed-event",
      ...(/^\s*#\s*define\s+HL_CALLB\s+"C"\s*$/m.test(header) ? { callbackMarker: "C" } : {}) }, minimumMacOS,
    sourceMetadata: { headerSha256: digest(header), bytecodeReaderSha256: digest(code), sdlPrimitivesSha256: digest(sdl), workflowSha256: digest(workflow) } };
}
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

async function readSourceMetadata(revision, { request = fetchUrlBuffer, signal } = {}) {
  if (!/^[a-f0-9]{40}$/.test(revision || "")) throw new Error("HashLink snapshots require an exact source commit.");
  const files = { header: "src/hl.h", code: "src/code.c", sdl: "libs/sdl/sdl.c", workflow: ".github/workflows/build.yml" };
  const responses = await Promise.all(Object.entries(files).map(async ([name, file]) => {
    const response = await request(`https://raw.githubusercontent.com/HaxeFoundation/hashlink/${revision}/${file}`,
      { signal, headers: { "User-Agent": "maclauncher" } });
    throwIfAborted(signal);
    if (response.status !== 200 || !Buffer.isBuffer(response.body) || response.body.length > 256 * 1024)
      throw new Error("HashLink source version metadata is unavailable.");
    return [name, response.body.toString("utf8")];
  }));
  return parseSourceMetadata(Object.fromEntries(responses));
}

function createDiscovery(dependencies = {}) {
  return async ({ logger, signal } = {}) => createGithubReleaseDiscovery({ owner: "HaxeFoundation", repo: "hashlink", includePrerelease: true, dependencies,
    mapRelease: async (release, { resolveRevision, githubAssetDigest, sourceUrl }) => {
      const tag = release.tag_name || "";
      if (/^\d+\.\d+$/.test(tag)) return sourceEntry(tag, await resolveRevision(release), sourceUrl);
      if (tag !== "latest") return null;
      const revision = await resolveRevision(release);
      const candidates = (release.assets || []).filter(asset => /^hashlink-[a-f0-9]{7,40}-darwin-cmake\.tar\.gz$/.test(asset.name || ""));
      if (!candidates.length) return null; // ARM-only libraries do not provide the bytecode JIT.
      if (!/^[a-f0-9]{40}$/.test(revision || "") || candidates.length !== 1) throw new Error("HashLink snapshot identity is ambiguous.");
      const asset = candidates[0], short = /^hashlink-([a-f0-9]+)-/.exec(asset.name)[1];
      const sha256 = githubAssetDigest(asset);
      const expectedUrl = `https://github.com/HaxeFoundation/hashlink/releases/download/latest/${asset.name}`;
      if (!revision.startsWith(short) || !sha256 || asset.browser_download_url !== expectedUrl || !Number.isSafeInteger(asset.id) || asset.id < 1)
        throw new Error("HashLink snapshot commit or archive digest is unavailable.");
      const metadata = await readSourceMetadata(revision, { ...dependencies, signal });
      const version = `${metadata.upstreamVersion}-dev-${revision.slice(0, 12)}`;
      return { ...metadata, version, versionLabel: `${metadata.upstreamVersion} dev · ${revision.slice(0, 12)} (Intel)`,
        upstreamRevision: revision, upstreamTag: "latest", sourceKind: "commit",
        sourceUrl: `https://github.com/HaxeFoundation/hashlink/commit/${revision}`, publishedAt: asset.created_at || release.published_at,
        architecture: "x86_64", requiresRosettaOnArm: true, hostArchitectures: ["arm64", "x64"], localBuild: false, prerelease: Boolean(release.prerelease),
        asset: { filename: asset.name, url: expectedUrl, sha256, assetId: asset.id, integritySource: "publisher-sha256" } };
    } })({ logger, signal });
}

module.exports = { bytecodeVersions, sourceEntry,
  parseSourceMetadata, readSourceMetadata, createDiscovery };
