const { githubRoutes, githubRelease } = require("../helpers/future-upstream.cjs");

// Ruffle publishes dated nightlies; the asset names spell the date with underscores.
const repository = "ruffle-rs/ruffle";
const nightly = (date, name = stamp => `ruffle-nightly-${stamp}-macos-universal.tar.gz`) => githubRelease(repository, `nightly-${date}`,
  [name(date.replace(/-/g, "_")), `ruffle-nightly-${date.replace(/-/g, "_")}-linux-x86_64.tar.gz`,
    `ruffle-nightly-${date.replace(/-/g, "_")}-windows-x86_64.zip`, `ruffle-nightly-${date.replace(/-/g, "_")}-web-selfhosted.zip`], { prerelease: true });
const releases = [nightly("2026-10-29"), nightly("2026-10-28")];
const replaced = { ...releases[0], assets: releases[0].assets.map(asset => ({ ...asset, size: asset.size + 1, digest: "sha256:" + "e".repeat(64) })) };
module.exports = { managers: ["ruffle"], current: githubRoutes(repository, releases),
  scenarios: {
    newVersion: { routes: githubRoutes(repository, [nightly("2026-10-30"), ...releases]), version: "nightly-2026-10-30", usable: true },
    renamedAsset: { routes: githubRoutes(repository, [nightly("2026-10-30", stamp => `ruffle-nightly-${stamp}-macos-arm64.tar.xz`), ...releases]),
      version: "nightly-2026-10-30", usable: true },
    addedAsset: { routes: githubRoutes(repository, [githubRelease(repository, "nightly-2026-10-30", [...nightly("2026-10-30").assets.map(asset => asset.name),
      "ruffle-nightly-2026_10_30-macos-universal.tar.gz.sha256", "ruffle-nightly-2026_10_30-macos-debug-symbols.zip"], { prerelease: true }), ...releases]),
    version: "nightly-2026-10-30", usable: true },
    replacedFile: { routes: githubRoutes(repository, [replaced, releases[1]]), version: "nightly-2026-10-29", usable: true },
    deletedRelease: { routes: githubRoutes(repository, [releases[0]]), version: "nightly-2026-10-29", usable: true, deleted: "nightly-2026-10-28" }
  } };
