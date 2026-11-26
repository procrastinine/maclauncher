const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const QUARANTINE_ATTRIBUTE = "com.apple.quarantine";
const XATTR = "/usr/bin/xattr";

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// The folders that hold a game's app and the native libraries its own processes
// load: the app folder or archive, and the folder holding it (Electron's
// resources folder) when that folder belongs to the same release. A release
// whose app is its own root clears only that folder; the folders above a
// release, and paths a link leads to outside it, stay untouched.
function appRoots({ appRoot, gameRoot } = {}) {
  if (typeof appRoot !== "string" || typeof gameRoot !== "string" ||
    !path.isAbsolute(appRoot) || !path.isAbsolute(gameRoot)) return [];
  let root;
  try { root = fs.realpathSync(gameRoot); } catch { return []; }
  try { if (!fs.statSync(root).isDirectory()) return []; } catch { return []; }
  const roots = [];
  for (const candidate of [appRoot, path.dirname(appRoot)]) {
    let real;
    try { real = fs.realpathSync(candidate); } catch { continue; }
    if (real === root || inside(root, real)) roots.push(real);
  }
  return [...new Set(roots)];
}

// Gatekeeper marks downloaded files for approval. Loading a quarantined native
// library waits for that approval before it returns, so a game imported
// straight from a download hangs before its first window when its app loads
// one. macOS drops the attribute once its user approves the file; launch does
// the same for the folders it starts, as installation does for the runtimes it
// downloads (managed-quarantine).
async function removeGameQuarantine({ appRoot, gameRoot }, { platform = process.platform, execute = execFile, logger } = {}) {
  if (platform !== "darwin") return [];
  const roots = appRoots({ appRoot, gameRoot });
  if (!roots.length) return [];
  const run = args => new Promise((resolve, reject) => {
    // -s acts on links themselves, so shared folders a link leads to outside
    // the game's release are never touched.
    execute(XATTR, args, { timeout: 30000, maxBuffer: 1024 * 1024, shell: false },
      (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message).trim())) : resolve(String(stdout || "")));
  });
  const cleared = [];
  for (const root of roots) {
    try {
      await run(["-drs", QUARANTINE_ATTRIBUTE, root]);
    } catch (error) {
      // macOS can reject removexattr on a file that carries no quarantine
      // attribute, for example a read-only publisher file. The launch fails
      // only when the attribute really remains.
      let attributes;
      try { attributes = await run(["-rs", root]); }
      catch { throw error; }
      if (/(?:^|[\s:])com\.apple\.quarantine(?:\r?\n|$)/.test(attributes))
        throw new Error(`Could not prepare the game's app at ${root}: ${error.message}`);
    }
    cleared.push(root);
  }
  if (cleared.length) logger?.info?.(`[game-quarantine] cleared ${cleared.join(", ")}`);
  return cleared;
}

module.exports = { appRoots, removeGameQuarantine };