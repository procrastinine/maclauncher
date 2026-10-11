const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { FileMatcher, getMainFileMatchers } = require("app-builder-lib/out/fileMatcher");

const projectRoot = path.resolve(__dirname, "..");
function packageConfig() { return JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")); }
function selectedBy(matcher, relative) {
  return matcher.createFilter()(path.join(matcher.from, relative), { isDirectory: () => false });
}

test("resource packaging keeps intended runtimes and excludes backup, cache and local payloads", () => {
  const pkg = packageConfig();
  const resources = pkg.build.extraResources.find(item => item.from === "src/resources");
  assert.ok(resources);
  const matcher = new FileMatcher(path.join(projectRoot, resources.from), "/packaged-resources", value => value, resources.filter);
  for (const file of ["7zip/bin/7zz", "RPGMakerDecrypter/RPGMakerDecrypter-cli", "maclauncher.png",
    "native-runtimes/engine/version/arm64/manifest.json", "native-runtimes/engine/version/arm64/files/bin/runner",
    "native-runtimes/engine/version/arm64/LICENSE.txt", "python/bin/python3", "python/lib/python3.12/os.py"])
    assert.equal(selectedBy(matcher, file), true, `Required resource excluded: ${file}`);
  for (const file of ["python-old-fixture/bin/python3", "unapproved-payload/private.json", "python/.env.local",
    "python/lib/python3.12/__pycache__/os.cpython.pyc", "python/lib/python3.12/os.pyc", "python/lib/python3.12/os.pyo",
    "python/.local/config.json", "native-runtimes/engine/.git/config", "native-runtimes/engine/localconfig.json",
    "native-runtimes/engine/build.log", "native-runtimes/engine/session.har", "7zip/._7zz"])
    assert.equal(selectedBy(matcher, file), false, `Private or stale resource included: ${file}`);
});

test("application packaging preserves code and artwork while excluding local files", () => {
  const { build } = packageConfig();
  const packager = { info: { projectDir: projectRoot, buildResourcesDir: "build", config: build,
    isPrepackedAppAsar: false, debugLogger: { isEnabled: false } } };
  const matchers = getMainFileMatchers(projectRoot, "/packaged-app", value => value, build.mac, packager,
    path.join(projectRoot, build.directories.output), false);
  const selected = relative => matchers.some(matcher => selectedBy(matcher, relative));
  for (const file of ["src/main/bootstrap.js", "src/modules/core/launcher.js", "src/runtime/electron-game.js",
    "src/modules/bgi/main.js", "src/modules/bgi/archive.js", "src/modules/bgi/inspect.js",
    "src/modules/rgss/resources/icon.png", "src/modules/rgss/runtime/bundled-binary.json",
    "src/modules/rgss/resources/soundfont/GMGSx.SF2", "src/modules/rgss/assets.js", "src/modules/rgss/rtp.js",
    "dist/renderer/index.html", "package.json", "LICENSE"])
    assert.equal(selected(file), true, `Application file excluded: ${file}`);
  for (const file of [".local/notes/private.json", "src/modules/example/.local/private.json", "src/modules/example/.env.local",
    "src/modules/example/localconfig.json", "src/modules/example/build.log", "src/modules/example/__pycache__/tool.pyc",
    "src/resources/python/bin/python3", "src/external/example/vendor.js", "src/modules/rgss/resources/mkxpz/runtime.app/Contents/MacOS/runner",
    "src/modules/rgss/resources/rtp/Standard/Audio/BGM/sample.mid",
    "src/modules/rgss/resources/rtp/RPGVX/Graphics/Characters/sample.png",
    "src/modules/rgss/resources/rtp/RPGVXAce/Fonts/VL-Gothic-Regular.ttf",
    "src/modules/bgi/native/probe-main.c", "src/modules/bgi/native/build.js", "src/modules/bgi/native/versions/probe-v1/vm-guards.c",
    "docs/README.md", "scripts/dev.mjs"])
    assert.equal(selected(file), false, `Local or separately packaged file included: ${file}`);
});

test("all directory resource rules exclude local configuration and generated diagnostics", () => {
  for (const resource of packageConfig().build.extraResources) {
    const matcher = new FileMatcher(path.join(projectRoot, resource.from), "/packaged-resources", value => value, resource.filter);
    const base = resource.from === "src/resources" ? "native-runtimes/engine" :
      resource.from === "src/external" ? "evbunpack" : resource.from.endsWith("unren") ? "third_party/rpatool" : "__urw";
    for (const suffix of [".env", ".env.local", ".local/private.json", "localconfig.json", "build.log", "session.har", "__pycache__/tool.pyc"]) {
      const file = `${base}/${suffix}`;
      assert.equal(selectedBy(matcher, file), false, `Private artifact selected by ${resource.from}: ${suffix}`);
    }
  }
});

test("build.extraResources includes upstream MVMZ plugin assets for packaging", () => {
  const packageJsonPath = path.resolve(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const extraResources = Array.isArray(pkg?.build?.extraResources) ? pkg.build.extraResources : [];

  const externalResource = extraResources.find(
    item =>
      item &&
      item.from === "src/external" &&
      item.to === "external" &&
      Array.isArray(item.filter)
  );

  assert.ok(externalResource, "Missing src/external -> external extraResources rule.");
  assert.ok(
    externalResource.filter.includes(
      "rpgmakermlinux-cicpoffs/nwjs/packagefiles/filestoexport/plugins/**"
    ),
    "Missing cicpoffs filestoexport/plugins filter in extraResources."
  );
  assert.ok(
    externalResource.filter.includes("rpgmakermlinux-cicpoffs/nwjs/packagefiles/plugins/**"),
    "Missing cicpoffs packagefiles/plugins filter in extraResources."
  );
  assert.ok(
    externalResource.filter.includes(
      "rpgmakermlinux-cicpoffs/nwjs/nwjs/packagefiles/filestoexport/plugins/**"
    ),
    "Missing cicpoffs nested filestoexport/plugins filter in extraResources."
  );
  assert.ok(
    externalResource.filter.includes(
      "rpgmakermlinux-cicpoffs/nwjs/nwjs/packagefiles/plugins/**"
    ),
    "Missing cicpoffs nested packagefiles/plugins filter in extraResources."
  );
});

test("build.asarUnpack includes bundled Flash Player app path", () => {
  const packageJsonPath = path.resolve(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const asarUnpack = Array.isArray(pkg?.build?.asarUnpack) ? pkg.build.asarUnpack : [];

  assert.ok(
    asarUnpack.includes("src/modules/flash/resources/flash-player/**/*.app/**"),
    "Missing Flash Player asarUnpack rule."
  );
});

test("MacLauncher ships a valid macOS icon and a 1024px Dock raster", () => {
  const root = path.resolve(__dirname, '..');
  const icns = fs.readFileSync(path.join(root, 'build', 'icon.icns'));
  assert.equal(icns.subarray(0, 4).toString(), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const png = fs.readFileSync(path.join(root, 'src', 'resources', 'maclauncher.png'));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  assert.ok(fs.existsSync(path.join(root, 'src', 'renderer', 'src', 'ui', 'assets', 'maclauncher.svg')));
});
