const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const Images = require("../src/core/icon-utils");
const Icons = require("../src/core/game-icons");
const RenpyIcons = require("../src/modules/renpy/icon");
const Renpy = require("../src/modules/renpy/main");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-icons-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, "Title", "game"), userDataDir = path.join(root, "launcher");
  fs.mkdirSync(game, { recursive: true });
  return { root, game, userDataDir };
}
const png = color => Images.encodePngBitmap({ width: 1, height: 1, buffer: Buffer.from(color || [255, 0, 0, 255]) });
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; }

test("folder imports use data-file siblings, explicit executable paths and bounded payload parents", t => {
  const f = fixture(t), root = path.dirname(f.game);
  for (const name of ["Title.exe", "Setup.exe", "unins000.exe", "dotNetFx40_Full_x86_x64.exe"]) write(path.join(root, name), "exe");
  const data = write(path.join(root, "data.win"), "data");
  assert.deepEqual(Icons.resolveIconCandidates({ importPath: root, gamePath: data, contentRootDir: root, name: "Title" }).map(item => path.basename(item.path)), ["Title.exe"]);
  assert.equal(Icons.resolveIconCandidates({ importPath: root, gamePath: path.join(root, "Title.exe"), contentRootDir: root })[0].path, path.join(root, "Title.exe"));
  assert.equal(Icons.resolveIconCandidates({ importPath: root, gamePath: f.game, contentRootDir: f.game })[0].path, path.join(root, "Title.exe"));
  write(path.join(f.root, "OtherGame.exe"), "exe");
  assert.equal(Icons.resolveIconCandidates({ importPath: root, gamePath: root, contentRootDir: root }).some(item => item.path.endsWith("OtherGame.exe")), false);
});

test("invalid module and first executable icons fall through to a valid candidate", async t => {
  const f = fixture(t), root = path.dirname(f.game);
  const first = write(path.join(root, "Title.exe"), "exe"), second = write(path.join(root, "Other.exe"), "exe");
  const invalid = write(path.join(root, "bad.png"), Buffer.alloc(0)), valid = write(path.join(root, "valid.png"), png());
  const attempts = [], canRenderPath = file => { try { return Images.isSupportedImageBuffer(fs.readFileSync(file)); } catch { return false; } };
  const selected = await Icons.selectIconForEntry({ entry: { importPath: root, gamePath: first, name: "Title", iconPath: valid, iconSource: "exe" },
    moduleIconPath: invalid, moduleDefaultIconPath: invalid, canRenderPath,
    extractCandidate: candidate => { attempts.push(candidate.path); return candidate.path === second ? valid : null; } });
  assert.deepEqual(attempts, [first, second]); assert.deepEqual(selected, { path: valid, source: "exe" });
  assert.deepEqual(await Icons.selectIconForEntry({ entry: { iconPath: valid, iconSource: "module" }, canRenderPath, extractCandidate: () => assert.fail("No candidates") }), { path: null, source: null });
});

test("custom artwork wins over module artwork and suffixless app bundles remain candidates", async t => {
  const f = fixture(t), custom = write(path.join(f.root, "custom.png"), png()), moduleIcon = write(path.join(f.root, "module.png"), png([0, 255, 0, 255]));
  const selected = await Icons.selectIconForEntry({ entry: { iconPath: custom, iconSource: "custom" }, moduleIconPath: moduleIcon,
    canRenderPath: file => Images.isSupportedImageBuffer(fs.readFileSync(file)), extractCandidate: () => assert.fail("Custom artwork needs no extraction") });
  assert.deepEqual(selected, { path: custom, source: "custom" });
  const app = path.join(f.root, "Suffixless");
  write(path.join(app, "Contents", "Info.plist"), "plist"); fs.mkdirSync(path.join(app, "Contents", "MacOS"));
  assert.deepEqual(Icons.resolveIconCandidates({ gamePath: app, nativeAppPath: app }), [{ path: app, source: "app" }]);
});

test("optional extraction failure keeps later candidates and cancellation stays observable", async t => {
  const f = fixture(t), first = write(path.join(f.game, "Game.exe"), "exe"), next = write(path.join(f.game, "Other.exe"), "exe"), valid = write(path.join(f.root, "valid.png"), png());
  const controller = new AbortController(), entry = { importPath: f.game, gamePath: first, name: "Game" };
  const extractCandidate = candidate => { if (candidate.path === first) throw Error("Broken optional extractor"); assert.equal(candidate.path, next); return valid; };
  const selected = await Icons.selectIconForEntry({ entry, extractCandidate, canRenderPath: file => file === valid, signal: controller.signal });
  assert.deepEqual(selected, { path: valid, source: "exe" });
  await assert.rejects(Icons.selectIconForEntry({ entry, canRenderPath: () => false, signal: controller.signal,
    extractCandidate: () => { controller.abort(new Error("Cancelled")); throw Error("helper stopped"); } }), /Cancelled/);
});

