const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const Upstream = require("../modules/shared/runtime/upstream");
const Python = require("../modules/shared/runtime/python");
const { reuseCompletedDownload } = require("./external-download-reuse");
const { readJsonDocument } = require("./json-files");
// Runs Legendary with a check of the manifest it selects. The check wraps
// Legendary's manifest lookups when the release has them; a release without
// them still runs, and a request for an exact build then ends with code 87.
const LEGENDARY_HOOKS = "('get_cdn_manifest','get_uri_manifest','load_manifest')";
const LEGENDARY_ENTRY = `import json,runpy,sys
request=json.load(sys.stdin)
exact=request.get('expectedVersion') or request.get('expectedManifestBuildId')
if exact or request.get('recordPath'):
    from legendary.core import LegendaryCore
    if all(callable(getattr(LegendaryCore,name,None)) for name in ${LEGENDARY_HOOKS}):
        original=LegendaryCore.get_cdn_manifest
        original_uri=LegendaryCore.get_uri_manifest
        def inspect(self,result):
            try:
                meta=self.load_manifest(result[0]).meta
                version,build=meta.build_version,meta.build_id
            except Exception:
                if exact: raise SystemExit(87)
                return result
            if request.get('expectedVersion') and version != request['expectedVersion']:
                raise SystemExit(86)
            if request.get('expectedManifestBuildId') and build != request['expectedManifestBuildId']:
                raise SystemExit(86)
            if request.get('recordPath'):
                with open(request['recordPath'],'w') as output:
                    json.dump({'version':version,'buildId':build},output)
            return result
        def selected_manifest(self,*args,**kwargs):
            return inspect(self,original(self,*args,**kwargs))
        def selected_uri(self,*args,**kwargs):
            return inspect(self,original_uri(self,*args,**kwargs))
        LegendaryCore.get_cdn_manifest=selected_manifest
        LegendaryCore.get_uri_manifest=selected_uri
    elif exact:
        raise SystemExit(87)
sys.argv=['legendary']+request['args']
runpy.run_module('legendary.cli',run_name='__main__')`;
// Wheel handling with the included Python's packaging library: choosing the
// newest release that satisfies a requirement and has a wheel this Python
// accepts, reading a wheel's own requirements, and extracting it safely.
const WHEELS = `import email.parser,json,pathlib,sys,zipfile
from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet
from packaging.tags import sys_tags
from packaging.utils import canonicalize_name,parse_wheel_filename
from packaging.version import Version
request=json.load(sys.stdin)
if request['mode']=='select':
    tags={str(tag):rank for rank,tag in enumerate(sys_tags())}
    wanted=SpecifierSet(request.get('specifier') or '')
    python=Version('.'.join(map(str,sys.version_info[:3])))
    best=None
    for release in request['releases']:
        try: version=Version(release['version'])
        except Exception: continue
        if version.is_prerelease or version not in wanted: continue
        for item in release['files']:
            try:
                ranks=[tags[str(tag)] for tag in parse_wheel_filename(item['name'])[3] if str(tag) in tags]
                if not ranks or item.get('requiresPython') and python not in SpecifierSet(item['requiresPython']): continue
            except Exception: continue
            key=(version,-min(ranks))
            if best is None or key>best[0]: best=(key,{'version':release['version'],'name':item['name']})
    print(json.dumps(best and best[1]))
elif request['mode']=='requires':
    archive=zipfile.ZipFile(request['wheel'])
    name=next(item for item in archive.namelist() if item.count('/')==1 and item.endswith('.dist-info/METADATA'))
    metadata=email.parser.Parser().parsestr(archive.read(name).decode('utf-8'))
    found=[]
    for line in metadata.get_all('Requires-Dist') or []:
        requirement=Requirement(line)
        if requirement.marker is None or requirement.marker.evaluate({'extra':''}):
            found.append({'name':canonicalize_name(requirement.name),'specifier':str(requirement.specifier)})
    print(json.dumps(found))
else:
    root=pathlib.Path(request['root']).resolve()
    archive=zipfile.ZipFile(request['wheel'])
    assert all(not pathlib.PurePosixPath(item.filename).is_absolute() and '..' not in pathlib.PurePosixPath(item.filename).parts and (item.external_attr >> 16) & 0o170000 != 0o120000 for item in archive.infolist())
    archive.extractall(root)
    print('null')`;
