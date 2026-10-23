const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Native = require("./local-native");
const MachO = require("./macho-load-commands");
const { downloadToFile, fetchUrlBuffer, throwIfAborted } = require("./download-utils");
const { runDownloadTask } = require("./download-manager");
const { confirmToolInstall } = require("./tool-install");
const { withRuntimeMutation } = require("../../../core/coordinated-runtime-managers");
const { systemVersionSync, versionAtLeast } = require("./bundled-native");
const run = promisify(execFile), VERSION = /^\d+\.\d+\.\d+$/;
const SOURCE = "https://learn.microsoft.com/en-us/dotnet/core/install/macos";
const PIN = Object.freeze({ version: "10.0.12", architecture: "arm64", minimumMacOS: "14.0",
  url: "https://builds.dotnet.microsoft.com/dotnet/Runtime/10.0.12/dotnet-runtime-10.0.12-osx-arm64.tar.gz",
  sha512: "d1b422c2afecb5e741430584c3e1887d5e0f2df321a80d492fdd13d8c7f99579f0dbbf34e348bc512cb276f0f86b4645423a032ded52808b74ab8eb0d7bf2a6d" });
const PIN8 = Object.freeze({ version: "8.0.31", architecture: "arm64", minimumMacOS: "14.0",
  url: "https://builds.dotnet.microsoft.com/dotnet/Runtime/8.0.31/dotnet-runtime-8.0.31-osx-arm64.tar.gz",
  sha256: "278d93091093a5b9a8e5d8466bf31183fdc12a7af86c41afa2865f4e4c6c07eb" });
const safeRelative = name => typeof name === "string" && name && !name.includes("\\") && !/[\x00-\x1f]/.test(name) &&
  !path.posix.isAbsolute(name) && name.split("/").every(part => part && part !== "." && part !== "..");
