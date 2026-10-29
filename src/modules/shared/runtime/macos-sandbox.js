const fs = require("node:fs"), path = require("node:path");
const { randomUUID } = require("node:crypto");
const Writable = require("../writable-input");
const warnGraphics = require("../graphics-warning");
const { isAbortError } = require("./download-utils");
const execFile = require("node:util").promisify(require("node:child_process").execFile);
let metalCompilerCacheDirectories;
function metalCompilerCaches() {
  if (process.platform !== "darwin") return Promise.resolve([]);
  if (!metalCompilerCacheDirectories) metalCompilerCacheDirectories = (async () => {
    const { stdout } = await execFile("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], { timeout: 5000 });
    const root = await canonical(stdout.trim(), "directory");
    if (!/^\/private\/var\/folders\/[^/]+\/[^/]+\/C$/.test(root))
      throw new Error("The system Metal compiler cache is unavailable.");
    return Promise.all(["com.apple.metal", "com.apple.metalfe", "com.apple.gpuarchiver"].map(async name => {
      const directory = path.join(root, name);
      await fs.promises.mkdir(directory, { recursive: true });
      const actual = await canonical(directory, "directory");
      if (!within(root, actual)) throw new Error("A Metal compiler cache escaped its system cache directory.");
      return actual;
    }));
  })().catch(error => { metalCompilerCacheDirectories = undefined; throw error; });
  return metalCompilerCacheDirectories;
}

const SYSTEM_READ = ["/System/Library", "/System/iOSSupport/System/Library", "/System/iOSSupport/usr/lib",
  "/System/Cryptexes/OS", "/System/Cryptexes/App", "/System/Cryptexes/Rosetta", "/System/Volumes/Preboot/Cryptexes/OS",
  "/System/Volumes/Preboot/Cryptexes/Rosetta", "/System/Volumes/Preboot/Cryptexes/Incoming/OS",
  "/System/Volumes/Preboot/Cryptexes/App/System", "/usr/lib", "/usr/share", "/Library/Apple/System/Library",
  "/Library/Apple/usr/lib", "/Library/Fonts", "/private/var/db/timezone", "/private/var/db/com.apple.dyld"];
const SYSTEM_FILES = ["/", "/private/etc/localtime", "/private/etc/hosts", "/private/etc/resolv.conf",
  "/private/etc/protocols", "/private/etc/services", "/private/etc/passwd", "/private/etc/group",
  "/dev/null", "/dev/zero", "/dev/random", "/dev/urandom",
  "/Library/Apple/usr/libexec/oah/libRosettaRuntime"];
const MACH_SERVICES = ["com.apple.system.logger", "com.apple.system.notification_center", "com.apple.windowserver.active",
  "com.apple.coreservices.launchservicesd", "com.apple.lsd.mapdb",
  // Cocoa registers its Dock menu endpoint here. Blocking it makes Dock report
  // a responsive application as unresponsive and removes its ordinary Quit action.
  "com.apple.dock.server",
  // Receiving standard application events (including Dock Quit) requires
  // registration with appleeventsd. Sending events remains separately denied.
  "com.apple.coreservices.appleevents",
  // Cocoa's own accessibility server validates incoming clients through TCC.
  // This connection leaves the system's accessibility authorization intact.
  "com.apple.tccd.system",
  // AppKit window ordering and display activation use these Apple graphics services.
  // WindowServer access alone can render a window without displaying it.
  "com.apple.window_proxies", "com.apple.windowmanager.dragserver", "com.apple.windowmanager.server",
  "com.apple.CoreDisplay.master", "com.apple.CoreDisplay.Notification",
  "com.apple.CARenderServer", "com.apple.cvmsServ", "com.apple.MTLCompilerService", "com.apple.MTLCompilerService.darwin",
  "com.apple.audio.coreaudiod", "com.apple.audio.audiohald", "com.apple.audio.AudioComponentRegistrar",
  // Passive route/interface queries need configd even when socket access is
  // allowed. Otherwise Android sees a route with no active transport at startup.
  "com.apple.SystemConfiguration.configd",
  // IOPM assertions keep owned background work and visible displays awake.
  // The native power manager retains their ordinary process-scoped lifetime.
  "com.apple.PowerManagement.control",
  "com.apple.audio.systemsoundserver", "com.apple.mDNSResponder", "com.apple.trustd.agent"];
const within = (root, file) => file === root || file.startsWith(root + path.sep);
function quote(value) {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Application isolation received an invalid path.");
  return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}
async function canonical(file, kind) {
  if (!path.isAbsolute(file || "")) throw new Error("Application isolation requires absolute file paths.");
  const actual = await fs.promises.realpath(file), stat = await fs.promises.stat(actual);
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) throw new Error("An Application isolation input is unavailable.");
  return actual;
}
function profile({ readDirectories, readFiles, writeDirectories, executables, blockNetwork = false, machServices = [], fileExtensions = {} }) {
  const ancestors = new Set(["/", "/etc", "/var", "/tmp"]);
  for (const file of [...SYSTEM_READ, ...SYSTEM_FILES, ...readDirectories, ...readFiles, ...writeDirectories, ...executables])
    for (let parent = path.dirname(file); parent !== path.dirname(parent); parent = path.dirname(parent)) ancestors.add(parent);
  const filters = (values, type) => [...new Set(values)].map(value => `(${type} ${quote(value)})`).join("\n  ");
  // An allow rule without selectors applies globally. An empty capability
  // collection supplies no authority, rather than an unfiltered allow rule.
  const allow = (operations, selectors) => selectors.trim() ? `(allow ${operations} ${selectors})` : "";
  // Seatbelt selects the most specific matching rule. A filtered outbound
  // grant overrides a later generic deny, so blocked profiles omit the grants.
  const services = [...MACH_SERVICES, ...machServices].filter(value => !blockNetwork || value !== "com.apple.mDNSResponder");
  return `(version 1)
(deny default)
${allow("file-read-metadata", filters([...ancestors], "literal"))}
${allow("file-read* file-map-executable", [filters([...SYSTEM_READ, ...readDirectories], "subpath"), filters([...SYSTEM_FILES, ...readFiles, ...executables], "literal")].join("\n  "))}
${allow("file-read* file-write* file-map-executable", filters(writeDirectories, "subpath"))}
${[["read", "com.apple.app-sandbox.read"], ["readWrite", "com.apple.app-sandbox.read-write"]].flatMap(([access, extension]) =>
  (fileExtensions[access] || []).map(directory => `(allow file-issue-extension (require-all (extension-class ${quote(extension)}) (subpath ${quote(directory)})))`)).join("\n")}
(allow file-write-data (literal "/dev/null") (literal "/dev/zero"))
${allow("process-exec", filters(executables, "literal"))}
(allow process-fork)
(allow process-info* (target self))
; A process owns the lifecycle of children it creates. Native fork adapters
; resume suspended children and reap failed starts through these signals.
(allow signal (target self) (target children))
(allow sysctl-read)
${allow("mach-lookup", filters(services, "global-name"))}
; AppKit owns these per-process accessibility and text-input endpoints.
; Global registration and access to another application's AX server stay denied.
(allow mach-register (local-name "com.apple.axserver" "com.apple.tsm.portname"))
; AppKit's embedded text UI uses an XPC service, not a global Mach service.
; Its completion panel otherwise retries remote-view creation continuously.
(allow mach-lookup
  (xpc-service-name "com.apple.hiservices-xpcservice")
  (xpc-service-name "com.apple.SafariPlatformSupport.Helper")
  (xpc-service-name "com.apple.ViewBridgeAuxiliary"))
; Native spelling/input services use locale-specific names with this suffix,
; matching macOS's application/container text-service rule.
(allow mach-lookup (global-name-regex "_OpenStep$"))
(allow mach-task-name (target self))
; Rosetta supplies translated executable mappings from its OS-owned cache.
; Opening unrelated cache files remains outside the application file grants.
(allow file-map-executable (subpath "/private/var/db/oah"))
(allow ipc-posix-shm-read-data ipc-posix-shm-write-data (ipc-posix-name "apple.shm.notification_center"))
(allow iokit-open
  (iokit-user-client-class "AGXDeviceUserClient")
  (iokit-user-client-class "AGXSharedUserClient")
  (iokit-user-client-class "IOAccelerator")
  (iokit-user-client-class "IOSurfaceRootUserClient")
  (iokit-user-client-class "IOAudioEngineUserClient"))
${blockNetwork ? '(deny network*)\n(deny mach-lookup (global-name "com.apple.mDNSResponder"))' : `(allow network-outbound (remote ip "*:*"))
(allow network-bind network-inbound (local ip "*:*"))
(allow network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder")))`}
`;
}

// Pass only process settings needed by the runtime. Launcher credentials and
// unrelated environment variables are not part of a game's environment.
function environment(base = process.env) {
  const result = { PATH: "/usr/bin:/bin" };
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "TZ", "__CF_USER_TEXT_ENCODING"])
    if (typeof base[key] === "string") result[key] = base[key];
  return result;
}

function graphicsWarning(message, error) {
  warnGraphics(console, message, String(error?.message || error || "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500));
}

async function isolateGraphics(graphics, directory, writableDirectory, signal) {
  signal?.throwIfAborted();
  try {
    const scoped = await scopeGraphics(graphics, directory, writableDirectory, signal);
    signal?.throwIfAborted();
    return scoped;
  } catch (error) {
    signal?.throwIfAborted();
    if (isAbortError(error)) throw error;
    // These are optional capabilities, separate from the caller's required
    // runtime and sandbox inputs. Never return a partially authorized adapter.
    graphicsWarning("[Graphics] Optional graphics could not be attached; using original rendering.", error);
    return {graphics: {}, readable: [], readableDirectories: [],executables:[],capabilities:"",fileExtensions:{}};
  }
}

async function scopeGraphics(graphics, directory, writableDirectory, signal) {
  const result = Object.fromEntries(Object.entries(graphics).filter(([key]) => key.startsWith("RESHADE_") || ["FSR4_ROOT", "FSR4_BUILD_DIR"].includes(key)));
  const readable = [],executables=[],extensionRead=[],extensionWrite=[];let capabilities="";
  let compilerCachesGranted=false;
  const grantCompilerCaches=async()=>{
    if(compilerCachesGranted)return;
    const caches=await metalCompilerCaches();
    readableDirectories.push(...caches);extensionWrite.push(...caches);
    for(const cache of caches)capabilities+=`\n(allow file-write* (subpath ${quote(cache)}))\n`;
    capabilities+='\n(allow mach-lookup (global-name "com.apple.bsd.dirhelper" "com.apple.system.opendirectoryd.libinfo" "com.apple.system.opendirectoryd.membership"))\n';
    compilerCachesGranted=true;
  };
  const readableDirectories=[];
  // This input is the launcher's explicit selection, never its ambient env.
  // Protected macOS executables strip DYLD, so callers restore this canonical
  // list after their sandbox boundary along with the scoped effect settings.
  const selected = graphics.DYLD_INSERT_LIBRARIES;
  if (selected != null && typeof selected !== "string") throw new Error("Invalid native graphics adapter selection.");
  const libraries = [...new Set((selected || "").split(path.delimiter).filter(Boolean))];
  if (libraries.length > 16) throw new Error("Too many native graphics adapters.");
  const canonicalLibraries = [...new Set(await Promise.all(libraries.map(file => canonical(file, "file"))))];
  if (canonicalLibraries.length) {
    result.DYLD_INSERT_LIBRARIES = canonicalLibraries.join(path.delimiter);
    readable.push(...canonicalLibraries);
    // All selected Metal adapters compile shaders, including spatial scaling
    // and LSFG. Authorize the OS-selected compiler caches before first use.
    await grantCompilerCaches();
    // The included processor loads its shader providers lazily. Grant only
    // declared code files from that exact installed payload, not arbitrary
    // neighboring folders or launcher data. Provider/model resources below
    // remain governed by their explicit graphics bindings.
    const coreRoot = require("../reshade").runtimeRoot();
    const core = path.join(coreRoot, "libreshade-macos.dylib");
    let actualCore;
    try { actualCore = await canonical(core, "file"); }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
    if (canonicalLibraries.includes(actualCore)) {
      const root = await canonical(coreRoot, "directory"), declaration = require("../reshade/publication").forRoot(root);
      for (const row of declaration.files.filter(row => row.path.endsWith(".dylib") || row.path.startsWith("isf/"))) {
        let file;
        try { file = await canonical(path.join(root, row.path), "file"); }
        catch (error) {
          // Preparation validates the selected provider. An unused optional
          // provider is not a requirement for another effect or presenter.
          if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
          throw error;
        }
        if (!within(root, file)) throw new Error("A graphics dependency escaped its included runtime.");
        readable.push(file);
      }
      const metadata = JSON.parse(await fs.promises.readFile(path.join(root, "runtime.json"), "utf8"));
      if (metadata.features?.shaders?.formats?.includes("isf")) {
        const cache = path.join(writableDirectory, "isf-cache");
        await fs.promises.mkdir(cache, { recursive: true });
        result.RESHADE_ISF_CACHE_ROOT = await canonical(cache, "directory");
      }
    }
  }
  const source = graphics.RESHADE_PREPARED_EFFECT;
  if (source) {
    const file = await canonical(source, "file"), stat = await fs.promises.stat(file);
    if (stat.size > 8 * 1024 ** 2) throw new Error("The prepared Application effect exceeds its size limit.");
    const bytes = await fs.promises.readFile(file);
    const output = path.join(directory, "prepared.fx");
    await fs.promises.writeFile(output, bytes, { mode: 0o600 });
    result.RESHADE_EFFECT = result.RESHADE_PREPARED_EFFECT = output;
    // The effect is already preprocessed. Copy only its declared image inputs,
    // never grant the app access to a custom shader's entire Mac directory.
    const roots = (graphics.RESHADE_TEXTURE_PATH || "").split(path.delimiter).filter(Boolean);
    const images = [...new Set([...bytes.toString("utf8").matchAll(/\bsource\s*=\s*"([^"\r\n]+)"/g)].map(match => match[1]))]
      .filter(name => /\.(?:png|jpe?g|bmp|gif)$/i.test(name));
    if (images.length > 128) throw new Error("The Application effect contains too many image inputs.");
    const textures = path.join(directory, "Textures");
    await fs.promises.rm(textures, { recursive: true, force: true });
    await fs.promises.mkdir(textures, { mode: 0o700 });
    let total = 0;
    for (const image of images) {
      signal?.throwIfAborted();
      const name = image.replaceAll("\\", "/");
      if (path.isAbsolute(name) || name.split("/").some(part => part === ".." || part === ""))
        throw new Error("Application effect image paths must stay inside the selected texture folders.");
      let input;
      for (const root of roots) {
        try { const realRoot = await canonical(root, "directory"), candidate = await canonical(path.join(realRoot, name), "file");
          if (within(realRoot, candidate)) { input = candidate; break; }
        } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
      }
      if (!input) throw new Error("An Application effect image is missing: " + name);
      const size = (await fs.promises.stat(input)).size;
      if (size > 64 * 1024 ** 2 || (total += size) > 256 * 1024 ** 2) throw new Error("Application effect images exceed their size limit.");
      const target = path.join(textures, name);await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.promises.copyFile(input, target);await fs.promises.chmod(target, 0o600);
    }
    result.RESHADE_TEXTURE_PATH = textures;
  }
  delete result.RESHADE_INCLUDE_PATH;
  if (graphics.RESHADE_DIAGNOSTICS || graphics.RESHADE_GPU_TIMING || graphics.RESHADE_TRACE === "1")
    require("../reshade/diagnostic-retention").pruneDiagnostics(writableDirectory);
  for (const [key, name] of [["RESHADE_WINDOW_STATE", "window-state"], ["RESHADE_LOG", "reshade.log"]]) {
    if (!graphics[key]) continue;
    const output = path.join(writableDirectory, name);
    Writable.atomicWrite(output, key === "RESHADE_WINDOW_STATE" ? Buffer.alloc(4096) : "", { root: writableDirectory });
    result[key] = output;
  }
  for (const [key, prefix] of [["RESHADE_DIAGNOSTICS", "diagnostics"], ["RESHADE_GPU_TIMING", "gpu-timing"]]) {
    if (!graphics[key]) continue;
    const name = path.basename(graphics[key]);
    const valid = new RegExp("^" + prefix + "-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$").test(name);
    // Native tracing appends .<pid>.jsonl. Keep the common bounded-retention
    // format and do not create an unused file at the prefix itself.
    result[key] = path.join(writableDirectory, valid ? name : prefix + "-" + randomUUID());
  }
  if (result.RESHADE_CAPTURE_PREFIX) {
    result.RESHADE_CAPTURE_PREFIX = path.join(writableDirectory, "frame-capture");
    if (result.RESHADE_CAPTURE_TRIGGER) result.RESHADE_CAPTURE_TRIGGER = path.join(writableDirectory, "frame-capture.request");
  }
  if (result.RESHADE_LOSSLESS_MODEL) readable.push(await canonical(result.RESHADE_LOSSLESS_MODEL, "file"));
  if (result.RESHADE_CONTROL_FILE) readable.push(await canonical(result.RESHADE_CONTROL_FILE, "file"));
  if (result.RESHADE_EFFECT_PLAN) readable.push(await canonical(result.RESHADE_EFFECT_PLAN, "file"));
  if (result.RESHADE_EFFECT_PLAN_MODELS) {
    const models = JSON.parse(result.RESHADE_EFFECT_PLAN_MODELS);
    if (!Array.isArray(models) || models.length > 32 || models.some(file => typeof file !== "string" || !path.isAbsolute(file))) throw new Error("Invalid graphics model bindings.");
    for (const file of models) readable.push(await canonical(file, "file"));
  }
  if (result.RESHADE_TEMPORAL_CONTROL_FILE) readable.push(await canonical(result.RESHADE_TEMPORAL_CONTROL_FILE, "file"));
  const statusKeys = ["RESHADE_RUNTIME_STATUS_FILE", "RESHADE_RUNTIME_STATUS_LAUNCH_ID", "RESHADE_RUNTIME_STATUS_TOKEN"];
  if (statusKeys.some(key => result[key] != null)) try {
    const [file, identity, token] = statusKeys.map(key => result[key]);
    if (!/^[\w-]{1,128}$/.test(identity || "") || !/^[a-f0-9]{64}$/.test(token || "") ||
        !path.isAbsolute(file || "") || path.basename(file) !== `runtime-status-${identity}.bin`)
      throw new Error("Invalid graphics status page binding.");
    const parent = await canonical(path.dirname(file), "directory"), page = path.join(parent, path.basename(file)),
      existing = await fs.promises.lstat(page).catch(error => {if (error.code !== "ENOENT") throw error;});
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || process.getuid && existing.uid !== process.getuid()))
      throw new Error("Invalid graphics status page destination.");
    // Off does not create/map a page. The launcher may prime this exact path
    // later; only existing data is writable, never creation or nearby files.
    // The native mapper validates the page header, token, size and lease.
    result.RESHADE_RUNTIME_STATUS_FILE = page;readable.push(page);
    capabilities += `\n(allow file-write-data (literal ${quote(page)}))\n`;
  } catch (error) {
    for (const key of statusKeys) delete result[key];
    graphicsWarning("[Graphics] Runtime processing status is unavailable.", error);
  }
  for (const prefix of ["RESHADE_RENDER_SOURCE", "RESHADE_VIRTUAL_SOURCE"]) {
    const input = result[prefix + "_CONTROL_FILE"], status = result[prefix + "_STATUS_FILE"], identity = result[prefix + "_LAUNCH_ID"],
      dedicated = prefix === "RESHADE_VIRTUAL_SOURCE", suffix = dedicated ? "-virtual" : "";
    if ([input, status, identity, result[prefix + "_ACTIVATION_API"]].every(value => value == null)) continue;
    if (!/^[\w-]{1,128}$/.test(identity || "") || !path.isAbsolute(input || "") || !path.isAbsolute(status || "") ||
        path.dirname(input) !== path.dirname(status) || path.basename(input) !== `source-control-${identity}${suffix}.json` ||
        path.basename(status) !== `source-status-${identity}${suffix}.json` || dedicated && result[prefix + "_ACTIVATION_API"] !== "1")
      throw new Error("Invalid render source channel paths.");
    const parent = await canonical(path.dirname(input), "directory"), command = await canonical(input, "file");
    if (command !== path.join(parent, path.basename(input))) throw new Error("A render source command escaped its declared directory.");
    let handle, packet;
    try {
      handle = await fs.promises.open(input, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 4096) throw new Error("Invalid render source command.");
      const buffer = Buffer.alloc(4097);let length = 0, count;
      while (length < buffer.length && (count = (await handle.read(buffer, length, buffer.length - length, null)).bytesRead)) length += count;
      if (length > 4096) throw new Error("Invalid render source command.");
      packet = JSON.parse(buffer.toString("utf8", 0, length));
    } finally { await handle?.close(); }
    if (packet?.schema !== 1 || packet.launchId !== identity || !["engine", "drawable", "virtual"].includes(packet.control) ||
        dedicated && packet.control !== "virtual" || !Number.isSafeInteger(packet.epoch) || packet.epoch < 1 ||
        !/^[a-f0-9]{64}$/.test(packet.revision || "") || !Object.hasOwn(packet, "source"))
      throw new Error("The render source command belongs to another launch.");
    const output = path.join(parent, path.basename(status)), existing = await fs.promises.lstat(output).catch(error => {if (error.code !== "ENOENT") throw error;});
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Invalid render source status destination.");
    result[prefix + "_CONTROL_FILE"] = command;result[prefix + "_STATUS_FILE"] = output;readable.push(command);
    // Only the receipt and its current native mkstemp/numeric producer
    // siblings are writable. Commands and neighboring launcher state remain
    // read-only, including after a later atomic command replacement.
    const escaped = output.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), nativeToken = "[A-Za-z0-9]".repeat(6);
    capabilities += `\n(allow file-read-metadata file-write* (literal ${quote(output)}) (regex ${quote("^" + escaped + "\\.tmp-(" + nativeToken + "|[0-9]+)$")}))\n`;
  }
  for(const binding of require("../reshade/temporal/providers").bindings(result)){
    const target=await canonical(binding.path,binding.type);
    (binding.type==="file"?readable:readableDirectories).push(target);
  }
  if(result.RESHADE_LIVE_EFFECTS)readableDirectories.push(await canonical(result.RESHADE_LIVE_EFFECTS, "directory"));
  if (result.RESHADE_EFFECT_MODEL_ROOTS != null) {
    try {
      let roots;
      try { roots = JSON.parse(result.RESHADE_EFFECT_MODEL_ROOTS); }
      catch { throw new Error("Invalid managed graphics model folders."); }
      const names = new Set(["lossless-models", "graphics-neural-models"]);
      if (!Array.isArray(roots) || roots.length > 2 || roots.some(root => typeof root !== "string" || !path.isAbsolute(root) || /[\x00-\x1f\x7f]/.test(root)))
        throw new Error("Invalid managed graphics model folders.");
      let parent;
      for (const root of roots) {
        const current = path.dirname(root), name = path.basename(root);
        if (path.resolve(root) !== root || !names.delete(name) || path.basename(current) !== "runtimes" || parent && parent !== current ||
            await canonical(path.dirname(current), "directory") !== path.dirname(current))
          throw new Error("Invalid managed graphics model folders.");
        // Only the two launcher-owned stores receive recursive read access.
        // Neither their parent nor aliases into unrelated data are authorized.
        Writable.assertOwnDirectory(path.dirname(current), root, { create: false });
        parent = current;
      }
      readableDirectories.push(...roots);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      // Later imports own these exact prospective paths. An unsafe future
      // grant supplies no authority; selected model files remain strict above.
      delete result.RESHADE_EFFECT_MODEL_ROOTS;
      graphicsWarning("[Graphics] Additional live model access is unavailable.", error);
    }
  }
  let neuralModels = [];
  if (result.RESHADE_NEURAL_MODELS) {
    neuralModels = JSON.parse(result.RESHADE_NEURAL_MODELS);
    if (!Array.isArray(neuralModels) || neuralModels.length > 32) throw new Error("Invalid neural model bindings.");
    for (const model of neuralModels) readableDirectories.push(await canonical(require("../reshade/neural").model(model), "directory"));
  }
  if (result.RESHADE_NEURAL_LIBRARY || result.RESHADE_NEURAL_ROOT) {
    try {
      const library = await canonical(result.RESHADE_NEURAL_LIBRARY, "file");
      const root = result.RESHADE_NEURAL_ROOT ? await canonical(result.RESHADE_NEURAL_ROOT, "directory") : null;
      if (root && !within(root, library)) throw new Error("The neural provider must remain inside its installed resources.");
      readable.push(library);if (root) {readableDirectories.push(root);extensionRead.push(root);}
      await grantCompilerCaches();
      if(root) {
        const helper=path.join(root,"maclauncher-neural-service");
        try {
          const executable=await canonical(helper,"file");
          if(!within(root,executable))throw new Error("The neural service escaped its installed resources.");
          await fs.promises.access(executable,fs.constants.X_OK);executables.push(executable);
          result.RESHADE_NEURAL_SERVICE=executable;
          const prefix="org.maclauncher.neural."+randomUUID().replaceAll("-","")+".";
          result.RESHADE_NEURAL_SERVICE_NAMESPACE=prefix;
          const expression="^"+prefix.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"[A-Fa-f0-9-]+$";
          // Each launch owns its exact helper and private per-launch namespace.
          capabilities+=`\n(allow mach-register (global-name-regex ${quote(expression)}))\n(allow mach-lookup (global-name-regex ${quote(expression)}))\n`;
        } catch(error) {if(error.code!=="ENOENT"&&error.code!=="ENOTDIR")throw error;}
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error) || neuralModels.length) throw error;
      // A dormant path-only authorization is not an installed provider. Its
      // absence must not discard independent shaders or the live connection.
      delete result.RESHADE_NEURAL_LIBRARY;delete result.RESHADE_NEURAL_ROOT;
      graphicsWarning("[Graphics] Additional live neural rendering is unavailable.", error);
    }
  }
  if(result.RESHADE_XESS_CONFIG){
    const selected=result.RESHADE_XESS_CONFIG;
    if(!path.isAbsolute(selected))throw new Error("The XeSS configuration path is invalid.");
    try{readable.push(await canonical(selected,"file"));}
    catch(error){if(error.code!=="ENOENT")throw error;const parent=await canonical(path.dirname(selected),"directory");readable.push(path.join(parent,path.basename(selected)));}
  }
  if(result.RESHADE_XESS_REQUEST_ROOT||result.RESHADE_XESS_RECEIPT_ROOT){
    const requests=await canonical(result.RESHADE_XESS_REQUEST_ROOT,"directory"),receipts=await canonical(result.RESHADE_XESS_RECEIPT_ROOT,"directory"),prefix=result.RESHADE_XESS_SERVICE_NAMESPACE;
    if(requests===receipts||path.dirname(requests)!==path.dirname(receipts)||path.basename(requests)!=="requests"||path.basename(receipts)!=="receipts"||!/^org\.maclauncher\.xess\.[a-f0-9]{24}\.$/.test(prefix||""))
      throw new Error("The XeSS compute session is invalid.");
    readableDirectories.push(requests,receipts);
    // Seatbelt's regex engine accepts '+' repetition; UUID length/structure
    // is validated separately at the compute-broker protocol boundary.
    const expression="^"+prefix.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"[A-Fa-f0-9-]+$";
    // Setup requests carry metadata only. Receipts are outside every game
    // writable directory, and the game receives no compute-host exec rights.
    capabilities+=`\n(allow file-write* (subpath ${quote(requests)}))\n(allow mach-register (global-name-regex ${quote(expression)}))\n(allow mach-lookup (global-name-regex ${quote(expression)}))\n`;
  }
  if (result.RESHADE_EFFECT_PLAN_ROOT) readableDirectories.push(await canonical(result.RESHADE_EFFECT_PLAN_ROOT, "directory"));
  if (result.RESHADE_RETROARCH_ROOT) {
    const root = await canonical(result.RESHADE_RETROARCH_ROOT, "directory");
    if (!result.RESHADE_EFFECT || !within(root, await canonical(result.RESHADE_EFFECT, "file"))) throw new Error("The RetroArch preset must remain inside its prepared resources.");
    readableDirectories.push(root);
  }
  if (result.RESHADE_LIBPLACEBO_ROOT) {
    const root = await canonical(result.RESHADE_LIBPLACEBO_ROOT, "directory");
    if (!result.RESHADE_EFFECT || !within(root, await canonical(result.RESHADE_EFFECT, "file"))) throw new Error("The libplacebo shader must remain inside its prepared resources.");
    readableDirectories.push(root);
  }
  return { graphics: result, readable: [...new Set(readable)], readableDirectories,executables,capabilities,fileExtensions:{read:extensionRead,readWrite:extensionWrite} };
}

module.exports = { profile, environment, canonical, within, isolateGraphics };

// A launcher-owned compute host receives its own policy when its exact code and
// resources are prepared. The requesting game gains only setup-file and Mach
// endpoint access, so new host installations remain usable by a running game.
async function isolateComputeHost(config,{userDataDir,requestRoot,receiptRoot,endpoint}={}) {
  const root=await canonical(userDataDir,"directory"),requests=await canonical(requestRoot,"directory"),receipts=await canonical(receiptRoot,"directory");
  if(!within(root,requests)||!within(root,receipts)||path.dirname(requests)!==path.dirname(receipts)||requests===receipts||
      !/^org\.maclauncher\.xess\.[a-f0-9]{24}\.[A-Fa-f0-9-]{36}$/.test(endpoint||""))
    throw new Error("The graphics compute session is invalid.");
  const resources=config?.resources;
  if(config?.schema!==1||!resources||!Array.isArray(config.arguments)||config.arguments.length>128)
    throw new Error("The graphics compute host declaration is invalid.");
  const list=async(key,kind,maximum=128)=>{
    const values=resources[key]||[];if(!Array.isArray(values)||values.length>maximum)throw new Error("The graphics compute resource declaration is invalid.");
    return Promise.all(values.map(value=>canonical(value,kind)));
  };
  const [read,code,writable,executables,baseCaches]=await Promise.all([list("read","file"),list("codeDirectories","directory",32),list("writableDirectories","directory",32),list("executables","file",32),metalCompilerCaches()]);
  const caches=[...baseCaches],metalExecutables=[];
  const scope=path.join(path.dirname(requests),"host-sandbox");require("../writable-input").assertOwnDirectory(root,scope);
  const home=path.join(scope,"home"),temporary=path.join(scope,"tmp");await Promise.all([fs.promises.mkdir(home,{recursive:true}),fs.promises.mkdir(temporary,{recursive:true})]);
  const executable=await canonical(config.executable,"file");if(!executables.includes(executable))throw new Error("The graphics compute executable is undeclared.");
  for(const file of [...executables])if(["wineloader","wine"].includes(path.basename(file))){
    const child=path.resolve(path.dirname(file),"../lib/wine/x86_64-unix/wine");try{const actual=await canonical(child,"file");executables.push(actual);metalExecutables.push(actual);}catch(error){if(error.code!=="ENOENT")throw error;}
  }
  // Metal namespaces an application host's compiler cache by its actual code
  // identifier. CLI helpers have no such namespace. Derive the selected host's
  // exact identifier instead of granting its entire user cache directory.
  for(const file of metalExecutables){
    const metadata=await execFile("/usr/bin/codesign",["-d","--verbose=4",file],{timeout:5000}),identifier=/^Identifier=(.+)$/m.exec(metadata.stderr)?.[1];
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(identifier||""))throw new Error("The graphics compute code identifier is unavailable.");
    for(const name of ["com.apple.metal","com.apple.metalfe","com.apple.gpuarchiver"]){const directory=path.join(path.dirname(baseCaches[0]),identifier,name);await fs.promises.mkdir(directory,{recursive:true});const actual=await canonical(directory,"directory");if(!within(path.dirname(baseCaches[0]),actual))throw new Error("The host compiler cache escaped its system cache directory.");caches.push(actual);}
  }
  // CrossOver's entrypoint is a Perl script; only its exact system interpreter
  // is executable. Runtime-supplied native children remain separately declared.
  if((await fs.promises.readFile(executable)).subarray(0,128).toString().startsWith("#!/usr/bin/perl"))executables.push(await canonical("/usr/bin/perl","file"));
  // sandbox-exec is protected and drops inherited DYLD variables. Restore
  // only these prepared code paths as literal env arguments after that boundary.
  const loaderVariables=Object.entries(config.environment||{}).filter(([key,value])=>typeof value==="string"&&
    /^DYLD_(?:LIBRARY_PATH|FALLBACK_LIBRARY_PATH|FRAMEWORK_PATH|FALLBACK_FRAMEWORK_PATH)$/.test(key));
  const envExecutable=loaderVariables.length?await canonical("/usr/bin/env","file"):null;
  if(envExecutable)executables.push(envExecutable);
  const prefix=config.environment?.WINEPREFIX;if(!path.isAbsolute(prefix||""))throw new Error("The graphics compute environment is undeclared.");
  const actualPrefix=await canonical(prefix,"directory");if(!writable.some(directory=>within(directory,actualPrefix)))throw new Error("The graphics compute environment is not writable.");
  const stat=await fs.promises.stat(actualPrefix),server=path.join("/private/tmp",`.wine-${process.getuid()}`,`server-${stat.dev.toString(16)}-${stat.ino.toString(16)}`);
  const policy=profile({readDirectories:[...code,await canonical(config.nativeRoot,"directory"),receipts,...caches],readFiles:read,
    writeDirectories:[...writable,home,temporary,server,...caches],executables:[...new Set(executables)],blockNetwork:true,
    fileExtensions:{read:code,readWrite:caches}})+
    `\n(allow mach-lookup (global-name ${quote(endpoint)} ${quote(server.replace(/^\/private/,""))} ${quote(`wine-${stat.ino.toString(16)}-msync`)} "com.apple.bsd.dirhelper" "com.apple.system.opendirectoryd.libinfo" "com.apple.system.opendirectoryd.membership"))\n`+
    `(allow mach-register (global-name ${quote(server.replace(/^\/private/,""))} ${quote(`wine-${stat.ino.toString(16)}-msync`)}))\n`+
    `(allow ipc-posix-shm* (ipc-posix-name ${["msync","msync-tid","esync"].flatMap(name=>[quote(`wine-${stat.ino.toString(16)}-${name}`),quote(`/wine-${stat.ino.toString(16)}-${name}`)]).join(" ")}))\n`+
    `(allow network-outbound (remote unix-socket (literal ${quote(path.join(server,"socket"))})))\n`+
    `(allow network-bind network-inbound (local unix-socket (literal ${quote(path.join(server,"socket"))})))\n`;
  const digest=require("node:crypto").createHash("sha256").update(policy).digest("hex"),file=path.join(scope,digest+".sb");
  await fs.promises.writeFile(file,policy,{mode:0o600});
  const variables={...environment(config.environment),...Object.fromEntries(Object.entries(config.environment||{}).filter(([key,value])=>typeof value==="string"&&
    (/^(?:WINE|CX_)/.test(key)||/^DYLD_(?:LIBRARY_PATH|FALLBACK_LIBRARY_PATH|FRAMEWORK_PATH|FALLBACK_FRAMEWORK_PATH)$/.test(key)||key==="VK_ICD_FILENAMES"||key==="VK_DRIVER_FILES")))};
  variables.HOME=home;variables.CFFIXED_USER_HOME=home;variables.TMPDIR=temporary+path.sep;
  return {executable:"/usr/bin/sandbox-exec",args:["-f",file,...(envExecutable?[envExecutable,...loaderVariables.map(([key,value])=>key+"="+value)]:[]),executable,...config.arguments],environment:variables};
}
module.exports.isolateComputeHost=isolateComputeHost;
