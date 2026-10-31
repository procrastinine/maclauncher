// Check for Updates: finds a newer MacLauncher release on GitHub, downloads the
// app for this launcher's CPU into the update cache, verifies it, stages it
// beside the running app and, on Restart to Update, replaces the app through a
// detached helper. Electron (dialogs, Dock progress, quitting) is injected, so
// the module also runs in plain Node. Nothing here uses the network except
// check() and the download it offers; launch() checks only when the
// "Check for updates at launch" setting is on.
const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const SemanticVersion = require("../core/semantic-version");
const { readJsonObject, writeJsonAtomic } = require("../core/json-files");
const Upstream = require("../modules/shared/runtime/upstream");
const Architecture = require("../modules/shared/runtime/architecture");
const ReleaseFiles = require("../modules/shared/runtime/release-files");
const AppBundle = require("../modules/shared/runtime/app-bundle");
const { readMachOArchitectures } = require("../modules/shared/runtime/local-native");
const { normalizeArchitecture, versionAtLeast } = require("../modules/shared/runtime/feature-requirements");
const { createAbortError, isAbortError } = require("../modules/shared/runtime/download-utils");

// MacLauncher's own releases. A published release holds, for each Mac CPU, an
// app archive and a build manifest that names the archive, its CPU, version,
// minimum macOS and SHA-256 (written by scripts/ci-macos.cjs and published by
// scripts/release.cjs under the tag v<version>).
const REPOSITORY = "procrastinine/maclauncher";
const MANIFEST = /\.build-manifest\.json$/i, ARCHIVE = /\.app\.zip$/i, BUNDLE = /\.app$/i;
const STAGE_PREFIX = ".MacLauncher-update-";
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

// --- Releases ------------------------------------------------------------------

/** The version a release tag names (v0.5.1 → 0.5.1); null for a prerelease or another tag. */
function releaseVersion(tag) {
  const version = String(tag || "").trim().replace(/^v(?=\d)/i, "");
  const parsed = SemanticVersion.parse(version);
  return parsed && !parsed.pre.length ? version : null;
}
function isNewer(version, current) {
  return Boolean(SemanticVersion.parse(version) && SemanticVersion.parse(current)) && SemanticVersion.compare(version, current) > 0;
}
// Each stable release tagged v<version> with its app archives and build
// manifests. Drafts and prereleases are left out by the shared release listing.
function recognizeRelease(release) {
  const tag = String(release?.tag_name || "").trim();
  const version = /^v\d/.test(tag) ? releaseVersion(tag) : null;
  if (!version) return [];
  const assets = (release.assets || []).filter(asset => ARCHIVE.test(asset?.name || "") || MANIFEST.test(asset?.name || ""));
  return [{ version, assets }];
}
function newestRelease(rows) {
  return (rows || []).filter(row => !row?.prerelease && releaseVersion(row?.version))
    .reduce((best, row) => !best || SemanticVersion.compare(row.version, best.version) > 0 ? row : best, null);
}

/** The archive this launcher can run, from the release's build manifest for its
 * CPU; a release without one falls back to an archive whose name states the
 * CPU and whose SHA-256 GitHub lists. `readManifest(listed)` returns the parsed
 * manifest or null. Returns `{ download }` or `{ reason }`. */