const supported = framework => /^net(?:8|10)\.0$/.test(framework || "");
const matchingVersion = (framework, version) => supported(framework) && VERSION.test(version || "") && version.split(".").slice(0, 2).join(".") === framework.slice(3);
const minimumMacOS = framework => supported(framework) ? "14.0" : null;
const verified = new Map();
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
function validateNative(directory, pin, files, signal) {
  const required = ["dotnet", "host/fxr/" + pin.version + "/libhostfxr.dylib",
    "shared/Microsoft.NETCore.App/" + pin.version + "/libhostpolicy.dylib",
    "shared/Microsoft.NETCore.App/" + pin.version + "/libcoreclr.dylib",
    "shared/Microsoft.NETCore.App/" + pin.version + "/System.Private.CoreLib.dll"];
  if (required.some(name => !files[name])) throw new Error(".NET tool host is incomplete.");
  for (const relative of Object.keys(files).filter(name => name === "dotnet" || name.endsWith(".dylib"))) {
    const image = MachO.readMachOLoadCommands(path.join(directory, relative), { signal });
    if (image.architectures.length !== 1 || image.architectures[0] !== "arm64" ||
      image.slices.some(slice => slice.platform !== 1 || !slice.minimumMacOS || !versionAtLeast(pin.minimumMacOS, slice.minimumMacOS)))
      throw new Error(".NET tool host CPU or macOS requirement differs from its package.");
    for (const slice of image.slices) for (const dependency of slice.dependencies) {
      if (dependency.path.startsWith("/usr/lib/") || dependency.path.startsWith("/System/Library/")) continue;
      const match = /^@(loader_path|rpath)\/(.+)$/.exec(dependency.path);
      if (!match || !safeRelative(match[2])) throw new Error(".NET tool host has an external native dependency.");
      const target = path.posix.join(path.posix.dirname(relative), match[2]);
      if (!files[target]) throw new Error(".NET tool host native dependency is missing.");
    }
  }
}
function resolve({ userDataDir, framework, minimumVersion = framework?.replace(/^net/, "") + ".0", verification = "full" } = {}) {
  if (!matchingVersion(framework, minimumVersion)) return null;
  const directory = root(userDataDir), major = Number(framework.slice(3).split(".")[0]);
  let rows = []; try { rows = fs.readdirSync(directory, { withFileTypes: true }); } catch { return null; }
  for (const item of rows.filter(item => item.isDirectory() && VERSION.test(item.name)).slice(0, 128).sort((a,b) => b.name.localeCompare(a.name, undefined, { numeric: true }))) {
    if (Number(item.name.split(".")[0]) !== major || !matchingVersion(framework, item.name) || !versionAtLeast(item.name, minimumVersion)) continue;
    const target = path.join(directory, item.name, "arm64");
    try {
      const recordPath = path.join(target, "host.json"), stat = fs.lstatSync(recordPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) continue;
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8")), pin = item.name === PIN.version ? PIN : item.name === PIN8.version ? PIN8 : null;
      if (record.version !== item.name || record.architecture !== "arm64" ||
        !(/^[a-f0-9]{128}$/.test(record.archiveSha512 || "") || /^[a-f0-9]{64}$/.test(record.archiveSha256 || "")) ||
        (pin && (pin.sha512 ? record.archiveSha512 !== pin.sha512 : record.archiveSha256 !== pin.sha256)) ||
        !record.files || Object.keys(record.files).length > 2000 || !record.minimumMacOS ||
        !versionAtLeast(record.minimumMacOS, minimumMacOS(framework)) ||
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
      if (verification !== "status" && verified.get(target) !== identity) {
        for (const [relative, data] of Object.entries(record.files)) if (Native.hashFile(path.join(target, "files", relative)) !== data.sha256) throw new Error("Changed host");
        if (verified.size >= 64) verified.delete(verified.keys().next().value);
        verified.set(target, identity);
      }
      return { ready: true, version: record.version, install: { executablePath: path.join(target, "files", "dotnet"), installDir: target },
        profile: { root: path.join(target, "files"), dotnetVersion: record.version, minimumMacOS: record.minimumMacOS },
        runtimeIdentity: { managerId: "dotnet-tools", version: record.version, variant: "arm64", sourcePath: target }, record };
    } catch {}
  }
  return null;
}
async function selectPin({ framework, minimumVersion, signal }, dependencies = {}) {
  if (!matchingVersion(framework, minimumVersion)) throw new Error("No compatible managed .NET tool host is available for this framework.");
  if (framework === "net10.0" && versionAtLeast(PIN.version, minimumVersion)) return PIN;
  if (framework === "net8.0" && versionAtLeast(PIN8.version, minimumVersion)) return PIN8;
  const major = Number(framework.slice(3).split(".")[0]), url = "https://builds.dotnet.microsoft.com/dotnet/release-metadata/" + major + ".0/releases.json";
  const response = await (dependencies.request || fetchUrlBuffer)(url, { signal });
  throwIfAborted(signal);
  if (response.status !== 200 || response.body.length > 4 * 1024 * 1024) throw new Error(".NET tool host release metadata is unavailable.");
  const data = JSON.parse(response.body.toString("utf8"));
  if (!Array.isArray(data.releases) || data.releases.length > 300) throw new Error(".NET tool host release history is invalid.");
  for (const release of data.releases) {
    const version = release.runtime?.version;
    if (!matchingVersion(framework, version) || Number(version.split(".")[0]) !== major || !versionAtLeast(version, minimumVersion)) continue;
    const asset = release.runtime.files?.find(file => file.name === "dotnet-runtime-osx-arm64.tar.gz" && file.rid === "osx-arm64");
    if (!asset || asset.url !== "https://builds.dotnet.microsoft.com/dotnet/Runtime/" + version + "/dotnet-runtime-" + version + "-osx-arm64.tar.gz" ||
      !/^[a-f0-9]{128}$/.test(asset.hash || "")) continue;
    return { version, architecture: "arm64", minimumMacOS: "14.0", url: asset.url, sha512: asset.hash };
  }
  throw new Error("No compatible published .NET tool host version was found.");
}
async function ensure(context, requirement, dependencies = {}) {
  if (!matchingVersion(requirement.framework, requirement.minimumVersion)) throw new Error("No compatible managed .NET tool host is available for this framework.");
  const hostVersion = (dependencies.systemVersionSync || systemVersionSync)();
  if (process.arch !== "arm64" || !versionAtLeast(hostVersion, minimumMacOS(requirement.framework)))
    throw new Error("This .NET tool host requires Apple Silicon and macOS " + minimumMacOS(requirement.framework) + " or later.");
  const existing = resolve({ userDataDir: context.userDataDir, ...requirement }); if (existing) return existing;
  const pin = await selectPin({ ...requirement, signal: context.signal }, dependencies);
  return withRuntimeMutation({ managerId: "dotnet-tools", version: pin.version, variant: "arm64" }, async () => {
    const completed = resolve({ userDataDir: context.userDataDir, ...requirement }); if (completed) return completed;
    await confirmToolInstall(context, { managerId: "ilspy", label: ".NET tool host", version: pin.version, requiresDownload: true,
      detail: "Required for the selected ILSpy version." });
    return runDownloadTask(context.downloads, { managerId: "ilspy", sectionId: "decompiler", version: pin.version,
      label: ".NET " + pin.version, kind: "tool", dedupeKey: "dotnet-tool-host:" + context.userDataDir + ":" + pin.version }, async task => {
      const signal = task.signal && context.signal ? AbortSignal.any([task.signal, context.signal]) : task.signal || context.signal, parent = path.join(root(context.userDataDir), pin.version); fs.mkdirSync(parent, { recursive: true });
      const temporary = fs.mkdtempSync(path.join(parent, ".install-")), files = path.join(temporary, "files"), target = path.join(parent, "arm64");
      try {
        const archive = path.join(temporary, "runtime.tar.gz"); fs.mkdirSync(files);
        await (dependencies.downloadToFile || downloadToFile)(pin.url, archive, { signal, onProgress: task.onProgress });
        throwIfAborted(signal);
        if (fs.statSync(archive).size > 64 * 1024 * 1024 ||
          (pin.sha512 && require("./pinned-native-manager").hashFile(archive, "sha512") !== pin.sha512) ||
          (pin.sha256 && Native.hashFile(archive) !== pin.sha256))
          throw new Error(".NET tool host package checksum does not match its release.");
        const execute = dependencies.run || run, options = { signal, timeout: 30000, maxBuffer: 4 * 1024 * 1024 };
        if (dependencies.extractArchive) await dependencies.extractArchive(archive, files, signal);
        else {
          const listing = await execute("/usr/bin/tar", ["-tzf", archive], options);
          const entries = listing.stdout.trim().split("\n").map(name => name.replace(/^\.\//, "").replace(/\/$/, "")).filter(Boolean);
          if (entries.length > 3000 || entries.some(name => !safeRelative(name))) throw new Error(".NET tool host archive contains an unsafe path.");
          const types = await execute("/usr/bin/tar", ["-tvzf", archive], options);
          if (types.stdout.trim().split("\n").some(line => !/^[d-]/.test(line))) throw new Error(".NET tool host archive contains unsupported links.");
          await execute("/usr/bin/tar", ["-xzf", archive, "-C", files], options);
        }
        const records = inventory(files); validateNative(files, pin, records, signal);
        const result = await execute(path.join(files, "dotnet"), ["--list-runtimes"], { ...options, cwd: files,
          env: { ...process.env, DOTNET_ROOT: files, DOTNET_ROOT_ARM64: files, DOTNET_MULTILEVEL_LOOKUP: "0" } });
        if (!result.stdout?.includes("Microsoft.NETCore.App " + pin.version + " [")) throw new Error(".NET tool host reports a different runtime version.");
        fs.writeFileSync(path.join(temporary, "host.json"), JSON.stringify({ version: pin.version, architecture: pin.architecture,
          minimumMacOS: pin.minimumMacOS, sourceUrl: SOURCE, assetUrl: pin.url,
          ...(pin.sha512 ? { archiveSha512: pin.sha512 } : { archiveSha256: pin.sha256 }), files: records }, null, 2));
        fs.rmSync(archive); throwIfAborted(signal);
        if (fs.existsSync(target)) fs.renameSync(target, target + ".previous-" + Date.now());
        fs.renameSync(temporary, target);
        const installed = resolve({ userDataDir: context.userDataDir, ...requirement });
        if (!installed) throw new Error("Installed .NET tool host failed its integrity check.");
        return installed;
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    });
  }, { userDataDir: context.userDataDir });
}
module.exports = { PIN, PIN8, SOURCE, supported, matchingVersion, minimumMacOS, resolve, ensure, __test: { root, safeRelative, inventory, validateNative, selectPin } };

