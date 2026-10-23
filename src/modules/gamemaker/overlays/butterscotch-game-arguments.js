const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PROFILE = "butterscotch-game-arguments-v1";
function apply(sourceRoot) {
  const file = path.join(sourceRoot, "src/cli/args.c");
  let text = fs.readFileSync(file, "utf8");
  for (const [before, after] of [
    ['        {"game-args", required_argument, nullptr, \'N\'},', '        {"game-args", required_argument, nullptr, \'N\'},\n        {"game-arg", required_argument, nullptr, 11000},'],
    ["            case 'N': {", "            case 11000:\n                arrput(args->gameArgs, safeStrdup(optarg));\n                break;\n            case 'N': {"]
  ]) {
    if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error("Butterscotch's argument parser differs from the selected source profile.");
    text = text.replace(before, after);
  }
  fs.writeFileSync(file, text);
  return { profile: PROFILE, sha256: crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex") };
}

module.exports = { PROFILE, apply };
