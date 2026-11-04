// Runs the native fixtures of a core build configured with -DBUILD_TESTING=ON.
// MACLAUNCHER_NATIVE_FIXTURES names an existing core build from MacLauncher Builds.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const {pathToFileURL} = require("node:url");

const requested = process.env.MACLAUNCHER_NATIVE_FIXTURES;
const build = requested ? path.resolve(requested) : null;
const unavailable = process.platform !== "darwin" ? "native fixtures run on macOS"
  : !requested ? "MACLAUNCHER_NATIVE_FIXTURES must name a core build configured with -DBUILD_TESTING=ON"
  : build && !fs.existsSync(path.join(build, "test")) ? "no native fixture build in " + build
  : null;
const load = file => import(pathToFileURL(path.join(__dirname, "..", file)).href);

test("native fixtures pass or report an explicit skip", {skip: unavailable || false}, async t => {
  const directory = build;
  const runner = await load("src/modules/shared/reshade/native/test/run.mjs");
  for (const name of Object.keys(runner.fixtures)) await t.test(name, async fixture => {
    for (const result of runner.runFixtures(directory, {only: [name]})) {
      if (result.status === "skip") { fixture.skip(result.mode + ": skipped: " + result.reason); continue; }
      assert.equal(result.status, "pass", `${result.mode}: ${result.reason}\n${result.output || ""}`);
    }
  });
});
