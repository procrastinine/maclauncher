const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Icons = require("./icon-utils");
const { throwIfAborted } = require("../modules/shared/runtime/download-utils");

const execute = promisify(execFile);

async function runIconCommand(command, args, { signal, ...options }) {
  throwIfAborted(signal);
  const pending = execute(command, args, options);
  // execFile's AbortSignal path can use SIGTERM independently of its timeout
  // signal. This private conversion child has no state to save on cancellation.
  const stop = () => pending.child.kill("SIGKILL");
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  try { return await pending; }
  finally { signal?.removeEventListener("abort", stop); }
}

// Runs in a backend worker. Only the extracted image crosses back to Electron.
async function extractIcon(sourcePath, source, { runCommand = runIconCommand, temporaryRoot = os.tmpdir(), signal } = {}) {
  throwIfAborted(signal);
  if (source === "exe") return { png: Icons.extractExeIconPngBuffer(sourcePath) };
  if (source !== "app") return null;
  const iconPath = Icons.findAppBundleIconPath(sourcePath);
  if (!iconPath) return null;
  if (process.platform !== "darwin") return { fallbackPath: iconPath };
  const directory = await fs.mkdtemp(path.join(temporaryRoot, "maclauncher-icon-"));
  try {
    const output = path.join(directory, "icon.png");
    await runCommand("/usr/bin/sips", ["-s", "format", "png", iconPath, "--out", output], {
      timeout: 10000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, signal
    });
    throwIfAborted(signal);
    const stat = await fs.stat(output);
    if (stat.isFile() && stat.size > 0 && stat.size <= 16 * 1024 * 1024) {
      const png = await fs.readFile(output);
      if (Icons.isSupportedImageBuffer(png)) return { png };
    }
  } catch { throwIfAborted(signal); } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  return { fallbackPath: iconPath };
}

module.exports = { extractIcon, runIconCommand };
