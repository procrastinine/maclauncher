const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const Native = require("./local-native");

function snapshotPrefix(prefix, { readRoots = [] } = {}) {
  if (!path.isAbsolute(prefix || "") || !fs.lstatSync(prefix).isDirectory()) throw new Error("Dependency prefixes must be real absolute directories.");
  const root = fs.realpathSync(prefix), files = [], tree = crypto.createHash("sha256");
  if (!Array.isArray(readRoots) || readRoots.length > 8 || readRoots.some(value => !path.isAbsolute(value || "") || !fs.lstatSync(value).isDirectory())) throw new Error("Dependency read roots must be explicit real directories.");
  const roots = [root, ...readRoots.map(value => fs.realpathSync(value))];
  let bytes = 0;
  function visit(directory, relative = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), item = path.posix.join(relative, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) { visit(file, item); continue; }
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("Dependency prefix contains an unsupported file.");
      const resolved = fs.realpathSync(file);
      if (!roots.some(value => resolved.startsWith(value + path.sep)) || !fs.statSync(resolved).isFile()) throw new Error("Dependency links must stay inside their declared prefixes.");
      const size = fs.statSync(resolved).size; bytes += size;
      if (files.length >= 8000 || bytes > 256 * 1024 * 1024) throw new Error("Dependency inventory exceeds its bounds.");
      const row = { path: item, sha256: Native.hashFile(resolved), size, mode: stat.mode & 0o777,
        ...(stat.isSymbolicLink() ? { link: fs.readlinkSync(file) } : {}) };
      files.push(row); tree.update(JSON.stringify(row) + "\n");
    }
  }
  visit(root); return { prefix: root, sha256: tree.digest("hex"), files, bytes };
}

function validateStack(stack, catalog, recipeSha256) {
  if (!stack || stack.version !== catalog.version || stack.architecture !== catalog.architecture || stack.minimumMacOS !== catalog.minimumMacOS ||
    stack.recipeSha256 !== recipeSha256 || !/^[a-f0-9]{64}$/.test(stack.prefixSha256 || "") || !Array.isArray(stack.sources) || stack.sources.length !== catalog.dependencies.length) {
    throw new Error("Dependency reuse requires the exact source recipe and prefix checksum.");
  }
  for (const pin of catalog.dependencies) {
    const source = stack.sources.find(row => row.id === pin.id);
    if (!source || Object.keys(pin).some(key => !isDeepStrictEqual(source[key], pin[key]))) throw new Error("Dependency source identity differs from the selected profile.");
  }
  const inventory = snapshotPrefix(stack.prefix);
  if (inventory.sha256 !== stack.prefixSha256) throw new Error("Dependency prefix checksum changed.");
  return inventory;
}

function linkPrefix(inputPrefix, outputPrefix, { readRoots = [] } = {}) {
  const original = fs.realpathSync(inputPrefix), output = fs.realpathSync(outputPrefix);
  if (!Array.isArray(readRoots) || readRoots.length > 8 || readRoots.some(value => !path.isAbsolute(value || "") || !fs.lstatSync(value).isDirectory())) throw new Error("Dependency read roots must be explicit real directories.");
  const roots = [original, ...readRoots.map(value => fs.realpathSync(value))];
  if (output === original || output.startsWith(original + path.sep) || original.startsWith(output + path.sep)) throw new Error("Dependency links require a separate build prefix.");
  function visit(directory, relative) {
    const destination = path.join(output, relative); fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(directory).sort()) {
      const source = path.join(directory, name), target = path.join(destination, name), stat = fs.lstatSync(source);
      if (stat.isDirectory()) { visit(source, path.join(relative, name)); continue; }
      const resolved = fs.realpathSync(source);
      if ((!stat.isFile() && !stat.isSymbolicLink()) || !roots.some(value => resolved.startsWith(value + path.sep)) || !fs.statSync(resolved).isFile()) throw new Error("Dependency links must reference declared regular files.");
      if (fs.existsSync(target)) {
        if (Native.hashFile(target) !== Native.hashFile(resolved)) throw new Error("Dependency prefixes contain conflicting files.");
      } else fs.symlinkSync(resolved, target);
    }
  }
  for (const relative of ["include", "lib"]) if (fs.existsSync(path.join(original, relative))) visit(path.join(original, relative), relative);
}

module.exports = { snapshotPrefix, validateStack, linkPrefix };
