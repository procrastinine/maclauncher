const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const test = require("node:test");
const { inspectPickle } = require("../src/modules/renpy/pickle-inspect");
const { readRpaIndex, readRpaMember, readRpycConfiguration } = require("../src/modules/renpy/script-config");
const { resolveConfiguredSaveLocation, sourceAssignments, parseSaveDirectoryList } = require("../src/modules/renpy/save-location");
const Renpy = require("../src/modules/renpy/main");
const RuntimeSdk = require("../src/modules/renpy/runtime/sdk");

const tuple = values => ({ tuple: values });
const global = (module, name) => ({ global: [module, name] });
const object = (name, state, args = []) => ({ klass: global("renpy.ast", name), args, state });
function uint(value, width = 4) { const out = Buffer.alloc(width); out.writeUIntLE(value, 0, width); return out; }
function pickleValue(value) {
  if (value === null) return Buffer.from("N");
  if (typeof value === "boolean") return Buffer.from([value ? 0x88 : 0x89]);
  if (typeof value === "number") { const bytes = Buffer.alloc(4); bytes.writeInt32LE(value); return Buffer.concat([Buffer.from("J"), bytes]); }
  if (typeof value === "string") { const bytes = Buffer.from(value); return Buffer.concat([Buffer.from("X"), uint(bytes.length), bytes]); }
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from("T"), uint(value.length), value]);
  if (value.reference != null) return Buffer.from([0x68, value.reference]);
  if (value.memo != null) return Buffer.concat([pickleValue(value.value), Buffer.from([0x71, value.memo])]);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from("]("), ...value.map(pickleValue), Buffer.from("e")]);
  if (value.global) return Buffer.from(`c${value.global.join("\n")}\n`);
  if (value.tuple) return Buffer.concat([Buffer.from("("), ...value.tuple.map(pickleValue), Buffer.from("t")]);
  if (value.klass) return Buffer.concat([pickleValue(value.klass), pickleValue(tuple(value.args)), Buffer.from([0x81]), pickleValue(value.state), Buffer.from("b")]);
  if (value.reducer) return Buffer.concat([pickleValue(value.reducer), pickleValue(tuple(value.args)), Buffer.from("R"), ...(value.state ? [pickleValue(value.state), Buffer.from("b")] : [])]);
  const entries = value instanceof Map ? [...value] : Object.entries(value);
  return Buffer.concat([Buffer.from("}("), ...entries.flatMap(([key, item]) => [pickleValue(key), pickleValue(item)]), Buffer.from("u")]);
}
function pickle(value) { return Buffer.concat([Buffer.from([0x80, 2]), pickleValue(value), Buffer.from(".")]); }
function compiledConfig(expression, { python2 = false, conditional = false, python = null } = {}) {
  const key = value => python2 ? Buffer.from(value) : value;
  const code = object("PyCode", tuple([1, python2 ? Buffer.from(expression) : expression, tuple(["options.rpy", 178]), "eval", python2 ? 2 : 3]));
  const define = object("Define", new Map([[key("store"), key("store.config")], [key("varname"), key("save_directory")],
    [key("code"), code], [key("linenumber"), 178], [key("operator"), key("=")], [key("index"), null]]));
  let statements = python ? [object("Python", { code: object("PyCode", tuple([1, python, tuple(["options.rpy", 1]), "exec", 3])) })] : [define];
  if (conditional) statements = [object("If", { entries: [tuple(["unknown_condition", statements])] })];
  return compiledAst([object("Init", { block: statements })]);
}
function compiledAst(statements) {
  const compressed = zlib.deflateSync(pickle(tuple([{}, statements]))), header = Buffer.alloc(46);
  header.write("RENPY RPC2"); header.writeUInt32LE(1, 10); header.writeUInt32LE(header.length, 14); header.writeUInt32LE(compressed.length, 18);
  return Buffer.concat([header, compressed, Buffer.alloc(16)]);
}
function rpa(file, members, { key = 0x42424242, version = "RPA-3.0", prefix = false } = {}) {
  const header = Buffer.from(`${version} ${"0".repeat(16)}${version === "RPA-2.0" ? "" : " " + key.toString(16).padStart(8, "0")}\n`);
  const chunks = [], index = new Map(); let offset = header.length;
  for (const [name, raw] of Object.entries(members)) {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const lead = prefix ? bytes.subarray(0, 5) : Buffer.alloc(0), body = bytes.subarray(lead.length);
    const midpoint = Math.floor(body.length / 2), slices = [body.subarray(0, midpoint), body.subarray(midpoint)];
    const records = [];
    for (const [part, data] of slices.entries()) { records.push(tuple([(offset ^ (version === "RPA-2.0" ? 0 : key)) >>> 0, (data.length ^ (version === "RPA-2.0" ? 0 : key)) >>> 0, part ? Buffer.alloc(0) : lead])); chunks.push(data); offset += data.length; }
    index.set(name, records);
  }
  header.write(offset.toString(16).padStart(16, "0"), 8);
  fs.writeFileSync(file, Buffer.concat([header, ...chunks, zlib.deflateSync(pickle(index))]));
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "renpy-save-location-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gameDir = path.join(root, "project", "game"), home = path.join(root, "home"); fs.mkdirSync(gameDir, { recursive: true });
  return { root, gameDir, home, options: path.join(gameDir, "options.rpy"), archive: path.join(gameDir, "archive.rpa"),
    resolve: options => resolveConfiguredSaveLocation([gameDir], { homeDir: home, env: {}, ...options }) };
}

