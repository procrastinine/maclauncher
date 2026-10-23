const fs = require("node:fs"), path = require("node:path");
const { randomUUID } = require("node:crypto");
const Writable = require("../writable-input");
const warnGraphics = require("../graphics-warning");
const { isAbortError } = require("./download-utils");

const SYSTEM_READ = ["/System/Library", "/System/iOSSupport/System/Library", "/System/iOSSupport/usr/lib",
  "/System/Cryptexes/OS", "/System/Cryptexes/App", "/System/Volumes/Preboot/Cryptexes/OS",
  "/System/Volumes/Preboot/Cryptexes/App/System", "/usr/lib", "/usr/share", "/Library/Apple/System/Library",
  "/Library/Apple/usr/lib", "/Library/Fonts", "/private/var/db/timezone", "/private/var/db/com.apple.dyld"];
const SYSTEM_FILES = ["/", "/private/etc/localtime", "/private/etc/hosts", "/private/etc/resolv.conf",
  "/private/etc/protocols", "/private/etc/services", "/private/etc/passwd", "/private/etc/group",
  "/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"];
const MACH_SERVICES = ["com.apple.system.logger", "com.apple.system.notification_center", "com.apple.windowserver.active",
  "com.apple.coreservices.launchservicesd", "com.apple.lsd.mapdb",
  // Cocoa registers its Dock menu endpoint here. Blocking it makes Dock report
  // a responsive application as unresponsive and removes its ordinary Quit action.
  "com.apple.dock.server",
  // Receiving standard application events (including Dock Quit) requires
  // registration with appleeventsd. Sending events remains separately denied.
  "com.apple.coreservices.appleevents",
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
; AppKit's embedded text UI uses an XPC service, not a global Mach service.
; Its completion panel otherwise retries remote-view creation continuously.
(allow mach-lookup
  (xpc-service-name "com.apple.SafariPlatformSupport.Helper")
  (xpc-service-name "com.apple.ViewBridgeAuxiliary"))
; Native spelling/input services use locale-specific names with this suffix,
; matching macOS's application/container text-service rule.
(allow mach-lookup (global-name-regex "_OpenStep$"))
(allow mach-task-name (target self))
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
    return {graphics: {}, readable: [], readableDirectories: []};
  }
}

async function scopeGraphics(graphics, directory, writableDirectory, signal) {
  const result = Object.fromEntries(Object.entries(graphics).filter(([key]) => key.startsWith("RESHADE_") || ["FSR4_ROOT", "FSR4_BUILD_DIR"].includes(key)));
  const readable = [];
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
      for (const row of declaration.files.filter(row => row.path.endsWith(".dylib"))) {
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
  for (const key of ["RESHADE_FSR2_LIBRARY", "RESHADE_FSR3_LIBRARY", "RESHADE_FSR4_LIBRARY"])
    if (result[key]) readable.push(await canonical(result[key], "file"));
  const readableDirectories = result.RESHADE_LIVE_EFFECTS ? [await canonical(result.RESHADE_LIVE_EFFECTS, "directory")] : [];
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
      readable.push(library);if (root) readableDirectories.push(root);
    } catch (error) {
      if (signal?.aborted || isAbortError(error) || neuralModels.length) throw error;
      // A dormant path-only authorization is not an installed provider. Its
      // absence must not discard independent shaders or the live connection.
      delete result.RESHADE_NEURAL_LIBRARY;delete result.RESHADE_NEURAL_ROOT;
      graphicsWarning("[Graphics] Additional live neural rendering is unavailable.", error);
    }
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
  if (result.FSR4_ROOT) readableDirectories.push(await canonical(result.FSR4_ROOT, "directory"));
  if (result.RESHADE_FSR_SHADER_DIRECTORY) readableDirectories.push(await canonical(result.RESHADE_FSR_SHADER_DIRECTORY, "directory"));
  return { graphics: result, readable: [...new Set(readable)], readableDirectories };
}

module.exports = { profile, environment, canonical, within, isolateGraphics };
