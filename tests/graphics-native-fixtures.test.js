// Runs the native fixtures of a core build configured with -DBUILD_TESTING=ON.
// MACLAUNCHER_NATIVE_FIXTURES=DIR uses an existing core build directory, for example
// DIR/core/build from node scripts/build-graphics-runtime.mjs --only core --work DIR --tests.
// MACLAUNCHER_NATIVE_FIXTURES=build materializes, configures and builds one in a
// temporary directory first, which needs the pinned sources and CMake.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {pathToFileURL} = require("node:url");

const requested = process.env.MACLAUNCHER_NATIVE_FIXTURES, temporary = requested === "build";
const build = requested && !temporary ? path.resolve(requested) : null;
const unavailable = process.platform !== "darwin" ? "native fixtures run on macOS"
  : !requested ? "MACLAUNCHER_NATIVE_FIXTURES names neither a core build configured with -DBUILD_TESTING=ON nor \"build\""
  : build && !fs.existsSync(path.join(build, "test")) ? "no native fixture build in " + build
  : null;
const load = file => import(pathToFileURL(path.join(__dirname, "..", file)).href);

test("native fixtures pass or report an explicit skip", {skip: unavailable || false}, async t => {
  let directory = build;
  if (temporary) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-native-fixtures-"));t.after(() => fs.rmSync(work, {recursive: true, force: true}));
    directory = (await (await load("scripts/build-graphics-runtime.mjs")).buildCore({work, jobs: Math.min(4, os.availableParallelism()), tests: true})).build;
  }
  const runner = await load("src/modules/shared/reshade/native/test/run.mjs");
  for (const name of Object.keys(runner.fixtures)) await t.test(name, async fixture => {
    for (const result of runner.runFixtures(directory, {only: [name]})) {
      if (result.status === "skip") { fixture.skip(result.mode + ": skipped: " + result.reason); continue; }
      assert.equal(result.status, "pass", `${result.mode}: ${result.reason}\n${result.output || ""}`);
    }
  });
});
