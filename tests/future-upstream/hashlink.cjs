const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease } = require("../helpers/future-upstream.cjs");

// HashLink publishes source-only numbered releases and a rolling `latest`
// release whose Intel Mac archive is named for its commit. The snapshot's
// version comes from the source files at that commit.
const repository = "HaxeFoundation/hashlink", API = `https://api.github.com/repos/${repository}/`;
const sha1 = text => crypto.createHash("sha1").update(text).digest("hex");
const first = sha1("snapshot one"), second = sha1("snapshot two");
const current = short => [`hashlink-${short}-darwin-cmake.tar.gz`, `hashlink-${short}-darwin-arm64-cmake.tar.gz`, `hashlink-${short}-win64.zip`, `hashlink-${short}-linux-amd64.tar.gz`];
function routes(commit, numbered, { version = "011000", assets = current, digest } = {}) {
  const latest = githubRelease(repository, "latest", assets(commit.slice(0, 7)), { prerelease: true });
  if (digest) latest.assets = latest.assets.map(asset => ({ ...asset, digest }));
  const result = githubRoutes(repository, [latest, ...numbered.map(tag => githubRelease(repository, tag, []))]);
  result[`${API}tags`] = result[`${API}tags`].map(tag => tag.name === "latest" ? { ...tag, commit: { sha: commit } } : tag);
  result[`${API}git/ref/tags/latest`] = { object: { type: "commit", sha: commit } };
  const raw = `https://raw.githubusercontent.com/HaxeFoundation/hashlink/${commit}/`;
  result[`${raw}src/hl.h`] = `#define HL_VERSION 0x${version}\n`;
  result[`${raw}src/code.c`] = "int max_version = 5;\nif( c->version <= 1 || c->version > max_version ) return NULL;";
  result[`${raw}libs/sdl/sdl.c`] = "DEFINE_PRIM(_BOOL, event_loop, _DYN);";
  return result;
}
const snapshot = (upstream, commit) => `${upstream}-dev-${commit.slice(0, 12)}`;
// Numbered releases list as source only; a new snapshot replaces the rolling one.
module.exports = { managers: ["hashlink"], current: routes(first, ["1.16", "1.15"]),
  scenarios: {
    newVersion: { routes: routes(second, ["1.17", "1.16", "1.15"], { version: "011100" }), version: snapshot("1.17.0", second), usable: true, deleted: snapshot("1.16.0", first) },
    renamedAsset: { routes: routes(second, ["1.17", "1.16", "1.15"], { version: "011100", assets: short => [`hashlink-${short}-macos-x86_64.tar.xz`, `hashlink-${short}-macos-arm64.zip`, `hashlink-${short}-windows-x64.zip`] }),
      version: snapshot("1.17.0", second), usable: true, deleted: snapshot("1.16.0", first) },
    addedAsset: { routes: routes(second, ["1.17", "1.16", "1.15"], { version: "011100", assets: short => [...current(short), `hashlink-${short}-darwin-cmake.sha256`,
      `hashlink-${short}-darwin-cmake-debug-symbols.zip`, `hashlink-${short}-linux-aarch64.AppImage`] }), version: snapshot("1.17.0", second), usable: true, deleted: snapshot("1.16.0", first) },
    replacedFile: { routes: routes(first, ["1.16", "1.15"], { digest: "sha256:" + "e".repeat(64) }), version: snapshot("1.16.0", first), usable: true, digests: ["e".repeat(64)] },
    deletedRelease: { routes: routes(first, ["1.16"]), version: snapshot("1.16.0", first), usable: true, deleted: "1.15" }
  },
  layout: {
    write(root) {
      fs.mkdirSync(path.join(root, "hashlink-1.16", "include"), { recursive: true });
      fs.writeFileSync(path.join(root, "hashlink-1.16", "hl"), "vm");
      return "hashlink-1.16/hl";
    },
    resolve: root => require("../../src/modules/hashlink/runtime/download").resolveExecutable(root)
  } };
