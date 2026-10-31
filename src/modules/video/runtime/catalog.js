const Upstream = require("../../shared/runtime/upstream");
const SOURCE_URL = "https://github.com/mpv-player/mpv/releases";
const Archive = require("../../shared/runtime/archive");
const Architecture = require("../../shared/runtime/architecture");
// The publisher names each Mac build by its macOS floor and CPU, for example
// mpv-v0.41.0-macos-14-arm.zip and mpv-v0.41.0-macos-15-intel.zip. A later
// CPU word, a universal build, a missing floor or another archive format is
// read the same way.
const LABELS = Object.freeze({ arm64: "Apple Silicon", x64: "Intel" });
function assetFacts(name) {
  if (!/^mpv[-_]/i.test(name || "") || !Archive.isMacName(name) || !Archive.archiveKind(name) || /(?:^|[._-])(?:debug|symbols?)(?:[._-]|$)/i.test(name)) return null;
  const architecture = Architecture.assetArchitecture(name) ||
    (/(?:^|[._-])arm(?:[._-]|$)/i.test(name) ? "arm64" : /(?:^|[._-])intel(?:[._-]|$)/i.test(name) ? "x64" : null);
  const floor = /(?:macos|osx|mac)[-_]?(\d{2})(?:[._-]|$)/i.exec(name)?.[1] || null;
  return architecture ? { architecture, floor } : null;
}
// Each tagged release, and the git-release development build, lists the
// lowest-floor build for this Mac's CPU. GitHub's digest verifies a download
// when GitHub publishes one; otherwise the hash is recorded at installation.
function recognize(release, { arch: requested, revision: tagRevision }) {
  const arch = requested || Architecture.selectedArchitecture();
  const snapshot = release.tag_name === "git-release";
  const tagged = /^v?(\d+(?:\.\d+)+)$/.exec(release.tag_name || "")?.[1];
  if (!snapshot && (release.prerelease || !tagged)) return [];
  // git-release is a moving tag. Its release notes identify the actual
  // source commit; asset names also contain that commit and a CI run ID.
  const commit = snapshot ? /^\s*[-*]?\s*Commit:\s*`?([a-f0-9]{40})`?\s*$/im.exec(release.body || "")?.[1]?.toLowerCase() : null;
  if (snapshot && !commit) throw new Error("The development build's notes name no exact source commit.");
  const candidates = (release.assets || []).flatMap(asset => {
    const facts = assetFacts(asset.name);
    const dev = snapshot && /(v\d+(?:\.\d+)+-dev-g([a-f0-9]{7,40})-(\d+))/i.exec(asset.name);
    if (!facts || (snapshot && (!dev || !commit.startsWith(dev[2].toLowerCase())))) return [];
    return [{ asset, build: snapshot ? dev[1].slice(1) : tagged, ...facts }];
  }).filter(row => [arch, "universal"].includes(row.architecture))
    .sort((a, b) => Number(a.architecture === "universal") - Number(b.architecture === "universal") || Number(a.floor || 0) - Number(b.floor || 0));
  const selected = candidates[0];
  if (!selected) return [];
  const { asset, build, floor } = selected;
  const expected = `https://github.com/mpv-player/mpv/releases/download/${release.tag_name}/${asset.name}`;
  if (asset.browser_download_url !== expected || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 512 * 1024 * 1024) return [];
  const revision = commit || tagRevision;
  if (!/^[a-f0-9]{40}$/i.test(revision || "")) throw new Error("Its source commit could not be identified.");
  return { version: floor ? `${build}-macos-${floor}-${arch}` : `${build}-${arch}`,
    label: `${snapshot ? `Git ${revision.slice(0, 9)} · ${build}` : build} · ${LABELS[arch]}${floor ? ` · macOS ${floor}+` : ""}`,
    revision: revision.toLowerCase(), sourceUrl: `https://github.com/mpv-player/mpv/tree/${revision.toLowerCase()}`,
    ...(snapshot ? { channel: "development" } : {}),
    // A universal build installs as this CPU's build.
    architecture: arch === "x64" ? "x86_64" : arch,
    details: { ...(snapshot ? { sourceKind: "commit", downloadTag: release.tag_name } : { upstreamTag: release.tag_name }),
      ...(floor ? { minimumMacOS: `${floor}.0` } : {}), hostArchitectures: [arch], localBuild: false },
    assets: [asset] };
}
const source = Upstream.github({ repository: "mpv-player/mpv", prerelease: true, recognize });
module.exports = { SOURCE_URL, source, assetFacts };
