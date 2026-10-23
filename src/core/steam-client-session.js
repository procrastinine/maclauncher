const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { parseSteamVdf } = require("./steam-installed-games");
const { normalizeVersions, describeSteamSelection, localAccount } = require("./steam-downloads");
const { findClient, clientRoots } = require("../modules/shared/reshade/steam-client-models");
const { writeJsonAtomic } = require("./json-files");
const { reuseCompletedDownload } = require("./external-download-reuse");
const { ARCHITECTURES, matchesSteamArchitecture } = require("./steam-architectures");

const CANCELLATION_NOTICE = "Cancel stops copying and importing. Steam may continue downloading into its content folder.";
const clone = value => JSON.parse(JSON.stringify(value));
const publicError = message => Object.assign(new Error(message), { steamPublic: true });
const aborted = () => Object.assign(new Error("Steam action cancelled."), { name: "AbortError", code: "ABORT_ERR" });
const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
function id(value, label = "app") {
  const result = String(value ?? "");
  if (!/^[1-9]\d{0,9}$/.test(result) || Number(result) > 0xffffffff) throw publicError(`Invalid Steam ${label} ID.`);
  return result;
}
function manifest(value) {
  const result = String(value ?? "");
  if (!/^[1-9]\d{0,19}$/.test(result) || BigInt(result) > 0xffffffffffffffffn) throw publicError("Invalid Steam manifest ID.");
  return result;
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
function launchClient(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: "ignore" });
    child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
  });
}
function clientRunning() { return spawnSync("/usr/bin/pgrep", ["-x", "steam_osx"], { stdio: "ignore" }).status === 0; }
function stripTimestamps(text) { return text.replace(/^\[\d{4}-\d\d-\d\d [^\]]+\]\s?/gm, "").replace(/\r/g, ""); }
function readLog(file, cursor) {
  let handle;
  try {
    handle = fs.openSync(file, "r"); const stat = fs.fstatSync(handle);
    if (!stat.isFile()) return "";
    if (stat.ino !== cursor.inode || stat.size < cursor.offset) cursor.offset = 0;
    cursor.inode = stat.ino;
    const data = Buffer.alloc(Math.min(1024 * 1024, Math.max(0, stat.size - cursor.offset)));
    cursor.offset += fs.readSync(handle, data, 0, data.length, cursor.offset);
    return data.toString("utf8");
  } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  finally { if (handle !== undefined) fs.closeSync(handle); }
}

// Commands share a single console log. A unique invalid command is a read-only
// marker: Steam has no echo command, but logs unknown command names verbatim.
// A trailing marker only confirms dispatch; asynchronous replies can follow it.
function createSteamConsoleRelay({ executable, logPath, execute = launchClient, pollInterval = 200, quietMs = 500, now = Date.now } = {}) {
  let tail = Promise.resolve(), disposed = false;
  const lifetime = new AbortController();
  function queryConsole(command, args = [], options = {}) {
    if (!["licenses_print", "licenses_for_app", "app_info_print", "download_depot", "find"].includes(command) ||
      !Array.isArray(args) || args.some(arg => !/^[a-z0-9_.-]{1,100}$/i.test(String(arg)) || String(arg).startsWith("-"))) {
      return Promise.reject(publicError("The Steam console request is invalid."));
    }
    const run = tail.then(async () => {
      if (disposed || options.signal?.aborted) throw aborted();
      const token = crypto.randomUUID().replace(/-/g, ""), begin = `ML_BEGIN_${token}`, end = `ML_END_${token}`;
      const stat = fs.statSync(logPath, { throwIfNoEntry: false }), cursor = { offset: stat?.size || 0, inode: stat?.ino };
      // +commands are processed without opening the desktop console. -console
      // opens its UI even with -silent and can steal focus from this window.
      await execute(executable, ["-silent", `+${begin}`, `+${command}`, ...args.map(String), `+${end}`]);
      const deadline = now() + (options.timeoutMs || 20000);
      let raw = "", text = "", started = false, ended = false, lastOutput = now();
      while (now() < deadline) {
        if (disposed || lifetime.signal.aborted || options.signal?.aborted && !options.keepLeaseOnAbort) throw aborted();
        const chunk = readLog(logPath, cursor);
        if (chunk) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw publicError("Steam returned too much console output.");
          const clean = stripTimestamps(raw), lines = clean.split("\n");
          const start = lines.findIndex(line => line.trim() === `>>> command not found: ${begin}`);
          if (start >= 0) {
            started = true;
            text = lines.slice(start + 1).filter(line => {
              if (line.trim() === `>>> command not found: ${end}`) { ended = true; return false; }
              return !line.startsWith("ExecCommandLine:");
            }).join("\n");
          }
          lastOutput = now();
        }
        if (started && /not logged (?:on|in)|not connected to steam|no connection to steam/i.test(text)) throw publicError("Sign in to the Steam app before reusing its session.");
        if (started && (options.complete ? options.complete(text) : ended && now() - lastOutput >= quietMs)) return text;
        await delay(pollInterval, undefined, { signal: lifetime.signal });
      }
      throw publicError("Steam did not finish this request. Check that the Steam app is running and signed in, then try again.");
    });
    tail = run.catch(() => {});
    // Cancellation detaches MacLauncher promptly while the relay retains its
    // lease until Steam's depot reply arrives. A following download cannot
    // mistake a cancelled transfer's completion for its own.
    if (options.keepLeaseOnAbort && options.signal) {
      return new Promise((resolve, reject) => {
        const cancel = () => reject(aborted());
        if (options.signal.aborted) cancel(); else options.signal.addEventListener("abort", cancel, { once: true });
        run.then(resolve, reject).finally(() => options.signal.removeEventListener("abort", cancel)).catch(() => {});
      });
    }
    return run;
  }
  return { queryConsole, dispose: () => { disposed = true; lifetime.abort(); } };
}

