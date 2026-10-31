const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createPinnedNativeManager, hashFile } = require("./pinned-native-manager");
const Upstream = require("./upstream");
const { readZipEntries, readZipEntry } = require("./zip");
const { readWindowsExecutable } = require("../../crossover/detect");
const Sikarugir = require("../../crossover/sikarugir/runtime/manager");
const CrossOver = require("../../crossover/runtime/manager");
const WineLaunch = require("../../crossover/sikarugir/launch");
const CrossLaunch = require("../../crossover/runtime/launch");
const GameData = require("../game-data");
const Writable = require("../writable-input");
const Rosetta = require("./rosetta");
const { environment: basicEnvironment } = require("./macos-sandbox");
const { confirmToolInstall } = require("./tool-install");
const { throwIfAborted } = require("./download-utils");
const SevenZip = require("./sevenzip");
const { runToolCommand } = require("./tool-command");
const { withRuntimeMutation, withRuntimeUse } = require("../../../core/coordinated-runtime-managers");

function inspectWindowsTool({ runtimePath, runtimeVersion, upstreamRevision, expectedSha256 }) {
  const stat = fs.lstatSync(runtimePath), info = stat.isFile() && !stat.isSymbolicLink() && readWindowsExecutable(runtimePath);
  if (!info || !["x86", "x86_64"].includes(info.executableArchitecture)) throw new Error("The tool package needs an x86 or x64 Windows executable.");
  const sha256 = hashFile(runtimePath);
  if (expectedSha256 && expectedSha256 !== sha256) throw new Error("The installed Windows tool changed. Reinstall its selected version.");
  return { executablePath: runtimePath, architectures: [info.executableArchitecture], needsRosetta: false,
    runtimeVersion, upstreamRevision, sha256 };
}
const safeRelative = name => typeof name === "string" && name && !name.includes("\\") && !/[\x00-\x1f]/.test(name) &&
  !path.posix.isAbsolute(name) && name.split("/").every(part => part && part !== "." && part !== "..");