test("RPA source and multi-part prefixes locate the configured macOS primary before creation", t => {
  const f = fixture(t);
  rpa(f.archive, { "options.rpy": 'define config.save_directory = "ExactTitle-1747615902"\n', "tl/french/options.rpy": 'define config.save_directory = "WrongTranslation"\n' }, { prefix: true });
  const location = f.resolve();
  assert.equal(location.primaryDirectory, path.join(f.home, "Library", "RenPy", "ExactTitle-1747615902"));
  assert.equal(location.confidence, "exact"); assert.equal(location.source, f.archive + "!/options.rpy");
  assert.equal(fs.existsSync(location.primaryDirectory), false);
  assert.deepEqual(location.directories.map(item => item.role), ["primary", "game-local"]);
  assert.match(readRpaMember(f.archive, "options.rpy").toString(), /ExactTitle/);
});

test("compiled Ren'Py Python2/3 configurations are inert AST evidence, in loose files and RPA", t => {
  for (const python2 of [true, false]) {
    const f = fixture(t), script = compiledConfig('u"Publisher/CompiledTitle"', { python2 });
    assert.equal(readRpycConfiguration(script, "options.rpyc")[0].expression, 'u"Publisher/CompiledTitle"');
    fs.writeFileSync(path.join(f.gameDir, "options.rpyc"), script);
    assert.equal(f.resolve().directory, path.join(f.home, "Library", "RenPy", "Publisher", "CompiledTitle"));
    fs.unlinkSync(path.join(f.gameDir, "options.rpyc")); rpa(f.archive, { "options.rpyc": script });
    assert.equal(f.resolve().directory, path.join(f.home, "Library", "RenPy", "Publisher", "CompiledTitle"));
    assert.match(f.resolve().source, /archive\.rpa!\/options\.rpyc:178$/);
  }
});

test("Python init configuration is supported while dynamic or conditional code stays unresolved", t => {
  const f = fixture(t);
  fs.writeFileSync(f.options, 'python early:\n    config.save_directory = "EarlyTitle"\n');
  assert.equal(f.resolve().name, "EarlyTitle");
  fs.writeFileSync(f.options, 'init python:\n    if unknown:\n        config.save_directory = "ConditionalTitle"\n');
  assert.equal(f.resolve().directory, null);
  fs.unlinkSync(f.options); fs.writeFileSync(path.join(f.gameDir, "options.rpyc"), compiledConfig('"ConditionalTitle"', { conditional: true }));
  assert.equal(f.resolve().directory, null);
  fs.writeFileSync(path.join(f.gameDir, "options.rpyc"), compiledConfig("None", { python: 'config.save_directory = "CompiledInit"' }));
  assert.equal(f.resolve().name, "CompiledInit");
});

test("configuration-looking dialogue and docstrings cannot provide a save location", () => {
  const fake = '"""\ndefine config.save_directory = "Forged"\n"""\nlabel start:\n    "config.save_directory = x"\n# config.savedir = "Forged"\n';
  assert.deepEqual(sourceAssignments(fake, "dialogue.rpy"), []);
});