async function chooseDownload(row, { arch, macOSVersion, readManifest }) {
  const label = Architecture.architectureLabel(arch);
  const files = row?.files || [];
  const archives = files.filter(file => ARCHIVE.test(file.name));
  const named = file => Architecture.assetArchitecture(file.name);
  const manifests = files.filter(file => MANIFEST.test(file.name) && [arch, "universal", null].includes(named(file)))
    .sort((a, b) => Number(!named(a)) - Number(!named(b))).slice(0, 4);
  for (const listed of manifests) {
    const manifest = await readManifest(listed);
    if (!manifest || ![arch, "universal"].includes(manifest.arch) || manifest.version !== row.version) continue;
    const archive = archives.find(file => file.name === manifest.appArchive);
    const sha256 = /^[a-f0-9]{64}$/.test(manifest.appArchiveSha256 || "") ? manifest.appArchiveSha256 : null;
    if (!archive || !sha256) continue;
    if (archive.digest?.algorithm === "sha256" && archive.digest.value !== sha256)
      return { reason: `The ${label} archive's SHA-256 on GitHub differs from the one in its build manifest.` };
    const minimumMacOS = typeof manifest.launcherMinimumMacOS === "string" ? manifest.launcherMinimumMacOS : null;
    if (minimumMacOS && macOSVersion && !versionAtLeast(macOSVersion, minimumMacOS))
      return { reason: `MacLauncher ${row.version} requires macOS ${minimumMacOS} or later.` };
    return { download: { name: archive.name, url: archive.url, ...(archive.bytes ? { bytes: archive.bytes } : {}),
      ...(archive.digest ? { digest: archive.digest } : {}), sha256, manifest: listed.name, ...(minimumMacOS ? { minimumMacOS } : {}) } };
  }
  const fallback = archives.find(file => [arch, "universal"].includes(named(file)) && file.digest?.algorithm === "sha256");
  if (fallback) return { download: { name: fallback.name, url: fallback.url, ...(fallback.bytes ? { bytes: fallback.bytes } : {}),
    digest: fallback.digest, sha256: fallback.digest.value } };
  return { reason: `This release has no ${label} app with a published SHA-256.` };
}

// --- Installation ----------------------------------------------------------------

/** Why this copy of MacLauncher cannot replace itself, or null. The update is
 * then offered through its release page. */
function installBlocker({ packaged, appPath, access = fs.accessSync }) {
  if (!packaged) return "MacLauncher is running from its source folder and does not replace itself.";
  if (!appPath) return "The MacLauncher app could not be located.";
  if (/\/AppTranslocation\//.test(appPath))
    return "macOS is running MacLauncher from a temporary read-only copy (App Translocation). Moving MacLauncher to the Applications folder and opening it from there allows updates in place.";
  try { access(path.dirname(appPath), fs.constants.W_OK); access(appPath, fs.constants.W_OK); }
  catch { return `MacLauncher cannot write to ${path.dirname(appPath)}.`; }
  return null;
}

function verifySignature(bundle, { signal, execute = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle],
      { timeout: 600000, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) }, (error, _stdout, stderr) => {
        if (!error) return resolve();
        if (signal?.aborted) return reject(createAbortError());
        const reason = String(stderr || error.message || "").trim().split("\n").filter(Boolean).pop() || "codesign rejected it";
        reject(new Error(`The downloaded app's code signature is not valid: ${reason}`));
      });
  });
}

/** The one app bundle extracted into `stage`, after checking its version,
 * bundle identifier, CPU and code signature. */
async function verifyStagedApp(stage, { version, arch, identifier, signal, execute }) {
  const bundles = fs.readdirSync(stage, { withFileTypes: true }).filter(entry => entry.isDirectory() && BUNDLE.test(entry.name));
  if (bundles.length !== 1) throw new Error("The downloaded archive does not contain exactly one app.");
  const bundle = path.join(stage, bundles[0].name);
  const inspected = AppBundle.inspectApplicationBundle(bundle);
  if (!inspected) throw new Error("The downloaded archive does not contain a valid Mac app.");
  const found = String(inspected.plist?.CFBundleShortVersionString || "").trim();
  if (found !== version) throw new Error(`The downloaded app reports version ${found || "(none)"} instead of ${version}.`);
  // Without the installed app's identifier there is nothing to compare, so the
  // update is refused rather than accepted unchecked.
  if (!identifier) throw new Error("The installed app's bundle identifier could not be read.");
  if (inspected.plist?.CFBundleIdentifier !== identifier)
    throw new Error(`The downloaded app's bundle identifier differs from ${identifier}.`);
  let cpus = [];
  try { cpus = readMachOArchitectures(inspected.executablePath).map(normalizeArchitecture); } catch {}
  if (!cpus.includes(arch)) throw new Error(`The downloaded app contains no ${Architecture.architectureLabel(arch)} code.`);
  await verifySignature(bundle, { signal, execute });
  return bundle;
}

