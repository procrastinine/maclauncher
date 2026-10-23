const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { runDownloadTask } = require("../runtime/download-manager");
const Models = require("./models");
function launchClient(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
const APP_ID = "993090", DEPOT_ID = "993091";
function clientRoots(home = os.homedir()) {
  return ["/Applications/Steam.app/Contents/MacOS", path.join(home, "Applications/Steam.app/Contents/MacOS"),
    path.join(home, "Library/Application Support/Steam/Steam.AppBundle/Steam/Contents/MacOS")];
}
function findClient({ home = os.homedir(), roots = clientRoots(home) } = {}) {
  for (const root of roots) {
    const file = path.join(root, "steam_osx");
    try { if (fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return file; } } catch {}
  }
  return null;
}
function readNewLines(file, cursor) {
  let handle;
  try {
    handle = fs.openSync(file, "r");
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) return "";
    if (stat.ino !== cursor.inode || stat.size < cursor.offset) cursor.offset = 0;
    cursor.inode = stat.ino;
    const bytes = Buffer.alloc(Math.min(1024 * 1024, stat.size - cursor.offset));
    cursor.offset += fs.readSync(handle, bytes, 0, bytes.length, cursor.offset);
    return bytes.toString("utf8");
  } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  finally { if (handle !== undefined) fs.closeSync(handle); }
}
async function acquire(context = {}, dependencies = {}) {
  const { userDataDir, signal, onProgress, home = os.homedir() } = context;
  const { executable = findClient({ home }), execute = launchClient, importModel = Models.importModel,
    timeout = 30 * 60 * 1000, pollInterval = 500 } = dependencies;
  if (!executable) throw new Error("Install Steam for Mac or use SteamCMD to download Lossless Scaling.");
  const steam = path.join(home, "Library/Application Support/Steam");
  const log = path.join(steam, "logs/console_log.txt");
  const stat = fs.statSync(log, { throwIfNoEntry: false });
  const cursor = { offset: stat?.size || 0, inode: stat?.ino };
  signal?.throwIfAborted();
  onProgress?.({ detail: "Waiting for Steam; cancel stops automatic import", downloaded: 0, total: null });
  // Steam forwards these arguments to the running client. download_depot uses
  // that client's existing account without changing its platform configuration.
  await execute(executable, ["-console", "+download_depot", APP_ID, DEPOT_ID]);
  const allowed = new Set([steam, ...clientRoots(home), path.dirname(executable)].map(root =>
    path.join(root, `steamapps/content/app_${APP_ID}/depot_${DEPOT_ID}`)));
  const deadline = Date.now() + timeout;
  let pending = "";
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    pending += readNewLines(log, cursor);
    const lines = pending.split(/\r?\n/); pending = lines.pop().slice(-16384);
    for (const line of lines) {
      if (/Depot download failed|not logged (?:on|in)/i.test(line))
        throw new Error("Steam could not download Lossless Scaling. Check the Steam console and account ownership, or try SteamCMD.");
      const complete = /Depot download complete\s*:\s*"([^"]+)"/.exec(line);
      if (!complete) continue;
      const directory = path.normalize(complete[1].replace(/\\/g, "/"));
      if (!allowed.has(directory)) continue;
      signal?.throwIfAborted();
      onProgress?.({ detail: "Importing Lossless Scaling models", downloaded: 0, total: null });
      const result = await importModel({ userDataDir, runtimePath: path.join(directory, "Lossless.dll"), signal });
      return { ...result, message: "Lossless Scaling downloaded with Steam for Mac and imported." };
    }
    await delay(pollInterval, undefined, { signal });
  }
  throw new Error("Steam download did not complete. Check the Steam console, then find the downloaded files or try SteamCMD.");
}
function downloadWithClient(context = {}) {
  return runDownloadTask(context.downloads, { dedupeKey: "lossless-steam", managerId: "graphics-models", sectionId: "default",
    label: "Lossless Scaling", detail: "Waiting for Steam; cancel stops automatic import" }, task => acquire({ ...context, ...task }));
}
module.exports = { APP_ID, DEPOT_ID, clientRoots, findClient, acquire, downloadWithClient };
