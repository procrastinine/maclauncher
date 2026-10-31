const crypto = require("node:crypto");
const Upstream = require("../../shared/runtime/upstream");
const { macDownloads } = require("../../shared/runtime/release-files");

function bytecodeVersions(version) {
  if (Number(version.split(".")[0]) !== 1) return [];
  const minor = Number(version.split(".")[1]);
  return minor <= 1 ? [1] : minor <= 3 ? [2] : minor <= 5 ? [2, 3] : minor <= 8 ? [2, 3, 4] : [2, 3, 4, 5];
}
// Numbered releases publish source only and stay listed with that reason.
function sourceEntry(version) {
  const minor = Number(version.split(".")[1]);
  return { version, architecture: "x64", details: { supportedBytecodeVersions: bytecodeVersions(version),
    nativeAbi: { sdlEventLoop: minor >= 10 ? "dynamic" : minor === 9 ? "typed-event" : "unknown" } },
    installReason: "No Mac download is available for this source release. A matching Mac runtime can be imported." };
}

// The package's own Mach-O images state the macOS requirement after download.
function parseSourceMetadata({ header, code, sdl }) {
  const version = /^\s*#define\s+HL_VERSION\s+0x([a-f0-9]{6})\s*$/im.exec(header)?.[1];
  const maximum = /\bint\s+max_version\s*=\s*(\d+)\s*;/.exec(code)?.[1];
  const minimum = /\bif\s*\(\s*c->version\s*<=\s*(\d+)\s*\|\|\s*c->version\s*>\s*max_version\s*\)/.exec(code)?.[1];
  const primitive = /\bDEFINE_PRIM\s*\(\s*_BOOL\s*,\s*event_loop\s*,\s*(_DYN|_OBJ\s*\([^)]*\))\s*\)/.exec(sdl)?.[1];
  if (!version || !maximum || minimum === undefined || !primitive || Number(minimum) < 0 ||
    Number(maximum) > 32 || Number(maximum) <= Number(minimum)) throw new Error("This HashLink snapshot has unsupported version or native-module metadata.");
  const numeric = Number.parseInt(version, 16);
  return { upstreamVersion: `${numeric >>> 16}.${(numeric >>> 8) & 255}.${numeric & 255}`,
    supportedBytecodeVersions: Array.from({ length: Number(maximum) - Number(minimum) }, (_, i) => i + Number(minimum) + 1).filter(i => i >= 2 && i <= 6),
    nativeAbi: { sdlEventLoop: primitive === "_DYN" ? "dynamic" : "typed-event",
      ...(/^\s*#\s*define\s+HL_CALLB\s+"C"\s*$/m.test(header) ? { callbackMarker: "C" } : {}) },
    sourceMetadata: { headerSha256: digest(header), bytecodeReaderSha256: digest(code), sdlPrimitivesSha256: digest(sdl) } };
}
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

// The rolling `latest` release carries the development build. Its version and
// bytecode and native-module contracts come from the source at its commit. The
// bytecode JIT is Intel code, so an archive named for ARM only is left out; a
// name without a CPU is Intel. The current archive name wins.
const source = Upstream.github({ repository: "HaxeFoundation/hashlink", prerelease: true, allArchitectures: true,
  recognize: async (release, { revision, readSource }) => {
    const tag = release.tag_name || "";
    if (/^\d+(?:\.\d+)+$/.test(tag)) return sourceEntry(tag);
    if (tag !== "latest") return null;
    const current = (release.assets || []).map(asset => String(asset?.name || "")).filter(name => /^hashlink-[a-f0-9]{7,40}-darwin-cmake\.tar\.gz$/.test(name));
    const asset = macDownloads(release.assets, { preferred: current }).find(item => item.architecture !== "arm64")?.asset;
    if (!asset) return null;
    const metadata = parseSourceMetadata({ header: await readSource("src/hl.h"), code: await readSource("src/code.c"), sdl: await readSource("libs/sdl/sdl.c") });
    return { version: `${metadata.upstreamVersion}-dev-${revision.slice(0, 12)}`, label: `${metadata.upstreamVersion} dev · ${revision.slice(0, 12)} (Intel)`,
      sourceUrl: `https://github.com/HaxeFoundation/hashlink/commit/${revision}`, publishedAt: asset.created_at || release.published_at, architecture: "x64",
      details: { ...metadata, upstreamTag: "latest", sourceKind: "commit", hostArchitectures: ["arm64", "x64"] }, assets: [asset] };
  } });

module.exports = { bytecodeVersions, sourceEntry, parseSourceMetadata, source };
