const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");
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

// Producer inputs that MacLauncher Builds compiles from the source tree. Their outputs ship in packages,
// so the application itself never reads these files.
const nativeBuildInputs = ["src/modules/crossover/temporal/dxmt{,/**}",
  "src/modules/crossover/temporal/{fidelityfx,streamline,xess}/{build.mjs,*.cpp,*.h,*.hpp}",
  "src/modules/crossover/temporal/xess/reference-exports.json", "src/modules/godot/graphics/{build.mjs,bridge.cpp,*.gd,*.glsl}",
  "src/modules/shared/reshade/{blur,cacao,cmaa2,dof,kuwahara,ssr,xegtao}/{build.mjs,*.hlsl}",
  "src/modules/shared/reshade/dof/generated/*.{hpp,json}", "src/modules/shared/reshade/{lens,libplacebo}{,/**}",
  "src/modules/shared/reshade/{stage-royale.mjs,shaderc-offline.cpp}", "src/modules/shared/reshade/temporal/*.{h,hpp}",
  "src/modules/shared/reshade/temporal/*/{build.mjs,adapt-runtime.mjs,*.mm,*.hpp}", "src/modules/shared/vulkan/native{,/**}",
  "src/modules/shared/runtime/steamworks/{build,source-overlay}.js",
  "src/modules/java/runtime/steamworks/{build-agent.cjs,stage-bridge.cjs,*.java}", "src/modules/love/runtime/luasteam-build.js",
  "src/modules/mages/native/{current-windows.patch,current-windows-overlay.json,dependency-overlays.json,ffmpeg-probe.c,portable-overlay.js}",
  "src/modules/ios/native{,/**}", "src/modules/shared/web/native{,/**}", "src/modules/video/native{,/**}"];
// Mentions that are not reads: the Godot module and the graphics declarations name the scripts inside the
// built graphics package, the LÖVE notice names the Builds producer, and comments cite native headers.
const nonReadingMentions = {
  "src/modules/godot/graphics/aov-effect.gd": ["src/modules/godot/graphics/index.js", "src/modules/shared/reshade/distribution-supplementals.json"],
  "src/modules/godot/graphics/autoload.gd": ["src/modules/godot/graphics/index.js", "src/modules/shared/reshade/distribution-supplementals.json"],
  "src/modules/godot/graphics/camera-effect.gd": ["src/modules/godot/graphics/index.js", "src/modules/shared/reshade/distribution-supplementals.json"],
  "src/modules/love/runtime/luasteam-build.js": ["src/modules/love/runtime/luasteam-package.js"],
  "src/modules/shared/reshade/temporal/frame.h": ["src/modules/shared/reshade/temporal-controls.js"],
  "src/modules/shared/reshade/temporal/payload-files.hpp": ["src/modules/shared/runtime/payload-files.js"] };
const commonNames = new Set(["build.mjs", "build.js", "source.json", "source-overlay.js", "patch.mjs", "index.js", "README.md"]);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const named = (text, name) => text.includes(name) && new RegExp(`(^|[^\\w.-])${escape(name)}(?![\\w-])`).test(text);
// A file refers to another by its relative path, a module specifier, its parent directory and name,
// its name from the same directory, or, for distinctive names, its name anywhere.
function refers(reader, text, file) {
  const name = path.posix.basename(file), directory = path.posix.dirname(file), from = path.posix.dirname(reader);
  const stem = /\.(js|cjs|mjs|json)$/.test(name) ? name.replace(/\.[^.]+$/, "") : null;
  if (!text.includes(stem || name)) return false;
  const relative = path.posix.relative(from, file);
  if (relative.includes("/") && named(text, relative)) return true;
  if (stem) {
    const specifier = path.posix.relative(from, path.posix.join(directory, stem));
    if (new RegExp(`['"\`]${specifier.startsWith(".") ? "" : "\\./"}${escape(specifier)}['"\`]`).test(text)) return true;
  }
  return named(text, `${path.posix.basename(directory)}/${name}`) || (from === directory || !commonNames.has(name)) && named(text, name);
}

test("native build inputs stay in the source tree, and nothing the application ships reads them", () => {
  const matches = matchers => { const filters = matchers.map(matcher => matcher.createFilter());
    return file => filters.some(filter => filter(path.join(projectRoot, file), { isDirectory: () => false })); };
  const shipped = matches(builderMatchers().sources);
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--", "src"], { cwd: projectRoot, encoding: "utf8" })
    .split("\n").filter(file => file && !/^src\/(external|resources)\//.test(file) && fs.existsSync(path.join(projectRoot, file)));
  const rules = packageConfig().build.files;
  const inputs = new Set();
  for (const pattern of nativeBuildInputs) {
    assert.ok(rules.includes(`!${pattern}`), `Packaging rule missing: !${pattern}`);
    const matched = files.filter(matches([new FileMatcher(projectRoot, "/inputs", value => value, [pattern])]));
    assert.ok(matched.length, `No source file matches ${pattern}`);
    for (const file of matched) inputs.add(file);
  }
  // The renderer reaches the application through its bundle, so its sources count as shipped readers.
  const readers = files.filter(file => /\.(js|cjs|mjs|ts|tsx|json|lua|rb|py|jxa)$/.test(file) && !inputs.has(file) &&
    (shipped(file) || file.startsWith("src/renderer/src/") && !/(__tests__|\.test\.)/.test(file)))
    .map(file => [file, fs.readFileSync(path.join(projectRoot, file), "utf8")]);
  const readersOf = file => readers.filter(([reader, text]) => refers(reader, text, file)).map(([reader]) => reader);
  // The search finds each way the application reads its own files.
  assert.ok(readersOf("src/modules/crossover/temporal/streamline/pe-exports.js").includes("src/modules/crossover/temporal/support-manager.js"));
  assert.ok(readersOf("src/modules/crossover/temporal/xess/source.json").includes("src/modules/crossover/temporal/xess/index.js"));
  assert.ok(readersOf("src/modules/love/runtime/luasteam-source-overlay.js").includes("src/modules/love/runtime/luasteam-package.js"));
  assert.ok(readersOf("src/modules/mages/native/impacto.patch").includes("src/modules/mages/native/adapter.js"));
  for (const file of ["src/modules/godot/graphics/index.js", "src/modules/godot/graphics/source.json", "src/modules/crossover/temporal/xess/source.json",
    "src/modules/crossover/temporal/streamline/pe-exports.js", "src/modules/love/runtime/luasteam-source-overlay.js",
    "src/modules/shared/reshade/temporal/fsr4/index.js", "src/modules/mages/native/impacto.patch"])
    assert.equal(shipped(file), true, file);
  for (const file of inputs) {
    assert.equal(shipped(file), false, `Native build input shipped: ${file}`);
    const allowed = nonReadingMentions[file] || [];
    assert.deepEqual(readersOf(file).filter(reader => !allowed.includes(reader)), [], `Application files refer to ${file}`);
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
