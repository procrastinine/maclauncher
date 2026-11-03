const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Arguments = require("../shared/runtime/launch-arguments");
const Tools = require("./native-tools");

function configuredIdentity(entry, context = {}) {
  const args = context.gameArguments || Arguments.parse(entry.launchArguments || "");
  let identifier;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--gameid") identifier = args[++index];
    else if (args[index].startsWith("--gameid=")) identifier = args[index].slice(9);
  }
  return identifier;
}

function saveDirectory(entry, context = {}) {
  const id = configuredIdentity(entry, context);
  return typeof id === "string" && id && !/[\\/\0]/.test(id) && ![".", ".."].includes(id)
    ? path.join(os.homedir(), "Library", "Application Support", id) : null;
}

// Import-time facts follow ScriptHandler::readScriptSub/readScript: CR/CRLF
// become LF, each script contributes a final LF, and the fallback ID is length.
function upstreamIdentity(root, entry) {
  const id = path.join(root, "game.id"), stat = fs.statSync(id, { throwIfNoEntry: false });
  if (stat?.isFile()) {
    if (stat.size > 8192) return null;
    return fs.readFileSync(id, "utf8").split(/[\r\n]/, 1)[0];
  }
  const source = Tools.readScript(root, entry);
  let text;
  if (source.mode !== "plain") text = source.bytes.toString("latin1").replace(/\r\n?/g, "\n") + "\n";
  else {
    const extension = source.name.slice(source.name.indexOf(".")), pieces = [];
    let bytes = 0;
    for (let index = 0; index < 100; index++) {
      let file = path.join(root, index + extension);
      if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) file = path.join(root, String(index).padStart(2, "0") + extension);
      const item = fs.statSync(file, { throwIfNoEntry: false });
      if (!item?.isFile()) continue;
      if ((bytes += item.size) > Tools.MAX_SCRIPT_BYTES) return null;
      pieces.push(fs.readFileSync(file).toString("latin1").replace(/\r\n?/g, "\n") + "\n");
    }
    text = pieces.join("");
  }
  let header = text.replace(/^[\n\r\t ]+/, "");
  while (header.startsWith(";")) {
    const end = header.indexOf("\n"), line = header.slice(0, end < 0 ? header.length : end);
    if (line.startsWith(";gameid ")) return line.slice(8);
    if (!/^;mode(?:800|400|320|w720)$/.test(line) && !/^;value[ \t]*\d+$/.test(line)) {
      if (/^;(?:mode|value|\$)/.test(line)) return null;
      break;
    }
    header = header.slice(end + 1).replace(/^[\n\r]+/, "");
  }
  return "ONScripter-" + text.length.toString(16);
}

function resolveSaveIdentity(entry, context = {}) {
  const runtime = entry.runtimeId || context.runtimeId || context.settings?.modules?.nscripter?.defaultRuntime || "onsyuri_mac";
  if (runtime !== "onscripter_en") return null;
  const root = entry.contentRootDir || entry.gamePath;
  if (!path.isAbsolute(root || "")) return null;
  try {
    const args = Arguments.parse(entry.launchArguments || "");
    let explicitSave;
    for (let index = 0; index < args.length; index++) if (["--save", "-s"].includes(args[index])) explicitSave = args[++index];
    const authored = configuredIdentity(entry);
    const id = explicitSave || entry.saveDirOverride ? null : authored === undefined ? upstreamIdentity(root, entry) : authored;
    const location = explicitSave ? path.resolve(root, explicitSave) : entry.saveDirOverride ||
      (typeof id === "string" && !/[\\/\0]/.test(id) && ![".", ".."].includes(id)
        ? path.join(os.homedir(), "Library", "Application Support", id) : null);
    if (!location) return null;
    return { namespace: "filesystem", identity: location, scope: "game",
      explicit: Boolean(explicitSave || entry.saveDirOverride || authored !== undefined), hostSubstitution: false,
      createPatch({ entry: current, gameId }) {
        // An authored explicit option is intentional. Otherwise the shared
        // importer may select this supported option for an actual collision.
        if (current.saveDirOverride || explicitSave || args.some(arg => arg === "--gameid" || arg.startsWith("--gameid=")) || !/^[A-Za-z0-9_-]{1,128}$/.test(gameId)) return null;
        return { launchArguments: "--gameid " + gameId + (current.launchArguments ? " " + current.launchArguments : ""),
          defaultSaveDir: path.join(os.homedir(), "Library", "Application Support", gameId) };
      } };
  } catch { return null; }
}

module.exports = { saveDirectory, resolveSaveIdentity };
