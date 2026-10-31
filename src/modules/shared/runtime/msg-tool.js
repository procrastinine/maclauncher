const fs = require("node:fs");
const path = require("node:path");
const { createPinnedNativeManager } = require("./pinned-native-manager");
const Upstream = require("./upstream");
const { macDownloads, locatePackaged } = require("./release-files");
const { throwIfAborted } = require("./download-utils");
const { confirmToolInstall } = require("./tool-install");
const { runToolCommand } = require("./tool-command");
const { withRuntimeUse } = require("../../../core/coordinated-runtime-managers");
const { assertOwnDirectory } = require("../writable-input");
const Native = require("./local-native");
const Rosetta = require("./rosetta");
const GameData = require("../game-data");

// Releases from 0.3.1 list every published Mac CPU; the shared manager picks
// one and reads the macOS floor from the installed executable.
const source = Upstream.github({ repository: "lifegpc/msg-tool", allArchitectures: true,
  recognize: release => {
    const version = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name || "")?.[1];
    if (!version || version.localeCompare("0.3.1", "en", { numeric: true }) < 0) return null;
    const current = ["aarch64", "x86_64"].map(cpu => `msg_tool-v${version}-${cpu}-apple-darwin.zip`);
    const downloads = macDownloads((release.assets || []).filter(asset => /msg[-_]?tool/i.test(asset?.name || "")), { preferred: current });
    return downloads.length ? downloads.map(({ asset, architecture }) => ({ version, architecture, assets: [asset] }))
      : { version, installReason: "This release has no macOS download." };
  } });

// The publisher may move the executable into a folder of its archive.
const executable = root => locatePackaged(root, "msg_tool") || path.join(root, "msg_tool");
const base = createPinnedNativeManager({ id: "msg-tool", label: "msg-tool", supportsDefault: true,
  sourceUrl: "https://github.com/lifegpc/msg-tool/releases", upstream: source, resolveExecutable: executable,
  prepareInstall: async ({ unpacked, pin, signal }) => {
    if (fs.existsSync(executable(unpacked))) fs.chmodSync(executable(unpacked), 0o755);
    return Upstream.githubLicense({ repository: "lifegpc/msg-tool", revision: pin.upstreamRevision, destination: path.join(unpacked, "LICENSE"), signal, label: "msg-tool" });
  } });

async function ensure(entry, payload, context) {
  let selected = base.resolveSelection(entry, context.settings, context.userDataDir, { version: payload?.toolVersion });
  if (selected.ready) return selected.install;
  const explicit = payload?.toolVersion || entry.runtimeData?.[base.id]?.version || context.settings?.runtimes?.[base.id]?.defaultVersion;
  if (!selected.version || !explicit && !base.getState({ userDataDir: context.userDataDir }).catalog.installableVersions.includes(selected.version)) {
    await base.refreshCatalog({ ...context, force: true });
    selected = base.resolveSelection(entry, context.settings, context.userDataDir, { version: payload?.toolVersion });
  }
  if (!selected.version) throw new Error("No compatible msg-tool download is available.");
  await confirmToolInstall(context, { manager: base, version: selected.version, requiresDownload: true });
  const installed = await base.installRuntime({ ...context, version: selected.version });
  context.onRuntimeStateChange?.(); return installed;
}

async function run(entry, context, { moduleId, install, args, cwd, logPath }) {
  if (!install?.version || !/^[a-z0-9-]+$/.test(moduleId || "")) throw new Error("msg-tool needs a selected installation and game module.");
  const privateRoot = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, moduleId), "tools", "msg-tool");
  assertOwnDirectory(context.userDataDir, privateRoot);
  await Rosetta.ensureForExecutable(install.executablePath, context);
  return withRuntimeUse({ managerId: base.id, sectionId: "default", version: install.version, sourcePath: install.installDir }, async use => {
    if (!base.core.resolveInstalled({ userDataDir: context.userDataDir, version: install.version })) throw new Error("msg-tool changed before execution.");
    await runToolCommand(install.executablePath, args, { cwd, logPath, signal: context.signal,
      env: { ...process.env, XDG_CACHE_HOME: path.join(privateRoot, "cache"), XDG_CONFIG_HOME: path.join(privateRoot, "config") },
      onSpawn: child => Promise.all([use.bind(child.pid), context.onToolProcessSpawn?.(child)]) });
  }, { userDataDir: context.userDataDir });
}

