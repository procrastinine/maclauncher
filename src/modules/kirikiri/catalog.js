const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Native = require("../shared/runtime/local-native");
const Upstream = require("../shared/runtime/upstream");
const { macDownloads, locatePackaged } = require("../shared/runtime/release-files");
const run = promisify(execFile);

// Upstream's single `latest` release is moving, so its version names the
// commit it was built from; an earlier installation keeps its meaning.
const source = Upstream.github({ repository: "krkrsdl2/krkrsdl2", prerelease: true, allArchitectures: true,
  recognize: (release, { revision }) => {
    const version = release.tag_name === "latest" ? `development-${revision.slice(0, 12)}` : release.tag_name;
    const rows = macDownloads(release.assets, { preferred: "krkrsdl2-macos.zip" })
      .map(({ asset, architecture }) => ({ version, ...(architecture ? { architecture } : {}), assets: [asset] }));
    return rows.length ? rows : { version,
      installReason: "This upstream release has no compatible Mac package. MacLauncher Builds provides separate Mac adaptations." };
  } });

// A release may move the executable into a folder.
const releaseExecutable = root => locatePackaged(root, "krkrsdl2") || path.join(root, "krkrsdl2");
async function prepareReleaseInstall({ unpacked, pin, signal, logger }, dependencies = {}) {
  const executable = releaseExecutable(unpacked);
  if (!fs.lstatSync(executable).isFile() || !fs.realpathSync(executable).startsWith(fs.realpathSync(unpacked) + path.sep)) throw new Error("KiriKiri release executable is missing or unsafe.");
  Native.readMachOArchitectures(executable);
  const options = { ...(signal ? { signal } : {}), timeout: 30000, maxBuffer: 1024 * 1024 };
  // Upstream ships an unsigned executable. Sign only the managed extraction;
  // the archive and final executable identities are recorded.
  const execute = dependencies.execFile || run;
  await execute("/usr/bin/codesign", ["--force", "--sign", "-", executable], options);
  await execute("/usr/bin/codesign", ["--verify", "--strict", executable], options);
  logger?.info?.(`[runtime] prepared KiriKiri release ${pin.version}`);
}

module.exports = { source, prepareReleaseInstall, releaseExecutable };
