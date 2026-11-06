const crypto = require("node:crypto");

// GStreamer's package index: one folder per release, each listing its packages
// with a .sha256sum file beside them.
const ROOT = "https://gstreamer.freedesktop.org/data/pkg/osx/";
const hex = text => crypto.createHash("sha256").update(text).digest("hex");
const page = names => `<html><body><pre>${names.map(name => `<a href="${name}">${name}</a>`).join("\n")}</pre></body></html>`;
const runtime = release => `gstreamer-1.0-${release}-universal.pkg`;
// A release folder with its runtime, development package and checksums.
function folder(release, packages = [runtime(release), `gstreamer-1.0-devel-${release}-universal.pkg`], seed = "") {
  const routes = { [`${ROOT}${release}/`]: page(packages.flatMap(name => [name, name + ".sha256sum"])) };
  for (const name of packages) routes[`${ROOT}${release}/${name}.sha256sum`] = `${hex(seed + name)}  ${name}\n`;
  return routes;
}
const routes = (...folders) => Object.assign({ [ROOT]: page(folders.map(item => Object.keys(item)[0].slice(ROOT.length))) }, ...folders);
const latest = folder("1.26.7"), earlier = folder("1.24.13"), next = folder("2.0.0");

module.exports = {
  managers: ["translator-gstreamer"],
  current: routes(latest, earlier),
  scenarios: {
    newVersion: { routes: routes(next, latest, earlier), version: "2.0.0-universal", usable: true },
    renamedAsset: { routes: routes(folder("2.0.0", ["gstreamer-1.0-2.0.0-macos-arm64.pkg"]), latest, earlier), version: "2.0.0-macos-arm64", usable: "either" },
    addedAsset: { routes: routes(folder("2.0.0", [runtime("2.0.0"), "gstreamer-1.0-2.0.0-x86_64.pkg", "gstreamer-1.0-debug-2.0.0-universal.pkg",
      "gstreamer-1.0-2.0.0-universal.dmg"]), latest, earlier), version: "2.0.0-universal", usable: true },
    replacedFile: { routes: routes(folder("1.26.7", undefined, "replaced "), earlier), version: "1.26.7-universal", usable: true,
      digests: [hex("replaced " + runtime("1.26.7"))] },
    deletedRelease: { routes: routes(latest), version: "1.26.7-universal", usable: true, deleted: "1.24.13-universal" }
  }
};
