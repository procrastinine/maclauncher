const fs = require("node:fs"), path = require("node:path");

// easyrpg.org lists one folder per release, and each folder lists its files.
// The publisher states no checksum, so a replaced file needs no new listing.
const ROOT = "https://easyrpg.org/downloads/player/";
const listing = (base, names) => `<html><body><table>${["..", ...names].map(name =>
  `<tr><td><a href="${name === ".." ? ".." : base + encodeURIComponent(name).replace(/%2F/g, "/")}">${name}</a></td></tr>`).join("")}</table></body></html>`;
const platforms = version => ["macos.app.zip", "macos-libretro.zip", "windows.zip", "linux.tar.gz", "android.apk"].map(suffix => `easyrpg-player-${version}-${suffix}`);
function routes(versions, files = {}) {
  const result = { [ROOT]: listing("/downloads/player/", [...versions.map(version => version + "/"), "dbgsym/", "latest/", "0.7.0/", "Player_Win98.zip"]) };
  for (const version of versions) result[`${ROOT}${version}/`] = listing(`/downloads/player/${version}/`, ["dbgsym/", ...(files[version] || platforms(version))]);
  return result;
}
module.exports = { managers: ["easyrpg"], current: routes(["0.8.1.1", "0.8.1"]),
  scenarios: {
    newVersion: { routes: routes(["0.9", "0.8.1.1", "0.8.1"]), version: "0.9", usable: true },
    renamedAsset: { routes: routes(["0.9", "0.8.1.1", "0.8.1"], { "0.9": ["easyrpg-player-0.9-macos-universal.dmg", "easyrpg-player-0.9-macos-libretro.zip",
      "easyrpg-player-0.9-windows-x86.zip", "easyrpg-player-0.9-linux-x86_64.tar.xz", "easyrpg-player-0.9-macos-universal.dmg.sha256", "easyrpg-player-0.9-src.tar.xz"] }),
    version: "0.9", usable: true },
    addedAsset: { routes: routes(["0.9", "0.8.1.1", "0.8.1"], { "0.9": [...platforms("0.9"), "easyrpg-player-0.9-macos-arm64-debug.zip", "easyrpg-player-0.9-riscv64.tar.gz"] }),
      version: "0.9", usable: true },
    replacedFile: { routes: routes(["0.8.1.1", "0.8.1"]), version: "0.8.1.1", usable: true },
    deletedRelease: { routes: routes(["0.8.1.1"]), version: "0.8.1.1", usable: true, deleted: "0.8.1" }
  },
  layout: {
    write(root) {
      fs.mkdirSync(path.join(root, "EasyRPG Player.app", "Contents", "MacOS"), { recursive: true });
      return "EasyRPG Player.app";
    },
    resolve: root => require("../../src/modules/easyrpg/runtime/manager").resolveExecutable(root)
  } };
