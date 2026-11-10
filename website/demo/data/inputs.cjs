// Prepares what the demo data generator reads beyond the source tree: the
// included runtime packages that build/runtime-packages.json locks for Apple
// Silicon, the Mac the generator presents. Packages that are missing from
// src/resources/native-runtimes are downloaded from their release assets,
// checked against the lock and unpacked there, as `pnpm setup:dev` does on a
// Mac. A checkout that already has every locked package is left unchanged.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../../..");
const Packages = require(path.join(repoRoot, "scripts/runtime-packages.cjs"));
const installed = path.join(repoRoot, "src/resources/native-runtimes");

// A package is present when its directory and its sealed declaration exist.
function missing(lock) {
  return lock.packages.filter(record => !fs.existsSync(path.join(installed, record.id, record.version, record.arch)) ||
    !fs.existsSync(path.join(installed, ".declarations", `${record.asset.sha256}.json`)));
}

async function prepare() {
  const lock = Packages.readLock({ repoRoot, arch: "arm64" });
  if (!missing(lock).length) return { fetched: 0, packages: lock.packages.length };
  const result = await Packages.fetchPackages({ repoRoot, lock });
  return { fetched: result.packages, packages: lock.packages.length };
}

module.exports = { prepare };
if (require.main === module) prepare()
  .then(result => console.log(`Included runtime packages: ${result.packages} locked, ${result.fetched} fetched`))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
