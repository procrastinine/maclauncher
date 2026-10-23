const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Native = require("../shared/runtime/local-native");
const MachO = require("../shared/runtime/macho-load-commands");
const { createGithubReleaseDiscovery } = require("../shared/runtime/github-runtime-catalog");
const run = promisify(execFile);

function createCatalogDiscovery(dependencies = {}) {
  return createGithubReleaseDiscovery({ owner: "krkrsdl2", repo: "krkrsdl2", includePrerelease: true, dependencies,
    mapRelease: async (release, { resolveRevision, githubAssetDigest, sourceUrl }) => {
      const upstreamRevision = await resolveRevision(release);
      // Upstream's single `latest` release is moving. Cache an immutable commit
      // identity instead of making a previous installation change its meaning.
      const version = release.tag_name === "latest" ? `development-${upstreamRevision.slice(0, 12)}` : release.tag_name;
      const asset = release.assets?.find(item => item.name === "krkrsdl2-macos.zip" && githubAssetDigest(item));
      return { version, upstreamRevision, sourceUrl, localBuild: false,
        ...(asset ? { executableRelative: "krkrsdl2", asset: { filename: asset.name,
          url: asset.browser_download_url, sha256: githubAssetDigest(asset) } }
          : { installReason: "This upstream release has no compatible Mac package. MacLauncher Builds provides separate Mac adaptations." }) };
    } });
}

async function prepareReleaseInstall({ unpacked, pin, signal, logger }, dependencies = {}) {
  if (!pin.asset || pin.asset.filename !== "krkrsdl2-macos.zip" || pin.executableRelative !== "krkrsdl2") throw new Error("Unsupported KiriKiri release layout.");
  const executable = path.join(unpacked, pin.executableRelative);
  if (!fs.lstatSync(executable).isFile() || !fs.realpathSync(executable).startsWith(fs.realpathSync(unpacked) + path.sep)) throw new Error("KiriKiri release executable is missing or unsafe.");
  Native.readMachOArchitectures(executable);
  const options = { ...(signal ? { signal } : {}), timeout: 30000, maxBuffer: 1024 * 1024 };
  const image = MachO.assertSystemLibraryClosure(MachO.readMachOLoadCommands(executable, { signal }), { fileType: 2 });
  if (image.slices.some(slice => !slice.dependencies.length)) throw new Error("KiriKiri runtime libraries are missing from this package.");
  // Upstream ships an unsigned universal executable. Sign only the managed,
  // digest-verified extraction; retain archive and final executable identities.
  const execute = dependencies.execFile || run;
  await execute("/usr/bin/codesign", ["--force", "--sign", "-", executable], options);
  await execute("/usr/bin/codesign", ["--verify", "--strict", executable], options);
  logger?.info?.(`[runtime] prepared checksum-pinned KiriKiri release ${pin.version}`);
}

module.exports = { createCatalogDiscovery, prepareReleaseInstall };
