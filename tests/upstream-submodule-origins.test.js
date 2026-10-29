const test = require("node:test");
const assert = require("node:assert/strict");
const Check = require("../scripts/check-upstream-overlays.cjs");
test("relative nested submodule URLs resolve against the declared parent origin", () => {
  const rows = Check.configRows([
    "submodule.libs/cauldron.path libs/cauldron",
    "submodule.libs/cauldron.url ../../Other/Cauldron.git",
    "submodule.local.path local",
    "submodule.local.url ./local",
    "submodule.absolute.path absolute",
    "submodule.absolute.url https://example.invalid/owner/absolute.git"
  ].join("\n"), "https://github.com/Owner/Project.git");
  assert.deepEqual(rows.map(row => row.repository), ["https://github.com/Other/Cauldron", "https://github.com/Owner/Project/local", "https://example.invalid/owner/absolute"]);
  assert.throws(() => Check.configRows("submodule.x.path x\nsubmodule.x.url ../x"), /Invalid URL/);
});
