import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// Vite's lockfile hash cannot notice a replaced dependency tree with the same
// lockfile. A cache for the actual installed layout also avoids stale React
// resolutions after moving a local node_modules link. No package is installed.
export function dependencyLayoutKey(root) {
  const require = createRequire(path.join(root, "package.json"));
  const records = ["react", "react-dom", "vite", "@vitejs/plugin-react"].map(name => {
    let directory = path.dirname(require.resolve(name));
    let file;
    while (true) {
      const candidate = path.join(directory, "package.json");
      if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate, "utf8")).name === name) {
        file = candidate;
        break;
      }
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`Cannot find the installed ${name} package metadata.`);
      directory = parent;
    }
    const stat = fs.statSync(file);
    const version = JSON.parse(fs.readFileSync(file, "utf8")).version;
    return [name, fs.realpathSync(file), version, stat.ino, stat.mtimeMs];
  });
  return createHash("sha256").update(JSON.stringify(records)).digest("hex").slice(0, 16);
}

export function devServerUrl(server, host) {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite did not open an HTTP port.");
  const connectHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return `http://${connectHost.includes(":") ? `[${connectHost}]` : connectHost}:${address.port}/`;
}

async function inBatches(values, callback) {
  for (let index = 0; index < values.length; index += 8) await Promise.all(values.slice(index, index + 8).map(callback));
}

export async function prepareRenderer(server, url, { fetchPage = fetch, signal } = {}) {
  const entry = "/src/main.tsx";
  // Explicit transforms surface nested import failures. waitForRequestsIdle
  // alone is insufficient because Vite's background warmup logs those errors.
  const graph = server.environments.client.moduleGraph;
  let pending = [entry];
  const visited = new Set();
  while (pending.length) {
    const batch = pending.filter(moduleUrl => !visited.has(moduleUrl));
    if (!batch.length) break;
    if (visited.size + batch.length > 1024) throw new Error("The renderer import graph exceeds the startup limit.");
    batch.forEach(moduleUrl => visited.add(moduleUrl));
    const next = [];
    await inBatches(batch, async moduleUrl => {
      signal?.throwIfAborted();
      const transformed = await server.transformRequest(moduleUrl);
      if (!transformed) throw new Error(`Vite could not prepare ${moduleUrl}.`);
      const node = await graph.getModuleByUrl(moduleUrl);
      for (const dependency of node?.importedModules || []) {
        if (dependency.type !== "asset" && dependency.url.startsWith("/")) next.push(dependency.url);
      }
    });
    pending = [...new Set(next)];
  }
  await server.waitForRequestsIdle();
  // Check the real HTTP pipeline, including the React optimized dependencies,
  // rather than assuming a listening socket can serve the renderer.
  await inBatches(["/", "/@vite/client", ...visited], async moduleUrl => {
    const response = await fetchPage(new URL(moduleUrl, url), { signal });
    if (!response.ok) throw new Error(`Vite startup failed: ${moduleUrl} returned HTTP ${response.status}.`);
    const body = await response.text();
    if (moduleUrl === "/" && (!body.includes('id="root"') || !body.includes(entry))) {
      throw new Error("The development server did not serve the MacLauncher page.");
    }
    if (moduleUrl !== "/" && /text\/html/i.test(response.headers.get("content-type") || "")) {
      throw new Error(`Vite served an HTML fallback for ${moduleUrl}. Check the installed dependencies.`);
    }
  });
  return { url, modules: visited.size };
}

export async function startLauncherDevServer({ root, host = "127.0.0.1", port = 5174,
  timeoutMs = 30_000, createViteServer, prepare = prepareRenderer } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("MACLAUNCHER_DEV_PORT must be a valid port number.");
  const createServer = createViteServer || (await import("vite")).createServer;
  const server = await createServer({
    configFile: path.join(root, "vite.config.mjs"),
    cacheDir: path.join(root, ".local", "cache", "vite", dependencyLayoutKey(root)),
    // Vite selects another port when occupied. The existing process stays alone,
    // and Electron always receives this owned server's actual bound port.
    server: { host, port, strictPort: false }
  });
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Vite did not prepare the renderer within ${timeoutMs / 1000} seconds.`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      await server.listen();
      const url = devServerUrl(server, host);
      const ready = await prepare(server, url, { signal: controller.signal });
      return { server, ...ready };
    })()]);
  } catch (error) {
    await server.close();
    throw error;
  } finally { clearTimeout(timer); }
}
