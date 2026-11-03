const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Native = require("./local-native");
const { createVerifiedIdentityCache } = require("./verified-identity");
const Architecture = require("./architecture");
const MachO = require("./macho-load-commands");
const Upstream = require("./upstream");
const { throwIfAborted } = require("./download-utils");
const { runDownloadTask } = require("./download-manager");
const { confirmToolInstall } = require("./tool-install");
const { withRuntimeMutation } = require("../../../core/coordinated-runtime-managers");
const { systemVersionSync, versionAtLeast } = require("./bundled-native");
const run = promisify(execFile), VERSION = /^\d+\.\d+\.\d+$/;
const SOURCE = "https://learn.microsoft.com/en-us/dotnet/core/install/macos";
const safeRelative = name => typeof name === "string" && name && !name.includes("\\") && !/[\x00-\x1f]/.test(name) &&
  !path.posix.isAbsolute(name) && name.split("/").every(part => part && part !== "." && part !== "..");
// Any .NET 8 or later runtime is acquired from Microsoft's release metadata.
const supported = framework => Number(/^net(\d+)\.0$/.exec(framework || "")?.[1]) >= 8;
const matchingVersion = (framework, version) => supported(framework) && VERSION.test(version || "") && version.split(".").slice(0, 2).join(".") === framework.slice(3);
// A host's minimum macOS is read from its own binaries at installation and
// recorded with it; nothing fixes it in advance.
const verified = createVerifiedIdentityCache({ maximum: 64 });
function root(userDataDir) {
  if (!path.isAbsolute(userDataDir || "") || userDataDir.includes("\0")) throw new Error("A launcher data directory is required for the tool host.");
  return path.join(userDataDir, "runtimes", "dotnet-tools");
}
function inventory(directory) {
  const files = {}; let bytes = 0;
  function walk(dir, prefix = "", depth = 0) {
    if (depth > 10) throw new Error(".NET tool host nesting exceeds its limit.");
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? prefix + "/" + item.name : item.name, file = path.join(dir, item.name);
      if (!safeRelative(relative) || item.isSymbolicLink()) throw new Error(".NET tool host contains an unsafe path.");
      if (item.isDirectory()) walk(file, relative, depth + 1);
      else if (item.isFile()) {
        const stat = fs.statSync(file);
        if (Object.keys(files).length >= 2000 || stat.size > 128 * 1024 * 1024 || (bytes += stat.size) > 256 * 1024 * 1024) throw new Error(".NET tool host exceeds its size limit.");
        files[relative] = { sha256: Native.hashFile(file), size: stat.size, mode: stat.mode & 0o777 };
      }
    }
  }
  walk(directory); return files;
}
// Returns the package's macOS floor: the latest deployment target of its
// binaries.
function validateNative(directory, pin, files, signal) {
  const required = ["dotnet", "host/fxr/" + pin.version + "/libhostfxr.dylib",
    "shared/Microsoft.NETCore.App/" + pin.version + "/libhostpolicy.dylib",
    "shared/Microsoft.NETCore.App/" + pin.version + "/libcoreclr.dylib",
    "shared/Microsoft.NETCore.App/" + pin.version + "/System.Private.CoreLib.dll"];
  if (required.some(name => !files[name])) throw new Error(".NET tool host is incomplete.");
  let floor = "0";
  for (const relative of Object.keys(files).filter(name => name === "dotnet" || name.endsWith(".dylib"))) {
    const image = MachO.readMachOLoadCommands(path.join(directory, relative), { signal });
    if (!image.architectures.includes(pin.architecture === "x64" ? "x86_64" : pin.architecture) ||
      image.slices.some(slice => slice.platform !== 1 || !slice.minimumMacOS))
      throw new Error(".NET tool host CPU or macOS requirement differs from its package.");
    for (const slice of image.slices) if (!versionAtLeast(floor, slice.minimumMacOS)) floor = slice.minimumMacOS;
    for (const slice of image.slices) for (const dependency of slice.dependencies) {
      if (dependency.path.startsWith("/usr/lib/") || dependency.path.startsWith("/System/Library/")) continue;
      const match = /^@(loader_path|rpath)\/(.+)$/.exec(dependency.path);
      if (!match || !safeRelative(match[2])) throw new Error(".NET tool host has an external native dependency.");
      const target = path.posix.join(path.posix.dirname(relative), match[2]);
      if (!files[target]) throw new Error(".NET tool host native dependency is missing.");
    }
  }
  return floor;
}
function resolve({ userDataDir, framework, minimumVersion = framework?.replace(/^net/, "") + ".0", verification = "full", architecture = Architecture.selectedArchitecture() } = {}) {
  if (!["arm64", "x64"].includes(architecture) || !matchingVersion(framework, minimumVersion)) return null;
  const directory = root(userDataDir), major = Number(framework.slice(3).split(".")[0]);
  let rows = []; try { rows = fs.readdirSync(directory, { withFileTypes: true }); } catch { return null; }
  for (const item of rows.filter(item => item.isDirectory() && VERSION.test(item.name)).slice(0, 128).sort((a,b) => b.name.localeCompare(a.name, undefined, { numeric: true }))) {
    if (Number(item.name.split(".")[0]) !== major || !matchingVersion(framework, item.name) || !versionAtLeast(item.name, minimumVersion)) continue;
    const target = path.join(directory, item.name, architecture);
    try {
      const recordPath = path.join(target, "host.json"), stat = fs.lstatSync(recordPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) continue;
      // Each install records its archive digest and file inventory; earlier
      // installs may record SHA-256 instead of the publisher's SHA-512.
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      if (record.version !== item.name || record.architecture !== architecture ||
        !(/^[a-f0-9]{128}$/.test(record.archiveSha512 || "") || /^[a-f0-9]{64}$/.test(record.archiveSha256 || "")) ||
        !record.files || Object.keys(record.files).length > 2000 || !record.minimumMacOS ||
        !versionAtLeast(systemVersionSync(), record.minimumMacOS) ||
        ["dotnet", "host/fxr/" + item.name + "/libhostfxr.dylib", "shared/Microsoft.NETCore.App/" + item.name + "/libcoreclr.dylib"]
          .some(name => !record.files[name])) continue;
      const identities = [];
      for (const [relative, data] of Object.entries(record.files)) {
        if (!safeRelative(relative) || !/^[a-f0-9]{64}$/.test(data.sha256 || "") || !Number.isSafeInteger(data.size)) throw new Error("Changed host");
        const fileStat = fs.lstatSync(path.join(target, "files", relative));
        if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size !== data.size || (fileStat.mode & 0o777) !== data.mode) throw new Error("Changed host");
        identities.push([relative, fileStat.dev, fileStat.ino, fileStat.size, fileStat.mtimeMs, fileStat.ctimeMs]);
      }
      const identity = JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, identities]);
      if (verification !== "status") verified.verify(target, { identity: () => identity, verify: () => {
        for (const [relative, data] of Object.entries(record.files)) if (Native.hashFile(path.join(target, "files", relative)) !== data.sha256) throw new Error("Changed host");
        return true;
      } });
      return { ready: true, version: record.version, install: { executablePath: path.join(target, "files", "dotnet"), installDir: target },
        profile: { root: path.join(target, "files"), dotnetVersion: record.version, minimumMacOS: record.minimumMacOS },
        runtimeIdentity: { managerId: "dotnet-tools", version: record.version, variant: architecture, sourcePath: target }, record };
    } catch {}
  }
  return null;
}
// Microsoft's release metadata for a .NET major version lists each runtime's
// archives, wherever Microsoft hosts them, with their SHA-512 digests.
const sources = new Map();
function hostSource(major) {
  if (!sources.has(major)) sources.set(major, Upstream.index({ hosts: ["microsoft.com"],
    locations: [`https://builds.dotnet.microsoft.com/dotnet/release-metadata/${major}.0/releases.json`],
    parse: ([document]) => {
      const releases = JSON.parse(document.text)?.releases;
      return (Array.isArray(releases) ? releases : []).flatMap(release => {
        const version = release?.runtime?.version;
        if (!VERSION.test(version || "")) return [];
        const files = (Array.isArray(release.runtime.files) ? release.runtime.files : []).filter(file => /^osx-(?:arm64|x64)$/.test(file?.rid || "") &&
          /\.(?:tar\.gz|tgz|tar\.xz)$/i.test(file?.name || "") && /runtime/i.test(file.name) && !/aspnetcore|windowsdesktop|symbols/i.test(file.name));
        return files.length ? [{ version, publishedAt: release["release-date"], files: files.map(file => ({ name: file.name, url: file.url,
          architecture: file.rid.slice(4), ...(file.hash ? { digest: file.hash, algorithm: "sha512" } : {}) })) }] : [];
      });
    } }));
  return sources.get(major);
}
// The newest published runtime meeting the tool's requirement, as this CPU's
// archive. The current file name wins.
async function selectPin({ framework, minimumVersion, signal, architecture }, dependencies = {}) {
  architecture ||= dependencies.architecture || Architecture.selectedArchitecture();
  if (!["arm64", "x64"].includes(architecture)) throw new Error("No compatible .NET tool host is available for this CPU.");
  if (!matchingVersion(framework, minimumVersion)) throw new Error("No compatible managed .NET tool host is available for this framework.");
  const major = Number(framework.slice(3).split(".")[0]), source = hostSource(major);
  const candidates = (await source.discover({ signal })).flatMap(row => {
    if (!matchingVersion(framework, row.version) || !versionAtLeast(row.version, minimumVersion)) return [];
    const files = row.files.filter(file => file.architecture === architecture);
    const listed = files.find(file => file.name === `dotnet-runtime-${row.version}-osx-${architecture}.tar.gz`) || files[0];
    return listed ? [{ version: row.version, architecture, url: listed.url, listed,
      ...(listed.digest?.algorithm === "sha512" ? { sha512: listed.digest.value } : {}) }] : [];
  }).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  throwIfAborted(signal);
  if (!candidates.length) throw new Error("No compatible published .NET tool host version was found.");
  return { ...candidates[0], source };
}
async function ensure(context, requirement, dependencies = {}) {
  if (!matchingVersion(requirement.framework, requirement.minimumVersion)) throw new Error("No compatible managed .NET tool host is available for this framework.");
  const architecture = dependencies.architecture || Architecture.selectedArchitecture();
  const hostVersion = (dependencies.systemVersionSync || systemVersionSync)();
  if (!["arm64", "x64"].includes(architecture)) throw new Error("This .NET tool host requires an Intel or Apple Silicon Mac.");
  const existing = resolve({ userDataDir: context.userDataDir, ...requirement, architecture }); if (existing) return existing;
  return withRuntimeMutation({ managerId: "dotnet-tools", version: requirement.framework, variant: architecture }, async () => {
    const completed = resolve({ userDataDir: context.userDataDir, ...requirement, architecture }); if (completed) return completed;
    await confirmToolInstall(context, { managerId: "ilspy", label: ".NET tool host", version: null, requiresDownload: true,
      detail: "Required for the selected ILSpy version." });
    const pin = await selectPin({ ...requirement, signal: context.signal, architecture }, dependencies);
    return runDownloadTask(context.downloads, { managerId: "ilspy", sectionId: "decompiler", version: pin.version,
      label: ".NET " + pin.version, kind: "tool", dedupeKey: "dotnet-tool-host:" + context.userDataDir + ":" + pin.version + ":" + architecture }, async task => {
      const signal = task.signal && context.signal ? AbortSignal.any([task.signal, context.signal]) : task.signal || context.signal, parent = path.join(root(context.userDataDir), pin.version); fs.mkdirSync(parent, { recursive: true });
      const temporary = fs.mkdtempSync(path.join(parent, ".install-")), files = path.join(temporary, "files"), target = path.join(parent, architecture);
      try {
        const archive = path.join(temporary, "runtime.tar.gz"); fs.mkdirSync(files);
        const fetched = await pin.source.download(pin.listed, archive, { signal, onProgress: task.onProgress });
        throwIfAborted(signal);
        const execute = dependencies.run || run, options = { signal, timeout: 30000, maxBuffer: 4 * 1024 * 1024 };
        if (dependencies.extractArchive) await dependencies.extractArchive(archive, files, signal);
        else {
          const listing = await execute("/usr/bin/tar", ["-tf", archive], options);
          const entries = listing.stdout.trim().split("\n").map(name => name.replace(/^\.\//, "").replace(/\/$/, "")).filter(Boolean);
          if (entries.length > 3000 || entries.some(name => !safeRelative(name))) throw new Error(".NET tool host archive contains an unsafe path.");
          const types = await execute("/usr/bin/tar", ["-tvf", archive], options);
          if (types.stdout.trim().split("\n").some(line => !/^[d-]/.test(line))) throw new Error(".NET tool host archive contains unsupported links.");
          await execute("/usr/bin/tar", ["-xf", archive, "-C", files], options);
        }
        const records = inventory(files), floor = validateNative(files, pin, records, signal);
        if (!versionAtLeast(hostVersion, floor)) throw new Error(".NET " + pin.version + " requires macOS " + floor + " or later.");
        // The host must start; its runtime files were checked above.
        await execute(path.join(files, "dotnet"), ["--list-runtimes"], { ...options, cwd: files,
          env: { ...process.env, DOTNET_ROOT: files, [architecture === "arm64" ? "DOTNET_ROOT_ARM64" : "DOTNET_ROOT_X64"]: files, DOTNET_MULTILEVEL_LOOKUP: "0" } });
        fs.writeFileSync(path.join(temporary, "host.json"), JSON.stringify({ version: pin.version, architecture: pin.architecture,
          minimumMacOS: floor, sourceUrl: SOURCE, assetUrl: pin.url,
          ...(pin.sha512 ? { archiveSha512: pin.sha512 } : { archiveSha256: fetched.sha256 }), files: records }, null, 2));
        fs.rmSync(archive); throwIfAborted(signal);
        if (fs.existsSync(target)) fs.renameSync(target, target + ".previous-" + Date.now());
        fs.renameSync(temporary, target);
        const installed = resolve({ userDataDir: context.userDataDir, ...requirement, architecture });
        if (!installed) throw new Error("Installed .NET tool host failed its integrity check.");
        return installed;
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    });
  }, { userDataDir: context.userDataDir });
}
module.exports = { SOURCE, supported, matchingVersion, resolve, ensure, hostSource, __test: { root, safeRelative, inventory, validateNative, selectPin } };

