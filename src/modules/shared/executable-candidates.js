const path = require("node:path");

// Utility executables remain available when explicitly selected, but should not
// tie with the game's executable during automatic folder discovery.
function executablePriority(file) {
  if (!/\.exe$/i.test(file)) return 0;
  const name = path.basename(file, path.extname(file));
  return /(?:^|[\s_.-])(?:unins\d*|uninstall(?:er)?|install(?:er)?|setup|config(?:uration)?|settings|launcher|vcredist|dxsetup|dxwebsetup|redist|crash(?:reporter)?)(?:$|[\s_.-])|^(?:dotnetfx|ndp\d|vc_redist)/i.test(name) ? -1000 : 0;
}

module.exports = { executablePriority };
