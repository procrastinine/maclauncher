const path = require("node:path");
const manifest = require("./manifest.json");
const keyNames = require("./keyboard-keys.json");
const Writable = require("../shared/writable-input");
const { gameDirectory } = require("./prepare");

const keyboard = new Map(keyNames.names.map(name => [name.toLowerCase(), name]));
const buttons = new Set(["Cross", "Circle", "Triangle", "Square", "L1", "R1", "L2", "R2", "L3", "R3", "Options", "TouchPad", "Up", "Down", "Left", "Right"]);
const keyboardOnly = new Set(["ToggleFullscreen", "TogglePerformanceOverlay", "Screenshot"]);
const mouseButtons = new Map(["Left", "Right", "Middle", "X1", "X2"].map(name => [name.toLowerCase(), name]));

function source(action, token) {
  const mouse = /^mouse\s+(.+)$/i.exec(token), wheel = /^wheel\s+(up|down)$/i.exec(token);
  if (mouse) {
    const button = mouseButtons.get(mouse[1].toLowerCase());
    if (!button) throw new Error("Unknown mouse button: " + token + ".");
    if (keyboardOnly.has(action)) throw new Error(action + " requires a keyboard key.");
    return "MOUSE:" + button;
  }
  if (wheel) {
    if (!buttons.has(action)) throw new Error("The mouse wheel requires a controller button.");
    return "WHEEL:" + wheel[1].toUpperCase();
  }
  const key = keyboard.get(token.toLowerCase() === "comma" ? "," : token.toLowerCase());
  if (!key || /[;#\r\n]/.test(key)) throw new Error("Unknown or unsupported key: " + token + ".");
  return "KEY:" + key;
}
function configuration(settings = {}, capabilities = { touchPadBinding: true }) {
  const lines = [];
  for (const field of manifest.runtime.entries.anyps5.settings.fields.filter(field => field.key.startsWith("bind"))) {
    if (field.key === "bindTouchPad" && capabilities.touchPadBinding !== true) continue;
    const action = field.key.slice(4), value = settings[field.key];
    if (value !== undefined && typeof value !== "string") throw new Error("Invalid binding for " + field.label + ".");
    const text = (value || "").trim() || field.default || "";
    if (!text) continue;
    if (text.length > 1024 || /[\x00-\x1f\x7f;#=]/.test(text)) throw new Error("Invalid binding for " + field.label + ".");
    const tokens = text.split(",").map(token => token.trim());
    if (tokens.length > 16 || tokens.some(token => !token)) throw new Error("Bindings require key names separated by commas.");
    const bindings = new Set(tokens.map(token => source(action, token)));
    for (const binding of bindings) lines.push(action + " = " + binding);
  }
  return lines.join("\n") + "\n";
}
function routingEnvironment(settings = {}, install) {
  if (settings.bindTouchPad !== undefined && typeof settings.bindTouchPad !== "string") throw new Error("Invalid binding for Touchpad click.");
  const touchPad = (settings.bindTouchPad || "").trim();
  if (touchPad && touchPad !== "V" && install?.manifest?.capabilities?.touchPadBinding !== true)
    throw new Error("The selected AnyPS5 runtime does not support touchpad key bindings. Install a compatible runtime or restore the default binding.");
  const routing = settings.mouseInput ?? "auto";
  if (!["auto", "controller", "native"].includes(routing)) throw new Error("Unknown mouse input mode.");
  if (routing === "auto") return {};
  if (install?.manifest?.capabilities?.mouseRouting !== true)
    throw new Error("The selected AnyPS5 runtime does not support mouse input selection. Choose Automatic or install a compatible runtime.");
  return { ANYPS5_MOUSE_ROUTING: routing };
}
function prepare(entry, context, install) {
  const root = gameDirectory(entry, context), file = path.join(root, "input.ini"), text = configuration(context.runtimeSettings, install?.manifest?.capabilities || {});
  Writable.assertOwnDirectory(context.userDataDir, root);
  Writable.atomicWrite(file, text, { root });
  return { ANYPS5_INPUT_CONFIG: file };
}
module.exports = { configuration, prepare, routingEnvironment };
