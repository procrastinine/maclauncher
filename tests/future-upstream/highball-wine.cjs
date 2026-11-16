const fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// Engine releases hold one archive and its checksum file. Intel builds are
// tagged engine-wine-<version>-<build>, arm64 builds engine-arm64-wine-...;
// the repository's other releases are not Wine. An arm64 build waits for the
// Highball application, which the offline fixture does not have.
const repository = "gauthierpiarrette/highball-engine";
const release = tag => githubRelease(repository, tag, [`${tag}.tar.gz`, `${tag}.tar.gz.sha256`]);
const releases = [release("engine-wine-11.0-20261112T101620Z-gst-rpath-0030"), release("engine-arm64-wine-11.18-20261108T132317Z-spatial-0056-0057"),
  release("engine-wine-10.18-20261020T080000Z-0020"), githubRelease(repository, "renderer-dxmt-0.7", ["renderer-dxmt-0.7.tar.gz"])];
const version = tag => /\d+\.\d+.*$/.exec(tag)?.[0] || tag;
module.exports = { managers: ["highball-wine"], current: githubRoutes(repository, releases),
  scenarios: githubScenarios(repository, releases, { version, bump: value => value.replace(/^(\d+)\.(\d+)/, (_, major, minor) => `${major}.${Number(minor) + 1}`) }),
  layout: {
    write(root) {
      const engine = path.join(root, "engine");
      for (const name of ["wine", "wineserver"]) { fs.mkdirSync(path.join(engine, "bin"), { recursive: true }); fs.writeFileSync(path.join(engine, "bin", name), name); }
      fs.mkdirSync(path.join(engine, "lib", "wine"), { recursive: true });
      return "engine/bin/wine";
    },
    resolve: root => path.join(root, require("../../src/runtime-adapters/wine-release").findWine(root).entry)
  } };
