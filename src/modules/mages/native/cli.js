#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { parseArgs } = require("node:util");
const Adapter = require("./adapter");
const { buildAdapter } = require("./build");

async function main(argv = process.argv.slice(2)) {
  const [command, ...arguments_] = argv;
  const { values } = parseArgs({ args: arguments_, options: {
    "work-dir": { type: "string" }, "source-dir": { type: "string" }, "avcpp-source": { type: "string" },
    "atrac9-source": { type: "string" }, "magic-enum-source": { type: "string" }, "ffmpeg-archive": { type: "string" },
    "dependency-prefix": { type: "string" }, game: { type: "string" }, "runtime-root": { type: "string" },
    "session-dir": { type: "string" }, "diagnostic-frames": { type: "string" }, "diagnostic-confirm-frame": { type: "string" },
    "log-level": { type: "string" }, launch: { type: "boolean", default: false }
  } });
  const location = key => values[key] ? path.resolve(values[key]) : undefined;
  if (command === "build") {
    const result = await buildAdapter({ workDir: location("work-dir"), sourceDir: location("source-dir"), avcppSource: location("avcpp-source"),
      atrac9Source: location("atrac9-source"), magicEnumSource: location("magic-enum-source"), ffmpegArchive: location("ffmpeg-archive"), dependencyPrefix: location("dependency-prefix") });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command !== "session") throw new Error("Use build or session. No source or dependency downloads occur automatically.");
  const session = Adapter.prepareWindowsSession({ gamePath: location("game"), runtimeRoot: location("runtime-root"), sessionDir: location("session-dir"),
    ...(values["diagnostic-frames"] === undefined ? {} : { diagnosticFrames: Number(values["diagnostic-frames"]) }),
    ...(values["diagnostic-confirm-frame"] === undefined ? {} : { diagnosticConfirmFrame: Number(values["diagnostic-confirm-frame"]) }),
    ...(values["log-level"] === undefined ? {} : { logLevel: values["log-level"] }) });
  Adapter.writeOwnedFile(path.join(session.sessionDir, "session.json"), JSON.stringify(session, null, 2));
  if (!values.launch) { console.log(JSON.stringify(session, null, 2)); return; }
  const child = spawn(session.executable, session.args, { cwd: session.cwd, env: { ...process.env, ...session.env }, stdio: "inherit" });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { if (code === 0) resolve(); else reject(new Error(`Native Windows adapter exited (${signal || code}); see ${session.logPath}.`)); });
  });
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