function peIcon(file) {
  const resource = 0x400, bytes = Buffer.alloc(resource + 248), pe = 0x80, optional = pe + 24;
  bytes.write("MZ"); bytes.writeUInt32LE(pe, 0x3c); bytes.write("PE\0\0", pe); bytes.writeUInt16LE(1, pe + 6); bytes.writeUInt16LE(224, pe + 20);
  bytes.writeUInt16LE(0x10b, optional); bytes.writeUInt32LE(0x1000, optional + 112); bytes.writeUInt32LE(248, optional + 116);
  const section = optional + 224; bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(248, section + 16); bytes.writeUInt32LE(resource, section + 20);
  bytes.writeUInt16LE(2, resource + 14);
  for (const [offset, id, target] of [[16, 3, 32], [24, 14, 96]]) { bytes.writeUInt32LE(id, resource + offset); bytes.writeUInt32LE((target | 0x80000000) >>> 0, resource + offset + 4); }
  for (const [offset, id, target, directory] of [[32, 1, 56, true], [56, 1033, 80, false], [96, 1, 120, true], [120, 1033, 144, false]]) {
    bytes.writeUInt16LE(1, resource + offset + 14); bytes.writeUInt32LE(id, resource + offset + 16); bytes.writeUInt32LE(directory ? (target | 0x80000000) >>> 0 : target, resource + offset + 20);
  }
  bytes.writeUInt32LE(0x1000 + 184, resource + 80); bytes.writeUInt32LE(64, resource + 84);
  bytes.writeUInt32LE(0x1000 + 160, resource + 144); bytes.writeUInt32LE(20, resource + 148);
  const group = resource + 160; bytes.writeUInt16LE(1, group + 2); bytes.writeUInt16LE(1, group + 4);
  bytes[group + 6] = 2; bytes[group + 7] = 2; bytes.writeUInt16LE(1, group + 10); bytes.writeUInt16LE(32, group + 12); bytes.writeUInt32LE(64, group + 14); bytes.writeUInt16LE(1, group + 18);
  const dib = resource + 184; bytes.writeUInt32LE(40, dib); bytes.writeInt32LE(2, dib + 4); bytes.writeInt32LE(4, dib + 8); bytes.writeUInt16LE(1, dib + 12); bytes.writeUInt16LE(32, dib + 14);
  Buffer.from([255, 0, 0, 255, 255, 255, 255, 255, 0, 0, 255, 255, 0, 255, 0, 255]).copy(bytes, dib + 40);
  bytes[dib + 60] = 0x40;
  return write(file, bytes);
}
test("PE bitmap icons become standalone PNGs with correct RGBA, row order and transparency in Node", async t => {
  const f = fixture(t), exe = peIcon(path.join(f.root, "Game.exe"));
  const original = fs.readFileSync(exe), image = Images.extractExeIconPngBuffer(exe);
  assert.equal(Images.isSupportedImageBuffer(image), true); assert.equal(image.readUInt32BE(16), 2); assert.equal(image.readUInt32BE(20), 2);
  const length = image.readUInt32BE(33), pixels = zlib.inflateSync(image.subarray(41, 41 + length));
  assert.deepEqual([...pixels], [0, 255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255]);
  assert.deepEqual(fs.readFileSync(exe), original);
  const service = require("../src/core/backend-worker-client").createBackendService({ userDataDir: f.userDataDir });
  t.after(() => service.close());
  const extracted = await service.request("icons", "extractIcon", exe, "exe");
  assert.deepEqual(Buffer.from(extracted.png), image);
  assert.deepEqual(fs.readFileSync(exe), original);
  const broken = Buffer.from(image); broken[broken.length - 1] ^= 1; assert.equal(Images.isSupportedImageBuffer(broken), false);
});
test("source fingerprints change when the executable or selected app icon changes", t => {
  const f = fixture(t), exe = write(path.join(f.root, "Title.exe"), "old");
  const first = Icons.sourceFingerprint({ path: exe, source: "exe" }); write(exe, "new icon bytes");
  assert.notEqual(Icons.sourceFingerprint({ path: exe, source: "exe" }), first);
  const app = path.join(f.root, "Title.app"); write(path.join(app, "Contents/Info.plist"), '<plist><key>CFBundleIconFile</key><string>Title</string></plist>');
  const icon = write(path.join(app, "Contents/Resources/Title.icns"), "old icon"), before = Icons.sourceFingerprint({ path: app, source: "app" });
  write(icon, "changed icon"); assert.notEqual(Icons.sourceFingerprint({ path: app, source: "app" }), before);
});