// The helper runs after MacLauncher quits. Paths arrive as arguments, so the
// script text never contains them. It moves the installed app aside within
// its own folder, moves the new app into place (restoring the previous app if
// that fails), moves the previous app to the Trash and opens the app.
const HELPER_SCRIPT = `#!/bin/sh
# MacLauncher update helper. Arguments: the launcher's process ID, the
# installed app, the verified new app, the staging folder beside the installed
# app, the command that opens an app, and an optional command that moves a
# file to the Trash.
pid=$1 app=$2 new=$3 stage=$4 open=$5 trash=$6
note() { printf '%s %s\\n' "$(/bin/date '+%Y-%m-%d %H:%M:%S')" "$*"; }
waited=0
while kill -0 "$pid" 2>/dev/null; do
  if [ "$waited" -ge 3000 ]; then note "MacLauncher is still running; the update stays ready."; exit 1; fi
  /bin/sleep 0.1; waited=$((waited + 1))
done
if [ ! -d "$app" ] || [ ! -d "$new" ]; then
  note "The installed app or the new version is missing; nothing was changed."
  [ -d "$app" ] && "$open" "$app"
  exit 1
fi
name=\${app##*/}
previous=$(/usr/bin/mktemp -d "$stage/previous.XXXXXX") || { note "The staging folder is not writable; nothing was changed."; "$open" "$app"; exit 1; }
if ! /bin/mv "$app" "$previous/$name"; then
  note "The installed app could not be moved; nothing was changed."; "$open" "$app"; exit 1
fi
if ! /bin/mv "$new" "$app"; then
  if /bin/mv "$previous/$name" "$app"; then
    note "The new version could not be moved into place; the previous version was restored."
    "$open" "$app"
  else
    note "The new version could not be moved into place, and the previous version could not be moved back. It is at $previous/$name."
  fi
  exit 1
fi
note "Installed the new version at $app."
if [ -n "$trash" ] && "$trash" "$previous/$name" >/dev/null 2>&1 && [ ! -e "$previous/$name" ]; then
  note "Moved the previous version to the Trash."
elif /bin/mv "$previous/$name" "$HOME/.Trash/\${name%.app} $(/bin/date '+%Y-%m-%d %H.%M.%S').app" 2>/dev/null; then
  note "Moved the previous version to the Trash."
else
  note "The previous version is kept at $previous/$name."
fi
/bin/rmdir "$previous" "$stage" 2>/dev/null
"$open" "$app"
`;
function helperArguments({ pid, appPath, newApp, stage, open = "/usr/bin/open", trash }) {
  const command = trash === undefined ? (fs.existsSync("/usr/bin/trash") ? "/usr/bin/trash" : "") : trash;
  return [String(pid), appPath, newApp, stage, open, command];
}
/** Writes the helper into the update cache and starts it detached; its output
 * goes to install.log there. */
function startHelper({ cacheDir, args, spawnProcess = spawn }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const script = path.join(cacheDir, "install-update.sh");
  fs.writeFileSync(script, HELPER_SCRIPT, { mode: 0o644 });
  const log = fs.openSync(path.join(cacheDir, "install.log"), "a");
  try {
    const child = spawnProcess("/bin/sh", [script, ...args], { detached: true, stdio: ["ignore", log, log] });
    child.unref?.();
    return child;
  } finally { fs.closeSync(log); }
}

