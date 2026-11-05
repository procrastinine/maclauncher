const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { promisify } = require("node:util");
const execute = promisify(require("node:child_process").execFile);
const { bindProcessStop } = require("../../../core/process-lifecycle");
const ProcessTree = require("../../../core/process-tree");

// External environments must never wait for or terminate the whole server on
// ordinary exit. The existing process-stop owner handles explicit Stop.
const EXTERNAL_SUPERVISOR = `count=$1
shift
while [ "$count" -gt 0 ]; do export "$1"; shift; count=$((count - 1)); done
wine=$1
shift
child=
stop_game() {
  trap '' TERM INT HUP
  if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; fi
  exit 143
}
trap stop_game TERM INT HUP
"$wine" "$@" &
child=$!
wait "$child"
status=$?
trap '' TERM INT HUP
exit "$status"
`;

function externalArguments(command, args, environment = {}) {
  const libraries = Object.entries(environment).filter(([key, value]) => /^DYLD_[A-Z0-9_]+$/.test(key) && typeof value === "string")
    .map(([key, value]) => `${key}=${value}`);
  return ["-c", EXTERNAL_SUPERVISOR, "maclauncher-wine", String(libraries.length), ...libraries, command, ...args];
}

async function runningState(prefixPath, { serverRoots, uid = process.getuid?.(), connect = net.createConnection, environment = process.env } = {}) {
  let stat; try { stat = fs.statSync(prefixPath, { bigint: true }); } catch { return { running: false }; }
  const name = `server-${stat.dev.toString(16)}-${stat.ino.toString(16)}`;
  const roots = serverRoots || [...new Set([environment.TMPDIR, "/tmp"].filter(Boolean))].map(root => path.join(root, `.wine-${uid}`));
  for (const root of roots) {
    const socketPath = path.join(root, name, "socket");
    const running = await new Promise(resolve => {
      let socket, timer, finished = false;
      const done = value => { if (finished) return; finished = true; clearTimeout(timer); socket?.destroy(); resolve(value); };
      try {
        if (!fs.statSync(socketPath).isSocket()) return done(false);
        socket = connect({ path: socketPath });
        socket.once("connect", () => done(true)); socket.once("error", () => done(false));
        timer = setTimeout(() => done(false), 250);
      } catch { done(false); }
    });
    if (running) return { running: true, socketPath, lockedSettings: ["MSync", "High Resolution"] };
  }
  return { running: false };
}

async function prepareEnvironment(record, context, options) {
  if (!record) return null;
  Object.assign(record, await runningState(record.prefixPath, options));
  if (record.running) context.logger?.warn?.("MSync and High Resolution cannot change until this Windows environment's wineserver stops.");
  return record;
}

// Reuse the launcher's incarnation-bound Stop callback and descendant lookup.
// No bottle-wide operation runs for an external reference without the dialog.
function bindStop(child, plan, context, { run = execute, list = ProcessTree.listCommands, kill = process.kill.bind(process),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), graceMs = 1500 } = {}) {
  return bindProcessStop(child, async ({ isCurrent }) => {
    let wholeEnvironment = !plan.existingEnvironment;
    if (!wholeEnvironment && typeof context.ui?.dialog?.showMessageBox === "function") {
      const result = await context.ui.dialog.showMessageBox({ type: "question", message: `Stop applications in ${plan.existingEnvironment.name}?`,
        detail: "Stop Game Only leaves other programs running. Close All asks all Windows programs to close, then forces any remaining programs to quit.",
        buttons: ["Stop Game Only", "Close All Applications"], defaultId: 0, cancelId: 0 });
      wholeEnvironment = result.response === 1;
    }
    if (!isCurrent()) return false;
    const env = { ...plan.environment, WINEPREFIX: plan.prefixPath || plan.bottlePath };
    delete env.DYLD_INSERT_LIBRARIES;
    if (wholeEnvironment) {
      const wine = plan.winePath || plan.install.executablePath;
      const args = plan.bottlePath ? ["--bottle", plan.bottlePath, "--no-update", "--", "wineboot.exe", "--end-session"] : ["wineboot.exe", "--end-session"];
      try { await run(wine, args, { env, timeout: graceMs, maxBuffer: 1024 * 1024 }); } catch {}
      await wait(graceMs);
      if (!isCurrent()) return false;
      try { await run(plan.serverPath || plan.install.serverPath, ["-k"], { env, timeout: 3000 }); } catch {}
    }
    const active = () => isCurrent() && child.exitCode == null && child.signalCode == null;
    if (!active()) return true;
    const owned = async () => {
      const rows = await list(), server = path.basename(plan.serverPath || plan.install?.serverPath || "wineserver");
      const servers = rows.filter(row => row[2] && path.basename(row[2]) === server).map(row => row[0]);
      const excluded = ProcessTree.descendants(servers, rows, Infinity);
      return ProcessTree.descendants(child.pid, rows.filter(row => !excluded.has(row[0])), Infinity);
    };
    const descendants = await owned();
    for (const pid of [...descendants].reverse()) if (active()) try { kill(pid, "SIGTERM"); } catch {}
    await wait(graceMs);
    if (!active()) return true;
    // Only currently owned descendants remain eligible for force termination;
    // never signal an unrelated process group or the external wineserver.
    const current = await owned();
    for (const pid of [...descendants].reverse()) if (current.has(pid)) try { kill(pid, "SIGKILL"); } catch {}
    return true;
  });
}

function installStopHandler(context, plan, dependencies) {
  const spawned = context.onProcessSpawn;
  context.onProcessSpawn = child => {
    if (Number.isSafeInteger(child.pid) && child.pid > 0) bindStop(child, plan, context, dependencies);
    return spawned?.(child);
  };
}

module.exports = { EXTERNAL_SUPERVISOR, externalArguments, runningState, prepareEnvironment, bindStop, installStopHandler, runTool: execute };
