const fs = require("node:fs");
const path = require("node:path");
const {execFile} = require("node:child_process");
const {promisify} = require("node:util");
const {bindProcessStop, processStopBinding} = require("../../../core/process-lifecycle");
const {forceStopProcessTree} = require("../../../core/process-stop");
const execute = promisify(execFile);

// AppKit Quit is independent of activation, Accessibility and screen capture.
// The kernel birth token also covers direct spawns, whose launchDate may be nil.
function nativeAppScript({pid, identity, birth, operation}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !["identify", "quit", "check"].includes(operation))
    throw new TypeError("An owned native application identity is required.");
  return `(function () {
ObjC.import("Foundation");
ObjC.bindFunction("dlopen", ["void *", ["char *", "int"]]);
$.dlopen("/usr/lib/libproc.dylib", 1);
ObjC.bindFunction("proc_pidinfo", ["int", ["int", "int", "unsigned long long", "void *", "int"]]);
// Public 64-bit proc_bsdinfo: 136 bytes, with start seconds/useconds at 120.
const info = $.NSMutableData.dataWithLength(136);
if ($.proc_pidinfo(${pid}, 3, 0, info.mutableBytes, 136) !== 136)
  return JSON.stringify({state:"process-unavailable"});
const actualBirth = ObjC.unwrap(info.subdataWithRange($.NSMakeRange(120, 16)).base64EncodedStringWithOptions(0));
if (${JSON.stringify(operation)} === "identify") return JSON.stringify({state:"identified",birth:actualBirth});
if (actualBirth !== ${JSON.stringify(birth || "")}) return JSON.stringify({state:"identity-changed"});
ObjC.import("AppKit");
const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});
if (!app || app.isNil()) return JSON.stringify({state:"unregistered"});
if (app.terminated) return JSON.stringify({state:"not-running"});
if (!app.executableURL || app.executableURL.isNil()) return JSON.stringify({state:"unregistered"});
const executable = ObjC.unwrap(app.executableURL.URLByResolvingSymlinksInPath.path);
const attributes = $.NSFileManager.defaultManager.attributesOfItemAtPathError(executable, null);
if (!attributes || attributes.isNil() ||
    ObjC.unwrap(attributes.objectForKey($.NSFileSystemNumber).stringValue) !== ${JSON.stringify(identity.device)} ||
    ObjC.unwrap(attributes.objectForKey($.NSFileSystemFileNumber).stringValue) !== ${JSON.stringify(identity.inode)})
  return JSON.stringify({state:"identity-changed"});
if (${JSON.stringify(operation)} === "check") return JSON.stringify({state:"matched"});
return JSON.stringify({state:app.terminate ? "requested" : "refused"});
})()`;
}

function waitForExit(child, milliseconds) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise(resolve => {
    let timer;
    const finish = value => {clearTimeout(timer);child.removeListener("exit", exited);resolve(value);};
    const exited = () => finish(true);
    child.once("exit", exited);timer = setTimeout(() => finish(false), milliseconds);
    if (child.exitCode != null || child.signalCode != null) finish(true);
  });
}

/** Opt-in normal Cocoa Quit for one owned native ChildProcess incarnation. */
function bindNativeAppStop(child, {executablePath, platform = process.platform, run = execute,
  graceMs = 2000, forceGraceMs = 2000, force = forceStopProcessTree, logger} = {}) {
  if (platform !== "darwin" || processStopBinding(child)) return child;
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0 || !path.isAbsolute(executablePath || "") ||
      !Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 15000 ||
      !Number.isSafeInteger(forceGraceMs) || forceGraceMs < 0 || forceGraceMs > 15000)
    throw new TypeError("An owned native application and bounded shutdown interval are required.");
  const pid = child.pid, stat = fs.statSync(fs.realpathSync(executablePath), {bigint:true});
  const identity = {device:stat.dev.toString(),inode:stat.ino.toString()};
  const alive = () => child.pid === pid && child.exitCode == null && child.signalCode == null;
  const invoke = async (operation, birth) => {
    const result = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", nativeAppScript({pid,identity,birth,operation})],
      {timeout:1500,maxBuffer:4096});
    return JSON.parse(result.stdout.trim());
  };
  // Capture the kernel incarnation during spawn publication, before Stop can
  // be requested or a later PID reuse can masquerade as this application.
  const identified = Promise.resolve().then(() => alive() ? invoke("identify") : null).catch(() => null);
  bindProcessStop(child, async ({isCurrent}) => {
    const current = () => isCurrent() && alive();
    if (!current()) return false;
    const captured = await identified;
    if (!current()) return true;
    const token = captured?.state === "identified" && typeof captured.birth === "string" ? Buffer.from(captured.birth,"base64") : null;
    const birth = token?.length === 16 && token.readBigUInt64LE(0) > 0n && token.readBigUInt64LE(8) < 1000000n ? captured.birth : null;
    const validate = value => {
      if (value?.state === "identity-changed") throw new Error("The native application identity changed before Stop.");
      return value;
    };
    if (birth) {
      let response;
      try {response = await invoke("quit",birth);} catch (error) {logger?.warn?.("Native application Quit request failed: " + error.message);}
      validate(response);
    }
    if (await waitForExit(child,graceMs)) return true;
    if (!current()) return false;
    if (birth) {
      let response;
      try {response = await invoke("check",birth);} catch {}
      validate(response);
      // An unavailable application identity is not authority to target a
      // different instance. Ordinary owned-child force semantics remain when
      // AppKit itself cannot service the exact original process.
      if (["not-running","process-unavailable"].includes(response?.state)) {
        if(await waitForExit(child,forceGraceMs))return true;
        throw new Error("The native process identity could not be confirmed for forced shutdown.");
      }
    }
    if (!current()) return false;
    if (!force(pid,{isCurrent:current})) {
      if (!current()) return true;
      throw new Error("The native application could not be stopped.");
    }
    if (!await waitForExit(child,forceGraceMs)) throw new Error("The native application did not finish forced shutdown.");
    return true;
  });
  return child;
}

module.exports = {bindNativeAppStop,nativeAppScript};
