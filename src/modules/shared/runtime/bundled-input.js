// Files that ship inside MacLauncher, and the inputs MacLauncher Builds
// compiles from, are pinned: one exact version and checksum, so the build can
// be reproduced. Packaging scripts fetch them from `origin`; the app has no way
// to download one and only checks the copy it carries. Anything downloaded at
// run time from an upstream publisher is a source in upstream.js instead.
function bundledInput({ name, version, sha256, bytes, origin, ...details }) {
  return Object.freeze({ ...details, name, version, sha256, ...(bytes ? { bytes } : {}), ...(origin ? { origin } : {}) });
}

module.exports = { bundledInput };