function windowsPath(file) {
  if (!path.isAbsolute(file || "") || /[\\:<>"|?*\0\r\n]/.test(file)) throw new Error("Windows tool paths must be absolute paths without Windows filename separators.");
  return "Z:" + file.replaceAll("/", "\\");
}

async function ensureWine(entry, context, dependencies = {}) {
  const sikarugir = dependencies.sikarugir || Sikarugir, crossover = dependencies.crossover || CrossOver;
  let selection = sikarugir.resolveSelection(entry, context.settings, context.userDataDir);
  if (selection.ready) return { ...selection, manager: sikarugir, kind: "sikarugir" };
  const local = crossover.resolveSelection(entry, context.settings, context.userDataDir, {});
  if (local.ready) return { ...local, manager: crossover, kind: "crossover" };
  await confirmToolInstall(context, { manager: sikarugir, version: selection.version, requiresDownload: true,
    detail: "Required to run the Windows inspection tool in a private environment." });
  selection = await sikarugir.resolveForPlay(entry, context);
  const install = await withRuntimeMutation({ managerId: sikarugir.id, version: selection.version },
    () => sikarugir.installRuntime({ ...context, version: selection.version }), { userDataDir: context.userDataDir });
  context.onRuntimeStateChange?.();
  return { version: install.version, install, manager: sikarugir, kind: "sikarugir" };
}

async function runWindowsTool(manager, entry, context, { moduleId, install, args, cwd, logPath, stdoutPath, timeout = 300000 }, dependencies = {}) {
  if (!/^[a-z0-9-]+$/.test(moduleId || "") || !/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") ||
    !path.isAbsolute(context.userDataDir || "") || !path.isAbsolute(cwd || "") || !path.isAbsolute(logPath || "") ||
    !Array.isArray(args) || args.some(value => typeof value !== "string" || /[\0\r\n]/.test(value))) throw new Error("Windows tool execution requires valid game, arguments and output paths.");
  const host = await (dependencies.ensureWine || ensureWine)(entry, context);
  if (host.install.needsRosetta) await (context.ensureRosetta ? context.ensureRosetta() : Rosetta.ensure(context));
  const directory = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, moduleId), "windows-tools", manager.id);
  Writable.assertOwnDirectory(context.userDataDir, directory);
  for (const name of ["home", "tmp", "prefixes"]) fs.mkdirSync(path.join(directory, name), { recursive: true });
  const identity = crypto.createHash("sha256").update(host.manager.id + ":" + host.version).digest("hex").slice(0, 20);
  const prefix = path.join(directory, "prefixes", identity);
  const identities = [{ managerId: manager.id, version: install.version, sourcePath: install.installDir },
    { managerId: host.manager.id, version: host.version, sourcePath: host.install.installDir }];
  return (dependencies.withRuntimeUse || withRuntimeUse)(identities, async use => {
    throwIfAborted(context.signal);
    const current = manager.resolveSelection(entry, context.settings, context.userDataDir, { version: install.version });
    if (!current.ready || current.install.binarySha256 !== install.binarySha256) throw new Error("The Windows tool changed before execution. Try again.");
    const settings = { windowsVersion: "win10", synchronization: "off" };
    const environment = source => ({ ...basicEnvironment(), ...Object.fromEntries(Object.entries(source)
      .filter(([key]) => /^(?:CX_|WINE|DYLD_|GST_|SikarugirAppWine)/.test(key) || key === "PATH")),
      HOME: path.join(directory, "home"), TMPDIR: path.join(directory, "tmp"), USER: "maclauncher", LOGNAME: "maclauncher" });
    const run = (command, serverPath, parameters, options = {}) => {
      const env = environment(options.env || {});
      return (dependencies.runCommand || runToolCommand)("/bin/sh", WineLaunch.supervisorArguments(command, serverPath, "prepare", parameters, env), {
        cwd: options.cwd || directory, env, logPath, signal: context.signal, timeout: options.timeout || timeout,
        onSpawn: child => Promise.all([use.bind(child.pid), context.onToolProcessSpawn?.(child)]) });
    };
    let env;
    if (host.kind === "crossover") {
      await CrossLaunch.ensureBottle(host.install, prefix, directory, settings, context,
        { run: (command, parameters, options) => run(command, host.install.serverPath, parameters, options) });
      env = CrossLaunch.buildEnvironment(settings, host.install, directory, prefix, { baseEnvironment: basicEnvironment() }).environment;
    } else {
      const runtime = WineLaunch.prefixRuntime(host.install, directory);
      await WineLaunch.ensurePrefix(host.install, prefix, directory, settings, runtime, context, { run });
      env = WineLaunch.buildEnvironment(settings, host.install, directory, prefix, runtime, { baseEnvironment: basicEnvironment() }).environment;
    }
    CrossLaunch.detachProfileAliases(prefix);
    let script;
    try {
      let parameters = [windowsPath(install.executablePath), ...args];
      if (stdoutPath) {
        const relative = path.relative(cwd, stdoutPath);
        if (!path.isAbsolute(stdoutPath) || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
          throw new Error("Tool text output must stay in its export directory.");
        if (fs.existsSync(stdoutPath) && fs.lstatSync(stdoutPath).isSymbolicLink()) throw new Error("Tool text output cannot be an alias.");
        const quoted = value => {
          if (/["\0\r\n]/.test(value)) throw new Error("Tool text output arguments cannot contain quotes or line breaks.");
          return '"' + value.replaceAll("%", "%%") + '"';
        };
        const command = parameters.map(quoted).join(" ") + " > " + quoted(windowsPath(stdoutPath));
        if (command.length > 8190) throw new Error("The Windows tool command exceeds the text export command limit.");
        script = path.join(directory, ".export-" + crypto.randomUUID() + ".cmd");
        fs.writeFileSync(script, "@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\n" + command + "\r\nexit /b %errorlevel%\r\n");
        parameters = ["cmd.exe", "/d", "/c", windowsPath(script)];
      }
      await run(host.install.executablePath, host.install.serverPath, parameters, { cwd, env, timeout });
    } finally { if (script) fs.rmSync(script, { force: true }); }
    return { host: host.manager.id, hostVersion: host.version, prefixPath: prefix };
  }, { userDataDir: context.userDataDir });
}

// Release files a Windows tool can use: its executable or an archive holding
// it. Other systems, CPUs Wine cannot run, installers and symbols stay out.
const TOOL_FILES = /\.(?:exe|zip|7z)$/i;
const OTHER_FILES = /(?:^|[^a-z0-9])(?:mac|macos|macosx|osx|darwin|apple|linux|android|ios|freebsd|arm64|aarch64|armhf|armv7|riscv64|debug|symbols|dbg|pdb|src|source|sources|setup|installer|gui)(?=[^a-z]|$)/i;
const WINDOWS_WORD = /(?:^|[^a-z0-9])(?:windows|win|win32|win64)(?=[^a-z]|$)/i, X64_WORD = /(?:^|[^a-z0-9])(?:x64|x86_64|amd64|win64)(?=[^a-z0-9]|$)/i;
const compact = value => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// The publisher's current file name wins, then a file named after the tool,
// then any Windows file; a 64-bit build and a bare executable rank first.
function windowsAssets(assets, { assetPattern, executableName }) {
  const stem = compact(path.basename(executableName, path.extname(executableName)));
  const score = name => (assetPattern.test(name) ? 0 : compact(name).includes(stem) ? 4 : 8) + (X64_WORD.test(name) ? 0 : 2) + (/\.exe$/i.test(name) ? 0 : 1);
  return (Array.isArray(assets) ? assets : []).filter(asset => {
    const name = String(asset?.name || "");
    return assetPattern.test(name) || TOOL_FILES.test(name) && !OTHER_FILES.test(name) && (compact(name).includes(stem) || WINDOWS_WORD.test(name));
  }).sort((a, b) => score(a.name) - score(b.name) || a.name.length - b.name.length);
}
// A tag names the version; a tag without one leaves it to the file name.
function releaseVersion(tag, asset) {
  const named = String(tag || "").replace(/^v(?=\d)/, "");
  if (/^\d/.test(named)) return named;
  return /\d+(?:\.\d+)+/.exec(named)?.[0] || /\d+(?:\.\d+)+/.exec(asset?.name || "")?.[0] || "";
}
// Several copies of one file: a 64-bit folder, then the shallowest path.
function preferredEntry(entries, basename) {
  return entries.filter(item => path.posix.basename(item.name).toLowerCase() === basename.toLowerCase() && !item.name.split("/").includes("__MACOSX"))
    .sort((a, b) => Number(!X64_WORD.test(a.name)) - Number(!X64_WORD.test(b.name)) || a.name.split("/").length - b.name.split("/").length)[0];
}

function createManagedWindowsTool({ id, label, owner, repo, executableName, assetPattern, files = [], notices, versionFromTag = releaseVersion, order = 260, dependencies = {} }) {
  if (!/^[A-Za-z0-9_.-]+\.exe$/i.test(executableName || "") || !(assetPattern instanceof RegExp) ||
    !files.every(name => /^[A-Za-z0-9_.-]+$/.test(name))) throw new Error("A Windows tool needs an executable and upstream artifact pattern.");
  // Each release's best Windows file; its tag or file name gives the version.
  const recognize = release => {
    const [asset] = windowsAssets(release.assets, { assetPattern, executableName });
    const version = asset && versionFromTag(String(release.tag_name || ""), asset);
    return asset && /^[0-9][0-9A-Za-z._-]{0,79}$/.test(version || "") ? { version, assets: [asset] } : null;
  };
  const repository = `${owner}/${repo}`, upstream = Upstream.github({ repository, recognize });
  // The executable and named companion files are found anywhere in the
  // archive, so a publisher may move them into folders.
  async function extractArchive(archive, unpacked, signal) {
    throwIfAborted(signal);
    const target = path.join(unpacked, executableName);
    if (/\.exe$/i.test(archive) && !files.length) fs.copyFileSync(archive, target);
    else if (/\.exe$/i.test(archive)) throw new Error(`${label} needs its archive with companion files.`);
    else {
      const work = path.join(unpacked, ".upstream");
      try {
        let entries;
        if (/\.zip$/i.test(archive)) {
          entries = readZipEntries(archive)?.entries?.filter(item => !item.name.endsWith("/"))
            .map(item => ({ name: item.name, read: limit => readZipEntry(archive, item, { maxOutputBytes: limit }) }));
        } else {
          const sevenZip = SevenZip.resolveSevenZipBinary(), listed = sevenZip && SevenZip.listArchiveEntriesSync(archive, sevenZip);
          if (!listed || listed.length > 4096 || listed.some(item => item.isLink || !safeRelative(item.path))) throw new Error(`${label} archive inventory is invalid.`);
          fs.mkdirSync(work);
          await runToolCommand(sevenZip, ["x", "-y", "-o" + work, archive], { cwd: unpacked, logPath: path.join(work, ".extract.log"), signal });
          entries = listed.filter(item => !item.isDirectory).map(item => ({ name: item.path, read: limit => {
            const file = path.join(work, ...item.path.split("/")), stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.size > limit) throw new Error(`${label} archive contains an invalid file.`);
            return fs.readFileSync(file);
          } }));
        }
        if (!entries?.length || entries.length > 4096) throw new Error(`${label} archive inventory is invalid.`);
        for (const name of [executableName, ...files]) {
          const item = preferredEntry(entries, name);
          if (!item) throw new Error(`${label} archive does not contain ${name}.`);
          fs.writeFileSync(path.join(unpacked, name), item.read(128 * 1024 ** 2));
        }
        for (const item of entries.filter(item => /(?:^|\/)(?:LICENSE|COPYING|COPYRIGHT)(?:[^/]*)$/i.test(item.name)).slice(0, 16)) {
          const name = path.posix.basename(item.name);
          if (/^[A-Za-z0-9_. ()-]+$/.test(name)) fs.writeFileSync(path.join(unpacked, name), item.read(1024 * 1024));
        }
      } finally { fs.rmSync(work, { recursive: true, force: true }); }
    }
    inspectWindowsTool({ runtimePath: target });
  }
  const core = createPinnedNativeManager({ id, label, supportsDefault: true,
    sourceUrl: `https://github.com/${repository}/releases`, upstream,
    resolveExecutable: root => path.join(root, executableName), inspectRuntime: inspectWindowsTool,
    prepareInstall: async ({ unpacked, pin, signal }) => {
      if (notices) return notices({ unpacked, pin, signal });
      if (!fs.readdirSync(unpacked).some(name => /^(?:LICENSE|COPYING|COPYRIGHT)(?:[^/]*)$/i.test(name)))
        await Upstream.githubLicense({ repository, revision: pin.upstreamRevision, destination: path.join(unpacked, "LICENSE"), signal });
    },
    dependencies: { ...dependencies, extractArchive: dependencies.extractArchive || extractArchive } });
  const manager = { ...core,
    ui: { groupId: "tools", tabLabel: "Tools", sectionLabel: label, order: 200, memberOrder: order, management: "managed" },
    async ensure(entry, payload, context) {
      const explicit = payload?.toolVersion || entry.runtimeData?.[id]?.version || context.settings?.runtimes?.[id]?.defaultVersion;
      let selected = core.resolveSelection(entry, context.settings, context.userDataDir, { version: payload?.toolVersion });
      if (selected.ready) return selected.install;
      await confirmToolInstall(context, { manager, version: selected.version || "latest", requiresDownload: true, detail: `Required for ${label} inspection.` });
      if (!explicit && !core.getState({ userDataDir: context.userDataDir }).catalog.installableVersions.includes(selected.version)) {
        await core.refreshCatalog({ ...context, force: true, latestOnly: true });
        selected = core.resolveSelection(entry, context.settings, context.userDataDir);
      }
      if (!selected.version) throw new Error(`No compatible upstream ${label} download is available.`);
      const installed = await core.installRuntime({ ...context, version: selected.version });
      context.onRuntimeStateChange?.(); return installed;
    },
    run: (entry, context, options) => runWindowsTool(manager, entry, context, options, dependencies),
    __test: { recognize, extractArchive, windowsAssets, releaseVersion }
  };
  return manager;
}
module.exports = { createManagedWindowsTool, windowsPath, runWindowsTool, ensureWine, inspectWindowsTool };
