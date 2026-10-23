const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Java = require("../java/runtime/java-runtime-manager");
const Runtime = require("./runtime");
const { environment } = require("../shared/runtime/macos-sandbox");

function deviceId(value) {
  if (value == null || value === "") return "";
  if (typeof value !== "string" || Buffer.byteLength(value) > 2048 || value.length > 512 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error("The selected media device identity is invalid.");
  return value;
}

// Capture permission is a per-game decision; module/global defaults cannot
// silently grant access to a newly imported application.
function selections(entry) {
  const settings = entry?.runtimeSettings?.klepton || {};
  return { audioInput: deviceId(settings.audioInput), cameraInput: deviceId(settings.cameraInput) };
}

function snapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Local media devices are unavailable.");
  const result = {};
  for (const key of ["audioInputs", "cameraInputs"]) {
    const records = value[key];
    if (!Array.isArray(records) || records.length > 128) throw new Error("Too many local media devices.");
    const seen = new Set();
    result[key] = [{ value: "", label: "Off" }];
    for (const record of records) {
      const uid = deviceId(record?.uid);
      if (!uid || seen.has(uid) || typeof record?.name !== "string" || !record.name || record.name.length > 512 || /[\x00-\x1f\x7f]/.test(record.name))
        throw new Error("Local media device information is invalid.");
      seen.add(uid); result[key].push({ value: uid, label: record.name });
    }
  }
  return result;
}

async function listDevices(entry, payload, context, dependencies = {}) {
  const runtime = await (dependencies.resolve ? dependencies.resolve({ signal: context.signal }) : Runtime.resolveSelectedForLaunch(entry, context));
  if (runtime.profile?.mediaInputsVersion !== 1) throw new Error("This Android runtime does not support media input selection.");
  const manager = dependencies.java || Java;
  const settings = manager.normalizeSettings(context.settings?.runtimes?.java);
  const options = { userDataDir: context.userDataDir, line: 21, variant: "arm64", strictVariant: true, hostArch: "arm64" };
  const host = manager.core.java.resolveBestInstalled({ ...options, version: settings.lines[21].defaultVersion }) ||
    manager.core.java.resolveBestInstalled({ ...options, version: null });
  if (!host?.javaPath) throw new Error("Install Apple Silicon Java 21 in Runtimes to list media devices.");
  // This owned entry only enumerates device identities. It never requests
  // permission, opens a capture stream or loads application classes.
  const execute = dependencies.execute || promisify(execFile);
  const result = await execute(host.javaPath, ["-Djava.awt.headless=true", "-Dklepton.audio=" + path.join(runtime.root, "native/libklepton-audio.dylib"),
    "-cp", path.join(runtime.root, "android-host.jar"), "maclauncher.android.media.MediaInputs", "--list"], {
    env: environment(), timeout: 8000, maxBuffer: 64 * 1024, signal: context.signal,
  });
  return snapshot(JSON.parse(result.stdout));
}

async function launchSelection(entry, context, runtime, dependencies = {}) {
  const selected = selections(entry);
  if (!selected.audioInput && !selected.cameraInput) return selected;
  const choices = await listDevices(entry, null, context, { ...dependencies, resolve: async () => runtime });
  for (const [key, group] of [["audioInput", "audioInputs"], ["cameraInput", "cameraInputs"]])
    if (selected[key] && !choices[group].some(option => option.value === selected[key]))
      throw new Error("The selected " + (key === "audioInput" ? "audio input" : "OBS camera") + " is unavailable. Choose a device in this game's Settings.");
  const preferences = dependencies.systemPreferences || context.ui?.systemPreferences;
  for (const [key, kind] of [["audioInput", "microphone"], ["cameraInput", "camera"]]) {
    if (!selected[key]) continue;
    context.signal?.throwIfAborted();
    if (!preferences?.getMediaAccessStatus || !preferences?.askForMediaAccess)
      throw new Error("macOS media permission is unavailable in this launcher session.");
    const status = preferences.getMediaAccessStatus(kind);
    if (status !== "granted" && (status !== "not-determined" || !await preferences.askForMediaAccess(kind)))
      throw new Error("The selected " + kind + " requires permission in macOS Privacy & Security.");
  }
  return selected;
}

async function configureLaunch(config, entry, context, runtime, select = launchSelection) {
  const media = await select(entry, context, runtime);
  if (media.audioInput) config.audioInputUid = media.audioInput;
  if (media.cameraInput) config.cameraInputUid = media.cameraInput;
  return media;
}

module.exports = { deviceId, selections, snapshot, listDevices, launchSelection, configureLaunch };
