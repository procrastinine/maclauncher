const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Screenshots = require("../src/modules/shared/reshade/screenshots");

test("screenshot names use the game title and local time, and never overwrite", () => {
  const date = new Date(2026, 9, 31, 14, 5, 9);
  assert.equal(Screenshots.fileName("Celeste", date), "Celeste 2026-10-31 at 14.05.09.png");
  assert.equal(Screenshots.fileName("A/B: C\\D\n", date), "A B C D 2026-10-31 at 14.05.09.png");
  assert.equal(Screenshots.fileName("...", date), "Screenshot 2026-10-31 at 14.05.09.png");
  assert.equal(Screenshots.baseName("x".repeat(300), date).length, 96 + " 2026-10-31 at 14.05.09".length);
  const taken = new Set(["Celeste 2026-10-31 at 14.05.09.png", "Celeste 2026-10-31 at 14.05.09 2.png"]);
  assert.equal(Screenshots.fileName("Celeste", date, name => taken.has(name)), "Celeste 2026-10-31 at 14.05.09 3.png");
});

test("saving moves the processed image out and leaves nothing staged", t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-screenshots-"));t.after(() => fs.rmSync(work, {recursive: true, force: true}));
  const launch = path.join(work, "launch"), pictures = path.join(work, "Pictures");fs.mkdirSync(launch);
  const prefix = path.join(launch, "frame-capture");
  for (let index = 0; index < 3; index++) {
    fs.writeFileSync(prefix + "-before.png", "before");fs.writeFileSync(prefix + "-after.png", "after " + index);
    fs.writeFileSync(prefix + ".capture-7-after.png", "partial");
    const saved = Screenshots.save({prefix, title: "Game", settings: {graphicsScreenshotFolder: pictures}, date: new Date(2026, 0, 2, 3, 4, 5)});
    assert.equal(fs.readFileSync(saved, "utf8"), "after " + index);
    assert.deepEqual(Screenshots.staged(prefix), []);
  }
  assert.deepEqual(fs.readdirSync(launch), []);
  assert.deepEqual(fs.readdirSync(pictures).sort(), ["Game 2026-01-02 at 03.04.05 2.png", "Game 2026-01-02 at 03.04.05 3.png", "Game 2026-01-02 at 03.04.05.png"]);
  // A failed capture also clears what it staged.
  fs.writeFileSync(prefix + "-before.png", "before");
  assert.throws(() => Screenshots.save({prefix, title: "Game", settings: {graphicsScreenshotFolder: pictures}}));
  assert.deepEqual(fs.readdirSync(launch), []);
});

test("the default folder is visible and a chosen folder must be absolute", () => {
  assert.equal(Screenshots.folder({}), path.join(os.homedir(), "Pictures", "MacLauncher"));
  assert.equal(Screenshots.folder({graphicsScreenshotFolder: "relative"}), Screenshots.DEFAULT_FOLDER);
  assert.equal(Screenshots.folder({graphicsScreenshotFolder: "/Volumes/Shots"}), "/Volumes/Shots");
});

const {spawnSync} = require("node:child_process");
const compiler = process.platform === "darwin" ? spawnSync("xcrun", ["--find", "clang++"], {encoding: "utf8"}) : null;
test("float, 10-bit, PQ and HLG outputs are converted to 8-bit sRGB for capture", {skip: !compiler || compiler.status !== 0 ? "clang++ is unavailable" : false}, t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-screenshot-color-"));t.after(() => fs.rmSync(work, {recursive: true, force: true}));
  const source = path.join(__dirname, "../src/modules/shared/reshade/native/test/screenshot-color.mm"), binary = path.join(work, "screenshot-color");
  const build = spawnSync("xcrun", ["clang++", "-x", "objective-c++", "-std=c++20", "-fobjc-arc", "-Wall", "-Werror", source, "-o", binary,
    "-framework", "Foundation", "-framework", "Metal", "-framework", "CoreGraphics"], {encoding: "utf8"});
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [], {encoding: "utf8"});
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /screenshot-color: pass/);
});

test("a sandbox that moves the capture channel rewrites the launch record, and saving reads the moved paths", async t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-screenshot-sandbox-"));t.after(() => fs.rmSync(work, {recursive: true, force: true}));
  const launchDirectory = path.join(work, "launch"), writable = path.join(work, "writable"), pictures = path.join(work, "Pictures");
  fs.mkdirSync(launchDirectory);fs.mkdirSync(writable);
  const original = {prefix: path.join(launchDirectory, "frame-capture"), trigger: path.join(launchDirectory, "frame-capture.request")};
  fs.writeFileSync(path.join(launchDirectory, "launch.json"), JSON.stringify({schema: 1, launchId: "a", phase: "prepared", screenshotCapture: original}));
  fs.writeFileSync(path.join(writable, "frame-capture.capture-3-after.png"), "stale");
  const {isolateGraphics} = require("../src/modules/shared/runtime/macos-sandbox");
  const scoped = await isolateGraphics({RESHADE_CAPTURE_PREFIX: original.prefix, RESHADE_CAPTURE_TRIGGER: original.trigger, RESHADE_CAPTURE_FINAL: "1"}, launchDirectory, writable);
  const moved = {prefix: path.join(writable, "frame-capture"), trigger: path.join(writable, "frame-capture.request")};
  assert.equal(scoped.graphics.RESHADE_CAPTURE_PREFIX, moved.prefix);
  assert.equal(scoped.graphics.RESHADE_CAPTURE_TRIGGER, moved.trigger);
  const launch = JSON.parse(fs.readFileSync(path.join(launchDirectory, "launch.json"), "utf8"));
  assert.deepEqual(launch.screenshotCapture, moved);
  assert.equal(launch.launchId, "a");
  assert.deepEqual(Screenshots.staged(moved.prefix), []);
  // The launcher requests and saves through the paths the record reports.
  const requestedAt = Date.now();Screenshots.request(launch.screenshotCapture.trigger);
  assert.ok(fs.existsSync(moved.trigger));
  fs.writeFileSync(moved.prefix + "-after.png", "processed");
  assert.equal(await Screenshots.wait(launch.screenshotCapture.prefix, requestedAt, {timeout: 1000}), moved.prefix + "-after.png");
  const saved = Screenshots.save({prefix: launch.screenshotCapture.prefix, title: "Sandboxed", settings: {graphicsScreenshotFolder: pictures}});
  assert.equal(fs.readFileSync(saved, "utf8"), "processed");
  assert.deepEqual(Screenshots.staged(moved.prefix), []);
  // Diagnostic capture has no screenshot channel, so its record is left alone.
  fs.writeFileSync(path.join(launchDirectory, "launch.json"), JSON.stringify({schema: 1, launchId: "b"}));
  assert.equal(Screenshots.relocate(original.prefix, moved), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(launchDirectory, "launch.json"), "utf8")).screenshotCapture, undefined);
});
