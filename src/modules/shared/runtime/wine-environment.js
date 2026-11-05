const fs = require("node:fs");
const path = require("node:path");
const Writable = require("../writable-input");

const INHERIT = "inherit";
const privateEnvironments = new WeakSet();
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};

// Only these launcher-owned roots may issue an initialization capability.
// An external reference is data, and can never be used as this capability.
function privateEnvironment(userDataDir, directory, relativePath) {
  if (!path.isAbsolute(userDataDir || "") || !path.isAbsolute(directory || "") ||
      typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error("A private Windows environment requires its launcher data directory.");
  }
  const relative = path.relative(userDataDir, directory).split(path.sep);
  const game = relative.length === 3 && relative[0] === "games" && /^[\w-]+$/.test(relative[1]) &&
    ["crossover", "sikarugir"].includes(relative[2]);
  const compute = relative.length === 3 && relative[0] === "graphics" && relative[1] === "compute-hosts" && /^[a-f0-9]+$/.test(relative[2]);
  const prefixPath = path.resolve(directory, relativePath);
  if ((!game && !compute) || prefixPath === path.resolve(directory) || !inside(directory, prefixPath)) {
    throw new Error("Windows environment initialization requires an owned private environment.");
  }
  Writable.assertOwnDirectory(userDataDir, directory, { create: false });
  Writable.assertOwnDirectory(directory, prefixPath, { create: false });
  const record = Object.freeze({ kind: "private", prefixPath, directory: path.resolve(directory), userDataDir: path.resolve(userDataDir) });
  privateEnvironments.add(record);
  return record;
}

function assertPrivateEnvironment(record, directory) {
  if (!privateEnvironments.has(record) || record.directory !== path.resolve(directory)) {
    throw new Error("External Windows environments cannot be initialized, recreated or removed.");
  }
  Writable.assertOwnDirectory(record.userDataDir, record.prefixPath, { create: false });
  return record.prefixPath;
}

function environmentReference(value) {
  if (value == null || value === "" || value === "private") return null;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { throw new Error("Invalid Windows environment reference."); } }
  if (!value || !["crossover-bottle", "sikarugir-wrapper"].includes(value.kind) ||
      !path.isAbsolute(value.path || "") || /[\0\r\n]/.test(value.path)) throw new Error("Invalid Windows environment reference.");
  return { kind: value.kind, path: path.resolve(value.path),
    ...(typeof value.bottleId === "string" ? { bottleId: value.bottleId } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}) };
}

module.exports = { INHERIT, inside, privateEnvironment, assertPrivateEnvironment, environmentReference };
