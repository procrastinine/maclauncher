const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, renameAsset, extraAssets } = require("../helpers/future-upstream.cjs");

const repository = "FWGS/xash3d-fwgs";
const ASSETS = ["xash3d-fwgs-apple-amd64.tar.xz", "xash3d-fwgs-apple-arm64.tar.xz", "xash3d-fwgs-linux-amd64.tar.gz",
  "xash3d-fwgs-win32-amd64.7z", "xash3d-fwgs-ios-arm64.ipa", "xash3d-fwgs-android.apk"];
const release = (tag, assets = ASSETS) => githubRelease(repository, tag, assets, { prerelease: true });
// The rolling main-branch release, a feature-branch build that stays unlisted
// and an old numbered release without files.
const releases = [release("continuous"), release("continuous-unvendoring"), release("v0.20", [])];
// Versions name the tag, its commit and the archive's digest, so a rebuilt
// archive is a new version and the replaced one leaves the list.
const snapshot = (item, name = "xash3d-fwgs-apple-arm64.tar.xz") =>
  `${item.tag_name.replace(/^v/, "")}-${crypto.createHash("sha1").update(item.tag_name).digest("hex")}-${item.assets.find(asset => asset.name === name).digest.slice(7)}`;
const rebuilt = { ...releases[0], assets: releases[0].assets.map(asset => ({ ...asset, size: asset.size + 1,
  digest: "sha256:" + crypto.createHash("sha256").update("rebuilt " + asset.name).digest("hex") })) };
const numbered = release("v0.21");
module.exports = { managers: ["xash3d-fwgs"], current: githubRoutes(repository, releases),
  scenarios: {
    newVersion: { routes: githubRoutes(repository, [numbered, ...releases]), version: snapshot(numbered), usable: true },
    renamedAsset: { routes: githubRoutes(repository, [release("v0.21", ASSETS.map(renameAsset)), ...releases]), usable: "either" },
    addedAsset: { routes: githubRoutes(repository, [release("continuous", [...ASSETS, ...extraAssets(releases[0].assets)]), ...releases.slice(1)]),
      version: snapshot(releases[0]), usable: true },
    replacedFile: { routes: githubRoutes(repository, [rebuilt, ...releases.slice(1)]), version: snapshot(rebuilt), usable: true,
      deleted: [snapshot(releases[0]), snapshot(releases[0], "xash3d-fwgs-apple-amd64.tar.xz")] },
    deletedRelease: { routes: githubRoutes(repository, [releases[0], releases[2]]), version: snapshot(releases[0]), usable: true }
  },
  layout: {
    write(root) { fs.writeFileSync(path.join(root, "xash3d"), ""); return "xash3d"; },
    resolve: root => require("../../src/modules/xash3d/runtime/manager").resolveExecutable(root)
  } };
