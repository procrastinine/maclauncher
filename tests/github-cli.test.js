const test = require("node:test");
const assert = require("node:assert/strict");
const CLI = require("../src/modules/shared/runtime/github-cli");

test("Finder PATH discovers installed Homebrew gh without changing the environment", () => {
  const env = { PATH: "/usr/bin:/bin" }, checked = [];
  const fileSystem = { statSync(file) { checked.push(file); if (file !== "/opt/homebrew/bin/gh") throw new Error("absent"); return { isFile: () => true }; }, accessSync() {} };
  assert.equal(CLI.executable({ env, platform: "darwin", fileSystem }), "/opt/homebrew/bin/gh");
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.deepEqual(checked, ["/usr/bin/gh", "/bin/gh", "/opt/homebrew/bin/gh"]);
});
test("explicit executable search order is retained and non-executable files are skipped", () => {
  const fileSystem = { statSync: () => ({ isFile: () => true }), accessSync(file) { if (file === "/custom/gh") throw new Error("not executable"); } };
  assert.equal(CLI.executable({ env: { PATH: "/custom:/working" }, platform: "darwin", fileSystem }), "/working/gh");
});
test("missing gh and failed GitHub authentication have distinct actionable errors", async () => {
  await assert.rejects(CLI.available({ required: true, runCommand: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } }), /was not found.*Install gh/);
  await assert.rejects(CLI.available({ required: true, runCommand: async () => { throw Object.assign(new Error("expired"), { code: 1 }); } }), /is installed.*gh auth login --hostname github.com/);
  assert.equal(await CLI.available({ runCommand: async () => { throw new Error("expired"); } }), false);
  assert.equal(await CLI.available({ runCommand: async (_command, args) => { assert.deepEqual(args, ["auth", "status", "--hostname", "github.com"]); } }), true);
});
