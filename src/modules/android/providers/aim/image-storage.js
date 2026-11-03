const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { assertOwnDirectory } = require("../../../shared/writable-input");

const RETIRED = /^\.maclauncher-aim-retired-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Called inside prepareSystem's per-folder serialization. An image volume has
// a different device from its parent. Stray host trees are renamed, never
// deleted here, so preparation does not depend on background upkeep or age.
function retireMountTargets(directory, { logger, signal } = {}) {
  assertOwnDirectory(path.dirname(directory), directory, { create: false });
  const parent = fs.lstatSync(directory), retired = [];
  try {
    for (const name of ["system", "derived"]) {
      signal?.throwIfAborted();
      const target = path.join(directory, name);
      let stat;
      try { stat = fs.lstatSync(target); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (stat.dev !== parent.dev) continue; // A mounted image stays attached.
      if (stat.isDirectory() && !fs.readdirSync(target).length) continue;
      const destination = path.join(directory, ".maclauncher-aim-retired-" + crypto.randomUUID());
      try { fs.renameSync(target, destination); }
      catch (error) {
        if (error.code === "EBUSY") throw Object.assign(new Error("The Android image folder is mounted or in use. Close the other Android session and try Play again.", { cause: error }), { code: "ANDROID_IMAGE_IN_USE" });
        throw error;
      }
      retired.push(name);
    }
  } finally {
    if (retired.length) logger?.info?.("[android] Retired stale AIM image folders: " + retired.join(", ") + ".");
  }
}

function imageDirectories(userDataDir) {
  const root = path.join(userDataDir, "android/runtimes/aim"), images = path.join(root, "images");
  assertOwnDirectory(userDataDir, images, { create: false });
  let names = [];
  try { names = fs.readdirSync(images).filter(name => /^[a-f0-9]{64}$/.test(name)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return [...names.map(name => path.join(images, name)),
    ...new Set(require("./image-cache.json").legacy.flatMap(row => row.versions).map(version => path.join(root, version)))];
}

module.exports = { retireMountTargets, imageDirectories, RETIRED };
