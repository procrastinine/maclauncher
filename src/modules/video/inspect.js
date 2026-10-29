const fs = require("node:fs"), path = require("node:path");
const GameData = require("../shared/game-data");
const Manager = require("./runtime/manager");
const { confirmToolInstall } = require("../shared/runtime/tool-install");
const { runToolCommand } = require("../shared/runtime/tool-command");
const { withRuntimeUse } = require("../../core/coordinated-runtime-managers");
const { throwIfAborted } = require("../shared/runtime/download-utils");

async function inspectMedia(entry, _payload, context, dependencies = {}) {
  if (entry.moduleData?.playlist) entry = require("./playlist").playableEntry(entry, context);
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(context.userDataDir || "") ||
      !path.isAbsolute(entry.gamePath || "") || !fs.statSync(entry.gamePath).isFile()) throw new Error("Media inspection requires a video in the library.");
  const manager = dependencies.manager || Manager;
  let selected = manager.resolveForPlay(entry, context);
  if (!selected.ready) {
    await confirmToolInstall(context, { manager, version: selected.version, requiresDownload: true,
      detail: "Required to inspect the video's streams, codecs, chapters and metadata." });
    await manager.installRuntime({ ...context, version: selected.version });
    context.onRuntimeStateChange?.(); selected = manager.resolveForPlay(entry, context);
  }
  if (!selected.ready) throw new Error(selected.reason);
  const root = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "video"), "inspection");
  fs.mkdirSync(root, { recursive: true }); const temporary = fs.mkdtempSync(path.join(root, ".inspect-"));
  try {
    const script = path.join(temporary, "inspect-media.lua"), report = path.join(temporary, "media.json");
    fs.copyFileSync(path.join(__dirname, "resources", "inspect-media.lua"), script);
    await (dependencies.withRuntimeUse || withRuntimeUse)([{ managerId: manager.id, sectionId: "default", version: selected.version,
      sourcePath: selected.install.installDir }], async use => {
      await (dependencies.runCommand || runToolCommand)(selected.install.executablePath,
        ["--no-config", "--load-scripts=no", "--ytdl=no", "--sub-auto=no", "--audio-file-auto=no", "--cover-art-auto=no",
          "--access-references=no", "--demuxer-lavf-o=protocol_whitelist=file",
          "--force-window=no", "--vo=null", "--ao=null", "--pause=yes", "--script=" + script, "--", entry.gamePath],
        { cwd: temporary, logPath: path.join(root, "inspect.log"), signal: context.signal,
          env: { ...process.env, MACLAUNCHER_MEDIA_INFO: report },
          onSpawn: child => Promise.all([use.bind(child.pid), context.onToolProcessSpawn?.(child)]) });
    }, { userDataDir: context.userDataDir });
    throwIfAborted(context.signal);
    const info = JSON.parse(fs.readFileSync(report, "utf8"));
    if (!Array.isArray(info.tracks) || !info.tracks.length) throw new Error("No media streams were found. See " + path.join(root, "inspect.log") + ".");
    const output = path.join(root, "media.json"); fs.renameSync(report, output);
    const result = { output, toolVersion: selected.version, format: info.format, duration: info.duration, tracks: info.tracks.length };
    entry.moduleData = { ...entry.moduleData, mediaInspectionPath: output }; context.onEntryChange?.({ moduleData: entry.moduleData });
    return result;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
module.exports = { inspectMedia };
