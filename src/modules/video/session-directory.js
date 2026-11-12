const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const marker = ".maclauncher-mpv-owner.json", sessions = new Map();
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}
function processes() {
  try { return execFileSync("/bin/ps", ["-ww", "-axo", "pid=,command="], { encoding: "utf8", timeout: 2000, maxBuffer: 8 * 1024 * 1024 }); }
  catch { return null; } // An unavailable process inventory never authorizes removal.
}
function used(commands, directory, root) {
  const names = new Set([directory, path.join(root, path.basename(directory))]);
  return [...names].some(name => commands.split("\n").some(line => {
    const option = "--config-dir=" + name, at = line.indexOf(option);
    return at >= 0 && (at + option.length === line.length || /\s/.test(line[at + option.length]));
  }));
}
function reclaim() {
  const root = os.tmpdir();
  let names;
  try { names = fs.readdirSync(root).filter(name => /^maclauncher-mpv-(?:[1-9]\d*-)?[A-Za-z0-9]{6}$/.test(name)); }
  catch { return; }
  if (!names.length) return;
  const commands = processes();
  if (commands === null) return;
  for (const name of names) {
    const directory = path.join(root, name);
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const real = fs.realpathSync(directory);
      if (used(commands, real, root)) continue;
      const encoded = /^maclauncher-mpv-([1-9]\d*)-/.exec(name);
      let owner;
      try {
        const file = path.join(directory, marker), info = fs.lstatSync(file);
        if (!info.isFile() || info.size > 1024) continue;
        owner = JSON.parse(fs.readFileSync(file, "utf8"));
        if (owner.schema !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) continue;
      } catch (error) { if (error.code !== "ENOENT") continue; }
      if (owner ? alive(owner.pid) : encoded && alive(Number(encoded[1]))) continue;
      // A preparer can die between spawning its player and recording its PID.
      // Leave recent unbound folders alone, then check the player's arguments.
      if (!owner?.player && Date.now() - stat.mtimeMs < 60000) continue;
      if (!encoded && !owner) {
        // Earlier releases have no marker. Match their generated layout only.
        if (fs.readdirSync(directory).length && !["fonts", "script-opts"].every(part => fs.lstatSync(path.join(directory, part)).isDirectory())) continue;
      }
      const current = fs.lstatSync(directory);
      if (current.dev !== stat.dev || current.ino !== stat.ino) continue;
      fs.rmSync(directory, { recursive: true, force: true });
    } catch { /* Another playback may already have reclaimed this folder. */ }
  }
}
function create() {
  reclaim();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `maclauncher-mpv-${process.pid}-`));
  let player = null;
  const cleanup = () => {
    if (player && player.exitCode == null && player.signalCode == null && alive(player.pid)) return;
    try { fs.rmSync(directory, { recursive: true, force: true }); sessions.delete(directory); }
    catch { /* Keep ownership so process exit or the next playback retries. */ }
  };
  const record = pid => {
    const file = path.join(directory, marker), staging = file + ".tmp";
    fs.writeFileSync(staging, JSON.stringify({ schema: 1, pid, player: Boolean(player) }), { mode: 0o600 });
    fs.renameSync(staging, file);
  };
  sessions.set(directory, { cleanup, active: () => player && alive(player.pid) });
  try { record(process.pid); } catch (error) { cleanup(); throw error; }
  function bind(child, ended = cleanup) {
    player = child;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      for (const event of ["exit", "close", "error"]) child.removeListener?.(event, event === "error" ? failed : finish);
      ended();
    };
    const failed = () => { if (!child.pid || child.exitCode != null || child.signalCode != null) finish(); };
    child.once?.("exit", finish);child.once?.("close", finish);child.on?.("error", failed);
    if (child.exitCode != null || child.signalCode != null || !child.pid) { finish();return false; }
    // If recording fails, the preparer marker and argument inventory still
    // protect the running player; do not delete files it may still read.
    try { record(child.pid); } catch {}
    return true;
  }
  return { directory, cleanup, bind };
}
process.once("exit", () => { for (const session of sessions.values()) if (!session.active()) session.cleanup(); });
module.exports = { create, reclaim, marker };
