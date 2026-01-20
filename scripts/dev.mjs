import net from "node:net";
import { spawn } from "node:child_process";

const args = new Set(process.argv.slice(2));
const debug = args.has("--debug") || process.env.MACLAUNCHER_DEBUG === "1";
const devtools = process.env.MACLAUNCHER_DEVTOOLS === "0" ? "0" : "1";
const devtoolsAuto = process.env.MACLAUNCHER_DEVTOOLS_AUTO === "1" ? "1" : "0";
const host = process.env.MACLAUNCHER_DEV_HOST || "127.0.0.1";
const port = Number(process.env.MACLAUNCHER_DEV_PORT || "5173");

function waitForPortOpen({ host, port, timeoutMs }) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host, port });
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

const vite = spawn("vite", ["--config", "vite.config.mjs"], {
  stdio: "inherit",
  env: { ...process.env, FORCE_COLOR: "1" }
});

try {
  await waitForPortOpen({ host, port, timeoutMs: 30_000 });
} catch (e) {
  vite.kill("SIGTERM");
  throw e;
}

const electronEnv = {
  ...process.env,
  ELECTRON_START_URL: `http://${host}:${port}`,
  MACLAUNCHER_DEBUG: debug ? "1" : process.env.MACLAUNCHER_DEBUG,
  MACLAUNCHER_DEVTOOLS: devtools,
  MACLAUNCHER_DEVTOOLS_AUTO: devtoolsAuto
};
delete electronEnv.ELECTRON_RUN_AS_NODE;

const electron = spawn("electron", ["."], {
  stdio: "inherit",
  env: electronEnv
});

const shutdown = () => {
  try {
    electron.kill("SIGTERM");
  } catch {}
  try {
    vite.kill("SIGTERM");
  } catch {}
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

electron.on("exit", code => {
  shutdown();
  process.exit(code ?? 0);
});
