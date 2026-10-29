const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process");
const {TEMPORARY_PROCESS_MAX_GRACE_MS: SHUTDOWN_GRACE_MS} = require("../../../../core/process-stop");
const Neural = require("./index"), Native = require("../../runtime/bundled-native");
const { withRuntimeUse } = require("../../../../core/coordinated-runtime-managers");
const warn = require("../../graphics-warning");
const MAX_LINE = 64 * 1024, MAX_STDERR = 64 * 1024;

function aborted() { const error = new Error("Video processing was cancelled."); error.name = "AbortError"; return error; }
function localFile(value, message) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(message);
  return value;
}

async function processVideo(options = {}) {
  const identity = options.userDataDir && Neural.modelIdentity(options.userDataDir, options.modelPath);
  return identity ? withRuntimeUse(identity, lease => runVideo({ ...options, lease }), { userDataDir: options.userDataDir }) : runVideo(options);
}
async function runVideo({ input, output, modelPath, signal, onProgress, onToolProcessSpawn, logger, root, lease, intensity = 1, temporal = true,
  codec = "h264", processingScale = 1, detailStrength = 1, colourStrength = 1, frameLimit, method="mlx-dlss",frameFactor=2,
  platform = process.platform, macOSVersion, graphicsArchitecture = process.arch } = {}) {
  if (signal?.aborted) throw aborted();
  root ||= require("../index").runtimeRoot();
  if (platform !== "darwin" || !Native.versionAtLeast(macOSVersion || Native.systemVersionSync(), "26.0"))
    throw new Error("Offline neural video processing requires macOS 26 or later.");
  input = fs.realpathSync(localFile(input, "Choose an existing input video."));
  if (!fs.statSync(input).isFile()) throw new Error("Choose an existing input video.");
  output = localFile(output, "Choose a new output video path.");
  output = path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
  if (input === output) throw new Error("Choose a new output file for processed video.");
  try { fs.lstatSync(output); throw new Error("The output video already exists."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (![".mp4", ".mov", ".m4v"].includes(path.extname(output).toLowerCase()))
    throw new Error("Processed video output must be MP4, MOV or M4V.");
  if (!["h264", "hevc", "prores"].includes(codec) || codec === "prores" && path.extname(output).toLowerCase() !== ".mov")
    throw new Error("Choose H.264, HEVC, or a MOV output for ProRes.");
  for (const [value, minimum, maximum] of [[processingScale, 1, 4], [detailStrength, 0, 8], [colourStrength, 0, 4]])
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)
      throw new Error("Choose supported neural video processing controls.");
  if (frameLimit !== undefined && (!Number.isSafeInteger(frameLimit) || frameLimit < 1))
    throw new Error("Choose a positive video frame count.");
  if(!Number.isInteger(frameFactor)||frameFactor<2||frameFactor>16)throw new Error("Choose a frame factor from 2 to 16.");
  const prepared = method==="mlx-dlss"?Neural.prepare({modelPath,intensity,temporal},{root,platform,macOSVersion,graphicsArchitecture,offlineVideo:true}):
    Neural.prepareMethod(method,{ modelPath, intensity, temporal }, { root, platform, macOSVersion, graphicsArchitecture, offlineVideo: true });
  const installed = Neural.resolve(root, { platform, macOSVersion, graphicsArchitecture });
  const name = "maclauncher-neural-video", executable = path.join(installed.directory, name);
  if (!installed.descriptor.files.some(row => row.path === name))
    throw new Error("The neural video processor is unavailable for this runtime.");
  fs.accessSync(executable, fs.constants.X_OK);
  const arguments_ = ["--input", input, "--output", output, "--model", prepared.settings.modelPath,
    "--intensity", String(intensity), "--temporal", temporal ? "on" : "off", "--codec", codec,
    "--processing-scale", String(processingScale), "--detail-strength", String(detailStrength),
    "--colour-strength", String(colourStrength)];
  if(method!=="mlx-dlss")arguments_.push("--method",method,"--frame-factor",String(frameFactor));
  if (frameLimit !== undefined) arguments_.push("--frames", String(frameLimit));
  if (signal?.aborted) throw aborted();

  return new Promise((resolve, reject) => {
    let child, stdout = "", stderr = "", result, failure, settled = false, cancelled = false, killTimer, ownership = Promise.resolve();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve(value);
    };
    const terminate = () => {
      child?.kill("SIGTERM");
      if (!killTimer) { killTimer = setTimeout(() => child?.kill("SIGKILL"), SHUTDOWN_GRACE_MS); killTimer.unref?.(); }
    };
    const cancel = () => { if (!result) { cancelled = true; terminate(); } };
    const line = text => {
      if (!text.trim()) return;
      let event;
      try { event = JSON.parse(text); } catch { failure = new Error("The neural video processor returned invalid progress."); terminate(); return; }
      if (!event || typeof event !== "object" || Array.isArray(event)) return;
      if (event.type === "progress") {
        if (![event.inputFrames, event.outputFrames, event.estimatedInputFrames].every(value => Number.isSafeInteger(value) && value >= 0) ||
          !Number.isFinite(event.fraction) || event.fraction < 0 || event.fraction > 1 ||
          !Number.isFinite(event.elapsedSeconds) || event.elapsedSeconds < 0) {
          failure = new Error("The neural video processor returned invalid progress."); terminate(); return;
        }
        if (onProgress) {
          const failed = error => warn(logger, "Video processing progress could not be reported.", error);
          try {
            const notification = onProgress({ type: "progress", inputFrames: event.inputFrames, outputFrames: event.outputFrames,
              estimatedInputFrames: event.estimatedInputFrames, fraction: event.fraction, elapsedSeconds: event.elapsedSeconds });
            if (notification && typeof notification.then === "function") Promise.resolve(notification).catch(failed);
          } catch (error) { failed(error); }
        }
      } else if (event.type === "complete") {
        if (typeof event.output !== "string" || path.resolve(event.output) !== output ||
          ![event.inputFrames, event.outputFrames, event.sceneResets].every(value => Number.isSafeInteger(value) && value >= 0) ||
          !Number.isFinite(event.elapsedSeconds) || event.elapsedSeconds < 0) {
          failure = new Error("The neural video processor returned an invalid result."); terminate(); return;
        }
        result = { output, inputFrames: event.inputFrames, outputFrames: event.outputFrames,
          sceneResets: event.sceneResets, elapsedSeconds: event.elapsedSeconds,
          motionBackend: typeof event.motionBackend === "string" ? event.motionBackend.slice(0, 64) : "" };
      } else if (event.type === "cancelled") cancelled = true;
      else if (event.type === "error") failure = new Error(typeof event.message === "string"
        ? event.message.slice(0, 4096) : "Neural video processing failed.");
    };
    const env = {...process.env};
    for (const key of Object.keys(env)) if (/^(DYLD_|RESHADE_|FSR4_)/.test(key)) delete env[key];
    try { child = spawn(executable, arguments_, { env, stdio: ["ignore", "pipe", "pipe"], shell: false }); }
    catch (error) { finish(error); return; }
    ownership = Promise.resolve().then(() => Promise.all([lease?.retainUntilClosed(child),
      onToolProcessSpawn?.(child, { stopOnLauncherExit: true, shutdownGraceMs: SHUTDOWN_GRACE_MS })])).catch(error => { failure = error; terminate(); });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf("\n")) !== -1) {
        if (newline > MAX_LINE) { failure = new Error("The neural video processor returned oversized progress."); terminate(); stdout = ""; return; }
        const next = stdout.slice(0, newline); stdout = stdout.slice(newline + 1); line(next);
      }
      if (stdout.length > MAX_LINE) { failure = new Error("The neural video processor returned oversized progress."); terminate(); stdout = ""; }
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-MAX_STDERR); });
    child.once("error", error => finish(error));
    child.once("close", async (code, exitSignal) => {
      await ownership;
      if (stdout.trim()) line(stdout);
      if (cancelled && !result) { finish(aborted()); return; }
      if (failure) { finish(failure); return; }
      if (code !== 0 || exitSignal || !result) {
        finish(new Error(stderr.trim().slice(-4096) || "Neural video processing did not complete.")); return;
      }
      try { if (!fs.statSync(output).isFile()) throw new Error("The processed video was not created."); }
      catch (error) { finish(error); return; }
      finish(null, result);
    });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

module.exports = { processVideo };