test("known environment and Ren'Py Data roots follow runtime precedence; local mirror stays separate", t => {
  const f = fixture(t); fs.writeFileSync(f.options, 'define config.save_directory = "Title"\n');
  const portable = path.join(f.root, "Ren'Py Data"); fs.mkdirSync(portable);
  assert.equal(f.resolve().directory, path.join(portable, "Title"));
  assert.equal(f.resolve({ env: { RENPY_PATH_TO_SAVES: path.join(f.root, "env-saves") } }).directory, path.join(f.root, "env-saves", "Title"));
  assert.equal(f.resolve({ env: { RENPY_PATH_TO_SAVES: "relative-runtime-root" } }).primaryDirectory, null);
  assert.equal(f.resolve({ isMacApp: true }).directories.length, 1);
  fs.writeFileSync(f.options, "define config.save_directory = None\n");
  assert.equal(f.resolve().directory, path.join(f.gameDir, "saves"));
  fs.writeFileSync(f.options, 'define config.save_directory = ""\n');
  assert.equal(f.resolve().directory, path.join(f.gameDir, "saves"));
});

test("loose sources override archived counterparts; conflicting source assignments are not guessed", t => {
  const f = fixture(t); rpa(f.archive, { "options.rpy": 'define config.save_directory = "Archived"' });
  fs.writeFileSync(f.options, 'define config.save_directory = "Loose"\n'); assert.equal(f.resolve().name, "Loose");
  fs.writeFileSync(path.join(f.gameDir, "init.rpy"), 'init python:\n    config.save_directory = "Conflict"\n');
  assert.equal(f.resolve().directory, null); assert.equal(f.resolve().confidence, "unknown");
});

test("literal savedir and additional save folders are reported without evaluating Python", t => {
  const f = fixture(t), explicit = path.join(f.root, "primary"), extra = path.join(f.root, "extra");
  fs.writeFileSync(f.options, `init python:\n    config.savedir = ${JSON.stringify(explicit)}\n    config.extra_savedirs = [${JSON.stringify(extra)}, ${JSON.stringify(explicit)}]\n`);
  const location = f.resolve();
  assert.equal(location.primaryDirectory, explicit);
  assert.deepEqual(location.directories.map(item => item.directory), [explicit, path.join(f.gameDir, "saves"), extra]);
  assert.equal(location.directories[2].role, "additional");
  assert.deepEqual(parseSaveDirectoryList(`(r"${extra}",)`), [extra]);
  assert.equal(parseSaveDirectoryList(`["${extra}")`), null);
  fs.writeFileSync(f.options, `define config.save_directory = "Known"\ndefine config.extra_savedirs = compute_directories()\n`);
  assert.equal(f.resolve().name, "Known"); assert.match(f.resolve().error, /Additional configured/);
});

test("pickle inspection never invokes globals/reducers and RPA indexes forbid object construction", t => {
  const f = fixture(t), sentinel = path.join(f.root, "must-not-exist");
  const malicious = pickle({ reducer: global("os", "system"), args: [`touch ${sentinel}`] });
  assert.throws(() => inspectPickle(malicious), /forbidden/);
  const inert = inspectPickle(malicious, { primitiveOnly: false }); assert.equal(inert.value.pickleKind, "reduce");
  assert.equal(fs.existsSync(sentinel), false);
  const header = Buffer.from("RPA-3.0 0000000000000022 42424242\n"); fs.writeFileSync(f.archive, Buffer.concat([header, zlib.deflateSync(malicious)]));
  assert.throws(() => readRpaIndex(f.archive), /forbidden/);
  assert.equal(fs.existsSync(sentinel), false);
});

test("shared conditional AST nodes and repeated configuration graphs cannot imply an unconditional setting", () => {
  const define = object("Define", { store: "store.config", varname: "save_directory", code: object("PyCode", tuple([1, '"UnsafeShared"'])), linenumber: 1 });
  const shared = compiledAst([object("Init", { block: { memo: 7, value: [define] } }), object("If", { entries: [tuple(["unknown", { reference: 7 }])] })]);
  assert.equal(readRpycConfiguration(shared, "shared.rpyc")[0].unsafeContext, true);
  const many = compiledAst([object("Init", { block: Array.from({ length: 257 }, () => define) })]);
  assert.throws(() => readRpycConfiguration(many, "many.rpyc"), /expressions.*limit/);
});