// --- Messages --------------------------------------------------------------------

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
function networkReason(error) {
  const code = error?.code || error?.cause?.code;
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT"].includes(code))
    return "GitHub could not be reached. Check the network connection and try again.";
  return String(error?.message || error || "The release list could not be read.");
}
// Native message boxes. `actions` maps each button to what it does.
const dialogs = {
  current: (current, latest) => ({ type: "info", message: "MacLauncher is up to date.",
    detail: latest === current ? `MacLauncher ${current} is the latest version.` : `No published release is newer than MacLauncher ${current}.`,
    buttons: ["OK"], actions: ["close"] }),
  failed: reason => ({ type: "warning", message: "MacLauncher could not check for updates.", detail: reason, buttons: ["OK"], actions: ["close"] }),
  available(result, arch) {
    const message = `MacLauncher ${result.version} is available (current ${result.currentVersion}).`;
    if (result.download && !result.reason) {
      const size = formatBytes(result.download.bytes);
      return { type: "info", message, detail: `The ${Architecture.architectureLabel(arch)} app${size ? ` (${size})` : ""} downloads from GitHub. It is checked against its published SHA-256 and its code signature, and replaces this copy when MacLauncher restarts.`,
        buttons: ["Download and Restart", "Release Notes", "Later"], actions: ["download", "notes", "later"] };
    }
    return { type: "info", message, detail: `${result.reason} The release page has the download.`,
      buttons: ["Open Release Page", "Later"], actions: ["notes", "later"] };
  },
  downloading: (version, progress) => ({ type: "info", message: `Downloading MacLauncher ${version}…`,
    detail: Number.isFinite(progress) ? `${Math.floor(progress * 100)}% downloaded.` : "Preparing the download.",
    buttons: ["Continue", "Cancel Download"], actions: ["later", "cancel"] }),
  ready: (version, appPath) => ({ type: "info", message: `MacLauncher ${version} is ready to install.`,
    detail: `MacLauncher quits, replaces ${appPath} with the new version and opens it. The current version moves to the Trash.`,
    buttons: ["Restart to Update", "Later"], actions: ["restart", "later"] }),
  installFailed: (version, reason) => ({ type: "warning", message: `MacLauncher ${version} could not be installed.`,
    detail: `${reason} The installed app was not changed.`, buttons: ["OK"], actions: ["close"] }),
  gamesRunning: (version, count) => ({ type: "warning", message: "Quit running games to finish the update.",
    detail: `MacLauncher ${version} is ready. Restarting replaces the app that ${count === 1 ? "the running game uses" : `${count} running games use`}, so Restart to Update is available after ${count === 1 ? "it closes" : "they close"}.`,
    buttons: ["OK"], actions: ["close"] })
};

// --- Updater ---------------------------------------------------------------------

