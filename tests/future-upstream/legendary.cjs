// Legendary publishes wheels and source archives on PyPI. The JSON API lists
// every release with each upload's size, SHA-256 and Python requirement; the
// included Python chooses a wheel it accepts. PyPI files never change behind a
// URL, so a release changes by new uploads, yanked uploads or removal.
const crypto = require("node:crypto");
const PROJECT = "https://pypi.org/pypi/legendary-gl/json";
function upload(version, filename, extra = {}) {
  const hash = crypto.createHash("sha256").update(filename).digest("hex");
  return { filename, packagetype: filename.endsWith(".whl") ? "bdist_wheel" : "sdist", python_version: filename.endsWith(".whl") ? "py3" : "source",
    requires_python: ">=3.9", size: 180000 + filename.length, yanked: false, yanked_reason: null, upload_time_iso_8601: "2026-01-01T00:00:00.000000Z",
    digests: { sha256: hash, md5: hash.slice(0, 32), blake2b_256: hash },
    url: `https://files.pythonhosted.org/packages/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4)}/${filename}`, ...extra };
}
const wheel = version => upload(version, `legendary_gl-${version}-py3-none-any.whl`);
const sdist = version => upload(version, `legendary_gl-${version}.tar.gz`);
function routes(releases) {
  const versions = Object.keys(releases), newest = versions[0];
  return { [PROJECT]: { info: { name: "legendary-gl", version: newest, requires_python: ">=3.9", project_url: "https://pypi.org/project/legendary-gl/" },
    releases, urls: releases[newest], last_serial: 1 } };
}
const releases = { "0.20.34": [wheel("0.20.34"), sdist("0.20.34")], "0.20.33": [wheel("0.20.33"), sdist("0.20.33")], "0.20.32": [wheel("0.20.32")] };
module.exports = { managers: ["legendary"], current: routes(releases),
  scenarios: {
    newVersion: { routes: routes({ "0.21.0": [wheel("0.21.0"), sdist("0.21.0")], ...releases }), version: "0.21.0", usable: true },
    // A release with only a source archive or a wheel for another Python has no usable wheel.
    sourceOnly: { routes: routes({ "0.22.0": [sdist("0.22.0"), upload("0.22.0", "legendary_gl-0.22.0-cp27-cp27m-win32.whl")], ...releases }),
      version: "0.22.0", usable: "either" },
    // Additional wheels next to the universal one: the release stays usable.
    addedAsset: { routes: routes({ "0.21.0": [wheel("0.21.0"), upload("0.21.0", "legendary_gl-0.21.0-cp312-cp312-macosx_11_0_arm64.whl"), sdist("0.21.0")], ...releases }),
      version: "0.21.0", usable: true },
    // A yanked upload is skipped; the release's other wheel stays.
    yankedRelease: { routes: routes({ ...releases, "0.20.34": [{ ...wheel("0.20.34"), yanked: true, yanked_reason: "broken" }, sdist("0.20.34")] }),
      version: "0.20.34", usable: "either", deleted: "0.20.34" },
    deletedRelease: { routes: routes({ "0.20.34": releases["0.20.34"], "0.20.33": releases["0.20.33"] }), version: "0.20.34", usable: true, deleted: "0.20.32" }
  } };
