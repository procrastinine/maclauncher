const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const { FileMatcher, getMainFileMatchers } = require("app-builder-lib/out/fileMatcher");
const { doMergeConfigs } = require("app-builder-lib/out/util/config/config");
const Content = require("../scripts/runtime-content.cjs");

const projectRoot = path.resolve(__dirname, "..");
function packageConfig() { return JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")); }
function selectedBy(matcher, relative) {
  return matcher.createFilter()(path.join(matcher.from, relative), { isDirectory: () => false });
}

test("Python resource traversal excludes the ctypes test extension and preserves ctypes runtime inputs", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "python-runtime-content-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const testExtension = "python/lib/python3.12/lib-dynload/_ctypes_test.cpython-312-darwin.so";
  const runtime = ["python/lib/python3.12/lib-dynload/_ctypes.cpython-312-darwin.so", "python/lib/python3.12/ctypes/__init__.py"];
  for (const file of [...runtime, testExtension]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "Synthetic Python component");
  }
  const matcher = new FileMatcher(root, "/resources", value => value, Content.withExclusions(["python/**"]));
  const selected = await require("builder-util").walk(root, matcher.createFilter());
  assert.deepEqual(selected.map(file => path.relative(root, file)).sort(), runtime.sort());
  assert.throws(() => Content.assertRuntimePath(testExtension), /Python test extension/);
  for (const file of runtime) assert.doesNotThrow(() => Content.assertRuntimePath(file));
});

test("normalized Builder FileSets preserve the source allowlist without adding a repository-wide matcher", () => {
  for (const normalizeFirst of [false, true]) {
    const original = packageConfig().build;
    const build = normalizeFirst ? Content.applyBuildPolicy(doMergeConfigs([original])) :
      doMergeConfigs([Content.applyBuildPolicy(original)]);
    const packager = { info: { projectDir: projectRoot, buildResourcesDir: "build", config: build,
      isPrepackedAppAsar: false, debugLogger: { isEnabled: false } } };
    const matchers = getMainFileMatchers(projectRoot, "/packaged-app", value => value, build.mac, packager,
      path.join(projectRoot, build.directories.output), false);
    assert.equal(matchers.length, 2, "Only the application and mapped Android source FileSets are present");
    for (const relative of [".local", "game_tests", "docs", "scripts", ".local/runtime/file.js",
      "game_tests/runtime/file.js", "docs/README.md", "src/modules/example/tests/probe.js"]) {
      for (const directory of [false, true]) {
        assert.equal(matchers.some(matcher => matcher.createFilter()(path.join(projectRoot, relative),
          { isDirectory: () => directory })), false, `Excluded input selected: ${relative}`);
      }
    }
    for (const relative of ["src/main/bootstrap.js", "dist/renderer/index.html", "package.json", "LICENSE"])
      assert.equal(matchers.some(matcher => selectedBy(matcher, relative)), true, `Application input excluded: ${relative}`);
  }
});

test("source-directory symlink entries are excluded while mapped Android runtime inputs remain selected", () => {
  const build = Content.applyBuildPolicy(doMergeConfigs([packageConfig().build]));
  const packager = { info: { projectDir: projectRoot, buildResourcesDir: "build", config: build,
    isPrepackedAppAsar: false, debugLogger: { isEnabled: false } } };
  const matchers = getMainFileMatchers(projectRoot, "/packaged-app", value => value, build.mac, packager,
    path.join(projectRoot, build.directories.output), false);
  const application = matchers.find(matcher => matcher.from === projectRoot);
  const aliases = ["src/resources", "src/external", "src/renderer", "src/modules/bgi/native",
    "src/modules/shared/reshade/native", "src/modules/shared/reshade/neural/native",
    "src/modules/renpy/resources/unren", "src/modules/renpy/resources/universal-renpy-walkthrough",
    "src/modules/android/native", "src/modules/android/art/boot-image-driver.rs",
    ...["native", "java", "adapters", "licenses", "tools", "composer", "graphics", "sensors"]
      .map(name => "src/modules/android/art/" + name)];
  for (const alias of aliases) {
    assert.equal(selectedBy(application, alias), false, `Build-source symlink selected: ${alias}`);
    if (!alias.endsWith(".rs")) assert.equal(selectedBy(application, alias + "/source.c"), false, `Build-source child selected: ${alias}`);
  }
  const android = matchers.find(matcher => matcher.from.endsWith("src/external/maclauncher-android"));
  assert.ok(android);
  const inputs = build.files.find(rule => rule.from === "src/external/maclauncher-android").filter.filter(pattern => !pattern.startsWith("!"));
  assert.equal(inputs.length, 12);
  for (const input of inputs) assert.equal(selectedBy(android, input), true, `Mapped Android runtime input excluded: ${input}`);
});

