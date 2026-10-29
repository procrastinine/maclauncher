const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");
const Native = require("../../shared/runtime/local-native");
const { inspectClassic } = require("../inspect");

async function mapRelease(release, { resolveRevision, sourceUrl }) {
  const version = release.tag_name.replace(/^v(?=\d)/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  return { version, upstreamVersion: version, upstreamTag: release.tag_name,
    upstreamRevision: await resolveRevision(release), sourceKind: "release", sourceUrl,
    publishedAt: release.published_at, backend: "upstream", license: "GPL-2.0-only",
    localBuild: false, evidence: "historical-windows-release", installReason: "Windows binaries only. A separate Mac runtime is available from MacLauncher Builds." };
}
const discoverCatalog = createGithubReleaseDiscovery({ owner: "OpenGMK", repo: "OpenGMK", mapRelease, includePrerelease: true });
const bundledRuntime = createBundledNativeRuntime({ managerId: "opengmk" });
const manager = createPinnedNativeManager({ id: "opengmk", label: "OpenGMK", catalog: [],
  projectBuilds: { projectId: "opengmk", repository: "procrastinine/maclauncher-builds" },
  distributionRequired: false,
  discoverCatalog, legacyInstalledRuntime: bundledRuntime,
  sourceUrl: "https://github.com/OpenGMK/OpenGMK/releases" });

function inspectSource(dataPath) {
  const inspection = inspectClassic(dataPath);
  if (!inspection) throw new Error("OpenGMK needs an unchanged standard GameMaker 8.0 or 8.1 Windows executable.");
  if (inspection.fileBytes > 128 * 1024 ** 2) throw new Error("OpenGMK Classic inputs are limited to 128 MiB.");
  return inspection;
}

// Runtime selection supplies only integrity-verified installed Mac builds.
function parserRuntime(selection) { return selection?.install || null; }

function validateReport(report) {
  if (!report || report.schemaVersion !== 1 || report.engine !== "gamemaker-classic" ||
    report.assetsVerified !== true || !["8.0", "8.1"].includes(report.version) || report.windowsExtensionHost !== false ||
    !Array.isArray(report.extensions) || report.extensions.length > 4096 ||
    !Array.isArray(report.externalDefinitions) || report.externalDefinitions.length > 4096) throw new Error("OpenGMK returned an invalid Classic asset/extension report.");
  const declarations = [];
  const profiles = report.nativeExtensionProfiles || [];
  if (!Array.isArray(profiles) || profiles.length > 32 || profiles.some(profile => !profile || typeof profile.id !== "string" ||
    !Array.isArray(profile.libraries) || profile.libraries.some(library => typeof library !== "string" || library.length > 1024) ||
    !Array.isArray(profile.functions) || profile.functions.length > 128 || profile.functions.some(fn => !fn || typeof fn.symbol !== "string" ||
      fn.symbol.length > 1024 || !Number.isInteger(fn.argumentCount) || fn.argumentCount < 0 || fn.argumentCount > 17 ||
      !Array.isArray(fn.argumentTypes) || fn.argumentTypes.length !== fn.argumentCount ||
      fn.argumentTypes.some(type => !["real", "string"].includes(type)) || !["real", "string"].includes(fn.returnType)))) throw new Error("Invalid native Classic extension capabilities.");
  for (const extension of report.extensions) {
    if (typeof extension.name !== "string" || !Array.isArray(extension.files) || extension.files.length > 4096) throw new Error("Invalid Classic extension declarations.");
    for (const file of extension.files) {
      if (!file || typeof file.name !== "string" || !["dll", "gml", "action-library", "other"].includes(file.kind) ||
        !Array.isArray(file.functions) || file.functions.length > 4096) throw new Error("Invalid Classic extension file declarations.");
      if (file.kind === "dll") {
        for (const fn of file.functions) {
          if (!fn || typeof fn.symbol !== "string" || !["cdecl", "stdcall", "unknown"].includes(fn.callingConvention) ||
            !Number.isInteger(fn.argumentCount) || fn.argumentCount < 0 || fn.argumentCount > 17 ||
            !Array.isArray(fn.argumentTypes) || fn.argumentTypes.length !== fn.argumentCount ||
            fn.argumentTypes.some(type => !["real", "string"].includes(type)) || !["real", "string"].includes(fn.returnType)) {
            throw new Error(`Unsupported Classic extension ABI in ${file.name}.`);
          }
          declarations.push({ extension: extension.name, library: file.name, ...fn });
        }
      }
    }
  }
  // File presence alone does not make a DLL necessary. Inventory declarations
  // here; the native ABI guard rejects every actual unsupported definition.
  const basename = library => path.posix.basename(library.replaceAll("\\", "/")).toLowerCase();
  const valueType = type => typeof type === "string" ? type : type?.identifier === "ty_string" || type === 1 ? "string" :
    type?.identifier === "ty_real" || type === 0 ? "real" : null;
  const implemented = declaration => profiles.some(profile => profile.libraries.some(alias => basename(alias) === basename(declaration.library)) &&
    profile.functions.some(fn => fn.symbol === declaration.symbol && fn.argumentCount === declaration.argumentCount &&
      fn.returnType === valueType(declaration.returnType) && Array.isArray(declaration.argumentTypes) &&
      fn.argumentTypes.length === declaration.argumentTypes.length && fn.argumentTypes.every((type, index) => type === valueType(declaration.argumentTypes[index]))));
  const unsupportedLibraries = [...new Set([
    ...declarations.filter(fn => !implemented(fn)).map(fn => fn.library),
    ...report.externalDefinitions.filter(fn => fn && typeof fn.library === "string" && typeof fn.symbol === "string" &&
      !implemented(fn)).map(fn => fn.library)
  ])];
  return { ...report, extensionCount: report.extensions.length, dllDeclarations: declarations,
    nativeExtensionProfiles: profiles, unsupportedLibraries,
    externalDefinitionCount: report.externalDefinitions.length,
    compatibility: "format-candidate", qualification: unsupportedLibraries.length
      ? `These declared Windows extensions need a native implementation if used: ${unsupportedLibraries.slice(0, 8).join(", ")}.`
      : "Runs GM8.0/8.1 data. SuperSound WAV/Ogg audio uses a native implementation." };
}

async function preflight(dataPath, selection, { signal, execute = run } = {}) {
  const source = inspectSource(dataPath), install = parserRuntime(selection);
  if (!install) return { ...source, parserAvailable: false };
  const native = Native.resolveLocalRuntime({ runtimePath: install.executablePath, runtimeVersion: selection.version,
    upstreamRevision: install.upstreamRevision, expectedSha256: install.binarySha256 });
  const before = Native.hashFile(dataPath);
  const options = { timeout: 30000, maxBuffer: 2 * 1024 * 1024, ...(signal ? { signal } : {}) };
  const identity = (await execute(native.executablePath, ["--version"], options)).stdout.trim();
  // The adapted executable reports its upstream version, source revision and overlay.
  if (!new RegExp(`^OpenGMK \\S+ MacLauncher ${install.upstreamRevision} \\S+$`).test(identity))
    throw new Error("OpenGMK executable source/overlay identity does not match the selected Mac build.");
  let output;
  try { output = await execute(native.executablePath, [dataPath, "--strict", "--singlethread", "--inspect-json"], options); }
  catch (error) { throw new Error(`OpenGMK could not parse the original Classic assets: ${(error.stderr || error.message).trim().slice(-1200)}`); }
  if (Native.hashFile(dataPath) !== before) throw new Error("The original Classic executable changed during preflight.");
  let report;
  try { report = JSON.parse(output.stdout); } catch { throw new Error("OpenGMK returned an unreadable Classic asset report."); }
  const inspected = validateReport(report);
  if (inspected.version !== source.classicVersion) throw new Error("Classic runner and parsed game version disagree.");
  return { ...inspected, parserAvailable: true, sourceSha256: before };
}

module.exports = { manager, bundledRuntime, mapRelease, discoverCatalog,
  inspectSource, parserRuntime, validateReport, preflight };