function createAppUpdater({
  userDataDir, currentVersion, packaged, appPath, arch = Architecture.defaultArchitecture(),
  macOSVersion = () => require("../modules/shared/runtime/host-capabilities").getHostCapabilities().macOSVersion,
  downloads = null, logger = console, showMessage = async () => ({ response: 0 }), dialogOwner = () => undefined,
  openExternal = async () => {}, trashItem = async () => {}, setProgress = () => {}, runningGames = () => 0,
  quit = () => {}, onChange = () => {}, access = fs.accessSync, execute = execFile, spawnProcess = spawn,
  helper = {}, launchDelayMs = 3000, source = Upstream.github({ repository: REPOSITORY, recognize: recognizeRelease, allArchitectures: true })
}) {
  const cacheDir = path.join(userDataDir, "updates");
  const files = { lastCheck: path.join(cacheDir, "last-check.json"), staged: path.join(cacheDir, "staged.json") };
  let lastCheck, staged, loaded = false, phase = "idle", checking = null;
  let progress = null, target = null, task = null, failure = null, restarting = false, helperStarted = false;
  const changed = () => { try { onChange(); } catch {} };
  const warn = (...args) => { try { logger.warn?.("[update]", ...args); } catch {} };

  function load() {
    if (loaded) return;
    loaded = true;
    lastCheck = readJsonObject(files.lastCheck);
    // A result recorded by another version (before an update) no longer
    // describes the running app.
    if (lastCheck && lastCheck.currentVersion !== currentVersion) lastCheck = null;
    staged = readJsonObject(files.staged);
    if (staged && isNewer(staged.version, currentVersion) && stagedUsable(staged)) { phase = "ready"; target = staged.version; }
  }
  function stagedUsable(record) {
    try {
      return record.appPath === appPath && typeof record.stage === "string" && path.dirname(record.stage) === path.dirname(appPath) &&
        path.basename(record.stage).startsWith(STAGE_PREFIX) && path.dirname(record.app) === record.stage && fs.lstatSync(record.app).isDirectory();
    } catch { return false; }
  }
  // A staging folder belongs to the updater only when it carries its prefix
  // and sits beside the running app or the app the record was prepared for.
  async function discard(record) {
    try { fs.rmSync(files.staged, { force: true }); } catch {}
    if (staged === record) staged = null;
    const stage = record?.stage;
    const folders = [appPath, record?.appPath].filter(value => typeof value === "string" && path.isAbsolute(value)).map(value => path.dirname(value));
    if (typeof stage !== "string" || !path.isAbsolute(stage) || !path.basename(stage).startsWith(STAGE_PREFIX) ||
      !folders.includes(path.dirname(stage)) || !fs.existsSync(stage)) return;
    try { await trashItem(stage); }
    catch (error) { warn(`The update staging folder ${stage} could not be moved to the Trash: ${error?.message || error}`); }
  }
  function remember(result) {
    lastCheck = { checkedAt: Date.now(), currentVersion, outcome: result.outcome,
      ...(result.version ? { version: result.version } : {}), ...(result.releaseUrl ? { releaseUrl: result.releaseUrl } : {}),
      ...(result.message ? { message: result.message } : {}) };
    try { writeJsonAtomic(files.lastCheck, lastCheck); } catch (error) { warn(`The update check result could not be saved: ${error.message}`); }
  }
  async function readManifest(listed, signal) {
    const target = path.join(cacheDir, "manifests", `${process.pid}-${Date.now()}-${path.basename(listed.name)}`);
    try {
      await Upstream.download(listed, target, { signal });
      if (fs.statSync(target).size > MAX_MANIFEST_BYTES) return null;
      try { return JSON.parse(fs.readFileSync(target, "utf8")); } catch { return null; }
    } finally { fs.rmSync(target, { force: true }); }
  }
  async function query() {
    const rows = await source.discover({ arch, logger });
    const latest = newestRelease(rows);
    if (!latest || !isNewer(latest.version, currentVersion)) return { outcome: "current", currentVersion, version: latest?.version || null };
    const blocker = installBlocker({ packaged, appPath, access });
    const choice = blocker ? {} : await chooseDownload(latest, { arch, macOSVersion: (() => { try { return macOSVersion(); } catch { return null; } })(),
      readManifest: listed => readManifest(listed) });
    return { outcome: "available", currentVersion, version: latest.version, releaseUrl: latest.sourceUrl,
      download: choice.download || null, reason: blocker || choice.reason || null };
  }
  /** Contacts GitHub. Called only for an explicit action or the launch setting. */
  function check() {
    load();
    if (checking) return checking;
    if (phase !== "idle") return Promise.resolve({ outcome: phase, version: target });
    phase = "checking"; failure = null; changed();
    checking = query().catch(error => ({ outcome: "error", currentVersion, message: networkReason(error) })).then(result => {
      remember(result);
      return result;
    }).finally(() => { checking = null; if (phase === "checking") phase = "idle"; changed(); });
    return checking;
  }
  async function show(owner, box) {
    const { actions, ...options } = box;
    const value = { ...options, noLink: true, defaultId: 0, cancelId: actions.lastIndexOf("later") >= 0 ? actions.lastIndexOf("later") : 0 };
    try {
      const { response } = await showMessage(owner ?? dialogOwner(), value);
      return actions[response] || "close";
    } catch (error) { warn(`The update message could not be shown: ${error?.message || error}`); return "close"; }
  }
  async function offer(result, owner) {
    const action = await show(owner, dialogs.available(result, arch));
    if (action === "notes" && result.releaseUrl) await Promise.resolve(openExternal(result.releaseUrl)).catch(() => {});
    if (action === "download") await download(result, owner);
  }
  function runTask(meta, runner) {
    if (downloads?.runTask) return downloads.runTask(meta, runner);
    const controller = new AbortController();
    task = { cancel: () => controller.abort(createAbortError()) };
    return runner({ signal: controller.signal, onProgress: () => {}, taskId: null });
  }
  async function download(result, owner) {
    if (phase !== "idle" || !result?.download) return false;
    phase = "downloading"; target = result.version; progress = null; failure = null; changed();
    const archive = path.join(cacheDir, "downloads", `MacLauncher-${result.version}-${arch}.app.zip`);
    let stage = null, record = null, aborted = false;
    try {
      record = await runTask({ label: `MacLauncher ${result.version}`, detail: Architecture.architectureLabel(arch), kind: "app-update", dedupeKey: "app-update" },
        async ({ signal, onProgress, taskId }) => {
          if (taskId) task = { cancel: () => downloads.cancel(taskId) };
          // The Dock, the download menu and Settings follow whole percents.
          const report = value => {
            try { onProgress?.(value); } catch {}
            const total = Number(value?.total), done = Number(value?.downloaded);
            if (!(total > 0) || !Number.isFinite(done)) return;
            const next = Math.min(1, Math.floor(done / total * 100) / 100);
            if (next === progress) return;
            progress = next;
            try { setProgress(progress); } catch {}
            changed();
          };
          const downloaded = await Upstream.download(result.download, archive, { signal, onProgress: report });
          if (downloaded.sha256 !== result.download.sha256)
            throw new Error(`The download does not match the SHA-256 published for MacLauncher ${result.version} (${Architecture.architectureLabel(arch)}).`);
          report({ detail: "Verifying…" });
          try { setProgress(2); } catch {}
          const blocker = installBlocker({ packaged, appPath, access });
          if (blocker) throw new Error(blocker);
          stage = fs.mkdtempSync(path.join(path.dirname(appPath), STAGE_PREFIX));
          try { await ReleaseFiles.extractArchive(archive, stage, signal); }
          catch (error) { if (signal?.aborted) throw error; throw new Error(`The downloaded archive could not be extracted: ${error.message}`, { cause: error }); }
          const app = await verifyStagedApp(stage, { version: result.version, arch, identifier: installedIdentifier(), signal, execute });
          return { version: result.version, arch, appPath, stage, app, sha256: downloaded.sha256, preparedAt: Date.now() };
        });
      const previous = staged;
      writeJsonAtomic(files.staged, record);
      staged = record; phase = "ready";
      if (previous && previous.stage !== record.stage) await discard(previous);
    } catch (error) {
      aborted = isAbortError(error);
      if (stage) fs.rmSync(stage, { recursive: true, force: true });
      phase = "idle"; target = null;
      if (!aborted) { failure = String(error?.message || error); warn(`MacLauncher ${result.version} could not be prepared: ${failure}`); }
    } finally {
      fs.rmSync(archive, { force: true });
      task = null; progress = null;
      try { setProgress(-1); } catch {}
      changed();
    }
    if (phase === "ready") return ready(owner);
    if (!aborted) await show(owner, dialogs.installFailed(result.version, failure));
    return false;
  }
  async function ready(owner) {
    const action = await show(owner, dialogs.ready(staged.version, appPath));
    return action === "restart" ? restart(owner) : false;
  }
  function installedIdentifier() { return AppBundle.readInfoPlist(appPath)?.CFBundleIdentifier || null; }
  async function abandon(owner, reason) {
    const version = staged.version;
    await discard(staged); phase = "idle"; target = null; failure = reason; changed();
    await show(owner, dialogs.installFailed(version, `${reason} Check for Updates downloads it again.`));
    return false;
  }
  /** Starts the helper and quits; the helper finishes once this process exits.
   * One helper per process: a repeated request only repeats the quit. */
  async function restart(owner) {
    load();
    if (helperStarted) { quit(); return true; }
    if (restarting || phase !== "ready" || !staged) return false;
    restarting = true;
    try {
      if (!stagedUsable(staged)) return await abandon(owner, "The prepared update is no longer beside the installed app.");
      const running = Number(runningGames()) || 0;
      if (running > 0) { await show(owner, dialogs.gamesRunning(staged.version, running)); return false; }
      const blocker = installBlocker({ packaged, appPath, access });
      if (blocker) { await show(owner, dialogs.installFailed(staged.version, blocker)); return false; }
      // The prepared app can wait for days; it is checked again, as at download,
      // before the helper replaces the installed app with it.
      let verified = null, problem = null;
      try { setProgress(2); } catch {}
      try { verified = await verifyStagedApp(staged.stage, { version: staged.version, arch, identifier: installedIdentifier(), execute }); }
      catch (error) { problem = String(error?.message || error); }
      finally { try { setProgress(-1); } catch {} }
      if (problem || verified !== staged.app) return await abandon(owner, problem || "The prepared update folder holds a different app.");
      try {
        startHelper({ cacheDir, spawnProcess, args: helperArguments({ pid: process.pid, appPath, newApp: staged.app, stage: staged.stage, ...helper }) });
      } catch (error) {
        await show(owner, dialogs.installFailed(staged.version, `The update helper could not start: ${error.message}`));
        return false;
      }
      helperStarted = true;
      logger.info?.(`[update] restarting to install MacLauncher ${staged.version}`);
      quit();
      return true;
    } finally { restarting = false; }
  }
  /** The menu command and the Settings button. */
  async function choose(owner) {
    load();
    if (phase === "downloading") {
      if (await show(owner, dialogs.downloading(target, progress)) === "cancel") cancel();
      return;
    }
    if (phase === "ready") { await ready(owner); return; }
    const result = await check();
    if (result.outcome === "current") await show(owner, dialogs.current(currentVersion, result.version));
    else if (result.outcome === "error") await show(owner, dialogs.failed(result.message));
    else if (result.outcome === "available") await offer(result, owner);
  }
  function cancel() { if (phase !== "downloading" || !task) return false; task.cancel(); return true; }
  /** At launch: finishes an installed or abandoned update's cleanup, then checks
   * only when `launcherSettings.checkForUpdatesAtLaunch` is true. */
  async function launch(launcherSettings) {
    load();
    if (staged && phase !== "ready") await discard(staged);
    if (launcherSettings?.checkForUpdatesAtLaunch !== true) return null;
    if (launchDelayMs > 0) await new Promise(resolve => { const timer = setTimeout(resolve, launchDelayMs); timer.unref?.(); });
    if (phase !== "idle") return null;
    const result = await check();
    if (result.outcome === "available") await offer(result);
    return result;
  }
  function snapshot() {
    load();
    return { currentVersion, phase, version: target, progress, error: failure, lastCheck: lastCheck || null };
  }
  async function act(action, owner) {
    if (action === "check") return choose(owner);
    if (action === "cancel") return cancel();
    if (action === "restart") return phase === "ready" ? restart(owner) : choose(owner);
    throw new Error("Unknown update action.");
  }
  return { check, choose, cancel, restart, launch, snapshot, act, download };
}

module.exports = { createAppUpdater, releaseVersion, isNewer, recognizeRelease, newestRelease, chooseDownload, installBlocker,
  verifyStagedApp, verifySignature, helperArguments, startHelper, HELPER_SCRIPT, dialogs, REPOSITORY, STAGE_PREFIX };
