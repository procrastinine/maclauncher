const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Module = require("node:module");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const Godot = require("../src/modules/godot/main");
const { createLauncher } = require("../src/core/launcher");
const { pack, settings } = require("./helpers/godot-pack");

// The saved settings name .NET, so every Standard result below comes from the game.
const savedSettings = { runtimes: { godot: { defaultVariant: "mono" } } };
function directory(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runtime-variant-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "game"));
  return { root, game: path.join(root, "game"), context: { userDataDir: path.join(root, "profile"), settings: savedSettings, runtimeId: "godot" } };
}
// A Godot 4 export: a standalone pack beside the publisher's executable.
function exported(f, files, { version = 2, major = 4 } = {}) {
  const value = pack(files, { version, offset: 0, trailer: false }), source = path.join(f.game, "Game.pck");
  fs.writeFileSync(source, value.buffer);
  return { gameId: "variant", gamePath: f.game, runtimeId: "godot", runtimeData: {},
    moduleData: { packagedType: "pck", packPath: source, packOffset: 0, packSize: value.size, detectedVersion: `${major}.4.1`, detectedMajor: major } };
}
function install(f, version, build) {
  const app = path.join(f.context.userDataDir, "runtimes/godot", version, build, "Godot.app");
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents/Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Godot</string></dict></plist>');
  fs.writeFileSync(path.join(app, "Contents/MacOS/Godot"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}
const variant = (entry, f) => Godot.__test.resolveRuntimeVariant(f.context.settings, entry.runtimeData?.godot, entry, f.context.userDataDir);
const gdscript = { "project.binary": settings({ "application/config/name": "Plain" }), "main.gdc": Buffer.from("GDSC") };

test("a GDScript-only Godot game downloads Standard only when no compatible build is installed", async t => {
  const f = directory(t), entry = exported(f, gdscript);
  // Native libraries beside the executable are not .NET assemblies.
  fs.writeFileSync(path.join(f.game, "steam_api64.dll"), "MZ");
  const expect = (build, message) => {
    assert.equal(variant(entry, f), build, message);
    assert.equal(Godot.runtimeRecommendation(entry, f.context).variant, build, "The inspector's Default entry follows Play");
    assert.equal(Godot.actions.runtimeStatus(entry, {}, f.context).requiredVariant, build);
  };
  expect("standard", "Nothing installed: Standard");
  assert.equal((await Godot.ensureRuntime(entry, f.context)).installOptions.variant, "standard", "Play downloads Standard");
  install(f, "4.3-stable", "mono");
  expect("standard", "A .NET build of another version is not compatible");
  install(f, "4.4.1-stable", "mono");
  expect("mono", "Only .NET installed: .NET");
  assert.equal(await Godot.ensureRuntime(entry, f.context), null, "Play runs on the installed .NET build without a download");
  install(f, "4.4.1-stable", "standard");
  expect("standard", "Both installed: Standard");
  assert.equal(await Godot.ensureRuntime(entry, f.context), null);
  assert.equal(variant({ ...entry, moduleData: { detectedMajor: 2 } }, f), "standard", "Godot 1 and 2 have only Standard builds");
});

test("a Godot game with .NET assemblies or a C# declaration defaults to .NET", async t => {
  const f = directory(t), entry = exported(f, gdscript);
  const data = path.join(f.game, "data_Plain_windows_x86_64");
  fs.mkdirSync(data);
  assert.equal(variant(entry, f), "standard", "An empty data folder holds no assemblies");
  fs.writeFileSync(path.join(data, "Plain.dll"), "MZ");
  assert.equal(variant(entry, f), "mono");
  assert.equal(Godot.runtimeRecommendation(entry, f.context).variant, "mono");
  assert.equal(Godot.actions.runtimeStatus(entry, {}, f.context).requiredVariant, "mono");
  assert.equal((await Godot.ensureRuntime(entry, f.context)).installOptions.variant, "mono");
  fs.rmSync(data, { recursive: true });
  // Godot 3 Mono exports nest their assemblies in data_<name>/Assemblies.
  const legacy = exported(f, gdscript, { version: 1, major: 3 });
  fs.mkdirSync(path.join(f.game, "data_Plain", "Assemblies"), { recursive: true });
  fs.writeFileSync(path.join(f.game, "data_Plain", "Assemblies", "Plain.dll"), "MZ");
  assert.equal(variant(legacy, f), "mono");
  fs.rmSync(path.join(f.game, "data_Plain"), { recursive: true });
  const declared = exported(f, { "project.binary": settings({ "application/config/name": "Sharp", "dotnet/project/assembly_name": "Sharp" }) });
  assert.equal(variant(declared, f), "mono", "A pack that declares C# needs .NET without a data folder");
  fs.rmSync(path.join(f.game, "Game.pck"));
  const project = { gameId: "project", gamePath: f.game, runtimeId: "godot", runtimeData: {},
    moduleData: { packagedType: "project-dir", packagedPath: f.game, projectRoot: f.game, detectedMajor: 4 } };
  fs.writeFileSync(path.join(f.game, "project.godot"), '[application]\nconfig/name="Project"\n');
  assert.equal(variant(project, f), "standard");
  fs.writeFileSync(path.join(f.game, "Project.csproj"), "<Project />");
  assert.equal(variant(project, f), "mono");
});

test("a per-game Godot variant applies unless the game needs .NET", async t => {
  const f = directory(t), plain = exported(f, gdscript);
  install(f, "4.4.1-stable", "standard");
  plain.runtimeData = { godot: { variant: "mono" } };
  assert.equal(variant(plain, f), "mono", "An explicit .NET choice precedes the installed Standard build");
  assert.equal(Godot.actions.runtimeStatus(plain, {}, f.context).requiredVariant, "mono");
  assert.equal((await Godot.ensureRuntime(plain, f.context)).installOptions.variant, "mono");
  assert.equal(Godot.runtimeRecommendation(plain, f.context).variant, "standard", "The Default entry names the automatic choice");
  assert.equal(Godot.runtimeRecommendation(plain, f.context).requiredVariant, undefined, "A GDScript game requires no variant");
  fs.mkdirSync(path.join(f.game, "data_Plain_windows_x86_64"));
  fs.writeFileSync(path.join(f.game, "data_Plain_windows_x86_64", "Plain.dll"), "MZ");
  const managed = { ...plain, runtimeData: { godot: { variant: "standard" } } };
  assert.equal(variant(managed, f), "mono", "A game that needs .NET uses it despite a Standard choice");
  assert.equal(Godot.actions.runtimeStatus(managed, {}, f.context).requiredVariant, "mono");
  assert.equal((await Godot.ensureRuntime(managed, f.context)).installOptions.variant, "mono");
  assert.deepEqual((({ variant, requiredVariant, requiredVariantReason }) => ({ variant, requiredVariant, requiredVariantReason }))(
    Godot.runtimeRecommendation(managed, f.context)), { variant: "mono", requiredVariant: "mono", requiredVariantReason: "This game uses C#, so it needs the .NET build." });
});

test("the launcher passes a module's recommended variant with or without a recommended version", async t => {
  const f = directory(t);
  let recommendation = { variant: "dotnet" };
  const manifest = { id: "test", label: "Test engine", gameType: "native", settingsDefaults: { defaultRuntime: "runner" },
    runtime: { default: "runner", supported: ["runner"], entries: { runner: {} }, manager: { runner: "fixture-manager" } } };
  const mod = { id: "test", manifest, runtimeRecommendation: () => recommendation };
  const launcher = createLauncher({ userDataDir: f.context.userDataDir, registry: {
    listModules: () => [manifest], getModule: id => id === "test" ? mod : null, getModuleInfo: () => manifest,
    detectGame: input => ({ moduleId: "test", gamePath: input, name: "Test game", moduleData: {} }) } });
  const entry = await launcher.resolveEntry(f.game);
  assert.deepEqual(await launcher.runAction(entry, "runtimeRecommendation"), { managerId: "fixture-manager", variant: "dotnet" });
  recommendation = { version: "2.0", sectionId: "stable", variant: "dotnet" };
  assert.deepEqual(await launcher.runAction(entry, "runtimeRecommendation"),
    { managerId: "fixture-manager", version: "2.0", variant: "dotnet", sectionId: "stable" });
  recommendation = { variant: "dotnet", requiredVariant: "dotnet", requiredVariantReason: "Needs .NET." };
  assert.deepEqual(await launcher.runAction(entry, "runtimeRecommendation"),
    { managerId: "fixture-manager", variant: "dotnet", requiredVariant: "dotnet", requiredVariantReason: "Needs .NET." });
  recommendation = { sectionId: "stable" };
  assert.equal(await launcher.runAction(entry, "runtimeRecommendation"), null);
});

test("the inspector's Default variant names the game's recommended variant and keeps the version label", async () => {
  const { build } = require("vite");
  const bundle = await build({ configFile: false, logLevel: "silent", build: { ssr: true, write: false,
    rollupOptions: { input: path.resolve(__dirname, "../src/renderer/src/ui/components/GameDetails.tsx"),
      external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs" } } } });
  const compiled = new Module(path.join(__dirname, "runtime-variant-components.cjs"), module);
  compiled.paths = module.paths;
  compiled._compile(bundle.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  const state = require("./library-layout-fixture").createLibraryFixture(), g = state.recents[0];
  const render = (status, runtimeData = {}) => renderToStaticMarkup(React.createElement(compiled.exports.GameDetails, {
    g: { ...g, runtimeData: { managed: runtimeData } }, state, moduleInfo: state.modules[0], actions: {},
    moduleActionResults: {}, moduleActionBusy: {}, runtimeStatusEntry: status ? { runtimeId: "managed", status } : null }));
  const defaultOption = markup => /aria-label="Runtime variant"[^>]*>\s*<option value=""[^>]*>([^<]*)</.exec(markup)?.[1];
  assert.equal(defaultOption(render(null)), "Default (Apple Silicon)", "Without a recommendation the manager default applies");
  const recommended = render({ runtimeRecommendation: { managerId: "fixture-manager", variant: "x64" } });
  assert.equal(defaultOption(recommended), "Default (Intel)");
  assert.doesNotMatch(recommended, /Recommended \(/, "A variant alone does not recommend a version");
  assert.doesNotMatch(recommended, /aria-label="Install recommended version"/);
  assert.equal(defaultOption(render({ runtimeRecommendation: { managerId: "fixture-manager", variant: "x64" } }, { variant: "arm64" })),
    "Default (Intel)", "An override keeps the automatic choice in the Default entry");
});

test("a variant the game requires is the inspector's effective choice, installs, and leaves the saved choice in place", async t => {
  const { build } = require("vite"), { react, componentHarness } = require("./helpers/renderer-component");
  const bundle = await build({ configFile: false, logLevel: "silent", build: { ssr: true, write: false,
    rollupOptions: { input: path.resolve(__dirname, "../src/renderer/src/ui/components/GameDetails.tsx"),
      external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } } } });
  const compiled = new Module(path.join(__dirname, "runtime-required-variant.cjs"), module);
  compiled.paths = module.paths;
  compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  const state = require("./library-layout-fixture").createLibraryFixture();
  const g = { ...state.recents[0], runtimeData: { managed: { variant: "arm64" } } }, saved = structuredClone(g.runtimeData);
  const installs = [], writes = [], reason = "This game needs the Intel build.";
  const actions = new Proxy({ onInstallRuntime: async (...args) => { installs.push(args); },
    onSetRuntimeData: async (...args) => { writes.push(args); } }, { get: (target, key) => target[key] || (async () => {}) });
  const harness = componentHarness(compiled.exports.GameDetails.type, { g, state, moduleInfo: state.modules[0], actions,
    moduleActionResults: {}, moduleActionBusy: {}, moduleActionError: null, runtimeStatusEntry: { runtimeId: "managed", status: {
      runtimeRecommendation: { managerId: "fixture-manager", version: "2.0", variant: "arm64", requiredVariant: "x64", requiredVariantReason: reason } } } });
  t.after(() => harness.close());
  const tree = harness.render();
  const nodes = (node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(child => nodes(child))] : []);
  const all = nodes(tree), menu = all.find(node => node.props["aria-label"] === "Runtime variant");
  assert.equal(menu.props.value, "", "The required variant replaces the saved choice as the selection");
  const options = nodes(menu).filter(node => node.type === "option");
  assert.equal(React.Children.toArray(options[0].props.children).join(""), "Default (Intel)");
  assert.deepEqual(options.slice(1).map(node => [node.props.value, Boolean(node.props.disabled), node.props.title]),
    [["arm64", true, reason], ["x64", false, undefined]]);
  assert.ok(all.some(node => node.props.className === "detailMeta" && React.Children.toArray(node.props.children).join("") === reason));
  all.find(node => node.props["aria-label"] === "Install recommended version").props.onClick();
  assert.deepEqual(installs, [["fixture-manager", "stable", "2.0", "x64"]], "Install follows the variant Play uses");
  assert.deepEqual(writes, []);
  assert.deepEqual(g.runtimeData, saved, "The saved choice stays");
});
