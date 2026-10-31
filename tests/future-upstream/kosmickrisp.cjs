const crypto = require("node:crypto");

// LWJGL's own listing names each release folder. Its build host serves each
// release's KosmicKrisp library with its size and a sidecar naming the Mesa
// revision. The Vulkan loader comes from Homebrew's formula metadata and GHCR
// bottle when the library is installed.
const LIST = "https://www.lwjgl.org/list?path=release/";
const library = version => `https://build.lwjgl.org/release/${version}/macosx/arm64/libvulkan_kosmickrisp.dylib`;
const revision = text => crypto.createHash("sha1").update(text).digest("hex");
const bottle = "c".repeat(64), bottleUrl = `https://ghcr.io/v2/homebrew/core/vulkan-loader/blobs/sha256:${bottle}`;
// `files` maps each version to the content its library URL serves; a version
// without an entry has no KosmicKrisp library.
function routes(versions, files = Object.fromEntries(versions.map(version => [version, version]))) {
  const result = { [LIST]: { path: "release/", folders: versions.map(version => version + "/"), files: [] } };
  for (const [version, content] of Object.entries(files)) {
    result[library(version)] = { status: 200, body: Buffer.alloc(0), headers: { "content-length": String(4096 + content.length) } };
    result[library(version) + ".git"] = revision(content) + "\n";
  }
  result["https://formulae.brew.sh/api/formula/vulkan-loader.json"] = { name: "vulkan-loader", versions: { stable: "1.4.328" },
    bottle: { stable: { rebuild: 0, files: { arm64_tahoe: { cellar: ":any", url: bottleUrl, sha256: bottle } } } } };
  result["https://ghcr.io/token"] = { token: "fixture-token" };
  result[bottleUrl] = { status: 200, body: Buffer.alloc(0), headers: { "content-length": "65536" } };
  return result;
}
const current = ["3.4.3", "3.4.2"];

module.exports = {
  managers: ["vulkan-kosmickrisp"],
  current: routes(current),
  scenarios: {
    newVersion: { routes: routes(["4.0.0", ...current]), version: "4.0.0", usable: true },
    // A release without a macOS KosmicKrisp library is left out.
    releaseWithoutLibrary: { routes: routes(["4.0.0", ...current], { "3.4.3": "3.4.3", "3.4.2": "3.4.2" }), version: "4.0.0", usable: "either" },
    // The build host replaced 3.4.3's library: the new size and revision apply.
    replacedFile: { routes: routes(current, { "3.4.3": "replaced 3.4.3", "3.4.2": "3.4.2" }), version: "3.4.3", usable: true },
    deletedRelease: { routes: routes(["3.4.3"]), version: "3.4.3", usable: true, deleted: "3.4.2" },
    // A listing entry that is not a release folder is ignored.
    unrelatedFolder: { routes: { ...routes(current), [LIST]: { path: "release/", folders: ["latest/", "nightly/", ...current.map(version => version + "/")] } },
      version: "3.4.3", usable: true }
  }
};
