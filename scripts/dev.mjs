import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "../src/core/electron-binary.js";
import { startLauncherDevServer } from "./dev-server.mjs";
import { prepareDevelopmentApp } from "./dev-app.mjs";
import { developmentContentEnvironment } from "./dev-server.mjs";

export async function startDevelopment(electronArguments = ["."]) {
  const args = new Set(process.argv.slice(2));
  if ([...args].some(argument => argument !== "--debug" && argument !== "--")) {
    throw new Error("Usage: node scripts/dev.mjs [--debug]");
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
    ...developmentContentEnvironment(process.env, projectRoot),
    ELECTRON_START_URL: url,
    MACLAUNCHER_DEBUG: debug ? "1" : process.env.MACLAUNCHER_DEBUG,
    MACLAUNCHER_DEVTOOLS: devtools,
    MACLAUNCHER_DEVTOOLS_AUTO: devtoolsAuto
  };
  delete electronEnv.ELECTRON_RUN_AS_NODE;

  const electron = spawn(electronBinary, electronArguments, {
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

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

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
