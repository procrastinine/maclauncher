import "./runtime-content-register.cjs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "../src/core/electron-binary.js";
import { startLauncherDevServer } from "./dev-server.mjs";
import { prepareDevelopmentApp } from "./dev-app.mjs";

export async function startDevelopment(electronArguments = ["."]) {
  const args = new Set(process.argv.slice(2));
  if ([...args].some(argument => !["--debug","--background","--"].includes(argument))) {
    throw new Error("Usage: node scripts/dev.mjs [--debug] [--background]");
  }
  if (args.has("--background") && !electronArguments.includes("--background")) electronArguments=[...electronArguments,"--background"];
  await createRequire(import.meta.url)("../src/modules/catsystem2/runtime/stage-cp932.cjs").prepare();
  if (process.platform === "darwin") {
    const require = createRequire(import.meta.url), repoRoot = path.resolve(import.meta.dirname, "..");
    // Python follows the development launcher process CPU, including an Intel process under Rosetta.
    await require("./ci-macos.cjs").preparePython({ repoRoot, arch: process.arch });
    await require("./published-inputs.cjs").prepareSevenZip({ repoRoot });
    await require("./published-inputs.cjs").prepareDeclaredPublishers({ repoRoot });
  }
  // A pull without an install can leave earlier included packages in place.
  // The offline manifest check only reports; startup continues either way.
  if (process.platform === "darwin") {
    try {
      const hint = createRequire(import.meta.url)("./runtime-packages.cjs").includedPackagesHint();
      if (hint) console.warn(hint);
    } catch {}
  }
  const electronBinary = await prepareDevelopmentApp({ electronBinary: resolveElectronBinary() });
  const debug = args.has("--debug") || process.env.MACLAUNCHER_DEBUG === "1";
  const devtools = process.env.MACLAUNCHER_DEVTOOLS === "0" ? "0" : "1";
  const devtoolsAuto = process.env.MACLAUNCHER_DEVTOOLS_AUTO === "1" ? "1" : "0";
  const host = process.env.MACLAUNCHER_DEV_HOST || "127.0.0.1";
  const port = Number(process.env.MACLAUNCHER_DEV_PORT || "5174");
  const projectRoot = path.resolve(import.meta.dirname, "..");

  const { server: vite, url } = await startLauncherDevServer({
    root: projectRoot, host, port
  });
  vite.printUrls();

  const electronEnv = {
    ...process.env,
    ELECTRON_START_URL: url,
    MACLAUNCHER_DEBUG: debug ? "1" : process.env.MACLAUNCHER_DEBUG,
    MACLAUNCHER_DEVTOOLS: devtools,
    MACLAUNCHER_DEVTOOLS_AUTO: devtoolsAuto
  };
  delete electronEnv.ELECTRON_RUN_AS_NODE;

  const electron = spawn(electronBinary, [path.join(projectRoot, "scripts/dev-bootstrap.cjs"), ...electronArguments], {
    stdio: "inherit",
    cwd: projectRoot,
    env: electronEnv
  });

  let closing;
  const shutdown = () => closing ||= (async () => {
    try {
      electron.kill("SIGTERM");
    } catch {}
    await vite.close();
  })();

  // A closed terminal sends SIGHUP; Electron must not outlive the server it loads from.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, shutdown);

  electron.on("error", error => {
    console.error(error.message);
    process.exitCode = 1;
    void shutdown();
  });

  electron.on("exit", async code => {
    await shutdown();
    process.exit(code ?? 0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startDevelopment();
}
