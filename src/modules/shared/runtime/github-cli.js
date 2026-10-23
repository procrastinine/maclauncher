const fs = require("node:fs");
const path = require("node:path");

// Finder and Dock launches do not inherit an interactive shell's PATH.
// Resolve the installed executable without running shell startup files or
// changing the environment used by games.
function executable({ env = process.env, platform = process.platform, fileSystem = fs } = {}) {
  const directories = [...new Set([...String(env.PATH || "").split(path.delimiter),
    ...(platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"] : [])])];
  for (const directory of directories) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, platform === "win32" ? "gh.exe" : "gh");
    try {
      if (!fileSystem.statSync(candidate).isFile()) continue;
      fileSystem.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return "gh";
}

async function available({ runCommand, logger, required = false } = {}) {
  try {
    await runCommand(executable(), ["auth", "status", "--hostname", "github.com"]);
    return true;
  } catch (cause) {
    const missing = cause?.code === "ENOENT";
    const message = missing
      ? "GitHub CLI (gh) was not found. Install gh, then authenticate with gh auth login."
      : "GitHub CLI (gh) is installed, but GitHub authentication could not be verified. Run gh auth login --hostname github.com, then try again.";
    logger?.warn?.(message);
    if (required) throw new Error(message, { cause });
    return false;
  }
}

module.exports = { executable, available };
