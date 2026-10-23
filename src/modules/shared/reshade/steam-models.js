const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { promisify } = require("node:util"), { execFile } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const Writable = require("../writable-input");
const { fetchUrlBuffer } = require("../runtime/download-utils");
const { runDownloadTask } = require("../runtime/download-manager");
const Models = require("./models");
const run = promisify(execFile);
// Valve's macOS bootstrap updates itself after launch. Pin the downloaded
// bootstrap; Steam verifies the authenticated application download separately.
const BOOTSTRAP = Object.freeze({ url: "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz",
  sha256: "8ecc17c8988e5acadcc78e631c48490f76150f2dfaa6cf8d7b4b67b097bd753b" });
const quote = text => "'" + text.replace(/'/g, "'\\''") + "'";
function terminalScript(session) {
  if (!path.isAbsolute(session) || /[\x00-\x1f]/.test(session)) throw new Error("Invalid Steam download directory.");
  return `#!/bin/bash
set -m
umask 077
cd ${quote(session)} || exit 1
steam_pid=
watch_pid=
finish() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ -n "$steam_pid" ]; then
    kill -TERM -- "-$steam_pid" 2>/dev/null
    sleep 2
    kill -KILL -- "-$steam_pid" 2>/dev/null
  fi
  if [ -n "$watch_pid" ]; then kill "$watch_pid" 2>/dev/null; wait "$watch_pid" 2>/dev/null; fi
  if [ -f active ]; then printf '%s' "$result" > result.tmp; mv result.tmp result; fi
}
trap finish EXIT
trap 'exit 1' HUP INT TERM
terminal_pid=$$
(
  while [ -f active ] && [ ! -f cancel ]; do sleep 1; done
  if [ -f steam.pid ]; then
    steam_job=$(cat steam.pid)
    kill -TERM -- "-$steam_job" 2>/dev/null
    sleep 2
    kill -KILL -- "-$steam_job" 2>/dev/null
  fi
  kill -TERM "$terminal_pid" 2>/dev/null
) </dev/null >/dev/null 2>&1 &
watch_pid=$!
printf '%s\\n' 'Download Lossless Scaling from Steam' 'Sign in with a Steam account that owns Lossless Scaling.' 'Password and Steam Guard prompts are handled by SteamCMD.'
printf 'Steam account name: '
IFS= read -r steam_account || exit 1
case "$steam_account" in ''|*[!a-zA-Z0-9_]*|anonymous) printf '%s\\n' 'A Steam account name is required.'; exit 1;; esac
[ -f active ] && [ ! -f cancel ] || exit 1
/usr/bin/env -i HOME="$PWD/home" TMPDIR="$PWD/tmp/" PATH=/usr/bin:/bin:/usr/sbin:/sbin \\
  ./tools/steamcmd.sh +@sSteamCmdForcePlatformType windows +@ShutdownOnFailedCommand 1 \\
  +force_install_dir "$PWD/content" +login "$steam_account" +app_update 993090 validate +quit &
steam_pid=$!
printf '%s' "$steam_pid" > steam.pid
# Bring SteamCMD's job to the foreground so its password/Guard prompts own the TTY.
fg %2
result=$?
if [ -f active ] && [ ! -f cancel ]; then steam_pid=; fi
printf '%s\\n' 'Steam finished. Return to MacLauncher for the import result.'
exit "$result"
`;
}
async function terminalDownload(session, { signal, execute = run, timeout = 30 * 60 * 1000 } = {}) {
  const script = path.join(session, "Download Lossless Scaling.command");
  fs.writeFileSync(script, terminalScript(session), { mode: 0o700, flag: "wx" });
  fs.writeFileSync(path.join(session, "active"), "", { mode: 0o600, flag: "wx" });
  let finished = false;
  try {
    signal?.throwIfAborted();
    await execute("/usr/bin/open", ["-a", "Terminal", script], { signal, timeout: 15000 });
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const result = path.join(session, "result");
      if (fs.existsSync(result)) {
        finished = true;
        if (fs.readFileSync(result, "utf8") !== "0") throw new Error("Steam download did not finish. Check the SteamCMD window, confirm account ownership, and try again.");
        return;
      }
      await delay(500, undefined, { signal });
    }
    throw new Error("Steam sign-in or download timed out. Try Download from Steam again.");
  } finally {
    fs.writeFileSync(path.join(session, "cancel"), "", { mode: 0o600 });
    fs.rmSync(path.join(session, "active"), { force: true });
    // The terminal watchdog stops the foreground process group before cleanup.
    if (!finished) await delay(3500);
  }
}
async function acquire(context = {}, dependencies = {}) {
  const { userDataDir, signal, onProgress } = context;
  const { fetchBootstrap = fetchUrlBuffer, execute = run, authenticate = terminalDownload, importModel = Models.importModel } = dependencies;
  const root = path.join(userDataDir, "runtimes/lossless-steam");
  Writable.assertOwnDirectory(userDataDir, root);
  const session = fs.mkdtempSync(path.join(root, ".download-"));
  try {
    for (const name of ["tools", "home", "tmp", "content"]) fs.mkdirSync(path.join(session, name), { mode: 0o700 });
    onProgress?.({ detail: "Downloading SteamCMD", downloaded: 0, total: null });
    const { body: bytes } = await fetchBootstrap(BOOTSTRAP.url, { signal, maxBytes: 32 * 1024 * 1024 });
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== BOOTSTRAP.sha256)
      throw new Error("The SteamCMD download has changed. Import an installed Lossless Scaling DLL or update MacLauncher.");
    const archive = path.join(session, "steamcmd.tar.gz"); fs.writeFileSync(archive, bytes, { mode: 0o600, flag: "wx" });
    await execute("/usr/bin/tar", ["-xzf", archive, "-C", path.join(session, "tools")], { signal, timeout: 30000 });
    await context.ensureRosetta?.({ signal });
    onProgress?.({ detail: "Complete Steam sign-in in Terminal", downloaded: 0, total: null });
    await authenticate(session, { signal });
    signal?.throwIfAborted();
    const runtimePath = path.join(session, "content/Lossless.dll");
    if (!fs.existsSync(runtimePath)) throw new Error("Steam did not download Lossless.dll. Confirm that the Steam account owns Lossless Scaling, or import an installed DLL.");
    onProgress?.({ detail: "Importing Lossless Scaling models", downloaded: 0, total: null });
    return { ...await importModel({ userDataDir, runtimePath, signal }), message: "Lossless Scaling models downloaded and imported." };
  } finally { await fs.promises.rm(session, { recursive: true, force: true }); }
}
function downloadFromSteam(context = {}) {
  if (process.platform !== "darwin") throw new Error("Steam download requires macOS.");
  return runDownloadTask(context.downloads, { dedupeKey: "lossless-steam", managerId: "graphics-models", sectionId: "default", label: "Lossless Scaling", detail: "Downloading from Steam" },
    task => acquire({ ...context, ...task }));
}
module.exports = { BOOTSTRAP, terminalScript, terminalDownload, acquire, downloadFromSteam };