function parseClientAppInfo(text, appId) {
  const clean = stripTimestamps(text), match = new RegExp(`(?:^|\\n)\\s*"${id(appId)}"\\s*\\n?\\s*\\{`).exec(clean);
  if (!match) return null;
  const start = clean.indexOf('"', match.index), source = clean.slice(start);
  let quoted = false, escaped = false, depth = 0, opened = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === "{") { opened = true; depth++; }
    else if (char === "}" && --depth === 0 && opened) {
      try { return parseSteamVdf(source.slice(0, index + 1))[String(appId)] || null; } catch { return null; }
    }
  }
  return null;
}

function waitForMetadata(promise, signal, timeoutMs) {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : aborted());
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); callback(value); };
    const cancel = () => finish(reject, signal.reason instanceof Error ? signal.reason : aborted());
    const timer = setTimeout(() => finish(reject, Object.assign(publicError("Steam metadata took too long to load. Try refreshing again."), { code: "STEAM_METADATA_TIMEOUT" })), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

// Public app metadata uses Steam's anonymous PICS service. No desktop command,
// account credentials or browser session is needed to load or refresh it.
function createSteamPublicAppInfoClient({ SteamUser, timeoutMs = 20000 } = {}) {
  let current, ready, lifetime, disposed = false;
  function connect() {
    if (disposed) throw aborted();
    if (ready) return { ready, lifetime };
    const Client = SteamUser || require("steam-user"), client = current = new Client({ dataDirectory: null, autoRelogin: false,
      // SteamUser's automatic PICS cache also enumerates anonymous server
      // licenses. Only fetch the app metadata explicitly requested here.
      enablePicsCache: false, picsCacheAll: false, changelistUpdateInterval: 0, promptSteamGuardCode: false });
    const controller = lifetime = new AbortController();
    let failed;
    const connection = ready = new Promise((resolve, reject) => {
      failed = () => {
        if (current !== client) return;
        const error = publicError("Steam public metadata could not be loaded. Try refreshing again.");
        current = ready = null; controller.abort(error); reject(error);
        client.removeAllListeners(); client.on("error", () => {}); client.logOff();
      };
      client.on("error", failed); client.on("disconnected", failed); client.once("loggedOn", () => resolve(client));
    });
    connection.catch(() => {});
    try { client.logOn({ anonymous: true }); } catch { failed(); }
    return { ready: connection, lifetime: controller };
  }
  async function getAppInfo(appId, { signal } = {}) {
    const applicationId = Number(id(appId));
    signal?.throwIfAborted();
    const operation = connect(), combined = signal ? AbortSignal.any([signal, operation.lifetime.signal]) : operation.lifetime.signal;
    try {
      const client = await waitForMetadata(operation.ready, combined, timeoutMs);
      const result = await waitForMetadata(client.getProductInfo([applicationId], [], true), combined, timeoutMs);
      const info = result.apps?.[applicationId]?.appinfo;
      if (!info) throw publicError("Steam did not return public versions for this game. Use cached versions or manual Steam sign-in for restricted metadata.");
      return info;
    } catch (error) {
      if (error.code === "STEAM_METADATA_TIMEOUT" && lifetime === operation.lifetime) {
        const client = current; current = ready = null; operation.lifetime.abort(error);
        if (client) { client.removeAllListeners(); client.on("error", () => {}); client.logOff(); }
      }
      throw error;
    }
  }
  function dispose() {
    disposed = true; lifetime?.abort(aborted());
    const client = current; current = ready = null;
    if (client) { client.removeAllListeners(); client.on("error", () => {}); client.logOff(); }
  }
  return { getAppInfo, dispose };
}

async function copyDepot(source, destination, signal) {
  if (!fs.lstatSync(source).isDirectory()) throw publicError("Steam did not create the selected depot folder.");
  const root = fs.realpathSync(source);
  if (!fs.lstatSync(root).isDirectory()) throw publicError("Steam did not create the selected depot folder.");
  await fs.promises.cp(root, destination, { recursive: true, force: true, dereference: false, verbatimSymlinks: true,
    filter: async file => {
      signal.throwIfAborted();
      const stat = await fs.promises.lstat(file);
      if (stat.isSymbolicLink()) {
        const target = await fs.promises.readlink(file);
        if (path.isAbsolute(target) || /^[a-z]:/i.test(target) || !inside(root, path.resolve(path.dirname(file), target))) throw publicError("Steam supplied an unsafe symbolic link.");
      } else if (!stat.isFile() && !stat.isDirectory()) throw publicError("Steam supplied an unsupported file type.");
      return true;
    } });
}

function createSteamClientSession(options = {}) {
  if (!path.isAbsolute(options.userDataDir || "")) throw publicError("A MacLauncher profile directory is required.");
  const homeDir = options.homeDir || os.homedir(), steamRoot = path.join(homeDir, "Library/Application Support/Steam");
  const root = path.join(options.userDataDir, "steam"), defaultDirectory = path.join(options.userDataDir, "external", "downloads", "steam");
  let relay, libraryHelper, publicMetadata, licensesForLibrary, disposed = false, generation = 0, libraryLoading, downloadTail = Promise.resolve();
  const jobs = new Map(), cache = new Map();
  const accountHint = () => (options.localAccount || localAccount)(homeDir) || {};
  const identity = () => { const hint = accountHint(); return { accountName: hint.accountName || "", displayName: hint.displayName || "" }; };
  const state = { connection: { status: "disconnected", mode: "client", ...identity() }, library: [], libraryLoading: false, libraryFetchedAt: null,
    libraryError: null, downloads: [], defaultDirectory, cancellationNotice: CANCELLATION_NOTICE };
  const snapshot = () => clone(state), emit = () => { if (!disposed) options.onChange?.(snapshot()); };
  const connected = () => { if (disposed || state.connection.status !== "connected") throw publicError("Connect the running Steam app to continue."); };
  function assertGeneration(expected) {
    const current = identity();
    if (current.accountName && state.connection.accountName && current.accountName !== state.connection.accountName) {
      generation++; state.connection = { status: "disconnected", mode: "client", ...current }; state.library = []; state.libraryFetchedAt = null; emit();
    }
    if (disposed || expected !== generation) throw publicError("The Steam account changed. Connect the running Steam app again.");
  }
  const localLibrary = () => libraryHelper ||= require("./steam-client-library").createSteamClientLibrary({ homeDir, userDataDir: options.userDataDir,
    queryConsole: (command, args, queryOptions) => {
      if (command === "licenses_print" && licensesForLibrary !== undefined) {
        const licenses = licensesForLibrary; licensesForLibrary = undefined; return Promise.resolve(licenses);
      }
      return queryConsole(command, args, queryOptions);
    } });
  function queryConsole(command, args, queryOptions) {
    if (!relay) {
      const executable = options.executable || findClient({ home: homeDir });
      if (!executable) throw publicError("Install and open Steam for Mac before reusing its session.");
      relay = createSteamConsoleRelay({ executable, logPath: path.join(steamRoot, "logs/console_log.txt"),
        execute: options.execute, pollInterval: options.pollInterval, quietMs: options.quietMs });
    }
    return relay.queryConsole(command, args, queryOptions);
  }
  async function connect() {
    if (disposed) throw publicError("The Steam window has closed.");
    if (jobs.size) throw publicError("Finish or cancel active downloads before reconnecting Steam.");
    if (!(options.isRunning || clientRunning)()) throw publicError("Open Steam and sign in before reusing its session.");
    const currentGeneration = ++generation;
    publicMetadata?.dispose(); publicMetadata = null;
    libraryHelper = null; state.libraryFetchedAt = null;
    state.connection = { status: "connecting", mode: "client", ...identity() }; emit();
    try {
      const licenses = await queryConsole("licenses_print");
      if (disposed || generation !== currentGeneration) return snapshot();
      if (!/License packageID\s+\d+/i.test(licenses)) throw publicError("Sign in to the Steam app before reusing its session.");
      licensesForLibrary = licenses;
      assertGeneration(currentGeneration);
      state.connection = { ...state.connection, status: "connected", mode: "client" }; emit();
      await loadLibrary({ licenses });
    } catch (error) {
      if (generation === currentGeneration && !disposed) { state.connection = { ...state.connection, status: "error", mode: "client", error: error.steamPublic ? error.message : "The running Steam session could not be connected." }; emit(); }
    }
    return snapshot();
  }
  async function loadLibrary({ refresh = false, licenses } = {}) {
    connected();
    if (libraryLoading) return libraryLoading;
    if (!refresh && state.libraryFetchedAt) return clone(state.library);
    state.libraryLoading = true; state.libraryError = null; emit();
    const currentGeneration = generation;
    libraryLoading = (async () => {
      try {
        const result = options.loadLibrary ? await options.loadLibrary({ homeDir, userDataDir: options.userDataDir, queryConsole, refresh, licenses }) :
          await localLibrary().loadLibrary({ refresh });
        assertGeneration(currentGeneration);
        state.library = Array.isArray(result) ? result : result.library;
        state.libraryFetchedAt = new Date().toISOString();
        if (result.accountName) state.connection.accountName = result.accountName;
        if (result.displayName) state.connection.displayName = result.displayName;
        state.libraryError = result.libraryError || null; return clone(state.library);
      } catch (error) { if (generation === currentGeneration) state.libraryError = error.steamPublic ? error.message : "The Steam library could not be read. Refresh to try again."; throw publicError(state.libraryError || "The Steam session changed."); }
      finally { if (generation === currentGeneration) { state.libraryLoading = false; libraryLoading = null; emit(); } }
    })();
    return libraryLoading;
  }
  async function appInfo(appId, { refresh = false, signal } = {}) {
    signal?.throwIfAborted();
    const local = !refresh && await (options.getCachedAppInfo ? options.getCachedAppInfo(appId) : localLibrary().getAppInfo(appId));
    signal?.throwIfAborted();
    if (local) return clone(local);
    publicMetadata ||= createSteamPublicAppInfoClient({ SteamUser: options.SteamUser, timeoutMs: options.metadataTimeoutMs });
    return publicMetadata.getAppInfo(appId, { signal });
  }
  async function getVersions(value, { refresh = false, signal } = {}) {
    connected(); const currentGeneration = generation; assertGeneration(currentGeneration);
    const appId = Number(id(value)), file = path.join(root, "catalog", `${appId}.json`);
    const previous = cache.get(appId) || readJson(file);
    if (!refresh && previous?.architectureSchema === 1) return clone(previous);
    const info = await appInfo(appId, { refresh, signal });
    assertGeneration(currentGeneration);
    const references = [...new Set(Object.values(info.depots || {}).map(depot => Number(depot?.depotfromapp)).filter(value => value > 0 && value !== appId))];
    for (const reference of references) {
      const source = await appInfo(reference, { refresh, signal });
      assertGeneration(currentGeneration);
      for (const [depotId, depot] of Object.entries(info.depots || {})) if (Number(depot?.depotfromapp) === reference && source.depots?.[depotId]) info.depots[depotId] = { ...source.depots[depotId], ...depot };
    }
    assertGeneration(currentGeneration);
    const versions = normalizeVersions(appId, info, previous?.history || []); cache.set(appId, versions); writeJsonAtomic(file, versions); return clone(versions);
  }
  function download(selection = {}) {
    connected(); const currentGeneration = generation; assertGeneration(currentGeneration);
    const appId = Number(id(selection.appId)), platform = selection.platform || "windows";
    if (!["macos", "windows", "linux"].includes(platform)) throw publicError("Choose Mac, Windows or Linux.");
    const branch = String(selection.branch || "public"), language = String(selection.language || "english"), architecture = String(selection.architecture || "all");
    if (!/^[a-z0-9_. -]{1,100}$/i.test(branch) || !/^[a-z_ -]{1,60}$/i.test(language) || !["all", ...ARCHITECTURES].includes(architecture)) throw publicError("The Steam version selection is invalid.");
    if (selection.destination && (!path.isAbsolute(selection.destination) || /[\x00-\x1f]/.test(selection.destination))) throw publicError("Choose an absolute download folder.");
    const record = { id: crypto.randomUUID(), appId, name: selection.name || state.library.find(row => Number(row.appId) === appId)?.name || `App ${appId}`,
      platform, branch, language, architecture, autoImport: selection.autoImport !== false, imported: false, status: "queued", downloaded: 0, total: null,
      detail: "Waiting for Steam", path: null, createdAt: new Date().toISOString() };
    const controller = new AbortController(), signal = controller.signal, job = { controller, record, promise: null };
    jobs.set(record.id, job); state.downloads.unshift(record); emit();
    const task = downloadTail.then(async () => {
      let stage, terminalStatus;
      try {
        signal.throwIfAborted(); record.status = "preparing"; emit();
        const versions = await getVersions(appId, { signal }), branchInfo = versions.branches.find(item => item.id === branch);
        if (!branchInfo) throw publicError("The selected Steam branch is unavailable. Refresh versions and choose again.");
        const explicit = Array.isArray(selection.depots) && selection.depots.length ? selection.depots : null;
        if (!explicit && architecture !== "all" && !versions.architectures?.[platform]?.includes(architecture)) throw publicError("Steam does not advertise this architecture for the selected platform. Choose a listed architecture or select depots explicitly.");
        const choices = explicit ? explicit.map(item => {
          const depot = versions.depots.find(row => String(row.id) === id(item.depotId, "depot"));
          if (!depot) throw publicError("The selected Steam depot does not belong to this game.");
          return { depot, manifestId: item.manifestId ? manifest(item.manifestId) : depot.manifests[branch]?.id, currentManifest: !item.manifestId };
        }) : versions.depots.filter(depot => (!depot.platforms.length || depot.platforms.includes(platform)) &&
          matchesSteamArchitecture(depot, architecture) &&
          (!depot.languages.length || depot.languages.includes(language)) && !depot.requiresAppId && (depot.manifests[branch] || depot.encryptedBranches.includes(branch)))
          .map(depot => ({ depot, manifestId: depot.manifests[branch]?.id, currentManifest: true }));
        if (!choices.length) throw publicError("Steam has no matching depots for this selection. Choose another version or select depots explicitly.");
        if (choices.some(item => !item.manifestId)) throw publicError("This branch is password protected. Unlock it in Steam or use manual sign-in to download it.");
        const selectedDepots = choices.map(item => ({ depotId: item.depot.id, manifestId: item.manifestId }));
        const duplicateRequest = { userDataDir: options.userDataDir, store: "steam", appId, platform, depots: selectedDepots, destination: selection.destination, confirmDuplicate: options.confirmDuplicate, signal };
        const { checkExistingDownload, createDownloadIdentity } = require("./external-download-duplicates");
        record.downloadIdentity = createDownloadIdentity(duplicateRequest);
        const existing = await checkExistingDownload(duplicateRequest);
        if (existing) return await reuseCompletedDownload(record, existing, { signal, onChange: emit, onDownloaded: options.onDownloaded });
        const identity = describeSteamSelection(branch, branchInfo, choices), suffix = identity.manifestSetId;
        record.buildId = identity.buildId; record.versionName = identity.versionName; record.version = identity.versionName;
        const parent = selection.destination || path.join(defaultDirectory, String(appId), platform);
        fs.mkdirSync(parent, { recursive: true }); const realParent = fs.realpathSync(parent);
        stage = fs.mkdtempSync(path.join(realParent, ".steam-download-"));
        const label = `${branch.replace(/[^a-z0-9_.-]+/gi, "-")}-${identity.buildId || "manifest"}-${suffix}-${record.id}`;
        const finalPath = path.join(realParent, selection.destination ? `${record.name.replace(/[^a-z0-9_. -]+/gi, "").slice(0, 70) || appId}-${platform}-${label}` : label);
        record.path = finalPath; record.status = "downloading"; record.total = choices.reduce((sum, item) => sum + (item.depot.manifests[branch]?.size || 0), 0) || null; emit();
        for (const choice of choices) {
          signal.throwIfAborted(); assertGeneration(currentGeneration); record.detail = `Steam is downloading ${choice.depot.name}`; emit();
          const contentAppId = choice.depot.depotFromAppId || appId;
          const allowed = [steamRoot, ...clientRoots(homeDir), path.dirname(options.executable || findClient({ home: homeDir }) || steamRoot)]
            .map(root => path.normalize(path.join(root, `steamapps/content/app_${contentAppId}/depot_${choice.depot.id}`)));
          let source;
          const complete = text => {
            if (/Depot download failed|Failed to download|Access denied|Manifest not available/i.test(text)) return true;
            for (const match of text.matchAll(/Depot download complete\s*:\s*"([^"]+)"/gi)) {
              const candidate = path.normalize(match[1].replace(/\\/g, "/"));
              if (allowed.includes(candidate)) { source = candidate; return true; }
            }
            return false;
          };
          await queryConsole("download_depot", [String(contentAppId), String(choice.depot.id), manifest(choice.manifestId)],
            { signal, complete, timeoutMs: options.downloadTimeoutMs || 2 * 60 * 60 * 1000, keepLeaseOnAbort: true });
          signal.throwIfAborted(); assertGeneration(currentGeneration);
          if (!source) throw publicError("Steam could not download the selected depot or manifest. Check ownership and access in Steam.");
          record.detail = `Copying ${choice.depot.name}`; emit();
          await (options.copyDepot || copyDepot)(source, stage, signal);
        }
        signal.throwIfAborted(); assertGeneration(currentGeneration);
        const metadata = { schema: 1, appId, name: record.name, platform, branch, buildId: identity.buildId, versionName: identity.versionName, version: identity.versionName, importPath: finalPath, path: finalPath, createdAt: record.createdAt, complete: true,
          depots: selectedDepots, architecture, downloadIdentity: record.downloadIdentity };
        writeJsonAtomic(path.join(stage, ".maclauncher-steam.json"), metadata); fs.renameSync(stage, finalPath); stage = null;
        const installations = readJson(path.join(root, "installations.json"), []);
        writeJsonAtomic(path.join(root, "installations.json"), [...(Array.isArray(installations) ? installations : []).filter(item => (typeof item === "string" ? item : item.path) !== finalPath), metadata]);
        record.status = "completed"; record.downloaded = record.total; record.detail = "Download complete"; record.completedAt = new Date().toISOString(); emit();
        if (record.autoImport && options.onDownloaded) {
          try { await options.onDownloaded(clone(record)); record.imported = true; }
          catch { record.importError = "The download is complete, but no supported game was imported. Import the folder manually to choose files."; }
        }
      } catch (error) {
        if (signal.aborted || error?.code === "ABORT_ERR" || error?.name === "AbortError") { terminalStatus = "cancelled"; record.detail = CANCELLATION_NOTICE; }
        else { terminalStatus = "error"; record.error = error.steamPublic ? error.message : error.code === "ENOSPC" ? "There is not enough space for this download." : "Steam could not download this version. Check the Steam console and try again."; record.detail = record.error; }
      } finally { if (stage) await fs.promises.rm(stage, { recursive: true, force: true }); if (terminalStatus) record.status = terminalStatus; jobs.delete(record.id); emit(); }
      return clone(record);
    });
    job.promise = task; downloadTail = task.catch(() => {}); return clone(record);
  }
  function cancel(value) { jobs.get(value)?.controller.abort(); return snapshot(); }
  function markImported(value) { const record = state.downloads.find(job => job.id === value); if (record) { record.imported = true; record.importError = null; emit(); } return snapshot(); }
  function disconnect() { generation++; libraryLoading = null; publicMetadata?.dispose(); publicMetadata = null; state.libraryLoading = false; for (const job of jobs.values()) job.controller.abort(); state.connection = { ...state.connection, status: "disconnected", mode: "client" }; emit(); return snapshot(); }
  async function dispose() { disposed = true; generation++; publicMetadata?.dispose(); for (const job of jobs.values()) job.controller.abort(); relay?.dispose(); await Promise.allSettled([...jobs.values()].map(job => job.promise)); }
  return { snapshot, connect, loadLibrary, getVersions, download, cancel, markImported, disconnect, dispose, queryConsole,
    submitAuth: () => { throw publicError("Complete Steam sign-in in the Steam app."); } };
}

module.exports = { createSteamClientSession, createSteamConsoleRelay, createSteamPublicAppInfoClient, parseClientAppInfo, CANCELLATION_NOTICE };
