const path = require("node:path");

// Programs shipped beside a game that are never the game itself: uninstallers,
// installers and redistributables, crash handlers and reporters, updaters, and
// bundled interpreters, runtimes and SDK tools. Automatic discovery skips them;
// a deliberate selection still uses them.
const SUPPORT = new RegExp([
  "uninst", "^unins\\d*$", "(?:^|[\\s_.-])install(?:er)?(?:$|[\\s_.-])", "^install", "setup", "redist", "prereq",
  "^dotnetfx", "^ndp\\d", "^oalinst$", "^directx", "^physx",
  "crash[\\s_.-]?(?:handler|report|pad|dump|sender|uploader)", "errorreport", "bugreport", "(?:^|[\\s_.-])report(?:er)?$",
  "^werfault$", "^createdump$",
  "(?:^|[\\s_.-])(?:auto)?update(?:r)?(?:$|[\\s_.-])", "(?:^|[\\s_.-])patch(?:er)?(?:$|[\\s_.-])", "^zsync(?:make)?$",
  "^pythonw?(?:\\d[\\d.]*)?$", "^javaw?s?$", "^jabswitch$", "^keytool$", "^nwjc$", "^chromedriver$", "^notification_helper$",
  "^qtwebengineprocess$", "browsersubprocess", "^ffmpeg$", "^ffprobe$", "^elevate$", "^dosbox(?:[-_ ]?x)?$", "^scummvm$", "^renpy$"
].join("|"), "i");
// Programs that belong to the game but are rarely how it starts: configuration
// and settings tools, launchers and loaders, servers and console wrappers. They
// stay eligible and rank below the game's executable. CamelCase suffixes such as
// TerrariaServer count; words that merely end in the same letters do not.
const SECONDARY = /config|settings|launcher|(?:^|[\s_.-])(?:console|editor|tools?|server|loader)$/i;
const SECONDARY_SUFFIX = /[a-z0-9](?:Server|Loader)$/;

function executableRole(file) {
  if (!/\.exe$/i.test(file)) return "game";
  const name = path.basename(file, path.extname(file));
  return SUPPORT.test(name) ? "support" : SECONDARY.test(name) || SECONDARY_SUFFIX.test(name) ? "secondary" : "game";
}

// Utility executables remain available when explicitly selected, but should not
// tie with the game's executable during automatic folder discovery.
function executablePriority(file) {
  return executableRole(file) === "game" ? 0 : -1000;
}

module.exports = { executableRole, executablePriority };