test("first-party test fixtures stay out of the application while runtime helpers and source archives remain included", () => {
  const {build}=packageConfig();
  const packager={info:{projectDir:projectRoot,buildResourcesDir:"build",config:build,
    isPrepackedAppAsar:false,debugLogger:{isEnabled:false}}};
  const matchers=getMainFileMatchers(projectRoot,"/packaged-app",value=>value,build.mac,packager,
    path.join(projectRoot,build.directories.output),false);
  const selected=relative=>matchers.some(matcher=>selectedBy(matcher,relative));
  for(const file of ["tests/core-launcher.test.js","tests/fixtures/graphics/probe.mm",
    "src/modules/shared/reshade/native/test/temporal-plan.mm","src/modules/shared/reshade/native/opengl-test.mm",
    "src/modules/shared/reshade/native/depth-opengl-test.fx","src/modules/shared/reshade/temporal/fsr/projection-test.mjs",
    "src/modules/crossover/temporal/dxmt/forwarder-test.c","src/modules/crossover/temporal/dxmt/test.mjs",
    "src/modules/crossover/temporal/streamline/test-forwarders.mjs","src/modules/crossover/temporal/streamline/camera-test.cpp",
    "src/modules/shared/reshade/native/effects-plan.mm","src/modules/shared/reshade/native/build.mjs",
    "src/modules/shared/reshade/neural/native/Package.swift","src/modules/shared/reshade/neural/build.mjs",
    "src/modules/shared/reshade/libplacebo-build.mjs",
    "src/renderer/src/App.tsx","src/renderer/public/icon.png","src/modules/shared/reshade/plan.d.mts",
    "src/renderer/__tests__/controls.test.tsx","src/core/fixtures/launch.json","src/runtime/player.spec.js"])
    assert.equal(selected(file),false,`Test-only application input included: ${file}`);
  for(const file of ["src/core/launcher.js","src/modules/shared/reshade/index.js",
    "src/modules/shared/reshade/features.json","src/modules/shared/reshade/effects/crt.fx",
    "src/modules/shared/reshade/shader-collection/crt-royale/Shaders/crt-royale/lib/special-functions.fxh",
    "src/modules/android/providers/aim/resources/maclauncher-aim","src/modules/rgss/evb-files.py",
    "src/modules/shared/installers/native/inno-inspect.cpp","src/modules/bgi/inspect.js"])
    assert.equal(selected(file),true,`Runtime or developer input unintentionally excluded: ${file}`);
  const resource=build.extraResources.find(item=>item.from==="src/resources");
  const resources=new FileMatcher(path.join(projectRoot,resource.from),"/packaged-resources",value=>value,resource.filter);
  for(const file of ["native-runtimes/reshade/version/universal/source.tar.gz",
    "native-runtimes/android-privacy/version/arm64/LICENSE.txt","native-runtimes/reshade/version/universal/libreshade-macos.dylib"])
    assert.equal(selectedBy(resources,file),true,`Runtime source, notice or binary excluded: ${file}`);
});

test("managed Android runtime payloads are excluded while owned integration helpers remain included", () => {
  const distribution = require('../scripts/distribution-model.cjs');
  const plan = distribution.createPlan({arch:'arm64', maximumMacOS:'26.0'});
  const managed = new Set(['android', 'android-art', 'android-aim']);
  assert.equal(plan.packages.some(item => managed.has(item.managerId)), false);
  assert.equal(plan.supplementals.some(item => managed.has(item.id)), false);
  const helper = plan.supplementals.find(item => item.id === 'android-privacy');
  assert.ok(helper);
  const development = JSON.parse(fs.readFileSync(path.join(projectRoot,'src/modules/android/distribution-supplementals.json')));
  assert.deepEqual(helper, development.find(item => item.id === 'android-privacy'), 'Helper bytes and actual license declarations are unchanged');
  const direct = packageConfig().build.extraResources.find(item => item.from === 'src/resources');
  const planned = distribution.resourceRules(plan).find(item => item.from === 'src/resources');
  for (const rule of [direct, planned]) {
    const matcher = new FileMatcher(path.join(projectRoot,rule.from),'/packaged-resources',value=>value,rule.filter);
    for (const id of managed) for (const file of ['runtime.json','manifest.json','source.tar.gz','files/source.tar.gz','native/libklepton-jvm.dylib','art/host/linux-run','files/bin/aimctl'])
      assert.equal(selectedBy(matcher,`native-runtimes/${id}/version/arm64/${file}`),false,`Managed Android payload included: ${id}/${file}`);
    assert.equal(selectedBy(matcher,`native-runtimes/${helper.directoryRelative}/${helper.manifestRelative}`),true);
  }
  assert.equal(planned.filter.some(pattern => !pattern.startsWith('!') && /^native-runtimes\/(android|android-art|android-aim)\//.test(pattern)), false);
});

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
  for (const file of [".local/example/private.json", "src/modules/example/.local/private.json", "src/modules/example/.env.local",
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

test("Flash Player is excluded from app files and unpacked resources", () => {
  const packageJsonPath = path.resolve(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const asarUnpack = Array.isArray(pkg?.build?.asarUnpack) ? pkg.build.asarUnpack : [];

  assert.ok(!asarUnpack.some(pattern => pattern.includes("flash-player")));
  assert.ok(pkg.build.files.includes("!src/modules/flash/resources/flash-player{,/**}"));
});

test("Builder preserves existing signatures of unpacked native helpers without skipping app signing", async () => {
  const { MacTargetHelper } = require("app-builder-lib/out/mac/MacTargetHelper");
  const helper = new MacTargetHelper({ config: { electronVersion: packageConfig().devDependencies.electron } });
  helper.getOptionsForFile = async () => () => ({});
  const app = "/application/MacLauncher.app";
  const options = await helper.buildSignOptions(app, { name: "-" }, "distribution", false,
    packageConfig().build.mac, undefined, require("builder-util").Arch.arm64);
  for (const file of ["src/modules/siglus/resources/native-host/macos-universal/siglus-host",
    "src/modules/android/providers/aim/resources/maclauncher-aim"]) {
    const full = `${app}/Contents/Resources/app.asar.unpacked/${file}`;
    assert.equal(options.ignore(full), true, `Pre-signed helper would be changed: ${file}`);
    assert.equal(options.ignore(full + "-other"), false, `Signature exclusion covers another file: ${file}`);
  }
  assert.equal(options.ignore(app), false);
  assert.equal(options.ignore(`${app}/Contents/MacOS/MacLauncher`), false);
  assert.equal(options.ignore(`${app}/Contents/Frameworks/Electron Framework.framework/Electron Framework`), false);
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
