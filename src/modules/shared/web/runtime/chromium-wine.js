const fs = require("node:fs"), path = require("node:path");
const Arguments = require("../../runtime/launch-arguments");
const { readPeExports } = require("../../runtime/pe-exports");
const { readMachOLoadCommands } = require("../../runtime/macho-load-commands");
const { wineLayout } = require("../../runtime/wine-layout");
const { environmentReference } = require("../../runtime/wine-environment");

const cache = new Map(), MAX_BYTES = 64 * 1024 * 1024;
const names = ["vkCreateInstance", "vkGetMemoryWin32HandleKHR", "disable-d3d11", "Direct3DCreate9", "Direct3DCreate9Ex"];
function binary(file, format) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const identity = [format, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
    const saved = cache.get(file);
    if (saved?.identity === identity) return saved.facts;
    const header = format === "pe" ? readPeExports(file) : readMachOLoadCommands(file);
    if (!header) return null;
    const bytes = fs.readFileSync(file), facts = {
      builtin: header.form === "builtin", architecture: header.architecture,
      exports: header.exports, architectures: header.architectures,
      names: new Set(names.filter(name => bytes.includes(Buffer.from(name + "\0"))))
    };
    if (cache.size >= 32) cache.delete(cache.keys().next().value);
    cache.set(file, { identity, facts });
    return facts;
  } catch { return null; }
}
function codeExport(image, name) {
  const value = image?.exports?.get(name);
  return value?.executable === true && value.forwarded === false;
}

// A necessary API can be absent without a runtime probe. Its presence does not
// establish extension mapping, resource properties or Windows handle transport.
function win32MemoryAPI(install, architecture) {
  const layout = wineLayout(install);
  const windows = architecture === "x86" ? "i386-windows" : architecture === "x86_64" ? "x86_64-windows" : null;
  if (!windows || !layout.windows.includes(windows) || !layout.unixRoot) return "unknown";
  const client = binary(path.join(layout.dllRoot, windows, "winevulkan.dll"), "pe");
  const native = ["winevulkan.so", "win32u.so"].map(name => binary(path.join(layout.unixRoot, name), "macho"));
  if (!client?.builtin || client.architecture !== architecture ||
      !codeExport(client, "vkGetDeviceProcAddr") || !codeExport(client, "vkGetInstanceProcAddr") ||
      native.some(image => !image?.architectures?.includes(layout.architecture) || !image.names.has("vkCreateInstance"))) return "unknown";
  return [client, ...native].some(image => image.names.has("vkGetMemoryWin32HandleKHR")) ? "declared" : "absent";
}

function explicitBackend(args) {
  return args.some(value => /^--(?:use-angle|use-gl|use-vulkan|disable-d3d11|use-warp|disable-gpu(?:-compositing)?|disable-webgl2?|disable-3d-apis|in-process-gpu|use-cmd-decoder)(?:=|$)/i.test(value));
}
function legacyD3D9(entry, context, launch) {
  const args = launch.arguments;
  if (require("../../../crossover/sources").get(context.runtimeId)?.invocation !== "wine" || context.wineEnvironment || explicitBackend(args)) return false;
  try {
    const directory = path.dirname(launch.executablePath), manifestPath = path.join(directory, "package.json");
    if (fs.statSync(manifestPath).size > 1024 * 1024) return false;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (typeof manifest.main !== "string" || !entry.indexHtml ||
        fs.realpathSync(path.resolve(directory, manifest.main)) !== fs.realpathSync(entry.indexHtml)) return false;
    if (manifest["chromium-args"] != null &&
        (typeof manifest["chromium-args"] !== "string" || explicitBackend(Arguments.parse(manifest["chromium-args"])))) return false;
    const egl = binary(path.join(directory, "libEGL.dll"), "pe");
    const browser = binary(launch.executablePath, "pe");
    const angle = binary(path.join(directory, "libGLESv2.dll"), "pe");
    if (egl?.builtin || egl?.architecture !== launch.executableArchitecture || !codeExport(egl, "eglInitialize") ||
        browser?.architecture !== launch.executableArchitecture ||
        !browser.names.has("disable-d3d11") || angle?.builtin || angle?.architecture !== launch.executableArchitecture ||
        !codeExport(angle, "glGetString") || !codeExport(angle, "glDrawArrays") ||
        !["Direct3DCreate9", "Direct3DCreate9Ex"].some(name => angle.names.has(name))) return false;
    return win32MemoryAPI(launch.install, launch.executableArchitecture) === "absent";
  } catch { return false; }
}

const WINE_D3D = "included:d3d-renderer:wined3d";
function resolveRuntimeSettings(entry, context, launch) {
  const settings = launch.settings;
  // D3D8 can import its renderer's D3D9 library, so supply one coherent default
  // for both APIs. Explicit per-API choices and external settings take priority.
  if ([settings.translatorD3D8, settings.translatorD3D9].some(value => value && value !== WINE_D3D) ||
      environmentReference(settings.environmentReference) !== null) return settings;
  const args = [...(Array.isArray(settings.arguments) ? settings.arguments : []), ...(context.gameArguments || [])];
  if (!legacyD3D9(entry, context, { ...launch, arguments: args })) return settings;
  const layout = wineLayout(launch.install), windows = launch.executableArchitecture === "x86" ? "i386-windows" : "x86_64-windows";
  for (const api of [8, 9]) {
    const library = binary(path.join(layout.dllRoot, windows, `d3d${api}.dll`), "pe");
    if (!library?.builtin || library.architecture !== launch.executableArchitecture || !codeExport(library, `Direct3DCreate${api}`)) return settings;
  }
  return { ...settings, translatorD3D8: WINE_D3D, translatorD3D9: WINE_D3D };
}
function resolveRuntimeArguments(entry, context, launch) {
  const args = launch.arguments;
  const selected = require("../../runtime/translator-roles").usedForApi(context.translatorPlan, "d3d9");
  if (selected?.engine !== "wined3d" || !legacyD3D9(entry, context, launch)) return args;
  // This browser's legacy EGL selector requests ANGLE D3D9. WineD3D avoids
  // DXVK shared handles; direct desktop GL has a separate WGL pbuffer failure.
  return ["--disable-d3d11", ...args];
}

module.exports = { resolveRuntimeArguments, resolveRuntimeSettings, win32MemoryAPI };
