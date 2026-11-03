const fs = require("node:fs");
const { writeFileAtomic } = require("../../atomic-file");

let runtimeSource;
// Existing standalone assets contain the same self-contained shared writer;
// no app-relative require or extra per-game helper file is needed at runtime.
function buildCheatsRuntimeSource() {
  if (runtimeSource === undefined) {
    const source = fs.readFileSync(require.resolve("./runtime"), "utf8");
    runtimeSource = source.replace('const { writeFileAtomic } = require("../../atomic-file");',
      `const writeFileAtomic = (${writeFileAtomic.toString()});`);
  }
  return runtimeSource;
}

module.exports = { buildCheatsRuntimeSource };
