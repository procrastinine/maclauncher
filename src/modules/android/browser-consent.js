const fs = require("node:fs"), path = require("node:path");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const execute = promisify(execFile);
const script = fs.readFileSync(path.join(__dirname, "browser-consent.jxa"), "utf8");

/** Trusted UI outside the Android sandbox, positioned against its actual window. */
async function confirmGameLink(child, { executablePath, launchedAt, title, url, run = execute, platform = process.platform }) {
  if (platform !== "darwin" || !Number.isInteger(child?.pid) || child.pid <= 0 ||
      child.exitCode != null || child.signalCode != null || child.killed) return false;
  const controller = new AbortController(), stop = () => controller.abort();
  child.once("exit", stop); child.once("close", stop);
  try {
    if (!path.isAbsolute(executablePath || "") || !Number.isFinite(launchedAt) || launchedAt <= 0 ||
        require("./web-links").webUrl(url) !== url) return false;
    const identity = fs.statSync(fs.realpathSync(executablePath), { bigint: true });
    const request = { pid: child.pid, earliest: (launchedAt - 2000) / 1000,
      device: identity.dev.toString(), inode: identity.ino.toString(), title: String(title || "Android application"), url };
    const result = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, JSON.stringify(request)],
      { signal: controller.signal, timeout: 120000, maxBuffer: 4096 });
    return !controller.signal.aborted && result.stdout.trim() === "open";
  } catch { return false; }
  finally { child.removeListener("exit", stop); child.removeListener("close", stop); }
}

module.exports = { confirmGameLink };
