const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Godot = require("../src/modules/godot/main"), Metadata = require("../src/modules/godot/metadata");
const Icons = require("../src/core/icon-utils"), {createGameMetadataService} = require("../src/core/game-metadata");
const GameStore = require("../src/core/game-store");
const Svg = require("../src/modules/godot/svg-icon");
const {pack, settings: binarySettings} = require("./helpers/godot-pack");
const png = Icons.encodePngBitmap({width: 1, height: 1, buffer: Buffer.from([30, 80, 140, 255])});
const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "godot-metadata-")));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const project = path.join(root, "project"), userDataDir = path.join(root, "data");fs.mkdirSync(project);
  return {root, project, userDataDir};
}
function detect(project) {return Godot.detectGame({rootDir: project, inputPath: project, stat: fs.statSync(project)});}
test("source project detection reads declared titles without evaluating resource expressions", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, "project.godot"), String.raw`config_version=5
[application]
config/name="Truck \"Town\" 日本語" ; label
[display]
config/name="Not the application"
`);
  let detected = detect(f.project);
  assert.equal(detected.name, 'Truck "Town" 日本語');assert.equal(detected.moduleData.projectName, detected.name);
  fs.writeFileSync(path.join(f.project, "project.godot"), 'config_version=5\n[application]\nconfig/name=Resource("res://name.tres")\n');
  assert.equal(detect(f.project).name, "project");
  fs.unlinkSync(path.join(f.project, "project.godot"));
  fs.writeFileSync(path.join(f.project, "engine.cfg"), '[application]\nname="Legacy title"\nicon="res://icon.png"\n');
  assert.equal(detect(f.project).name, "Legacy title");
});
test("project metadata rejects unsafe resource paths, malformed titles and oversized configs", t => {
  const f = fixture(t), config = path.join(f.project, "project.godot"), outside = path.join(f.root, "outside.png");fs.writeFileSync(outside, png);
  fs.symlinkSync(outside, path.join(f.project, "linked.png"));
  for (const icon of ['res://../outside.png', 'res://linked.png', outside, 'user://icon.png']) {
    fs.writeFileSync(config, '[application]\nconfig/name="Valid"\nconfig/icon=' + JSON.stringify(icon) + '\n');
    assert.equal(Metadata.icon(Metadata.read(f.project)), null);
  }
  fs.writeFileSync(config, '[application]\nconfig/name="Line\\nBreak"\n');assert.equal(Metadata.read(f.project).name, null);
  fs.writeFileSync(config, ' '.repeat(1024 * 1024 + 1));assert.equal(Metadata.read(f.project), null);
  fs.unlinkSync(config);fs.symlinkSync(outside, config);assert.equal(Metadata.read(f.project), null);
});
test("ordinary metadata refresh replaces old folder names and module-default icons for PNG and WebP", async t => {
  for (const [extension, bytes] of [["png", png], ["webp", webp]]) {
    const f = fixture(t), config = path.join(f.project, "project.godot"), icon = path.join(f.project, "icon." + extension);
    fs.writeFileSync(config, `config_version=5\n[application]\nconfig/name="Truck Town"\nconfig/icon="res://icon.${extension}"\n`);fs.writeFileSync(icon, bytes);
    const registry = {listModuleIds: () => ["godot"], listModules: () => [Godot.manifest], getModuleInfo: () => Godot.manifest,
      getModule: () => Godot, getModuleDir: () => path.resolve(__dirname, "../src/modules/godot"), detectGameAsync: async () => detect(f.project)};
    const entry = {...detect(f.project), gameId: "metadata", moduleId: "godot", runtimeId: "godot", importPath: f.project,
      name: "project", moduleData: {...detect(f.project).moduleData, projectName: undefined},
      iconPath: path.resolve(__dirname, "../src/modules/godot/resources/icon.png"), iconSource: "module-default"};
    GameStore.writeGameRecord(f.userDataDir, entry);
    const source = fs.readFileSync(config), settings = {modules: {godot: {}}, runtimes: {}};
    const service = createGameMetadataService({userDataDir: f.userDataDir, registry});
    let refreshed = await service.refreshEntry(entry, settings);
    assert.equal(refreshed.name, "Truck Town");assert.equal(refreshed.iconPath, icon);assert.equal(refreshed.iconSource, "module");
    assert.equal(GameStore.readGameRecord(f.userDataDir, entry.gameId).name, "Truck Town");assert.deepEqual(fs.readFileSync(config), source);
    fs.writeFileSync(config, `config_version=5\n[application]\nconfig/name="Updated source title"\nconfig/icon="res://icon.${extension}"\n`);
    refreshed = await service.refreshEntry(refreshed, settings);
    assert.equal(refreshed.name, "Updated source title", "ordinary refresh observes changed source metadata without a forced scan");
    const customIcon = path.join(f.project, "custom.png");fs.writeFileSync(customIcon, png);
    refreshed = {...refreshed, name: "Custom library title", iconPath: customIcon, iconSource: "custom"};GameStore.writeGameRecord(f.userDataDir, refreshed);
    fs.writeFileSync(config, `config_version=5\n[application]\nconfig/name="Another source title"\nconfig/icon="res://icon.${extension}"\n`);
    const custom = await service.refreshEntry(refreshed, settings, {force: true});
    assert.equal(custom.name, "Custom library title");assert.equal(custom.iconPath, customIcon);assert.equal(custom.iconSource, "custom");
  }
});
test("exported metadata refresh uses the declared native ICO before the generic icon and preserves custom metadata", async t => {
  const f = fixture(t), source = path.join(f.project, "Game.exe");
  const ico = Buffer.alloc(22 + png.length);ico.writeUInt16LE(1, 2);ico.writeUInt16LE(1, 4);ico[6] = ico[7] = 1;ico.writeUInt16LE(32, 12);ico.writeUInt32LE(png.length, 14);ico.writeUInt32LE(22, 18);png.copy(ico, 22);
  const generic = Icons.encodePngBitmap({width: 1, height: 1, buffer: Buffer.from([240, 20, 30, 255])});
  const value = pack({"project.binary": binarySettings({"application/config/name": "Packed title 日本語", "application/config/icon": "res://icon.png", "application/config/windows_native_icon": "res://Game_Icon.ico"}), "icon.png": generic, "Game_Icon.ico": ico});
  fs.writeFileSync(source, value.buffer);const before = fs.readFileSync(source);
  const detectExport = () => Godot.detectGame({rootDir: f.project, inputPath: source, stat: fs.statSync(source)});
  const registry = {listModuleIds: () => ["godot"], listModules: () => [Godot.manifest], getModuleInfo: () => Godot.manifest,
    getModule: () => Godot, getModuleDir: () => path.resolve(__dirname, "../src/modules/godot"), detectGameAsync: async () => detectExport()};
  const entry = {...detectExport(), gameId: "packed", moduleId: "godot", runtimeId: "godot", importPath: source,
    iconPath: path.resolve(__dirname, "../src/modules/godot/resources/icon.png"), iconSource: "module-default"};
  GameStore.writeGameRecord(f.userDataDir, entry);
  const service = createGameMetadataService({userDataDir: f.userDataDir, registry}), runtimeSettings = {modules: {godot: {}}, runtimes: {}};
  const refreshed = await service.refreshEntry(entry, runtimeSettings);
  assert.equal(refreshed.name, "Packed title 日本語");assert.equal(refreshed.moduleData.projectName, refreshed.name);assert.equal(refreshed.iconSource, "module");
  assert.deepEqual(fs.readFileSync(refreshed.iconPath), png, "the exported native icon is used instead of the generic project icon");
  const time = fs.statSync(refreshed.iconPath).mtimeMs;assert.equal((await service.refreshEntry(refreshed, runtimeSettings)).iconPath, refreshed.iconPath);assert.equal(fs.statSync(refreshed.iconPath).mtimeMs, time);
  const customIcon = path.join(f.project, "custom.png");fs.writeFileSync(customIcon, generic);
  const custom = {...refreshed, name: "Custom title", iconPath: customIcon, iconSource: "custom"};GameStore.writeGameRecord(f.userDataDir, custom);
  const kept = await service.refreshEntry(custom, runtimeSettings, {force: true});assert.equal(kept.name, "Custom title");assert.equal(kept.iconPath, customIcon);assert.equal(kept.iconSource, "custom");
  assert.deepEqual(fs.readFileSync(source), before);
});
test("exported icon metadata rejects external paths, oversized values and damaged resource checksums", async t => {
  const f = fixture(t), source = path.join(f.project, "Game.exe");
  for (const icon of ["res://../outside.png", "file:///outside.png", "user://outside.png"]) {
    const value = pack({"project.binary": binarySettings({"application/config/name": "Game", "application/config/icon": icon}), "icon.png": png});fs.writeFileSync(source, value.buffer);
    const entry = {gameId: "pack", moduleData: {packPath: source, packOffset: value.offset, packSize: value.size}};
    assert.equal(await Godot.resolveGameIcon(entry, f), null);
  }
  const value = pack({"project.binary": binarySettings({"application/config/name": "Game", "application/config/icon": "res://icon.png"}), "icon.png": png});value.buffer[value.offset + value.size - 1] ^= 1;fs.writeFileSync(source, value.buffer);
  const entry = {gameId: "pack", moduleData: {packPath: source, packOffset: value.offset, packSize: value.size}};
  assert.equal(await Godot.resolveGameIcon(entry, f), null);
  assert.equal(Metadata.binarySettings(Buffer.alloc(1024 * 1024 + 1)), null);
});
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" viewBox="0 0 64 32"><defs><linearGradient id="paint"><stop stop-color="#28a0c8"/></linearGradient></defs><rect width="64" height="32" fill="url(#paint)"/></svg>';
test("source SVG validation permits local shapes and rejects active or externally linked resources", () => {
  assert.equal(Svg.safeSvg(Buffer.from(svg)), true);
  for (const unsafe of ['<!DOCTYPE svg [<!ENTITY load SYSTEM "file:///secret">]>' + svg,
    svg.replace('<svg ', '<svg onload="alert(1)" '), svg.replace('<rect ', '<rect onclick="alert(1)" '),
    svg.replace('<defs>', '<script>alert(1)</script><defs>'), svg.replace('<defs>', '<foreignObject><div/></foreignObject><defs>'),
    svg.replace('url(#paint)', 'url(https://example.invalid/image)'), svg.replace('url(#paint)', 'url(file:///secret)'),
    svg.replace('<defs>', '<use href="https://example.invalid/icon.svg#icon"/><defs>'),
    svg.replace('<defs>', '<style>@import "https://example.invalid/style";</style><defs>'),
    svg.replace('<defs>', '<use href="&#35;paint"/><defs>'), svg.replace('<defs>', '<set attributeName="href" to="https://example.invalid"/><defs>')])
    assert.equal(Svg.safeSvg(Buffer.from(unsafe)), false);
  assert.equal(Svg.safeSvg(Buffer.alloc(256 * 1024 + 1)), false);
});
test("SVG conversion uses an immutable validated snapshot, reuses its content cache and honors overrides", async t => {
  const f = fixture(t), file = path.join(f.project, "icon.svg");fs.writeFileSync(file, svg);
  const metadata = {root: f.project, iconPath: file}, entry = {gameId: "svg", moduleData: {projectRoot: f.project}};
  let conversions = 0;
  const runCommand = async (command, args, options) => {
    conversions++;assert.equal(command, "/usr/bin/osascript");assert.equal(options.timeout, 10000);assert.equal(options.killSignal, "SIGKILL");
    assert.equal(path.dirname(args[2]), path.dirname(args[3]), "the converter script is materialized outside any app.asar");
    assert.deepEqual(fs.readFileSync(args[2]), fs.readFileSync(path.resolve(__dirname, "../src/modules/godot/svg-icon.jxa")));
    assert.notEqual(args[3], file);assert.equal(fs.readFileSync(args[3], "utf8"), svg);
    fs.writeFileSync(file, '<svg><image href="https://example.invalid"/></svg>');
    assert.equal(fs.readFileSync(args[3], "utf8"), svg, "source replacement cannot change the validated converter input");
    fs.writeFileSync(args[4], png);
  };
  const output = await Svg.prepare(metadata, entry, {...f, runCommand});assert.ok(output);assert.equal(conversions, 1);
  fs.writeFileSync(file, svg);assert.equal(await Svg.prepare(metadata, entry, {...f, runCommand}), output);assert.equal(conversions, 1);
  assert.deepEqual(fs.readFileSync(output), png);
  fs.writeFileSync(path.join(f.project, "project.godot"), '[application]\nconfig/icon="res://icon.svg"\n');
  assert.equal(await Godot.resolveGameIcon({...entry, iconPath: path.join(f.project, "custom.png"), iconSource: "custom"},
    {...f, runCommand: () => assert.fail("Custom artwork bypasses project conversion")}), null);
});
test("SVG conversion failure is optional and cancellation cleans its temporary snapshot", async t => {
  const f = fixture(t), file = path.join(f.project, "icon.svg");fs.writeFileSync(file, svg);
  const metadata = {root: f.project, iconPath: file}, entry = {gameId: "svg"};
  assert.equal(await Svg.prepare(metadata, entry, {...f, runCommand: async () => {throw Error("Unsupported image");}}), null);
  const controller = new AbortController(), reason = Object.assign(new Error("Metadata cancelled"), {name: "AbortError"});
  const pending = Svg.prepare(metadata, entry, {...f, signal: controller.signal, runCommand: async (_command, _args, {signal}) => {
    controller.abort(reason);signal.throwIfAborted();
  }});
  await assert.rejects(pending, error => error === reason);
  const directory = path.join(f.userDataDir, "games", "svg", "modules", "godot", "icons");
  assert.deepEqual(fs.readdirSync(directory), [], "failed conversion and cancellation publish no image or temporary snapshot");
});
test("AppKit rasterizes declared SVG through the normal module icon pipeline without changing source", {skip: process.platform !== "darwin"}, async t => {
  const f = fixture(t), file = path.join(f.project, "icon.svg");fs.writeFileSync(file, svg);
  fs.writeFileSync(path.join(f.project, "project.godot"), '[application]\nconfig/name="Vector project"\nconfig/icon="res://icon.svg"\n');
  const entry = {...detect(f.project), gameId: "svg"};
  const output = await Godot.resolveGameIcon(entry, {userDataDir: f.userDataDir});assert.ok(output);
  const bitmap = fs.readFileSync(output);assert.ok(Icons.isSupportedImageBuffer(bitmap));
  assert.equal(bitmap.readUInt32BE(16), 64);assert.equal(bitmap.readUInt32BE(20), 32);
  assert.equal(fs.readFileSync(file, "utf8"), svg);
  const before = fs.statSync(output).mtimeMs;
  assert.equal(await Godot.resolveGameIcon(entry, {userDataDir: f.userDataDir}), output);assert.equal(fs.statSync(output).mtimeMs, before);
  fs.writeFileSync(file, svg.replace("#28a0c8", "#c85028"));
  assert.notEqual(await Godot.resolveGameIcon(entry, {userDataDir: f.userDataDir}), output, "changed artwork gets a new content identity");
});