test("malformed references, overlarge structures, archive path escapes and invalid script slots fail closed", t => {
  const f = fixture(t);
  assert.throws(() => inspectPickle(Buffer.from([0x80, 2, 0x68, 9, 0x2e])), /reference/);
  assert.throws(() => inspectPickle(pickle([1, 2, 3]), { limits: { items: 2 } }), /limit/);
  assert.throws(() => inspectPickle(Buffer.concat([pickle(1), Buffer.from("extra")])), /termination/);
  assert.throws(() => inspectPickle(Buffer.from([0x80, 5, 0x95, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])), /length/);
  assert.throws(() => inspectPickle(Buffer.from(`I${"9".repeat(621)}\n.`)), /integer.*limit/);
  rpa(f.archive, { "../options.rpy": 'define config.save_directory = "Escape"' }); assert.throws(() => readRpaIndex(f.archive), /Unsafe/);
  const script = compiledConfig('"Broken"'); script.writeUInt32LE(0xffffffff, 14); assert.throws(() => readRpycConfiguration(script, "bad.rpyc"), /slot/);
});

test("cached source evidence invalidates after edits and new nested initialization files", t => {
  const f = fixture(t);
  fs.writeFileSync(f.options, 'define config.save_directory = "Before"\n');
  assert.equal(f.resolve().name, "Before"); assert.equal(f.resolve().name, "Before");
  fs.writeFileSync(f.options, 'define config.save_directory = "After"\n');
  assert.equal(f.resolve().name, "After");
  const nested = path.join(f.gameDir, "initialization"); fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, "custom.rpy"), 'init python:\n    config.save_directory = dynamic_name\n');
  fs.mkdirSync(path.join(f.gameDir, "saves"));
  const location = f.resolve();
  assert.equal(location.primaryDirectory, null);
  assert.deepEqual(location.directories.map(item => item.directory), [path.join(f.gameDir, "saves")]);
  assert.equal(location.directories[0].confidence, "inferred");
});

test("archive-cache invalidation and normalized module hydration repair stale blank/title-guess records", t => {
  const f = fixture(t); rpa(f.archive, { "options.rpy": 'define config.save_directory = "Before"' }); assert.equal(f.resolve().name, "Before");
  rpa(f.archive, { "options.rpy": 'define config.save_directory = "After"' }); assert.equal(f.resolve().name, "After");
  const entry = { gamePath: path.dirname(f.gameDir), contentRootDir: path.dirname(f.gameDir), defaultSaveDir: null,
    runtimeId: "sdk", runtimeData: {}, moduleData: { major: 8 }, saveDirOverride: "/explicit-user-choice" };
  const result = Renpy.resolveSaveLocations(entry, { homeDir: f.home, env: {} });
  assert.equal(entry.defaultSaveDir, path.join(f.home, "Library", "RenPy", "After"));
  assert.equal(entry.saveDirOverride, "/explicit-user-choice"); assert.deepEqual(entry.moduleData.saveDirectories, result.directories);
});

test("SDK save discovery uses the selected private mirror and keeps original existing saves visible", t => {
  const f = fixture(t), userDataDir = path.join(f.root, "userdata");
  fs.writeFileSync(f.options, 'define config.save_directory = "PrivateMirror"\n');
  fs.mkdirSync(path.join(f.gameDir, "saves"));
  const entry = { gameId: "private-mirror-game", gamePath: path.dirname(f.gameDir), contentRootDir: path.dirname(f.gameDir),
    runtimeId: "sdk", runtimeData: { sdk: { version: "8.5.3" } }, moduleData: { major: 8 } };
  const location = Renpy.resolveSaveLocations(entry, { userDataDir, homeDir: f.home, env: {} });
  const mirror = path.join(RuntimeSdk.resolveWrapperDir(userDataDir, entry.gameId, "8.5.3"), "game", "saves");
  assert.equal(location.primaryDirectory, path.join(f.home, "Library", "RenPy", "PrivateMirror"));
  assert.deepEqual(location.directories.map(item => item.directory), [location.primaryDirectory, mirror, path.join(f.gameDir, "saves")]);
  assert.equal(location.directories.at(-1).role, "original");
  assert.equal(fs.existsSync(mirror), false);
  fs.writeFileSync(f.options, "define config.save_directory = None\n");
  const local = Renpy.resolveSaveLocations(entry, { userDataDir, homeDir: f.home, env: {} });
  assert.equal(local.primaryDirectory, mirror);
  assert.deepEqual(local.directories.map(item => item.directory), [mirror, path.join(f.gameDir, "saves")]);
  assert.equal(fs.existsSync(userDataDir), false);
});
