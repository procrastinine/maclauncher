const fs = require("node:fs");
const path = require("node:path");
const { createManagedWindowsTool, windowsPath } = require("../shared/runtime/managed-windows-tool");
const SevenZip = require("../shared/runtime/sevenzip");
const { readZipEntryBuffer } = require("../shared/runtime/zip");
const { downloadToFile, throwIfAborted } = require("../shared/runtime/download-utils");
const { runToolCommand } = require("../shared/runtime/tool-command");
const { assertOwnDirectory } = require("../shared/writable-input");
const Native = require("../shared/runtime/local-native");
const Launch = require("./launch");
const { realLiveProfile } = require("./source-profile");

const notices = { url: "https://github.com/yoremi-trad-fr/rldev-2026/releases/download/rldev2026/Rldev2026.2.zip",
  sha256: "a94eb906e013a9e68506e1cd0aef73fae42787fb8cc9aa791b7f2d26bbae5bc0" };
const members = ["V1.40-Windows/bin/kprl16.exe", "V1.40-Windows/KFN/reallive.kfn", "V1.40-Windows/README.md"];
const manager = createManagedWindowsTool({ id: "rldev", label: "RLdev", owner: "yoremi-trad-fr", repo: "rldev2026-go-edition",
  executableName: "kprl16.exe", assetPattern: /^V1\.40-Windows\.7z$/, versionFromTag: tag => tag === "rldev2026-go" ? "1.4.0" : "", order: 269,
  dependencies: { async extractArchive(archive, destination, signal) {
    throwIfAborted(signal);
    const sevenZip = SevenZip.resolveSevenZipBinary();
    if (!sevenZip) throw new Error("The included archive extractor is unavailable.");
    const work = path.join(destination, ".upstream"), noticeArchive = path.join(destination, ".notices.zip");
    fs.mkdirSync(work);
    try {
      await runToolCommand(sevenZip, ["x", "-y", "-o" + work, archive, ...members],
        { cwd: destination, logPath: path.join(destination, "install.log"), signal });
      for (const member of members) {
        const source = path.join(work, ...member.split("/")), stat = fs.lstatSync(source);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 ** 2) throw new Error("The RLdev package has an invalid production file.");
        fs.copyFileSync(source, path.join(destination, path.basename(member)));
      }
      // The publisher's Go package keeps the original KFN GPL declaration.
      // Retain the original RLdev notices without assigning new Go code a license.
      await downloadToFile(notices.url, noticeArchive, { signal });
      if (Native.hashFile(noticeArchive) !== notices.sha256) throw new Error("The original RLdev notice package changed.");
      for (const name of ["COPYING", "GPL", "LGPL"]) {
        const bytes = readZipEntryBuffer(noticeArchive, name);
        if (!bytes || bytes.length > 128 * 1024) throw new Error("An original RLdev license notice is missing.");
        fs.writeFileSync(path.join(destination, name), bytes);
      }
      fs.writeFileSync(path.join(destination, "NOTICE-SOURCES.json"), JSON.stringify({ upstream: "https://github.com/yoremi-trad-fr/rldev2026-go-edition",
        originalNotices: notices, scope: "Original RLdev and bundled KFN notices; the publisher provides no separate Go license file." }, null, 2) + "\n");
    } finally { fs.rmSync(work, { recursive: true, force: true }); fs.rmSync(noticeArchive, { force: true }); }
  } } });

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

module.exports = { manager, decompile, realLiveProfile, __test: { diagnostics } };
