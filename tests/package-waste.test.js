const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const { FileMatcher, getMainFileMatchers, getNodeModuleFileMatcher } = require("app-builder-lib/out/fileMatcher");
const { doMergeConfigs } = require("app-builder-lib/out/util/config/config");
const Content = require("../scripts/runtime-content.cjs");

const projectRoot = path.resolve(__dirname, "..");
function packageConfig() { return JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")); }
function selectedBy(matcher, relative) {
  return matcher.createFilter()(path.join(matcher.from, relative), { isDirectory: () => false });
}
function builderMatchers() {
  const build = Content.applyBuildPolicy(doMergeConfigs([packageConfig().build]));
  const info = { projectDir: projectRoot, buildResourcesDir: "build", config: build, isPrepackedAppAsar: false, debugLogger: { isEnabled: false } };
  return { build, sources: getMainFileMatchers(projectRoot, "/packaged-app", value => value, build.mac, { info }, path.join(projectRoot, build.directories.output), false),
    modules: getNodeModuleFileMatcher(projectRoot, "/packaged-app", value => value, build.mac, info) };
}

test("RPG Maker MV inputs ship once, from the layout their consumers read first", () => {
  const external = packageConfig().build.extraResources.find(rule => rule.from === "src/external");
  const matcher = new FileMatcher(path.join(projectRoot, external.from), "/packaged-resources/external", value => value, external.filter);
  const { getVersion } = require("../src/modules/mv/libs/catalog");
  const version = getVersion("mv-pixi", "pixi5-cicpoffs");
  const pixi = "rpgmakermlinux-cicpoffs/nwjs/packagefiles/rpgmaker-mv-pixi5";
  // The development lookup resolves the same layout that the package selects.
  assert.equal(version.bundleRoot, path.join(projectRoot, "src/external", pixi));
  for (const file of version.files) {
    assert.ok(fs.statSync(path.join(projectRoot, "src/external", pixi, file)).isFile(), file);
    assert.equal(selectedBy(matcher, `${pixi}/${file}`), true, file);
    assert.equal(selectedBy(matcher, `rpgmakermlinux-cicpoffs/nwjs/nwjs/packagefiles/rpgmaker-mv-pixi5/${file}`), false, file);
  }
  const plugins = "rpgmakermlinux-cicpoffs/nwjs/packagefiles/filestoexport/plugins";
  for (const name of ["Clipboard_llule.js", "CustomizeMaxSaveFile.js"]) {
    assert.ok(fs.statSync(path.join(projectRoot, "src/external", plugins, name)).isFile(), name);
    assert.equal(selectedBy(matcher, `${plugins}/${name}`), true, name);
    assert.equal(selectedBy(matcher, `rpgmakermlinux-cicpoffs/nwjs/nwjs/packagefiles/plugins/${name}`), false, name);
  }
  // TypeScript declarations describe the engine API for editors; games load only the JavaScript.
  for (const name of ["rmmv.d.ts", "rmmv-pixi.d.ts"]) assert.equal(selectedBy(matcher, `${pixi}/js/${name}`), false, name);
  assert.equal(selectedBy(matcher, `${pixi}/LICENSE`), true);
});


test("npm source maps, browser bundles and schema sources stay out while every file the Steam clients load remains", () => {
  const { modules } = builderMatchers();
  for (const file of ["node_modules/protobufjs/dist/protobuf.js", "node_modules/protobufjs/dist/protobuf.js.map",
    "node_modules/protobufjs/dist/light/protobuf.min.js", "node_modules/steam-user/protobufs/common.proto",
    "node_modules/steam-user/protobufs/renderer/rendermessages.proto", "node_modules/bytebuffer/dist/bytebuffer.js",
    "node_modules/bytebuffer/dist/bytebuffer-dataview.min.js", "node_modules/bytebuffer/dist/bytebuffer.min.map",
    "node_modules/chardet/lib/encoding/index.js.map"])
    assert.equal(selectedBy(modules, file), false, file);
  for (const file of ["node_modules/steam-user/protobufs/generated/_load.js", "node_modules/steam-user/protobufs/generated/common.json",
    "node_modules/protobufjs/src/index.js", "node_modules/protobufjs/google/protobuf/descriptor.json", "node_modules/bytebuffer/dist/bytebuffer-node.js"])
    assert.equal(selectedBy(modules, file), true, file);
  const loaded = JSON.parse(execFileSync(process.execPath, ["-e",
    'for (const name of ["steam-user", "steam-session", "steam-appticket", "qrcode-generator"]) require(name);' +
    'process.stdout.write(JSON.stringify(Object.keys(require.cache)))'], { cwd: projectRoot, encoding: "utf8" }));
  const files = loaded.map(file => path.relative(projectRoot, file).split(path.sep).join("/")).filter(file => file.startsWith("node_modules/"));
  assert.ok(files.length > 100, "The Steam clients load their package graph");
  assert.deepEqual(files.filter(file => !selectedBy(modules, file)), [], "Loaded npm files excluded from the application");
});

test("native runtime resources contain exactly the selected included builds, whatever else the source tree holds", () => {
  const Model = require("../scripts/distribution-model.cjs");
  const nativeRoot = path.join(projectRoot, "src/resources/native-runtimes");
  for (const arch of ["arm64", "x64"]) {
    const plan = Model.createPlan({ arch, maximumMacOS: "13.0" });
    assert.deepEqual(plan.packages, [], "Game engines use managed delivery");
    assert.equal(new Set(plan.supplementals.map(item => `${item.id}/${item.arch}`)).size, plan.supplementals.length, "One build per included helper and processor");
    const resources = Model.resourceRules(plan, Content.applyBuildPolicy(doMergeConfigs([packageConfig().build])).extraResources)
      .find(rule => rule.from === "src/resources");
    const matcher = new FileMatcher(path.join(projectRoot, resources.from), "/resources", value => value, resources.filter);
    const selected = new Set(plan.supplementals.map(item => item.directoryRelative));
    for (const item of plan.supplementals) {
      assert.equal(selectedBy(matcher, `native-runtimes/${item.directoryRelative}/${item.files[0].path}`), true, item.directoryRelative);
      assert.equal(selectedBy(matcher, `native-runtimes/${item.id}/0.0.0-unselected/${item.arch}/${item.files[0].path}`), false, `${item.id} restage`);
    }
    for (const runtime of plan.runtimes.filter(row => row.includedExecution === "none"))
      assert.equal(selectedBy(matcher, `native-runtimes/${runtime.managerId}/1.0.0/${arch}/manifest.json`), false, `${runtime.managerId} is managed`);
    // Development restages and managed installs in this checkout never reach the app.
    if (!fs.existsSync(nativeRoot)) continue;
    for (const id of fs.readdirSync(nativeRoot)) for (const version of fs.statSync(path.join(nativeRoot, id)).isDirectory() ? fs.readdirSync(path.join(nativeRoot, id)) : []) {
      const directory = path.join(nativeRoot, id, version);
      if (!fs.statSync(directory).isDirectory()) continue;
      for (const leaf of fs.readdirSync(directory)) {
        const relative = `${id}/${version}/${leaf}`;
        if (!selected.has(relative)) assert.equal(selectedBy(matcher, `native-runtimes/${relative}/manifest.json`), false, relative);
      }
    }
  }
});

test("each module icon ships once, as the module file that main reads for games without artwork", () => {
  const Modules = require("../src/modules/registry");
  const { build, sources } = builderMatchers();
  const icons = Modules.listModules().map(manifest =>
    path.relative(projectRoot, path.join(Modules.getModuleDir(manifest.id), manifest.icon.path)).split(path.sep).join("/"));
  assert.ok(icons.length >= 21);
  for (const icon of icons) {
    assert.equal(sources.some(matcher => selectedBy(matcher, icon)), true, `Application files lack ${icon}`);
    for (const rule of build.extraResources) {
      const from = typeof rule === "string" ? rule : rule.from;
      if (!icon.startsWith(from + "/")) continue;
      const matcher = new FileMatcher(path.join(projectRoot, from), "/resources", value => value, rule.filter);
      assert.equal(selectedBy(matcher, path.relative(from, icon)), false, `${icon} also ships through ${from}`);
    }
  }
  // The renderer shows the icon URL that main sends, so its bundle imports no module artwork.
  const sourcesOfBundle = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--", "src/renderer/src", "src/modules"], { cwd: projectRoot, encoding: "utf8" })
    .split("\n").filter(file => /^src\/renderer\/src\/.*\.(ts|tsx|js|mjs|css)$|^src\/modules\/.*\.(ts|tsx|mts)$/.test(file) && !file.endsWith(".d.ts") &&
      fs.existsSync(path.join(projectRoot, file)));
  assert.ok(sourcesOfBundle.includes("src/renderer/src/ui/components/GameIcon.tsx"));
  for (const file of sourcesOfBundle)
    assert.doesNotMatch(fs.readFileSync(path.join(projectRoot, file), "utf8"), /modules\/[^"'`\n]*resources\/|resources\/icon\.png/, file);
});
