const fs = require("node:fs");
const path = require("node:path");
const { createManagedWindowsTool, windowsPath } = require("../shared/runtime/managed-windows-tool");
const Upstream = require("../shared/runtime/upstream");
const { readZipEntries, readZipEntryBuffer } = require("../shared/runtime/zip");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const { assertOwnDirectory } = require("../shared/writable-input");
const Native = require("../shared/runtime/local-native");
const Launch = require("./launch");
const { realLiveProfile } = require("./source-profile");

// The Go publisher supplies no license file. The original RLdev and KFN
// notices come from the newest RLdev 2026 release archive.
const noticeSource = Upstream.github({ repository: "yoremi-trad-fr/rldev-2026",
  recognize: release => {
    const asset = (release.assets || []).find(item => /\.zip$/i.test(item?.name || ""));
    return asset ? { version: release.tag_name, assets: [asset] } : null;
  } });
async function originalNotices({ unpacked, signal }) {
  const listed = (await noticeSource.discover({ signal })).find(row => row.files.length)?.files[0];
  if (!listed) throw new Error("The original RLdev notices are unavailable.");
  const archive = path.join(unpacked, ".notices.zip");
  try {
    const { sha256, integrity } = await noticeSource.download(listed, archive, { signal });
    const entries = readZipEntries(archive)?.entries || [];
    for (const name of ["COPYING", "GPL", "LGPL"]) {
      const item = entries.filter(entry => path.posix.basename(entry.name) === name).sort((a, b) => a.name.length - b.name.length)[0];
      const bytes = item && readZipEntryBuffer(archive, item.name);
      if (!bytes || bytes.length > 128 * 1024) throw new Error("An original RLdev license notice is missing.");
      fs.writeFileSync(path.join(unpacked, name), bytes);
    }
    const originalNotices = { url: listed.url, sha256, integrity };
    fs.writeFileSync(path.join(unpacked, "NOTICE-SOURCES.json"), JSON.stringify({ upstream: "https://github.com/yoremi-trad-fr/rldev2026-go-edition",
      originalNotices, scope: "Original RLdev and bundled KFN notices; the publisher provides no separate Go license file." }, null, 2) + "\n");
    return { originalNotices };
  } finally { fs.rmSync(archive, { force: true }); }
}
const manager = createManagedWindowsTool({ id: "rldev", label: "RLdev", owner: "yoremi-trad-fr", repo: "rldev2026-go-edition",
  executableName: "kprl16.exe", assetPattern: /^V[\d.]+-Windows\.7z$/i, files: ["reallive.kfn"], notices: originalNotices, order: 269 });

function diagnostics(log) {
  const failed = new Map();
  for (const line of log.split(/\r?\n/)) {
    const match = /^Warning: (SEEN\d{4}\.TXT): (.*)$/.exec(line);
    if (match && !match[2].startsWith("context ")) failed.set(match[1], match[2]);
  }
  return [...failed].map(([script, reason]) => ({ script, reason }));
}

async function decompile(entry, payload, context, info, inventory) {
  const profile = realLiveProfile(info);
  if (!profile) throw new Error("RealLive source recovery requires a recognized SEEN archive, interpreter version and any required game key.");
  const stat = fs.lstatSync(info.scenarioPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 ** 3) throw new Error("The RealLive archive must be a bounded regular file.");
  const tool = await manager.ensure(entry, payload, context), parent = path.join(Launch.moduleRoot(entry, context), "source");
  assertOwnDirectory(context.userDataDir, parent);
  const outputDir = fs.mkdtempSync(path.join(parent, "decompiled-")), logPath = path.join(outputDir, "decompile.log");
  const sourceSha256 = Native.hashFile(info.scenarioPath);
  await manager.run(entry, context, { moduleId: "siglus", install: tool, cwd: outputDir, logPath,
    args: ["-d", "-f", profile.version, ...(profile.gameId ? ["-G", profile.gameId] : []),
      "-kfn", windowsPath(path.join(tool.installDir, "reallive.kfn")), "-e", "UTF8", "-o", windowsPath(outputDir), windowsPath(info.scenarioPath)] });
  throwIfAborted(context.signal);
  if (Native.hashFile(info.scenarioPath) !== sourceSha256) throw new Error("The original RealLive archive changed during source recovery.");
  const failedScripts = diagnostics(fs.readFileSync(logPath, "utf8"));
  for (const { script } of failedScripts) {
    for (const extension of ["org", "utf"]) {
      const name = script.replace(/\.TXT$/, "." + extension), source = path.join(outputDir, name);
      if (fs.existsSync(source)) {
        fs.mkdirSync(path.join(outputDir, "partial"), { recursive: true });
        fs.renameSync(source, path.join(outputDir, "partial", name));
      }
    }
  }
  const files = inventory(outputDir), sourceFiles = files.filter(file => !file.path.startsWith("partial" + path.sep) && /\.org$/i.test(file.path));
  if (!sourceFiles.length) throw new Error(`RLdev produced no source exports. See ${logPath}.`);
  const result = { outputDir, representation: "reconstructed-reallive-source", scriptCount: sourceFiles.length,
    expectedScripts: info.scenarios, complete: failedScripts.length === 0 && sourceFiles.length === info.scenarios,
    failedFileCount: failedScripts.length, failedScripts, toolVersion: tool.version, toolArchiveSha256: tool.archiveSha256,
    profile, originalPath: info.scenarioPath, originalSha256: sourceSha256, files };
  fs.writeFileSync(path.join(outputDir, "export.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  entry.moduleData = { ...entry.moduleData, sourceExportDir: outputDir }; context.onEntryChange?.({ moduleData: entry.moduleData });
  context.ui?.shell?.showItemInFolder?.(outputDir); return result;
}

module.exports = { manager, decompile, realLiveProfile, __test: { diagnostics, originalNotices } };