// Checks an installed Legendary: it imports with its dependencies, reports its
// version, and has the manifest lookups the entry above checks.
const LEGENDARY_CHECK = `import json,runpy,sys
from legendary.core import LegendaryCore
print(json.dumps(all(callable(getattr(LegendaryCore,name,None)) for name in ${LEGENDARY_HOOKS})))
sys.stdout.flush()
sys.argv=['legendary','--version']
runpy.run_module('legendary.cli',run_name='__main__')`;
const clone = value => JSON.parse(JSON.stringify(value));
const publicError = message => Object.assign(new Error(message), { externalPublic: true });
const label = store => store === "epic" ? "Epic Games" : "GOG";
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
function message(error, store) {
  if (error?.externalPublic) return error.message;
  if (error?.code === "ENOSPC") return "There is not enough space for this download.";
  if (["EACCES", "EPERM"].includes(error?.code)) return "The selected download folder cannot be written.";
  return `${label(store)} could not complete this action. Check the connection and account access, then try again.`;
}
function safeId(value) {
  const text = String(value || "");
  if (!/^[a-z0-9_.-]{1,160}$/i.test(text)) throw publicError("The selected game ID is invalid.");
  return text;
}
function platform(value) { const text = String(value || "").toLowerCase(); return ["mac", "osx", "osx64"].includes(text) ? "macos" : ["win", "win32", "win64"].includes(text) ? "windows" : text; }
function platforms(value) {
  const values = Array.isArray(value) ? value : value && typeof value === "object" ? Object.keys(value).filter(key => value[key]) : String(value || "").split(/[,;\s]+/);
  return [...new Set(values.map(platform).filter(item => ["windows", "macos", "linux"].includes(item)))];
}
function codeFromInput(input) {
  const value = String(input || "").trim();
  if (!value || value.length > 16384 || /[\x00-\x1f]/.test(value)) throw publicError("Paste the authorization code or the browser redirect URL.");
  if (value.startsWith("{")) { try { return safeCode(JSON.parse(value).authorizationCode); } catch { throw publicError("The authorization response is invalid."); } }
  if (/^https?:\/\//i.test(value)) { const url = new URL(value); return safeCode(url.searchParams.get("code") || url.searchParams.get("authorizationCode")); }
  return safeCode(value.replace(/^"|"$/g, ""));
}
function safeCode(value) { if (!/^[a-z0-9_.-]{4,2048}$/i.test(String(value || ""))) throw publicError("The authorization code is invalid."); return String(value); }
function launch(command, args, { input, env, cwd, signal, onLine, captureOutput = true, maxOutput = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, args, { cwd, env: env || process.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", outputBytes = 0, pending = "", cancelled = false, killTimer, failure;
    const stop = () => {
      cancelled = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      killTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 2000); killTimer.unref?.();
    };
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", bytes => { if (!captureOutput) { for (const line of bytes.toString("utf8").split(/[\r\n]/)) if (line) onLine?.(line); return; } outputBytes += bytes.length; if (outputBytes > maxOutput) { failure = publicError("The store response was too large."); stop(); return; } output += bytes.toString("utf8"); });
    child.stderr.on("data", bytes => { pending += bytes.toString("utf8"); const lines = pending.split(/[\r\n]/); pending = lines.pop().slice(-8192); for (const line of lines) onLine?.(line); });
    child.on("error", error => { failure = error; });
    child.on("close", code => {
      clearTimeout(killTimer); signal?.removeEventListener("abort", stop);
      if (failure) reject(failure);
      else if (cancelled) reject(signal?.reason || new Error("Cancelled"));
      else if (code === 86) reject(publicError("The selected Epic build is no longer current. Refresh versions or supply its earlier manifest URL."));
      else if (code === 87) reject(publicError("This Legendary release cannot confirm the selected Epic build. Choose the current build to download it."));
      else if (code !== 0) reject(publicError("The store download helper could not complete this action. Check account access and the selected game version."));
      else resolve({ stdout: output });
    });
    child.stdin.on("error", () => {}); child.stdin.end(input || "");
  });
}
// Legendary and its dependencies come from PyPI: Legendary's newest release,
// then for each requirement its wheel names, the newest release that
// satisfies it with a wheel the included Python accepts. PyPI's SHA-256
// verifies each wheel, and the installation records every package. Installed
// copies keep working offline. A newest release that cannot confirm exact
// Epic builds yields to the newest installed Legendary that can.
const LEGENDARY = Upstream.pypi({ project: "legendary-gl", recognize: pypiWheels });
function pypiWheels({ version, files }) {
  const wheels = files.filter(item => /\.whl$/i.test(item.name || ""));
  return wheels.length ? { version, files: wheels, details: { requiresPython: Object.fromEntries(wheels.map(item => [item.name, item.details?.requires_python || ""])) } } : [];
}
const RECEIPT = ".maclauncher-tools.json";
const legendaryVersion = receipt => receipt?.legendaryVersion || receipt?.packages?.find(item => item?.name === "legendary-gl")?.version || null;
const newerVersion = (a, b) => String(b).localeCompare(String(a), undefined, { numeric: true });
// Installed Legendary copies, newest first. A receipt without `confirmsBuilds`
// belongs to a release that has the manifest lookups.
function installedLegendary(parent) {
  let names = [];
  try { names = fs.readdirSync(parent).filter(name => name.startsWith("legendary-")); } catch {}
  return names.map(name => {
    const packagesPath = path.join(parent, name), receipt = readJson(path.join(packagesPath, RECEIPT));
    return { packagesPath, version: legendaryVersion(receipt), confirmsBuilds: receipt?.confirmsBuilds !== false };
  }).filter(item => item.version && fs.existsSync(path.join(item.packagesPath, "legendary", "cli.py"))).sort((a, b) => newerVersion(a.version, b.version));
}
const prepared = new Map(), provisionTasks = new Map();
async function ensureLegendary({ userDataDir, signal, onProgress, execute = launch, pythonPath, logger } = {}) {
  const embedded = pythonPath || Python.resolveEmbeddedPythonBinary(Python.resolveEmbeddedPythonRoot());
  if (!embedded || !path.isAbsolute(embedded)) throw publicError("The included game download helper is unavailable. Reinstall MacLauncher.");
  const parent = path.join(userDataDir, "external", "tools");
  // PyPI is asked once per session; later store actions reuse the answer.
  if (prepared.has(parent)) return { pythonPath: embedded, packagesPath: prepared.get(parent) };
  if (provisionTasks.has(parent)) return provisionTasks.get(parent);
  const task = (async () => {
    const installed = installedLegendary(parent), usable = installed.find(item => item.confirmsBuilds) || installed[0];
    const settle = packagesPath => { prepared.set(parent, packagesPath); return { pythonPath: embedded, packagesPath }; };
    let row;
    try {
      onProgress?.("Checking Epic download support");
      row = await newestRelease(LEGENDARY, "", { signal, python: wheelTool(embedded, execute, signal) });
    } catch (error) {
      signal?.throwIfAborted();
      if (usable) return settle(usable.packagesPath);
      throw publicError(`The Epic download helper is unavailable: ${error.externalPublic ? error.message : "PyPI could not be reached."}`);
    }
    if (!row) {
      if (usable) return settle(usable.packagesPath);
      throw publicError("PyPI lists no Legendary release for the included Python.");
    }
    const current = installed.find(item => item.version === row.version);
    if (current && (current.confirmsBuilds || !usable?.confirmsBuilds)) return settle(current.packagesPath);
    if (current) return settle(usable.packagesPath);
    let added;
    try { added = await installLegendary({ parent, embedded, execute, signal, onProgress, first: row }); }
    catch (error) {
      signal?.throwIfAborted();
      if (!usable) throw error;
      logger?.warn?.(`[external] Legendary ${row.version} could not be installed: ${error.message || error}`);
      onProgress?.(`Using Legendary ${usable.version}; Legendary ${row.version} could not be installed`);
      return settle(usable.packagesPath);
    }
    if (!added.confirmsBuilds && usable?.confirmsBuilds) {
      logger?.warn?.(`[external] Legendary ${row.version} has no manifest lookups to confirm Epic builds; using Legendary ${usable.version}.`);
      onProgress?.(`Using Legendary ${usable.version}; Legendary ${row.version} cannot confirm Epic builds`);
      return settle(usable.packagesPath);
    }
    return settle(added.packagesPath);
  })();
  provisionTasks.set(parent, task); try { return await task; } finally { provisionTasks.delete(parent); }
}
function wheelTool(embedded, execute, signal) {
  return async request => JSON.parse((await execute(embedded, ["-I", "-c", WHEELS], { input: JSON.stringify(request), signal,
    env: { ...process.env, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" } })).stdout || "null");
}
// The newest release of a PyPI source that satisfies `specifier` and has a
// wheel the included Python accepts, as that row with its chosen file.
async function newestRelease(source, specifier, { signal, python }) {
  const rows = await source.discover({ signal });
  const choice = await python({ mode: "select", specifier, releases: rows.map(row => ({ version: row.version,
    files: row.files.map(item => ({ name: item.name, requiresPython: row.details?.requiresPython?.[item.name] || "" })) })) });
  const row = choice && rows.find(item => item.version === choice.version);
  const listed = row?.files.find(item => item.name === choice.name);
  return listed ? { version: row.version, file: listed, source } : null;
}
async function installLegendary({ parent, embedded, execute, signal, onProgress, first }) {
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); const stage = fs.mkdtempSync(path.join(parent, ".legendary-setup-"));
  const python = wheelTool(embedded, execute, signal);
  try {
    const packageRoot = path.join(stage, "packages"); fs.mkdirSync(packageRoot);
    const wanted = new Map([["legendary-gl", []]]), resolved = new Map(), packages = [];
    for (const [name, specifiers] of wanted) {
      if (resolved.has(name)) continue;
      if (wanted.size > 64) throw publicError("Legendary names more dependencies than MacLauncher installs.");
      signal?.throwIfAborted(); onProgress?.(`Preparing Epic download support (${name})`);
      const release = name === "legendary-gl" ? first : await newestRelease(Upstream.pypi({ project: name, recognize: pypiWheels }), specifiers.join(","), { signal, python });
      if (!release) throw publicError(`PyPI lists no ${name} release that Legendary can use with the included Python.`);
      resolved.set(name, release.version);
      const archive = path.join(stage, release.file.name), downloaded = await release.source.download(release.file, archive, { signal });
      for (const requirement of await python({ mode: "requires", wheel: archive })) {
        if (!wanted.has(requirement.name)) wanted.set(requirement.name, []);
        if (requirement.specifier) wanted.get(requirement.name).push(requirement.specifier);
      }
      await python({ mode: "extract", wheel: archive, root: packageRoot });
      fs.rmSync(archive);
      packages.push({ name, version: release.version, filename: release.file.name, url: release.file.url, sha256: downloaded.sha256, integrity: downloaded.integrity });
    }
    const lines = [];
    const result = await execute(embedded, ["-c", LEGENDARY_CHECK], { signal, onLine: line => lines.push(line),
      env: { ...process.env, PYTHONPATH: packageRoot, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" } })
      .catch(() => { signal?.throwIfAborted(); throw publicError(`Legendary ${first.version} does not run with the included Python${lines.length ? `: ${lines.at(-1)}` : "."}`); });
    const confirmsBuilds = /^true\b/.test(String(result.stdout || "").trim());
    const identity = crypto.createHash("sha256").update(JSON.stringify(packages.map(({ name, version, sha256 }) => [name, version, sha256]))).digest("hex");
    writeJson(path.join(packageRoot, RECEIPT), { identity, legendaryVersion: first.version, confirmsBuilds, source: "https://pypi.org/project/legendary-gl/", packages });
    const target = path.join(parent, `legendary-${first.version}-${identity.slice(0, 12)}`);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true }); fs.renameSync(packageRoot, target);
    return { packagesPath: target, version: first.version, confirmsBuilds };
  } finally { await fs.promises.rm(stage, { recursive: true, force: true }); }
}
const GOG_CLIENT_ID = "46899977096215655";
// Public Galaxy OAuth application credential, shared by the GOG desktop client
// and documented by gog-cli. Account secrets are never constants or logs.
const GOG_CLIENT_SECRET = "9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9";
const GOG_REDIRECT = "https://embed.gog.com/on_login_success?origin=client";
const AUTH_URLS = { epic: "https://legendary.gl/epiclogin", gog: `https://auth.gog.com/auth?${new URLSearchParams({ client_id: GOG_CLIENT_ID, redirect_uri: GOG_REDIRECT, response_type: "code", layout: "client2" })}` };
function findSession(store, homeDir) {
  const files = store === "epic" ? [".config/legendary/user.json", "Library/Application Support/heroic/legendaryConfig/legendary/user.json", "Library/Application Support/heroic/legendaryConfig/user.json", ".config/heroic/legendaryConfig/legendary/user.json"] :
    [".local/share/gog-cli/session.json", "Library/Application Support/gog-cli/session.json", "Library/Application Support/heroic/gog_store/auth.json", ".config/heroic/gog_store/auth.json"];
  const locate = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 3) return null;
    if (typeof value.refresh_token === "string" && typeof value.access_token === "string") return value;
    for (const nested of Object.values(value)) { const result = locate(nested, depth + 1); if (result) return result; }
    return null;
  };
  for (const relative of files) { const result = locate(readJson(path.join(homeDir, relative))); if (result) return clone(result); }
  return null;
}
function normalizeEpicLibrary(games, previous = []) {
  const rows = new Map(previous.map(row => [row.appId, row]));
  for (const game of games || []) {
    const appId = safeId(game.app_name || game.appId), assets = game.asset_infos || {}, supported = platforms(Object.keys(assets));
    const existing = rows.get(appId), icons = game.metadata?.keyImages || [];
    rows.set(appId, { appId, name: game.app_title || game.title || appId, platforms: [...new Set([...(existing?.platforms || []), ...supported])], shared: false,
      iconUrl: icons.find(item => ["DieselGameBoxTall", "Thumbnail", "DieselGameBox"].includes(item.type))?.url || null,
      versions: Object.fromEntries(Object.entries(assets).map(([key, value]) => [platform(key), value.build_version || value.buildVersion || ""])) });
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function normalizeGogVersions(appId, product) {
  const installers = (product.downloads?.installers || []).filter(item => item.files?.length), groups = new Map();
  for (const item of installers) {
    const version = String(item.version || "Current"), id = crypto.createHash("sha256").update(version).digest("hex").slice(0, 16);
    if (!groups.has(id)) groups.set(id, { id, name: version, description: "Offline installers", buildId: version, version, passwordRequired: false, platforms: [], languages: [] });
    const group = groups.get(id); group.platforms = [...new Set([...group.platforms, platform(item.os)])]; group.languages = [...new Set([...group.languages, item.language || "en"])];
  }
  return { appId: String(appId), name: product.title || String(appId), platforms: [...new Set(installers.map(item => platform(item.os)))], branches: [...groups.values()], depots: [], history: [],
    languages: [...new Set(installers.map(item => item.language || "en"))], supportsManifestOverride: false,
    historyNote: "Available GOG offline installer versions, platforms and languages. Earlier builds are available when supplied by GOG." };
}
// GOG's account, catalog and content services. Installer files come from the
// CDN host each download link names.
const GOG = Upstream.service({ hosts: ["gog.com"] });
async function requestJson(url, { headers, signal } = {}) {
  try {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
    const { body, status = 200 } = await GOG.request(url, { headers, signal: requestSignal, maxRedirects: headers?.Authorization ? 0 : 5, maxBytes: 32 * 1024 * 1024 });
    if ([401, 403].includes(status)) throw Object.assign(publicError("Sign in again to access this store library."), { authExpired: true });
    if (status < 200 || status >= 300) throw Object.assign(publicError(`The store request failed (HTTP ${status}). Refresh and try again.`), { httpStatus: status });
    return JSON.parse(body.toString("utf8"));
  }
  catch (error) { if (/HTTP (?:401|403)/.test(error?.message || "")) throw Object.assign(publicError("Sign in again to access this store library."), { authExpired: true }); throw error; }
}
function createExternalStoreDownloads(options = {}) {
  const store = options.store;
  if (!["epic", "gog"].includes(store) || !path.isAbsolute(options.userDataDir || "")) throw new Error("A store and MacLauncher profile are required.");
  const homeDir = options.homeDir || os.homedir(), root = path.join(options.userDataDir, "external"), storeRoot = path.join(root, store), defaultDirectory = path.join(root, "downloads", store);
  const cache = readJson(path.join(storeRoot, "library.json"), {});
  const state = { connection: { status: "disconnected", accountName: cache.accountName || "" }, library: cache.library || [], libraryLoading: false,
    libraryFetchedAt: cache.fetchedAt || null, libraryError: null, downloads: [], defaultDirectory };
  const jobs = new Map(), versions = new Map(), products = new Map(), manifestMetadata = new Map(); let session, runtimeDir, authLeases = 0, disposed = false, generation = 0, activeLibrary, loadedAccount = cache.accountName, sessionController = new AbortController();
  const snapshot = () => clone(state), emit = () => { if (!disposed) options.onChange?.(snapshot()); };
  const active = () => { if (!session || state.connection.status !== "connected") throw publicError(`Connect a ${label(store)} account to continue.`); };
  const persist = async () => { if (session) await options.saveSession?.(clone(session)); };
  async function gogToken(params, expectedGeneration = generation, signal = sessionController.signal) {
    const data = await requestJson(`https://auth.gog.com/token?${new URLSearchParams({ client_id: GOG_CLIENT_ID, client_secret: GOG_CLIENT_SECRET, ...params })}`, { signal });
    if (!data.access_token || !data.refresh_token) throw publicError("GOG sign-in was not accepted. Obtain a new authorization code.");
    if (disposed || generation !== expectedGeneration) throw publicError("The store account changed.");
    session = { ...session, ...data, expires_at: new Date(Date.now() + Number(data.expires_in || 3600) * 1000).toISOString() }; await persist(); return session;
  }
  async function gogGet(url, signal, retry = true) {
    signal ||= sessionController.signal;
    const expectedGeneration = generation;
    if (!session?.access_token) throw publicError("Connect a GOG account to continue.");
    const endpoint = new URL(url);
    if (endpoint.protocol !== "https:" || !(endpoint.hostname === "gog.com" || endpoint.hostname.endsWith(".gog.com"))) throw publicError("GOG returned an unsupported account service URL.");
    if (retry && Date.parse(session.expires_at || "") < Date.now() + 30000) await gogToken({ grant_type: "refresh_token", refresh_token: session.refresh_token }, expectedGeneration, signal);
    if (disposed || generation !== expectedGeneration) throw publicError("The store account changed.");
    try { return await requestJson(url, { headers: { Authorization: `Bearer ${session.access_token}` }, signal }); }
    catch (error) { if (retry && error.authExpired) { await gogToken({ grant_type: "refresh_token", refresh_token: session.refresh_token }, expectedGeneration, signal); return gogGet(url, signal, false); } throw error; }
  }
  async function legendary(args, { signal, code, onLine, expectedVersion, expectedManifestBuildId } = {}) {
    signal ||= sessionController.signal;
    const expectedGeneration = generation;
    const support = await (options.ensureLegendary || ensureLegendary)({ userDataDir: options.userDataDir, signal, logger: options.logger,
      onProgress: detail => { state.connection.detail = detail; emit(); }, execute: options.execute, pythonPath: options.pythonPath });
    if (disposed || generation !== expectedGeneration) throw publicError("The store account changed.");
    runtimeDir ||= fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-epic-session-")); fs.chmodSync(runtimeDir, 0o700);
    if (!fs.existsSync(path.join(runtimeDir, "config.ini"))) fs.writeFileSync(path.join(runtimeDir, "config.ini"), "[Legendary]\ndisable_update_check = true\ndisable_update_notice = true\n", { mode: 0o600 });
    const userFile = path.join(runtimeDir, "user.json"), recordPath = args[0] === "install" ? path.join(runtimeDir, `manifest-${crypto.randomUUID()}.json`) : null;
    authLeases++; if (session && !fs.existsSync(userFile)) writeJson(userFile, session);
    try {
      const actual = code ? ["-y", "auth", "--code", code, "--disable-webview"] : ["-y", ...args];
      const result = await (options.execute || launch)(support.pythonPath, ["-c", LEGENDARY_ENTRY], {
        input: JSON.stringify({ args: actual, expectedVersion, expectedManifestBuildId, recordPath }), signal, onLine, cwd: runtimeDir,
        env: { ...process.env, LEGENDARY_CONFIG_PATH: runtimeDir, PYTHONPATH: support.packagesPath, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1" } });
      if (disposed || generation !== expectedGeneration) throw publicError("The store account changed.");
      const updated = readJson(userFile); if (updated?.refresh_token) { session = updated; await persist(); }
      return ["list", "info", "status"].includes(args[0]) && result.stdout.trim() ? JSON.parse(result.stdout) : recordPath ? readJson(recordPath) : null;
    } finally { if (recordPath) fs.rmSync(recordPath, { force: true }); authLeases--; if (!authLeases) fs.rmSync(userFile, { force: true }); }
  }
  async function connect(credentials = {}) {
    if (disposed) throw publicError("The External window has closed.");
    if (jobs.size) throw publicError("Finish or cancel active downloads before changing this store account.");
    if (authLeases) throw publicError("Wait for the current store account action to finish.");
    sessionController.abort(); sessionController = new AbortController();
    const current = ++generation; state.connection = { status: "connecting" }; state.libraryError = null; emit();
    activeLibrary = null; versions.clear(); products.clear(); manifestMetadata.clear();
    try {
      if (credentials.code) return await submitAuth({ code: credentials.code });
      session = credentials.mode === "manual" ? null : await options.loadSession?.();
      if (credentials.mode === "reuse") session ||= (options.findSession || findSession)(store, homeDir);
      if (current !== generation || disposed) return snapshot();
      if (!session) {
        if (credentials.mode === "reuse") throw publicError(`No reusable ${label(store)} sign-in was found. Use browser sign-in.`);
        state.connection = { status: "guard", authUrl: AUTH_URLS[store], guard: { kind: "authorization", url: AUTH_URLS[store], message: "Open sign-in in the browser, then paste the authorization code or redirect URL." } }; emit(); return snapshot();
      }
      await finishConnect(current); return snapshot();
    } catch (error) { if (current === generation) { state.connection = { status: "error", error: message(error, store) }; emit(); } throw publicError(message(error, store)); }
  }
  async function finishConnect(current) {
    let accountName;
    if (store === "gog") { const data = await gogGet("https://embed.gog.com/userData.json"); accountName = data.username || session.user_id || "GOG"; }
    else { await legendary(["status", "--offline", "--json"]); accountName = session?.displayName || session?.account_id || "Epic Games"; }
    if (current !== generation || disposed) return;
    if (loadedAccount && loadedAccount !== accountName) { state.library = []; state.libraryFetchedAt = null; }
    state.connection = { status: "connected", accountName }; await persist(); emit(); loadLibrary({ refresh: false }).catch(() => {});
  }
  async function submitAuth({ code } = {}) {
    const current = ++generation, authorization = codeFromInput(code); state.connection = { status: "connecting" }; emit();
    try {
      if (store === "gog") await gogToken({ grant_type: "authorization_code", code: authorization, redirect_uri: GOG_REDIRECT });
      else { session = null; await legendary([], { code: authorization }); if (!session) throw publicError("Epic Games sign-in was not accepted. Obtain a new authorization code."); }
      await finishConnect(current); return snapshot();
    } catch (error) { if (current === generation) { state.connection = { status: "error", error: message(error, store) }; emit(); } throw publicError(message(error, store)); }
  }
  async function loadLibrary({ refresh = false } = {}) {
    active(); if (activeLibrary) return activeLibrary;
    if (!refresh && state.libraryFetchedAt && state.connection.accountName === loadedAccount) return clone(state.library);
    const current = generation; state.libraryLoading = true; state.libraryError = null; emit();
    activeLibrary = (async () => {
      try {
        let rows = [];
        if (store === "epic") {
          for (const osName of ["Windows", "Mac"]) {
            const args = ["list", "--json", "--platform", osName]; if (refresh) args.push("--force-refresh");
            rows = normalizeEpicLibrary(await legendary(args), rows);
          }
        } else {
          let page = 1, pages = 1;
          do {
            const data = await gogGet(`https://embed.gog.com/account/getFilteredProducts?mediaType=1&page=${page}`);
            pages = Math.min(1000, Number(data.totalPages || 1));
            for (const product of data.products || []) rows.push({ appId: String(product.id), name: product.title || String(product.id), platforms: platforms(product.worksOn || product.supportedOperatingSystems),
              shared: false, iconUrl: product.image ? String(product.image).replace(/^\/\//, "https://") : null });
            page++;
          } while (page <= pages);
          rows.sort((a, b) => a.name.localeCompare(b.name));
        }
        if (current !== generation || disposed) return [];
        state.library = rows; state.libraryFetchedAt = new Date().toISOString(); loadedAccount = state.connection.accountName; writeJson(path.join(storeRoot, "library.json"), { accountName: state.connection.accountName, fetchedAt: state.libraryFetchedAt, library: rows });
        return clone(rows);
      } catch (error) { if (current === generation) { state.libraryError = message(error, store); emit(); } throw publicError(message(error, store)); }
      finally { if (current === generation) { activeLibrary = null; state.libraryLoading = false; emit(); } }
    })(); return activeLibrary;
  }
  async function getVersions(value, { refresh = false, signal } = {}) {
    active(); const appId = safeId(value), current = generation;
    signal?.throwIfAborted();
    if (!refresh && versions.has(appId)) return clone(versions.get(appId));
    const row = state.library.find(item => item.appId === appId); let result;
    if (store === "gog") {
      const product = await gogGet(`https://api.gog.com/products/${encodeURIComponent(appId)}?expand=downloads`, signal); products.set(appId, product); result = normalizeGogVersions(appId, product);
      const builds = [];
      for (const osName of result.platforms.filter(item => item !== "linux")) {
        let data;
        try { data = await gogGet(`https://content-system.gog.com/products/${encodeURIComponent(appId)}/os/${osName === "macos" ? "osx" : osName}/builds?generation=2`, signal); }
        catch (error) { if ([400, 404].includes(error.httpStatus)) continue; throw error; }
        for (const build of data.items || []) if (build.build_id && build.public !== false) builds.push({
          id: `galaxy:${osName}:${build.build_id}`, name: build.version_name || `Build ${build.build_id}`, buildId: String(build.build_id), description: build.branch || "Galaxy build",
          updatedAt: build.date_published || null, platforms: [osName], passwordRequired: false, delivery: "galaxy", generation: Number(build.generation) || 2
        });
      }
      result.branches = [...builds, ...result.branches.map(branch => ({ ...branch, description: "Offline installers", delivery: "offline" }))];
      result.historyNote = "Galaxy builds can be selected by exact build ID. Offline installers are listed separately by their supplied version, platform and language. Availability follows GOG account and server access.";
    } else {
      if (!row) throw publicError("Refresh the Epic library and choose a game.");
      const branches = [];
      for (const osName of row.platforms.length ? row.platforms : ["windows"]) {
        const data = await legendary(["info", appId, "--json", "--platform", osName === "macos" ? "Mac" : osName === "linux" ? "Linux" : "Windows"], { signal });
        const version = data?.manifest?.build_version || data?.game?.version || row.versions?.[osName] || "Current";
        branches.push({ id: osName, name: String(version), buildId: String(version), manifestBuildId: data?.manifest?.build_id || null, platforms: [osName], description: `${osName === "macos" ? "Mac" : osName === "windows" ? "Windows" : "Linux"} build`, passwordRequired: false,
          downloadSize: Number(data?.manifest?.download_size) || null, installSize: Number(data?.manifest?.disk_size) || null });
      }
      result = { appId, name: row.name, platforms: row.platforms, branches, depots: [], history: [], languages: [], supportsManifestOverride: true,
        historyNote: "Epic lists the currently published builds. A known earlier manifest URL can be supplied when the account and game servers allow access." };
    }
    if (current !== generation || disposed) throw publicError("The store account changed.");
    versions.set(appId, result); return clone(result);
  }
  function download(selection = {}) {
    active(); const appId = safeId(selection.appId), osName = platform(selection.platform || "windows");
    if (!["windows", "macos", "linux"].includes(osName)) throw publicError("Choose Mac, Windows or Linux.");
    if (selection.destination && (!path.isAbsolute(selection.destination) || /[\x00-\x1f]/.test(selection.destination))) throw publicError("Choose an absolute download folder.");
    const job = { id: crypto.randomUUID(), store, appId, name: String(selection.name || state.library.find(row => row.appId === appId)?.name || appId), platform: osName,
      branch: String(selection.branch || ""), language: String(selection.language || "en"), autoImport: selection.autoImport !== false, imported: false, status: "queued", downloaded: 0, total: null, path: null, detail: "Preparing download", createdAt: new Date().toISOString() };
    const controller = new AbortController(), signal = controller.signal; jobs.set(job.id, { controller, job }); state.downloads.unshift(job); emit(); let stage, terminalStatus;
    const task = (async () => {
      try {
        job.status = "preparing"; emit(); const catalog = await getVersions(appId, { signal }); signal.throwIfAborted();
        if (!catalog.platforms.includes(osName) && !selection.manifestUrl) throw publicError("This game has no download for the selected platform.");
        const selectedBranch = job.branch ? catalog.branches.find(row => row.id === job.branch && row.platforms.includes(osName)) : catalog.branches.find(row => row.platforms.includes(osName));
        let selectedInstaller, requestedManifestUrl, selectedManifest;
        if (store === "epic") {
          if (!selectedBranch && !selection.manifestUrl) throw publicError("The selected Epic version is unavailable.");
          if (selection.manifestUrl) {
            const url = new URL(selection.manifestUrl); if (url.protocol !== "https:") throw publicError("The Epic manifest URL must use HTTPS.");
            requestedManifestUrl = url.href; selectedManifest = manifestMetadata.get(requestedManifestUrl);
            if (!selectedManifest) {
              try { selectedManifest = (await legendary(["info", requestedManifestUrl, "--json", "--platform", osName === "macos" ? "Mac" : osName === "linux" ? "Linux" : "Windows"], { signal }))?.manifest; if (selectedManifest) manifestMetadata.set(requestedManifestUrl, selectedManifest); }
              catch (error) { if (signal.aborted) throw error; }
            }
            job.versionId = selectedManifest?.build_id ? `manifest:${selectedManifest.build_id}:${osName}` : `manifest-url:${crypto.createHash("sha256").update(requestedManifestUrl).digest("hex")}`;
          } else job.versionId = selectedBranch.manifestBuildId ? `manifest:${selectedBranch.manifestBuildId}:${osName}` : `${selectedBranch.buildId}:${osName}`;
        } else {
          if (!selectedBranch) throw publicError("There is no GOG installer or build for this version and platform.");
          if (selectedBranch.delivery === "galaxy") { job.language = job.language === "english" ? "en" : job.language; job.versionId = `galaxy:${selectedBranch.buildId}:${job.language}`; }
          else {
            const language = job.language === "english" ? "en" : job.language, product = products.get(appId);
            selectedInstaller = product.downloads.installers.find(item => platform(item.os) === osName && String(item.version || "Current") === selectedBranch.version && item.language === language) ||
              product.downloads.installers.find(item => platform(item.os) === osName && String(item.version || "Current") === selectedBranch.version && (!selection.language || item.language === language));
            if (!selectedInstaller) throw publicError("There is no GOG installer for this version, platform and language.");
            job.language = selectedInstaller.language || "en"; job.versionId = `${selectedBranch.id}:${job.language}`;
          }
        }
        const duplicateRequest = { userDataDir: options.userDataDir, store, appId, platform: osName, versionId: job.versionId, destination: selection.destination, confirmDuplicate: options.confirmDuplicate, signal };
        const { checkExistingDownload, createDownloadIdentity } = require("./external-download-duplicates");
        job.downloadIdentity = createDownloadIdentity(duplicateRequest);
        const existing = await checkExistingDownload(duplicateRequest); signal.throwIfAborted();
        if (existing) return await reuseCompletedDownload(job, existing, { signal, onChange: emit, onDownloaded: options.onDownloaded });
        const parent = path.resolve(selection.destination || path.join(defaultDirectory, appId, osName)); fs.mkdirSync(parent, { recursive: true }); const realParent = fs.realpathSync(parent);
        stage = fs.mkdtempSync(path.join(realParent, ".external-download-")); const content = path.join(stage, "content"); fs.mkdirSync(content);
        const finalPath = path.join(realParent, `${job.name.replace(/[^a-z0-9_. -]/gi, "").slice(0, 70) || appId}-${job.id}`); job.path = finalPath;
        if (store === "epic") {
          const branch = selectedBranch;
          if (!branch && !selection.manifestUrl) throw publicError("The selected Epic version is unavailable.");
          job.branch = branch?.id || "manifest"; job.total = branch?.downloadSize || null; job.status = "downloading"; emit();
          const args = ["install", appId, "--base-path", stage, "--game-folder", "content", "--platform", osName === "macos" ? "Mac" : osName === "linux" ? "Linux" : "Windows", "--download-only", "--skip-dlcs", "--max-shared-memory", "256", "--max-workers", "4"];
          if (requestedManifestUrl) args.push("--manifest", requestedManifestUrl);
          const installedVersion = await legendary(args, { signal, expectedVersion: requestedManifestUrl || branch?.buildId === "Current" ? undefined : branch?.buildId,
            expectedManifestBuildId: requestedManifestUrl ? selectedManifest?.build_id : branch?.manifestBuildId, onLine: line => {
            const progress = /Progress:\s*([0-9.]+)%/.exec(line), bytes = /Downloaded:\s*([0-9.]+)\s*(MiB|GiB)/i.exec(line);
            if (bytes) job.downloaded = Math.round(Number(bytes[1]) * (bytes[2].toLowerCase() === "gib" ? 1024 ** 3 : 1024 ** 2));
            else if (progress && job.total) job.downloaded = Math.round(job.total * Number(progress[1]) / 100);
            job.detail = progress ? `Downloading · ${progress[1]}%` : "Downloading game files"; emit();
          } });
          job.version = installedVersion?.version || (selection.manifestUrl ? "Manifest" : branch.buildId); job.buildId = installedVersion?.buildId || (selection.manifestUrl ? null : branch.buildId);
          job.manifestBuildId = installedVersion?.buildId || selectedManifest?.build_id || branch?.manifestBuildId || null;
          if (!fs.readdirSync(content).length) throw publicError("Epic Games did not return any game files.");
        } else {
          const product = products.get(appId), branch = selectedBranch;
          if (!branch || !branch.platforms.includes(osName)) throw publicError("There is no GOG installer or build for this version and platform.");
          if (branch.delivery === "galaxy") {
            job.version = branch.name; job.buildId = branch.buildId;
            if (!Number.isFinite(Date.parse(session.expires_at || "")) || Date.parse(session.expires_at) < Date.now() + 30000) await gogToken({ grant_type: "refresh_token", refresh_token: session.refresh_token }, generation, signal);
            const { executablePath } = await (options.ensureGogdl || require("./gogdl-tool").ensureGogdl)({ userDataDir: options.userDataDir, signal, onProgress: detail => { job.detail = typeof detail === "string" ? detail : detail.detail || "Preparing GOG download support"; emit(); } });
            runtimeDir ||= fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-gog-session-")); fs.chmodSync(runtimeDir, 0o700);
            const authFile = path.join(runtimeDir, `auth-${job.id}.json`);
            const helperConfigRoot = path.join(runtimeDir, `gogdl-${job.id}`); fs.mkdirSync(helperConfigRoot, { mode: 0o700 });
            writeJson(authFile, { [GOG_CLIENT_ID]: { ...session, loginTime: Math.floor(Date.now() / 1000), expires_in: Math.max(1, Math.floor((Date.parse(session.expires_at || "") - Date.now()) / 1000)) || 3600 } });
            try {
              job.branch = branch.id; job.status = "downloading"; job.detail = "Downloading game files"; emit();
              await (options.execute || launch)(executablePath, ["--auth-config-path", authFile, "download", appId, "--build", branch.buildId,
                "--path", content, "--platform", osName === "macos" ? "osx" : osName, "--lang", job.language === "english" ? "en" : job.language, "--skip-dlcs"], {
                signal, cwd: runtimeDir, env: { ...process.env, GOGDL_CONFIG_PATH: helperConfigRoot, XDG_CONFIG_HOME: path.join(helperConfigRoot, "config"), XDG_CACHE_HOME: path.join(helperConfigRoot, "cache"), XDG_DATA_HOME: path.join(helperConfigRoot, "data") }, captureOutput: false, onLine: line => {
                  const percent = /(?:progress|download)[^\d]*([0-9.]+)%/i.exec(line);
                  job.detail = percent ? `Downloading · ${percent[1]}%` : "Downloading game files"; emit();
                } });
              const updated = readJson(authFile)?.[GOG_CLIENT_ID]; if (updated?.refresh_token) { session = { ...session, ...updated }; await persist(); }
            } finally { fs.rmSync(authFile, { force: true }); await fs.promises.rm(helperConfigRoot, { recursive: true, force: true }); }
            if (!fs.readdirSync(content).length) throw publicError("GOG did not return any game files.");
          } else {
          const installer = selectedInstaller;
          if (!installer) throw publicError("There is no GOG installer for this version, platform and language.");
          job.version = branch.name; job.buildId = branch.buildId;
          job.branch = branch.id; job.language = installer.language || "en"; job.total = installer.files.reduce((sum, item) => sum + Number(item.size || 0), 0); job.status = "downloading"; emit();
          const files = [];
          for (let index = 0; index < installer.files.length; index++) {
            signal.throwIfAborted(); const file = installer.files[index], link = await gogGet(file.downlink, signal);
            const url = new URL(link.downlink); if (url.protocol !== "https:") throw publicError("GOG returned an unsupported download link.");
            const cdn = Upstream.service({ hosts: [url.hostname] });
            let md5, expectedSize = Number(file.size) || null, listedName;
            if (link.checksum) {
              const { body, status } = await cdn.request(link.checksum, { signal, maxBytes: 4 * 1024 * 1024 }); const xml = body.toString("utf8");
              md5 = /\bmd5="([a-f0-9]{32})"/i.exec(xml)?.[1]; expectedSize = Number(/\btotal_size="(\d+)"/.exec(xml)?.[1]) || expectedSize;
              listedName = /<file\b[^>]*\bname="([^"]+)"/.exec(xml)?.[1];
              if (status !== 200 || !md5) throw publicError("GOG did not return valid checksum metadata for this file.");
            }
            // The checksum record names the file; otherwise GOG's CDN path carries it.
            let filename = listedName || file.filename || decodeURIComponent(path.posix.basename(url.pathname));
            filename = path.basename(String(filename)).replace(/[\x00-\x1f<>:"|?*\\/]/g, "_");
            if (!filename || filename === "." || filename === "..") filename = `${appId}-${index + 1}.bin`;
            if (files.includes(filename)) throw publicError("GOG supplied conflicting installer filenames.");
            const listed = cdn.file({ name: filename, url: url.href, ...(expectedSize ? { bytes: expectedSize } : {}), ...(md5 ? { digest: { algorithm: "md5", value: md5 } } : {}) });
            if (!listed) throw publicError("GOG returned an unsupported download link.");
            job.detail = filename; emit(); let lastEmit = 0; const before = job.downloaded;
            try {
              await cdn.download(listed, path.join(content, filename), { signal, onProgress: ({ downloaded }) => {
                job.downloaded = before + downloaded; if (Date.now() - lastEmit > 150) { lastEmit = Date.now(); emit(); } } });
            } catch (error) {
              if (signal.aborted) throw error;
              throw /its publisher lists/.test(error?.message || "") ? publicError("The game download failed its integrity check.")
                : error?.statusCode ? publicError("The game download is unavailable. Refresh versions and try again.") : error;
            }
            files.push(filename);
          }
          job.importPath = path.join(finalPath, files.find(file => /\.(?:exe|pkg|dmg|sh)$/i.test(file)) || files[0]);
          }
        }
        signal.throwIfAborted();
        job.versionName = job.version;
        const metadata = { schema: 1, store, appId, name: job.name, platform: osName, branch: job.branch, version: job.version, versionName: job.versionName, buildId: job.buildId, manifestBuildId: job.manifestBuildId, versionId: job.versionId, downloadIdentity: job.downloadIdentity,
          manifestUrl: requestedManifestUrl, language: job.language, path: finalPath, importPath: job.importPath || finalPath, complete: true, createdAt: job.createdAt };
        writeJson(path.join(content, ".maclauncher-external.json"), metadata); fs.renameSync(content, finalPath);
        // A damaged index is kept beside it; one that cannot be read is not replaced.
        const index = readJsonDocument(path.join(root, "installations.json"), { array: true }) || []; writeJson(path.join(root, "installations.json"), [...index, metadata]);
        job.status = "completed"; job.detail = "Download complete"; job.completedAt = new Date().toISOString(); if (job.total) job.downloaded = job.total; emit();
        if (job.autoImport && options.onDownloaded) { try { await options.onDownloaded(clone(job)); job.imported = true; } catch { job.importError = "The download is complete, but no supported game was imported. Import the downloaded files manually."; } }
      } catch (error) { const cancelled = signal.aborted || error?.code === "ABORT_ERR" || error?.name === "AbortError"; terminalStatus = cancelled ? "cancelled" : "error"; job.detail = cancelled ? "Download cancelled" : message(error, store); if (!cancelled) job.error = job.detail; }
      finally { if (stage) await fs.promises.rm(stage, { recursive: true, force: true }); if (terminalStatus) job.status = terminalStatus; jobs.delete(job.id); emit(); }
      return clone(job);
    })(); jobs.get(job.id).promise = task; return clone(job);
  }
  function markImported(id) { const job = state.downloads.find(item => item.id === id); if (job) { job.imported = true; job.importError = null; emit(); } return snapshot(); }
  function cancel(id) { jobs.get(id)?.controller.abort(); return snapshot(); }
  function disconnect() { generation++; sessionController.abort(); activeLibrary = null; session = null; for (const job of jobs.values()) job.controller.abort(); state.connection = { status: "disconnected" }; state.libraryLoading = false; emit(); return snapshot(); }
  async function dispose() { disposed = true; disconnect(); await Promise.allSettled([...jobs.values()].map(job => job.promise)); if (runtimeDir) await fs.promises.rm(runtimeDir, { recursive: true, force: true }); }
  return { snapshot, connect, submitAuth, loadLibrary, getVersions, download, cancel, markImported, disconnect, dispose };
}

module.exports = { createExternalStoreDownloads, ensureLegendary, installedLegendary, normalizeEpicLibrary, normalizeGogVersions, codeFromInput, findSession, launch, AUTH_URLS, LEGENDARY };