function outputFiles(directory) {
  const files = []; let bytes = 0;
  function walk(root, depth = 0) {
    if (depth > 16) throw new Error("Text export directory nesting exceeds its limit.");
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, item.name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("Text export cannot contain aliases.");
      if (stat.isDirectory()) walk(file, depth + 1);
      else if (stat.isFile()) {
        if (files.length >= 100000 || (bytes += stat.size) > 512 * 1024 ** 2) throw new Error("Text export exceeds its size limit.");
        files.push({ path: path.relative(directory, file), bytes: stat.size, sha256: Native.hashFile(file) });
      } else throw new Error("Text export contains an unsupported file.");
    }
  }
  walk(directory); return files;
}

async function exportText(entry, payload, context, { moduleId, inputs, scriptType, encoding, allowPartial = false }) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 1024) throw new Error("Text export needs supported script inputs.");
  const originals = inputs.map(file => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024 ** 2) throw new Error("Text export inputs must be bounded regular files.");
    return { path: file, sha256: Native.hashFile(file) };
  });
  const tool = await ensure(entry, payload, context), parent = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, moduleId), "text-exports");
  assertOwnDirectory(context.userDataDir, parent);
  const outputDir = fs.mkdtempSync(path.join(parent, "export-")), logPath = path.join(outputDir, "export.log");
  const failedFiles = [];
  for (const [index, input] of inputs.entries()) {
    throwIfAborted(context.signal);
    const output = path.join(outputDir, String(index + 1).padStart(4, "0") + "-" + path.basename(input) + ".json");
    try {
      await run(entry, context, { moduleId, install: tool, cwd: outputDir, logPath,
        args: ["export", "-x", "1", "-X", "2", "-t", typeof scriptType === "function" ? scriptType(input) : scriptType,
          "-T", "json", "-E", "utf8", ...(encoding ? ["-e", encoding] : []), input, output] });
    } catch (error) {
      if (!allowPartial || ![1, 2].includes(error.exitCode)) throw error;
      throwIfAborted(context.signal);
      failedFiles.push({ path: input, reason: error.message }); fs.rmSync(output, { force: true });
    }
  }
  for (const original of originals) if (Native.hashFile(original.path) !== original.sha256) throw new Error("An original script changed during text export.");
  const files = outputFiles(outputDir), json = files.filter(file => /\.json$/i.test(file.path));
  if (!json.length) throw new Error(`msg-tool produced no text exports. See ${logPath}.`);
  let messageCount = 0;
  for (const item of json) {
    const value = JSON.parse(fs.readFileSync(path.join(outputDir, item.path), "utf8"));
    if (Array.isArray(value)) messageCount += value.length;
  }
  const result = { outputDir, messageCount, fileCount: json.length, toolVersion: tool.version,
    representation: "readable-messages", originalFiles: originals, toolArchiveSha256: tool.archiveSha256, files,
    complete: failedFiles.length === 0, failedFileCount: failedFiles.length, failedFiles };
  fs.writeFileSync(path.join(outputDir, "export.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  context.ui?.shell?.showItemInFolder?.(outputDir); return result;
}

module.exports = { ...base,
  ui: { groupId: "tools", tabLabel: "Tools", sectionLabel: "msg-tool", order: 200, memberOrder: 267, management: "managed" },
  ensure, run, exportText, outputFiles, resolveExecutable: executable };
