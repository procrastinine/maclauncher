const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const System4 = require("../src/modules/alicesoft/system4-build");
const Alice = require("../src/modules/alicesoft/main");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-system4-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}

test("the System4 Mac overlay supplies portable shaders and explicit build identity without source downloads", t => {
  const root = fixture(t); fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "meson.build"), ["gl = dependency('GL')", ...["libavcodec", "libavformat", "libavutil", "libswscale"].map(name => `dep = dependency('${name}', required: false)`)].join("\n"));
  fs.writeFileSync(path.join(root, "meson_options.txt"), "");
  fs.writeFileSync(path.join(root, "src/meson.build"), "fallback : 'unknown version'");
  fs.writeFileSync(path.join(root, "src/video.c"), '"#version 140\\n"\nSDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 1);\nGLchar *source = SDL_LoadFile(path, NULL);');
  System4.adaptSource(root, System4.VERSION);
  const video = fs.readFileSync(path.join(root, "src/video.c"), "utf8");
  assert.match(video, /#version 150/); assert.match(video, /CONTEXT_MINOR_VERSION, 2/);
  assert.match(video, /SDL_GetBasePath/); assert.match(video, /\.\.\/share\/xsystem4/);
  assert.match(fs.readFileSync(path.join(root, "meson.build"), "utf8"), /appleframeworks/);
  assert.equal((fs.readFileSync(path.join(root, "meson.build"), "utf8").match(/get_option\('ffmpeg'\)/g) || []).length, 4);
  assert.match(fs.readFileSync(path.join(root, "src/meson.build"), "utf8"), new RegExp(System4.VERSION));
  assert.throws(() => System4.adaptSource(root, System4.VERSION), /overlay does not match/);
});

test("global System4 Build rejects a mismatched source before tools or registration", { skip: process.platform !== "darwin" }, async t => {
  const root = fixture(t), sourceDir = path.join(root, "source"); fs.mkdirSync(sourceDir);
  const git = args => execFileSync("git", ["-C", sourceDir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { stdio: "ignore" });
  git(["init", "-q"]); fs.writeFileSync(path.join(sourceDir, "test.txt"), "fixture"); git(["add", "."]); git(["commit", "-qm", "fixture"]);
  const manager = Alice.runtimeManagers.find(row => row.id === "xsystem4"), userDataDir = path.join(root, "userdata");
  await assert.rejects(System4.buildManagedSystem4({ manager, version: System4.VERSION, sourceDir, userDataDir,
    dependencies: { findBuildTool: () => assert.fail("tools must not be called for the wrong pin") } }), /revision mismatch/);
  assert.equal(fs.existsSync(manager.core.getInstallDir({ userDataDir, version: System4.VERSION })), false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(System4.buildManagedSystem4({ manager, version: System4.VERSION, sourceDir, userDataDir, signal: controller.signal }), error => error.name === "AbortError");
});

test("System4 portable versions cannot use the older dependency build recipe", { skip: process.platform !== "darwin" }, async t => {
  const root = fixture(t), manager = Alice.runtimeManagers.find(row => row.id === "xsystem4"), version = "snapshot-04333ad-macos-v2";
  await assert.rejects(System4.buildManagedSystem4({ manager, version, sourceDir: path.join(root, 'absent-source'),
    userDataDir: path.join(root, 'userdata'), dependencies: { findBuildTool() { assert.fail('No tools for the older recipe'); } } }), /portable source recipe/);
  assert.equal(fs.readdirSync(root).length, 0);
});
