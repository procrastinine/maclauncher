const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

test("graphics build CLI executes through an alias and stays inert when imported", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-build-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.resolve(__dirname, "../scripts/build-graphics-runtime.mjs");
  const alias = path.join(root, "build.mjs");
  fs.symlinkSync(script, alias);
  const checked = spawnSync(process.execPath, [alias, "--check", "--only", "core"], { encoding: "utf8" });
  assert.ifError(checked.error);
  assert.equal(checked.stderr, "");
  const plan = JSON.parse(checked.stdout);
  assert.deepEqual(plan.selected, ["core"]);
  assert.ok(Array.isArray(plan.unresolved));
  assert.equal(checked.status, plan.unresolved.length ? 1 : 0);

  const wrapper = path.join(root, "import.mjs");
  fs.writeFileSync(wrapper, `import { plan } from ${JSON.stringify(pathToFileURL(alias).href)};\nif (typeof plan !== "function") throw Error("Missing build API");\nconsole.log("imported");\n`);
  const imported = spawnSync(process.execPath, [wrapper, "--check", "--only", "core"], { encoding: "utf8" });
  assert.ifError(imported.error);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "imported\n");
  assert.equal(imported.stderr, "");
});
