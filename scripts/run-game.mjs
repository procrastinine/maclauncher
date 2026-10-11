import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { createLauncher } from "../src/core/launcher.js";
import GameStore from "../src/core/game-store.js";
import { resolveElectronBinary } from "../src/core/electron-binary.js";
import Modules from "../src/modules/registry.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELP = `Usage: pnpm launch --game <path> [--runtime <id>] [--user-data <path>] [--wait]
       pnpm launch --game <path> --inspect
       pnpm launch --game <path> --action <id> [--payload '<JSON>']

Native engines run directly through the shared backend. Electron web games open
only the standalone game host. Missing runtimes prompt before downloading.
--yes permits required downloads without a prompt; --offline uses installed runtimes.
--accept-runtime-licenses explicitly accepts required system-runtime licenses with --yes.
--inspect is read-only and prints detected metadata and resolved runtime.
It also includes the staged detection trace, candidates and version evidence.
--wait inherits native process output and returns its exit status.
--smoke preserves the existing Electron smoke harness; --debug enables logs.`;

function parseArgs(argv) {
  const out = {};
  const values = new Map([["--game", "game"], ["--runtime", "runtimeId"],
    ["--user-data", "userDataDir"], ["--action", "action"], ["--payload", "payload"]]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (values.has(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
      out[values.get(arg)] = value;
    } else if (["--inspect", "--wait", "--debug", "--smoke", "--yes", "--offline", "--accept-runtime-licenses"].includes(arg)) {
      out[arg.slice(2)] = true;
    } else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (out.payload && !out.action) throw new Error("--payload requires --action.");
  if (out.inspect && out.action) throw new Error("Choose --inspect or --action.");
  return out;
}

function waitForChild(child) {
  if (!child || typeof child.once !== "function") throw new Error("Runtime did not return a process to wait for.");
  child.ref?.();
  return new Promise((resolve, reject) => {
    const forward = signal => {
      try { process.kill(-child.pid, signal); }
      catch { try { child.kill(signal); } catch {} }
    };
    const onInterrupt = () => forward("SIGINT");
    const onTerminate = () => forward("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    const cleanup = () => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const onError = error => { cleanup(); reject(error); };
    const onClose = (code, signal) => {
      cleanup();
      if (signal) console.error(`Game exited with ${signal}.`);
      resolve(code ?? (signal ? 1 : 0));
    };
    child.once("error", onError);
    child.once("close", onClose);
    if (child.exitCode !== null && child.exitCode !== undefined) onClose(child.exitCode, child.signalCode);
  });
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) console.log(HELP);
  else if (options.smoke) {
    // The smoke harness checks Electron renderer lifecycle and keeps its own flags.
    await import("./run-electron-game.mjs");
  } else {
    if (!options.game) throw new Error(`Missing --game.\n${HELP}`);
    const payload = options.payload ? JSON.parse(options.payload) : {};
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Action payload must be a JSON object.");
    if (options.debug) process.env.MACLAUNCHER_DEBUG = "1";
    const logger = {
      debug: (...args) => { if (options.debug) console.error(...args); },
      info: (...args) => console.error(...args), warn: (...args) => console.error(...args),
      error: (...args) => console.error(...args)
    };
    let launcher;
    launcher = createLauncher({
      userDataDir: options.userDataDir, logger,
      confirmRuntimeInstall: async plan => {
        if (options.yes && (!plan.licenseRequired || options["accept-runtime-licenses"])) {
          return plan.licenseRequired ? { approved: true, licenseAccepted: true } : true;
        }
        const versionLabel = [plan.label, plan.versionLabel || plan.version].filter(Boolean).join(" ");
        if (!process.stdin.isTTY) throw new Error(`${versionLabel} is required. Run with --yes${plan.licenseRequired ? " --accept-runtime-licenses" : ""} to install it or install it in Runtimes.`);
        const input = createInterface({ input: process.stdin, output: process.stderr });
        try {
          const prompt = plan.licenseRequired ? `Agree to ${plan.licenseUrl} and install ${plan.label}? [y/N] ` : `Download ${versionLabel}? [y/N] `;
          const approved = /^y(?:es)?$/i.test((await input.question(prompt)).trim());
          return approved && plan.licenseRequired ? { approved: true, licenseAccepted: true } : approved;
        }
        finally { input.close(); }
      },
      processOptions: options.wait ? { detached: true, stdio: "inherit" } : {},
      launchHosted: async (entry, runtimeId, context) => {
        const binary = resolveElectronBinary();
        const launch = (await import("../src/core/electron-binary.js")).default.createElectronHostLaunch({
          executable: binary, appPath: path.join(repoRoot, "src/runtime/electron-game.js"),
          gamePath: entry.importPath || entry.gamePath, runtimeId, userDataDir: launcher.userDataDir
        });
        return (await import("../src/core/hosted-process.js")).default.launchHostedProcess({ ...launch,
          forwardOutput: options.wait === true,
        onDiagnostics: diagnostics => { if (options.debug && !options.wait && diagnostics.stderr) console.error(diagnostics.stderr); } });
      }
    });
    const settings = launcher.loadSettings();
    const detectionReport = options.inspect ? await Modules.explainDetectionAsync(options.game) : null;
    if (detectionReport?.error) throw new Error(detectionReport.error.message);
    const entry = await launcher.resolveEntry(options.game, {
      runtimeId: options.runtimeId, persist: !options.inspect, settings, detectionReport
    });
    if (options.inspect) {
      console.log(JSON.stringify({ entry, detection: detectionReport, runtimeSupport: launcher.resolveRuntimeSupportForEntry(
        Modules.getModule(entry.moduleId), Modules.getModuleInfo(entry.moduleId), entry,
        launcher.resolveModuleSettings(settings, entry.moduleId)
      ) }, null, 2));
    } else if (options.action) {
      const result = await launcher.runAction(entry, options.action, payload, { settings });
      console.log(JSON.stringify(result ?? true, null, 2));
    } else {
      const result = await launcher.launchEntry(entry, { runtimeId: options.runtimeId, strict: Boolean(options.runtimeId), settings,
        autoInstallRuntime: !options.offline });
      if (result.kind === "cancelled") console.error("Launch cancelled.");
      else {
        launcher.persistEntry({ ...(GameStore.readGameRecord(launcher.userDataDir, entry.gameId) || entry), lastPlayedAt: Date.now() });
        if (options.wait) process.exitCode = await waitForChild(result.child);
        else console.log(`Started ${entry.name || path.basename(entry.gamePath)} with ${result.runtimeId}${result.child?.pid ? ` (PID ${result.child.pid})` : ""}.`);
      }
    }
  }
} catch (error) {
  console.error(`MacLauncher: ${error.message || error}`);
  process.exitCode = 1;
}