const tuple = values => ({ tuple: values });
function pickleValue(value) {
  if (value === null) return Buffer.from("N");
  if (typeof value === "number") { const bytes = Buffer.alloc(5); bytes[0] = 0x4a; bytes.writeInt32LE(value, 1); return bytes; }
  if (typeof value === "string" || Buffer.isBuffer(value)) { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value), header = Buffer.alloc(5); header[0] = Buffer.isBuffer(value) ? 0x54 : 0x58; header.writeUInt32LE(bytes.length, 1); return Buffer.concat([header, bytes]); }
  if (Array.isArray(value)) return Buffer.concat([Buffer.from("]("), ...value.map(pickleValue), Buffer.from("e")]);
  if (value.tuple) return Buffer.concat([Buffer.from("("), ...value.tuple.map(pickleValue), Buffer.from("t")]);
  if (value.klass) return Buffer.concat([Buffer.from(`crenpy.ast\n${value.klass}\n`), pickleValue(tuple([])), Buffer.from([0x81]), pickleValue(value.state), Buffer.from("b")]);
  const entries = value instanceof Map ? [...value] : Object.entries(value);
  return Buffer.concat([Buffer.from("}("), ...entries.flatMap(([key, item]) => [pickleValue(key), pickleValue(item)]), Buffer.from("u")]);
}
const pickle = value => Buffer.concat([Buffer.from([0x80, 2]), pickleValue(value), Buffer.from(".")]);
function rpa(file, members) {
  const header = Buffer.from("RPA-2.0 0000000000000000\n"), chunks = [], index = new Map(); let offset = header.length;
  for (const [name, bytes] of Object.entries(members)) { const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes); index.set(name, [tuple([offset, data.length])]); chunks.push(data); offset += data.length; }
  header.write(offset.toString(16).padStart(16, "0"), 8);
  return write(file, Buffer.concat([header, ...chunks, zlib.deflateSync(pickle(index))]));
}
function compiledIcon(expression) {
  const define = { klass: "Define", state: { store: "store.config", varname: "window_icon", operator: "=", index: null,
    code: { klass: "PyCode", state: tuple([1, expression, tuple(["options.rpy", 10]), "eval", 3]) } } };
  const compressed = zlib.deflateSync(pickle(tuple([{}, [{ klass: "Init", state: { block: [define] } }]]))), header = Buffer.alloc(46);
  header.write("RENPY RPC2"); header.writeUInt32LE(1, 10); header.writeUInt32LE(46, 14); header.writeUInt32LE(compressed.length, 18);
  return Buffer.concat([header, compressed]);
}
test("Ren'Py configured and compiled custom icons are read as safe literals without executing game code", t => {
  const f = fixture(t), custom = write(path.join(f.game, "assets/custom.png"), png([0, 0, 255, 255]));
  write(path.join(f.game, "gui/icon.png"), png());
  write(path.join(f.game, "options.rpy"), 'define config.window_icon = "assets/custom.png"\n');
  assert.equal(RenpyIcons.resolveRenpyIcon({ roots: [f.game] }).path, custom);
  fs.rmSync(path.join(f.game, "options.rpy")); write(path.join(f.game, "options.rpyc"), compiledIcon('"assets/custom.png"'));
  assert.equal(RenpyIcons.resolveRenpyIcon({ roots: [f.game] }).path, custom);
  fs.rmSync(path.join(f.game, "options.rpyc"));
  const sentinel = path.join(f.root, "executed");
  write(path.join(f.game, "options.rpy"), `define config.window_icon = __import__('os').system(${JSON.stringify("touch " + sentinel)})\n`);
  assert.equal(RenpyIcons.resolveRenpyIcon({ roots: [f.game] }).path, path.join(f.game, "gui/icon.png"));
  assert.equal(fs.existsSync(sentinel), false);
});
test("Ren'Py reads only the requested bounded archived icon and refreshes changed source bytes", async t => {
  const f = fixture(t), archive = path.join(f.game, "archive.rpa"), first = png(), second = png([0, 255, 0, 255]);
  rpa(archive, { "options.rpy": 'define config.window_icon = "assets/custom.png"', "assets/custom.png": first, "unrelated.txt": "stay archived" });
  const original = fs.readFileSync(archive), options = { roots: [f.game], userDataDir: f.userDataDir, gameId: "title" };
  const resolved = RenpyIcons.resolveRenpyIcon(options);
  assert.match(resolved.source, /archive\.rpa!\/assets\/custom.png$/); assert.deepEqual(fs.readFileSync(resolved.path), first);
  assert.deepEqual(fs.readFileSync(archive), original); assert.equal(fs.existsSync(path.join(f.game, "assets")), false);
  rpa(archive, { "options.rpy": 'define config.window_icon = "assets/custom.png"', "assets/custom.png": second });
  const updated = RenpyIcons.resolveRenpyIcon(options); assert.notEqual(updated.fingerprint, resolved.fingerprint); assert.deepEqual(fs.readFileSync(updated.path), second);
  assert.equal(Renpy.resolveGameIcon({ contentRootDir: path.dirname(f.game), gameId: "title" }, { userDataDir: f.userDataDir }), updated.path);
  const service = require("../src/core/backend-worker-client").createBackendService({ userDataDir: f.userDataDir });
  t.after(() => service.close());
  const background = await service.request("icons", "resolveModuleIcon", {
    moduleId: "renpy", contentRootDir: path.dirname(f.game), gameId: "title"
  });
  assert.equal(background, updated.path);
});
test("bad, oversized and unsafe configured icons fall back without external reads or full extraction", t => {
  const f = fixture(t), icon = write(path.join(f.game, "gui/icon.png"), png());
  write(path.join(f.game, "gui/window_icon.png"), Buffer.alloc(0));
  write(path.join(f.game, "options.rpy"), 'define config.window_icon = "../outside.png"\n'); write(path.join(f.root, "outside.png"), png([0, 0, 255, 255]));
  assert.equal(RenpyIcons.resolveRenpyIcon({ roots: [f.game] }).path, icon);
  fs.rmSync(icon); fs.rmSync(path.join(f.game, "options.rpy"));
  rpa(path.join(f.game, "archive.rpa"), { "gui/window_icon.png": Buffer.alloc(RenpyIcons.MAX_ICON_BYTES + 1), "gui/icon.png": png() });
  const found = RenpyIcons.resolveRenpyIcon({ roots: [f.game], userDataDir: f.userDataDir, gameId: "title" });
  assert.match(found.source, /gui\/icon.png$/); assert.equal(fs.existsSync(path.join(f.game, "gui/icon.png")), false);
});

