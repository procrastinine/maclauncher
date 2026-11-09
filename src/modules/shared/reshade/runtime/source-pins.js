// Copyright (c) MacLauncher contributors. MIT license.
// The upstream source revisions recorded by the installed graphics package.
// The app's graphics version lock fixes that package; every component source
// revision the app needs at runtime is read from its runtime.json here.
const fs = require("node:fs"), path = require("node:path");
function sourceRevision(relative, root = require("../index").runtimeRoot()) {
  const record = JSON.parse(fs.readFileSync(path.join(root, "runtime.json"), "utf8"));
  for (const line of Array.isArray(record.sourcePins) ? record.sourcePins : []) {
    const [revision, name] = String(line).trim().split(/\s+/);
    if (name === relative && /^[a-f0-9]{40}$/.test(revision)) return revision;
  }
  throw Error("The installed graphics package records no source revision for " + relative + ".");
}
module.exports = { sourceRevision };
