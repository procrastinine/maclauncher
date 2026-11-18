"use strict";
// A fixture executable compiled once for its compiler, arguments and input files and kept under the system
// temporary folder, so a test's deadline times the executable's own run, and later runs reuse the same linked file
// instead of compiling, signing and first-launching a new one. Builds of other inputs older than a day are removed.
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DAY = 24 * 60 * 60 * 1000;

function cachedBinary(name, compiler, args, inputs, { root = path.join(os.tmpdir(), "maclauncher-test-binaries") } = {}) {
  const hash = crypto.createHash("sha256");
  const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
  hash.update(JSON.stringify([compiler, version.stdout || "", args]));
  for (const file of inputs) hash.update(path.resolve(file)).update("\0").update(fs.readFileSync(file));
  const key = hash.digest("hex").slice(0, 24), parent = path.join(root, name), binary = path.join(parent, key, name);
  if (fs.existsSync(binary)) return { binary, compiled: false };
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  // Concurrent test processes each link their own file; the first rename wins and later ones replace it with the same build.
  const partial = path.join(path.dirname(binary), `.${name}.${process.pid}.${Date.now()}`);
  const result = spawnSync(compiler, [...args, "-o", partial], { encoding: "utf8" });
  if (result.status !== 0) {
    fs.rmSync(partial, { force: true });
    return { binary: null, compiled: false, error: result.stderr || String(result.error || `status ${result.status}`) };
  }
  fs.renameSync(partial, binary);
  for (const other of fs.readdirSync(parent)) {
    const folder = path.join(parent, other);
    try { if (other !== key && Date.now() - fs.statSync(folder).mtimeMs > DAY) fs.rmSync(folder, { recursive: true, force: true }); } catch {}
  }
  return { binary, compiled: true };
}

module.exports = { cachedBinary };
