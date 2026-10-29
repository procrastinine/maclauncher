const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Custom = require("../../shared/runtime/custom-runtime");
const AppBundle = require("../../shared/runtime/app-bundle");

function inspect(runtimePath, { sectionId } = {}) {
  const tool = sectionId === "gdsdecomp";
  let selected = runtimePath;
  if (fs.statSync(selected).isDirectory() && !selected.toLowerCase().endsWith(".app")) {
    const entries = fs.readdirSync(selected, { withFileTypes: true });
    if (entries.length > 256) throw new Error("Select the runtime application or executable within this folder.");
    const apps = entries.filter(item => item.isDirectory() && /\.app$/i.test(item.name) &&
      (tool ? /gdre|gdsdecomp/i : /godot/i).test(item.name));
    if (apps.length === 1) selected = path.join(selected, apps[0].name);
  }
  const native = Custom.inspectNative(selected, { candidates: tool ? ["gdre_tools", "GDRE_tools", "bin/gdre_tools"] : ["Godot", "godot", "bin/godot"] });
  let app = selected.toLowerCase().endsWith(".app") ? selected : null;
  if (!app) {
    let parent = path.dirname(native.executablePath);
    for (let depth = 0; depth < 4; depth++, parent = path.dirname(parent)) {
      if (parent.toLowerCase().endsWith(".app") && fs.existsSync(path.join(parent, "Contents/Info.plist"))) { app = parent; break; }
    }
  }
  const rawVersion = app ? AppBundle.readAppBundleVersion(app) : null;
  const runtimeVersion = rawVersion?.match(/\d+\.\d+(?:\.\d+)?/)?.[0] || null;
  if (!tool && runtimeVersion && runtimeVersion.split(".")[0] !== sectionId)
    throw new Error("The selected Godot runtime belongs to a different major version list.");
  const variant = [app && path.join(app, "Contents/Resources/GodotSharp"), path.join(native.root, "GodotSharp")]
    .filter(Boolean).some(file => fs.existsSync(file)) ? "mono" : "standard";
  return { ...native, ...(app ? { appPath: app } : {}), runtimeVersion, variant, engineFamily: tool ? null : sectionId,
    ...(tool ? { cliPath: native.executablePath } : {}) };
}

async function versionForPlay(install, context = {}) {
  if (install.runtimeVersion) return install.runtimeVersion;
  const value = await new Promise((resolve, reject) => {
    const child = spawn(install.executablePath, ["--version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL" });
    context.onToolProcessSpawn?.(child);
    let output = "", overflow = false;
    const append = bytes => { output += bytes.toString("utf8"); if (output.length > 65536) { overflow = true; child.kill("SIGKILL"); } };
    child.stdout.on("data", append); child.stderr.on("data", append);
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 && !overflow ? resolve(output) : reject(new Error("The custom Godot runtime could not report its version" + (signal ? ` (${signal})` : "."))));
  });
  const version = value.match(/\b(\d+\.\d+(?:\.\d+)?)(?:[.-](rc\d+|beta\d+|alpha\d+|dev\d+))?/)?.slice(1).filter(Boolean).join("-");
  if (!version || version.split(".")[0] !== install.engineFamily) throw new Error("The custom Godot runtime does not match its major version list.");
  return version;
}

module.exports = { inspect, versionForPlay };
