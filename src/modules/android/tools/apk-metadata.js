const fs = require("node:fs"), path = require("node:path");
const { spawn } = require("node:child_process");
const Bundled = require("../../shared/runtime/bundled-native");
const Included = require("../../shared/runtime/included-helpers");
const Sandbox = require("../../shared/runtime/macos-sandbox");

const MAX_REPLY = 1024 * 1024, MAX_ICON = 8 * 1024 * 1024;
const children = new Set();
function stopChildren() { for (const child of children) { try { child.kill("SIGKILL"); } catch {} } }
function retainChild(child) {
  if (!children.size) process.once("exit", stopChildren);
  children.add(child);
  child.once("close", () => {
    children.delete(child);
    if (!children.size) process.off("exit", stopChildren);
  });
}

function createReader({ declaration, resourceRoot, spawnProcess = spawn } = {}) {
  function definition() {
    const pin = declaration || JSON.parse(fs.readFileSync(path.join(__dirname, "../distribution-included.json"), "utf8"))
      .find(record => record.id === "android-apk-metadata");
    if (!pin) throw new Error("The included APK metadata reader is unavailable. Reinstall MacLauncher.");
    return pin;
  }
  function identity() {
    const pin = definition();
    return `${pin.version}:${pin.manifestSha256}`;
  }
  function resolve() {
    const pin = definition();
    const root = Included.resolveIncluded([pin], { id: pin.id, version: pin.version, resourcesRoot: resourceRoot })?.directory;
    if (!root) throw new Error("The included APK metadata reader is unavailable. Reinstall MacLauncher.");
    const metadata = Bundled.readRegular(path.join(root, pin.manifestRelative), Bundled.LIMITS.manifestBytes);
    if (metadata.sha256 !== pin.manifestSha256) throw new Error("The included APK metadata reader changed. Reinstall MacLauncher.");
    const manifest = JSON.parse(metadata.bytes), executableRelative = Bundled.relativeFile(manifest.executableRelative);
    const executable = pin.files.find(record => record.path === executableRelative);
    if (manifest.schemaVersion !== 1 || manifest.version !== pin.version || !executable?.architectures?.includes("arm64") || !(executable.mode & 0o111))
      throw new Error("The included APK metadata reader is invalid. Reinstall MacLauncher.");
    Bundled.verifyPayload(root, pin);
    return { root, executable: fs.realpathSync(path.join(root, executableRelative)), identity: identity() };
  }
  async function inspect({ sourceApks, locale, outputDirectory, context = {} }) {
    context.signal?.throwIfAborted();
    if (!Array.isArray(sourceApks) || !sourceApks.length || sourceApks.length > 1024)
      throw new Error("APK metadata requires a package or package set.");
    const tool = resolve(), output = await Sandbox.canonical(outputDirectory, "directory");
    const sources = await Promise.all(sourceApks.map(file => Sandbox.canonical(file, "file")));
    const profile = Sandbox.profile({ readDirectories: [], readFiles: sources,
      writeDirectories: [output], executables: [tool.executable], blockNetwork: true });
    const env = { ...Sandbox.environment(), HOME: output, CFFIXED_USER_HOME: output, TMPDIR: output + path.sep };
    const result = await new Promise((resolveResult, reject) => {
      const child = spawnProcess("/usr/bin/sandbox-exec", ["-p", profile, tool.executable],
        { cwd: output, env, stdio: ["pipe", "pipe", "pipe"] });
      retainChild(child);
      let stdout = "", stderr = "", failure, replyBytes = 0;
      const fail = error => { failure ||= error; child.kill("SIGKILL"); };
      const abort = () => fail(context.signal.reason || new DOMException("APK metadata read cancelled.", "AbortError"));
      const timer = setTimeout(() => fail(new Error("APK metadata read timed out.")), 30000);
      context.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", bytes => {
        replyBytes += Buffer.byteLength(bytes);
        if (replyBytes > MAX_REPLY) fail(new Error("APK metadata response exceeded its limit."));
        else stdout += bytes;
      });
      child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-65536); });
      child.stdin.on("error", fail);
      child.once("error", error => { failure ||= error; });
      child.once("close", (code, signal) => {
        clearTimeout(timer); context.signal?.removeEventListener("abort", abort);
        if (failure) return reject(failure);
        if (code !== 0) return reject(new Error("APK metadata extraction failed" + (signal ? ` (${signal})` : ` (${code})`) + ". " + stderr.trim()));
        try { resolveResult(JSON.parse(stdout)); } catch { reject(new Error("The APK metadata response is invalid.")); }
      });
      try { context.onToolProcessSpawn?.(child, { ownerName: "APK metadata", stopOnLauncherExit: true }); }
      catch (error) { fail(error); }
      if (context.signal?.aborted) abort();
      child.stdin.end(JSON.stringify({ sourceApks: sources, locale, outputDirectory: output }));
    });
    if (result.schemaVersion !== 1 || typeof result.packageName !== "string" ||
        result.label != null && typeof result.label !== "string" || !result.activityWindows || typeof result.activityWindows !== "object")
      throw new Error("The APK metadata response is invalid.");
    if (result.iconFile != null) {
      if (result.iconFile !== path.join(output, "icon.png")) throw new Error("The APK metadata icon is outside its output directory.");
      const image = Bundled.readRegular(result.iconFile, MAX_ICON);
      if (image.size < 24 || !image.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new Error("The APK metadata icon is invalid.");
    }
    return result;
  }
  return { identity, resolve, inspect };
}

module.exports = { ...createReader(), createReader };