test("Ren'Py WebP conversion uses the injected adapter and writes only owned cache files", t => {
  const f = fixture(t), source = write(path.join(f.game, "gui/icon.webp"), Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64"));
  const original = fs.readFileSync(source), entry = { contentRootDir: path.dirname(f.game), gameId: "title" };
  const adapter = { createFromPath: () => ({ isEmpty: () => false, toPNG: () => png() }) };
  const result = Renpy.resolveGameIcon(entry, { userDataDir: f.userDataDir, ui: { nativeImage: adapter } });
  assert.equal(result.startsWith(f.userDataDir + path.sep), true); assert.equal(path.extname(result), ".png");
  assert.equal(Images.isSupportedImageBuffer(fs.readFileSync(result)), true); assert.deepEqual(fs.readFileSync(source), original);
  assert.equal(fs.existsSync(path.join(f.game, "gui/icon.png")), false);
  assert.equal(Renpy.resolveGameIcon(entry, { ui: { nativeImage: adapter } }), source);
  assert.equal(fs.existsSync(path.join(f.game, "gui/icon.png")), false);
});

test("Ren'Py cache refuses dangling symlinks without writing outside per-game data", t => {
  const f = fixture(t);
  rpa(path.join(f.game, "archive.rpa"), { "gui/window_icon.png": png() });
  const directory = path.join(f.userDataDir, "games/title/modules/renpy/icons"), outside = path.join(f.root, "must-not-be-created.png");
  fs.mkdirSync(directory, { recursive: true }); fs.symlinkSync(outside, path.join(directory, "window-icon.png"));
  assert.equal(RenpyIcons.resolveRenpyIcon({ roots: [f.game], userDataDir: f.userDataDir, gameId: "title" }), null);
  assert.equal(fs.existsSync(outside), false); assert.equal(fs.lstatSync(path.join(directory, "window-icon.png")).isSymbolicLink(), true);
});
