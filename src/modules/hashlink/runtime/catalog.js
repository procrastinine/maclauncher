const crypto = require("node:crypto");
const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");
const { fetchUrlBuffer, throwIfAborted } = require("../../shared/runtime/download-utils");

const SNAPSHOT_REVISION = "d049add0a84dc6ae43088a6c386992dbba8604dc";
const SNAPSHOT_VERSION = `2.0.0-dev-${SNAPSHOT_REVISION.slice(0, 12)}`;
const SNAPSHOT = Object.freeze({
  version: SNAPSHOT_VERSION, versionLabel: "2.0.0 dev · d049add0a84d (Intel)",
  upstreamVersion: "2.0.0", upstreamRevision: SNAPSHOT_REVISION, upstreamTag: "latest", sourceKind: "commit",
  sourceUrl: `https://github.com/HaxeFoundation/hashlink/commit/${SNAPSHOT_REVISION}`,
  primitiveProfileId: "stock-2.0.0-d049add0a84d", primitiveProfileSha256: "455b0b44ad7e1a3ba4e94caec5246d040c7995d6bbea263b3b58362b97d38851",
  publishedAt: "2026-10-08T14:19:01Z", architecture: "x86_64", requiresRosettaOnArm: true,
  hostArchitectures: ["arm64", "x64"], minimumMacOS: "10.13.0", localBuild: false,
  supportedBytecodeVersions: [2, 3, 4, 5, 6], nativeAbi: { sdlEventLoop: "dynamic", callbackMarker: "C" },
  sourceMetadata: { bytecodeReaderSha256: "a862ad26dfe774a600c8ed0fe0a760d083863f2fe74696a788379baeac6edb94",
    headerSha256: "f561c47c4370b050305ce8d52c7bf3bf2fb95d5dbce2da8463f90fe21bfb48a2",
    sdlPrimitivesSha256: "ed90c8398621df0e5ed138d68b6a9797e91d6f8a2e1a541d421a82c9ec7f36c9" },
  installReason: "Intel bytecode VM with matching Mac native modules. Apple Silicon requires Rosetta.",
  asset: { filename: "hashlink-d049add-darwin-cmake.tar.gz",
    url: "https://github.com/HaxeFoundation/hashlink/releases/download/latest/hashlink-d049add-darwin-cmake.tar.gz",
    sha256: "8fd6d320861c4ca149a5eaff13f3b5ccc9c35d24c8a15147a3b12e9eef4e251b",
    assetId: 622039920, integritySource: "publisher-sha256" }
});

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
    localBuild: version === "1.16", installReason: version === "1.9"
      ? "Choose 1.9 Mac graphics v2 for a new installation. Existing exact 1.9 installations remain supported."
      : version === "1.16"
      ? "Intel VM with std/ui. fmt/SDL/OpenAL require matching native modules. Apple Silicon requires Rosetta."
      : "No compatible Mac bytecode VM is available for this release. A matching Mac runtime can be imported." };
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
      const metadata = revision === SNAPSHOT_REVISION ? SNAPSHOT : await readSourceMetadata(revision, { ...dependencies, signal });
      const version = `${metadata.upstreamVersion}-dev-${revision.slice(0, 12)}`;
      return { ...metadata, version, versionLabel: `${metadata.upstreamVersion} dev · ${revision.slice(0, 12)} (Intel)`,
        upstreamRevision: revision, upstreamTag: "latest", sourceKind: "commit",
        sourceUrl: `https://github.com/HaxeFoundation/hashlink/commit/${revision}`, publishedAt: asset.created_at || release.published_at,
        architecture: "x86_64", requiresRosettaOnArm: true, hostArchitectures: ["arm64", "x64"], localBuild: false,
        installReason: "Intel bytecode VM with matching Mac native modules. Apple Silicon requires Rosetta.",
        asset: { filename: asset.name, url: expectedUrl, sha256, assetId: asset.id, integritySource: "publisher-sha256" } };
    } })({ logger, signal });
}

module.exports = { SNAPSHOT, SNAPSHOT_REVISION, SNAPSHOT_VERSION, bytecodeVersions, sourceEntry,
  parseSourceMetadata, readSourceMetadata, createDiscovery };
