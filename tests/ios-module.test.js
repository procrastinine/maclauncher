const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const MachO = require("../src/modules/ios/macho");
const Archive = require("../src/modules/ios/archive");
const { inspectIpa, detectGame } = require("../src/modules/ios/inspect");
function binary({ encrypted = false, padding = 512 } = {}) {
  const size = 32 + 152 + 16 + 24, start = size + padding;
  const b = Buffer.alloc(start + 8); [0xfeedfacf, 0x0100000c, 0, 2, 3, 192, 0, 0].forEach((v, i) => b.writeUInt32LE(v, i * 4));
  b.writeUInt32LE(0x19, 32); b.writeUInt32LE(152, 36); b.write("__TEXT", 40); b.writeBigUInt64LE(BigInt(b.length), 80); b.writeUInt32LE(1, 96);
  b.write("__text", 104); b.writeBigUInt64LE(8n, 144); b.writeUInt32LE(start, 152);
  b.writeUInt32LE(0x25, 184); b.writeUInt32LE(16, 188); b.writeUInt32LE(0xd0000, 192);
  b.writeUInt32LE(0x2c, 200); b.writeUInt32LE(24, 204); b.writeUInt32LE(encrypted ? 1 : 0, 216);
  b.writeBigUInt64LE(0xd65f03c052800000n, start); return b;
}
function zip(file, entries) {
  let offset = 0; const local = [], central = [];
  for (const [name, bytes, mode = 0x81a4] of entries) {
    const n = Buffer.from(name), crc = (Archive.crc32(bytes) ^ 0xffffffff) >>> 0, h = Buffer.alloc(30), c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(bytes.length, 18); h.writeUInt32LE(bytes.length, 22); h.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x314, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(bytes.length, 20); c.writeUInt32LE(bytes.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE((mode << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    local.push(h, n, bytes); central.push(c, n); offset += h.length + n.length + bytes.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...local, dir, end]));
}
test("iOS Mach-O platform conversion preserves code and refuses encrypted or overlapping headers", () => {
  const input = binary(), before = Buffer.from(input), output = MachO.convert(input, { inject: "@executable_path/Frameworks/PlayTools.framework/PlayTools" });
  assert.deepEqual(input, before); assert.deepEqual(output.subarray(-8), input.subarray(-8));
  const info = MachO.inspect(output), build = info.commands.find(c => c.cmd === 0x32);
  assert.equal(build.bytes.readUInt32LE(8), 6); assert.equal(info.commands.filter(c => c.cmd === 0xc).length, 1);
  assert.throws(() => MachO.convert(binary({ encrypted: true })), /Encrypted/);
  assert.throws(() => MachO.convert(binary({ padding: 0 }), { inject: "PlayTools" }), /padding/);
  const arm64e = binary(); arm64e.writeUInt32LE(2, 8); assert.throws(() => MachO.inspect(arm64e), /ARM64/);
  const truncated = binary(); truncated.writeUInt32LE(999999, 36); assert.throws(() => MachO.inspect(truncated), /length/);
});
test("IPA archive extracts exact bytes and rejects traversal, links, aliases, corruption", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ios-archive-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "owned.ipa"); zip(file, [["Payload/A.app/resource", Buffer.from("original")]]);
  const a = Archive.open(file); try { assert.equal(a.read("Payload/A.app/resource").toString(), "original"); await a.extract(path.join(root, "out")); } finally { a.close(); }
  assert.equal(fs.readFileSync(path.join(root, "out/Payload/A.app/resource"), "utf8"), "original");
  for (const entries of [ [["../escape", Buffer.from("x")]], [["link", Buffer.from("outside"), 0xa1ff]], [["A", Buffer.from("x")], ["a", Buffer.from("x")]], [["A", Buffer.from("x")], ["A/child", Buffer.from("x")]] ]) {
    zip(file, entries); assert.throws(() => Archive.open(file), /unsafe|links|alias|shadows/);
  }
  zip(file, [["data", Buffer.from("original")]]); const corrupt = fs.readFileSync(file); corrupt[34] ^= 1; fs.writeFileSync(file, corrupt);
  const c = Archive.open(file); try { assert.throws(() => c.read("data"), /checksum/); } finally { c.close(); }
});
test("IPA detection exposes encrypted state without inventing playability", { skip: process.platform !== "darwin" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ios-inspect-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "owned.ipa"), info = Buffer.from(JSON.stringify({ CFBundleIdentifier: "org.maclauncher.owned", CFBundleExecutable: "Owned", CFBundleName: "Owned app", CFBundleShortVersionString: "1" }));
  for (const encrypted of [false, true]) {
    zip(file, [["Payload/Owned.app/Info.plist", info], ["Payload/Owned.app/Owned", binary({ encrypted })]]);
    assert.equal(inspectIpa(file).encrypted, encrypted); assert.equal(detectGame({ inputPath: file }).moduleData.encrypted, encrypted);
  }
  assert.equal(detectGame({ inputPath: file + ".zip" }), null);
  assert.equal(require("../src/modules/ios/main").manifest.runtime.default, "playcover");
});
module.exports = { zip, binary };
test("PlayTools dependency copying uses the recorded bounded library inventory", t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ios-tools-dependencies-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const framework=path.join(root,"PlayTools.framework");fs.mkdirSync(framework);
  const name="libswiftCompatibilitySpan.dylib",file=path.join(root,name);fs.writeFileSync(file,"owned library identity");
  const sha256=require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const {dependencies}=require('../src/modules/ios/prepare');
  assert.deepEqual(dependencies(framework,[{name,sha256}]),[{name,sha256,file}]);
  assert.throws(()=>dependencies(framework,[{name:"../outside",sha256}]),/inventory/);
  assert.throws(()=>dependencies(framework,[{name,sha256},{name,sha256}]),/inventory/);
  fs.writeFileSync(file,"changed");assert.throws(()=>dependencies(framework,[{name,sha256}]),/changed/);
});
test("IPA extraction reuses one derived tree and leaves original bytes unchanged", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ios-extract-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "input.ipa"), output = path.join(root, "derived");
  zip(source, [["resource", Buffer.from("one")]]); const before = fs.readFileSync(source);
  const { extract } = require("../src/modules/ios/prepare");
  const first = await extract({ source, root: output }), second = await extract({ source, root: output });
  assert.equal(first.extractedRoot, second.extractedRoot); assert.deepEqual(fs.readFileSync(source), before);
  zip(source, [["resource", Buffer.from("two")]]); const third = await extract({ source, root: output });
  assert.equal(third.extractedRoot, first.extractedRoot); assert.equal(fs.readFileSync(path.join(third.extractedRoot, "resource"), "utf8"), "two");
  assert.deepEqual(fs.readdirSync(output).sort(), ["contents", "source.json"]);
});
test("shared macOS sandbox confines files and iOS adds only its own scene services", async t => {
  const shared = require("../src/modules/shared/runtime/macos-sandbox");
  const options = { readDirectories: ["/owned/runtime"], readFiles: ["/owned/config"], writeDirectories: ["/owned/data"], executables: ["/owned/runtime/game"], blockNetwork: true };
  const text = shared.profile(options); assert.match(text, /\(deny default\)/); assert.match(text, /\(deny network\*\)/); assert.doesNotMatch(text, /frontboard|lsd\.open|AppleEvents/);
  assert.doesNotMatch(text, /\(allow network/);
  assert.doesNotMatch(text.match(/\(allow mach-lookup[\s\S]*?\n\(allow mach-task-name/)?.[0] || "", /mDNSResponder/);
  const online = shared.profile({ ...options, blockNetwork: false });
  assert.match(online, /\(allow network-outbound \(remote ip "\*:\*"\)\)/);
  assert.doesNotMatch(online, /\(deny network\*\)/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ios-sandbox-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = path.join(root, "prepared", "Owned.app"), executablePath = path.join(appRoot, "Owned"); fs.mkdirSync(appRoot, { recursive: true }); fs.writeFileSync(executablePath, "fixture");
  const result = await require("../src/modules/ios/sandbox").prepareSandbox({ root, launch: { appRoot, executablePath } });
  assert.equal(result.environment.HOME, fs.realpathSync(root) + "/data/home"); assert.equal(result.environment.CFFIXED_USER_HOME, result.environment.HOME);
  assert.match(result.profile, /com\.apple\.frontboard\.workspace/); assert.doesNotMatch(result.profile, /lsd\.open|AppleEvents|filebroker/);
  assert.equal(result.command, "/usr/bin/sandbox-exec"); assert.equal(result.args.at(-1), fs.realpathSync(executablePath));
  const library = path.join(root, "selected/core.dylib"), audio = path.join(root, "selected/audio.dylib");
  fs.mkdirSync(path.dirname(library));fs.writeFileSync(library, "graphics");fs.writeFileSync(audio, "audio");
  const alias = path.join(root, "selected-alias.dylib");fs.symlinkSync(library, alias);
  const injected = await require("../src/modules/ios/sandbox").prepareSandbox({root, launch: {appRoot, executablePath},
    graphics: {DYLD_INSERT_LIBRARIES: alias+":"+audio+":"+library}});
  const canonicalLibrary=fs.realpathSync(library), canonicalAudio=fs.realpathSync(audio);
  assert.equal(injected.graphics.DYLD_INSERT_LIBRARIES, canonicalLibrary+":"+canonicalAudio);
  assert.ok(injected.args.includes("DYLD_INSERT_LIBRARIES="+injected.environment.DYLD_INSERT_LIBRARIES));
  assert.ok(injected.environment.DYLD_INSERT_LIBRARIES.endsWith(":"+canonicalLibrary+":"+canonicalAudio));
  assert.ok(injected.profile.includes('(literal "'+canonicalLibrary+'")'));
  assert.ok(!injected.profile.includes('(subpath "'+fs.realpathSync(path.dirname(library))+'")'));
});

// Hold every field used by the old cache key while bytes change in place.
// File identity is held by inode, so renaming the prior generation cannot
// accidentally make the fixture reveal its otherwise-hidden write.
function coarseTimes(t, ...heldFiles) {
  const original = fs.lstatSync, held = new Map();
  const hold = file => { const stat = original(file, { bigint: true }); held.set(`${stat.dev}:${stat.ino}`, stat); };
  heldFiles.forEach(hold);
  t.mock.method(fs, "lstatSync", (file, ...args) => {
    const info = original(file, ...args); if (!info) return info;
    const saved = held.get(`${info.dev}:${info.ino}`);
    return new Proxy(info, { get(target, key) {
      let value = saved && ["dev", "ino", "size", "mtimeNs", "mtimeMs", "ctimeNs", "ctimeMs", "mode"].includes(key) ? saved[key] : target[key];
      if (typeof target[key] === "number" && typeof value === "bigint") value = Number(value);
      if (key === "ctimeNs" && typeof value === "bigint") return value / 1000000000n * 1000000000n;
      if (key === "ctimeMs" && typeof value === "number") return Math.floor(value / 1000) * 1000;
      return value;
    } });
  });
  return hold;
}
function ipaCache(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ios-coarse-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "original.ipa"), root = path.join(directory, "cache");
  const write = text => zip(source, [["resource", Buffer.from(text)]]);
  write("one");
  return { directory, source, root, write, resource: path.join(root, "contents/resource"), meta: path.join(root, "source.json") };
}
function noStaging(root) {
  assert.deepEqual(fs.readdirSync(root).filter(name => /^\.(?:input|extract|prepare|replaced)-/.test(name) || name.endsWith(".tmp")), []);
}
function preparedIpa(t) {
  const f = ipaCache(t), file = require.resolve("../src/modules/ios/prepare"), prior = require.cache[file];
  t.mock.method(require("../src/modules/shared/runtime/host-capabilities"), "getHostCapabilities", () => ({ platform: "darwin", hardwareArch: "arm64" }));
  t.mock.method(require("../src/modules/shared/runtime/tool-command"), "runToolCommand", async () => ({ stdout: "", stderr: "" }));
  delete require.cache[file];const module = require(file);
  t.after(() => { if (prior) require.cache[file] = prior; else delete require.cache[file]; });
  const info = Buffer.from(JSON.stringify({ CFBundleIdentifier: "org.example.owned", CFBundleExecutable: "Owned", CFBundleName: "Owned" }));
  f.write = text => zip(f.source, [["Payload/Owned.app/Info.plist", info], ["Payload/Owned.app/Owned", binary()], ["Payload/Owned.app/resource", Buffer.from(text)]]);
  f.write("one");
  f.framework = path.join(f.directory, "PlayTools.framework");fs.mkdirSync(f.framework);fs.writeFileSync(path.join(f.framework, "PlayTools"), "fixture tools");
  f.frameworkHash = require("node:crypto").createHash("sha256").update("fixture tools").digest("hex");
  return { ...f, module, options: { source: f.source, root: f.root, framework: f.framework, frameworkHash: f.frameworkHash } };
}

test("coarse iOS source identities use byte keys and preserve private generations", async t => {
  await t.test("equal-size IPA rewrites refresh clean contents without accumulating old generations", async t => {
    const f = ipaCache(t);coarseTimes(t, f.source);
    const { extract } = require("../src/modules/ios/prepare");
    await extract(f);const old = fs.readFileSync(f.meta, "utf8");f.write("two");
    await extract(f);
    assert.equal(fs.readFileSync(f.resource, "utf8"), "two");
    assert.notEqual(JSON.parse(fs.readFileSync(f.meta)).sourceSha256, JSON.parse(old).sourceSha256);
    await extract(f);f.write("tri");await extract(f);
    assert.equal(fs.existsSync(path.join(f.root, "preserved")), false);
    noStaging(f.root);
  });
  await t.test("a hidden private write is retained while the new original becomes current", async t => {
    const f = ipaCache(t), hold = coarseTimes(t, f.source), { extract } = require("../src/modules/ios/prepare");
    await extract(f);hold(f.resource);fs.writeFileSync(f.resource, "mod");
    const save = path.join(f.root, "data/home/save.dat");fs.mkdirSync(path.dirname(save), { recursive: true });fs.writeFileSync(save, "progress");
    f.write("two");await extract(f);
    assert.equal(fs.readFileSync(f.resource, "utf8"), "two");
    const retained = path.join(f.root, "preserved"), names = fs.readdirSync(retained);
    assert.equal(names.length, 1);assert.equal(fs.readFileSync(path.join(retained, names[0], "resource"), "utf8"), "mod");
    assert.equal(fs.readFileSync(save, "utf8"), "progress");
    await extract(f);assert.equal(fs.readdirSync(retained).length, 1);
  });
  await t.test("legacy coarse receipts preserve private changes without probing obsolete generations", async t => {
    const f = ipaCache(t);coarseTimes(t, f.source);const { extract } = require("../src/modules/ios/prepare");
    await extract(f);const legacy = JSON.parse(fs.readFileSync(f.meta));delete legacy.sourceSha256;delete legacy.files;fs.writeFileSync(f.meta, JSON.stringify(legacy));
    fs.writeFileSync(path.join(f.root, "contents/save.dat"), "legacy progress");
    fs.mkdirSync(path.join(f.root, ".previous"));fs.writeFileSync(path.join(f.root, ".previous/older-save.dat"), "older progress");
    await extract(f);
    const directories = fs.readdirSync(path.join(f.root, "preserved")).map(name => path.join(f.root, "preserved", name));
    assert.ok(directories.some(folder => fs.existsSync(path.join(folder, "save.dat"))));
    assert.equal(fs.readFileSync(path.join(f.root, ".previous/older-save.dat"), "utf8"), "older progress");
    assert.equal(fs.readFileSync(f.resource, "utf8"), "one");noStaging(f.root);
  });
  await t.test("source mutation during a held-stat hash leaves the prior tree and receipt intact", async t => {
    const f = ipaCache(t);coarseTimes(t, f.source);const { extract } = require("../src/modules/ios/prepare");
    await extract(f);const receipt = fs.readFileSync(f.meta);f.write("two");
    const opened = new Map(), open = fs.openSync, read = fs.readSync;let mutated = false;
    t.mock.method(fs, "openSync", (file, ...args) => { const fd = open(file, ...args);opened.set(fd, String(file));return fd; });
    t.mock.method(fs, "readSync", (fd, ...args) => { const count = read(fd, ...args);if (!mutated && count && opened.get(fd) === f.source) { mutated = true;f.write("tri"); }return count; });
    await assert.rejects(extract(f), /changed during preparation or extraction/);
    assert.equal(mutated, true);assert.equal(fs.readFileSync(f.resource, "utf8"), "one");assert.deepEqual(fs.readFileSync(f.meta), receipt);noStaging(f.root);
  });
  await t.test("a changed staged archive is rejected before extraction or publication", async t => {
    const f = ipaCache(t);coarseTimes(t, f.source);const { extract } = require("../src/modules/ios/prepare");
    await extract(f);const receipt = fs.readFileSync(f.meta);f.write("two");
    const shared = require("../src/modules/shared/copy-file"), copy = shared.cloneOrCopySync;let mutated = false;
    t.mock.method(shared, "cloneOrCopySync", (from, to, ...args) => { const result = copy(from, to, ...args);if (String(from) === f.source) { zip(to, [["resource", Buffer.from("tri")]]);mutated = true; }return result; });
    const file = require.resolve("../src/modules/ios/prepare"), prior = require.cache[file];delete require.cache[file];
    const checked = require(file);t.after(() => { require.cache[file] = prior; });
    await assert.rejects(checked.extract(f), /changed during preparation or extraction/);
    assert.equal(mutated, true);assert.equal(fs.readFileSync(f.resource, "utf8"), "one");assert.deepEqual(fs.readFileSync(f.meta), receipt);noStaging(f.root);
  });
  await t.test("a held-stat source rewrite during extraction does not publish a new tree", async t => {
    const f = ipaCache(t);coarseTimes(t, f.source);const { extract } = require("../src/modules/ios/prepare");
    await extract(f);const receipt = fs.readFileSync(f.meta);f.write("two");
    const open = Archive.open;
    t.mock.method(Archive, "open", file => { const archive = open(file), extract = archive.extract;return { ...archive, async extract(...args) { await extract(...args);f.write("tri"); } }; });
    await assert.rejects(extract(f), /changed during preparation or extraction/);
    assert.equal(fs.readFileSync(f.resource, "utf8"), "one");assert.deepEqual(fs.readFileSync(f.meta), receipt);noStaging(f.root);
  });
  await t.test("receipt publication failure restores both the prior tree and prior receipt", async t => {
    const f = ipaCache(t);coarseTimes(t, f.source);const { extract } = require("../src/modules/ios/prepare");
    await extract(f);const receipt = fs.readFileSync(f.meta);f.write("two");
    const rename = fs.renameSync;
    t.mock.method(fs, "renameSync", (from, to) => { if (String(to) === f.meta && String(from).endsWith(".tmp")) throw new Error("fixture receipt rename failure");return rename(from, to); });
    await assert.rejects(extract(f), /receipt rename failure/);
    assert.equal(fs.readFileSync(f.resource, "utf8"), "one");assert.deepEqual(fs.readFileSync(f.meta), receipt);noStaging(f.root);
  });
  await t.test("preparation retains a modified prior bundle and the separate saved-data root", async t => {
    const f = preparedIpa(t), hold = coarseTimes(t, f.source);
    const first = await f.module.prepare(f.options), resource = path.join(first.appRoot, "resource");hold(resource);fs.writeFileSync(resource, "mod");
    const save = path.join(f.root, "data/home/save.dat");fs.mkdirSync(path.dirname(save), { recursive: true });fs.writeFileSync(save, "progress");
    f.write("two");const second = await f.module.prepare(f.options);
    assert.equal(fs.readFileSync(path.join(second.appRoot, "resource"), "utf8"), "two");
    const retained = fs.readdirSync(path.join(f.root, "preserved"));assert.equal(retained.length, 1);
    assert.equal(fs.readFileSync(path.join(f.root, "preserved", retained[0], "Owned.app/resource"), "utf8"), "mod");
    assert.equal(fs.readFileSync(save, "utf8"), "progress");noStaging(f.root);
  });
  await t.test("copied dependency mutation fails before any new prepared bundle is published", async t => {
    const shared = require("../src/modules/shared/copy-file"), copy = shared.cloneOrCopySync;let library, mutated = false;
    t.mock.method(shared, "cloneOrCopySync", (from, to, ...args) => { const result = copy(from, to, ...args);if (String(from) === library) { fs.writeFileSync(to, "other");mutated = true; }return result; });
    const f = preparedIpa(t);coarseTimes(t, f.source);const first = await f.module.prepare(f.options), meta = path.join(f.root, "prepared.json"), receipt = fs.readFileSync(meta);
    library = path.join(f.directory, "libFixture.dylib");fs.writeFileSync(library, "first");
    const options = { ...f.options, frameworkDependencies: [{ name: "libFixture.dylib", sha256: require("node:crypto").createHash("sha256").update("first").digest("hex") }] };
    await assert.rejects(f.module.prepare(options), /changed during preparation or extraction/);
    assert.equal(mutated, true);assert.equal(fs.readFileSync(path.join(first.appRoot, "resource"), "utf8"), "one");assert.deepEqual(fs.readFileSync(meta), receipt);noStaging(f.root);
  });
  await t.test("a framework inventory failure cleans both preparation and input snapshots", async t => {
    const f = preparedIpa(t);coarseTimes(t, f.source);await f.module.prepare(f.options);f.write("two");
    const file = path.join(f.framework, "settings.bin");fs.writeFileSync(file, "settings");const stat = fs.lstatSync;
    t.mock.method(fs, "lstatSync", (name, ...args) => { if (String(name) === file) throw new Error("fixture inventory read failed");return stat(name, ...args); });
    await assert.rejects(f.module.prepare(f.options), /inventory read failed/);noStaging(f.root);
    assert.equal(fs.readFileSync(path.join(f.root, "prepared/Owned.app/resource"), "utf8"), "one");
  });
});

test("warm iOS preparation avoids repeated work while retaining coarse input verification", async t => {
  await t.test("fine identities reuse runtime hashes without input reads, conversion, signing or receipt writes", async t => {
    t.mock.method(require("../src/modules/shared/file-time"), "hasFineChangeTime", () => true);
    const f = preparedIpa(t), dependency = path.join(f.directory, "libFixture.dylib");fs.writeFileSync(dependency, "first");
    const options = { ...f.options, frameworkDependencies: [{ name: "libFixture.dylib", sha256: require("node:crypto").createHash("sha256").update("first").digest("hex") }] };
    const first = await f.module.prepare(options), inode = fs.statSync(first.appRoot).ino, meta = path.join(f.root, "prepared.json");
    const tools = require("../src/modules/shared/runtime/tool-command").runToolCommand, calls = tools.mock.callCount();
    const legacy = JSON.parse(fs.readFileSync(meta));delete legacy.tools;delete legacy.dependencyFiles;fs.writeFileSync(meta, JSON.stringify(legacy));
    t.mock.method(Archive, "open", () => assert.fail("A valid legacy receipt does not need another extraction"));
    await f.module.prepare(options);
    assert.equal(fs.statSync(first.appRoot).ino, inode, "A verification receipt upgrade leaves the prepared bundle in place");
    const record = fs.readFileSync(meta);
    const inputFiles = new Set([f.source, path.join(f.framework, "PlayTools"), dependency]);
    const open = fs.openSync;
    t.mock.method(fs, "openSync", (file, ...args) => { assert.equal(inputFiles.has(String(file)), false, "Unchanged precise inputs keep their verified bytes");return open(file, ...args); });
    const writes = [], write = fs.writeFileSync;
    t.mock.method(fs, "writeFileSync", (file, ...args) => { writes.push(file);return write(file, ...args); });
    const second = await f.module.prepare(options);
    assert.deepEqual(second, first);assert.equal(fs.statSync(second.appRoot).ino, inode);assert.deepEqual(fs.readFileSync(meta), record);
    assert.deepEqual(writes, [], "An unchanged warm launch writes no receipt or prepared file");
    assert.equal(tools.mock.callCount(), calls, "An unchanged warm launch neither converts nor signs");
  });
  await t.test("coarse runtime identities still read bytes and reject a held-stat rewritten dependency", async t => {
    const f = preparedIpa(t), hold = coarseTimes(t, f.source), dependency = path.join(f.directory, "libFixture.dylib");fs.writeFileSync(dependency, "first");
    const options = { ...f.options, frameworkDependencies: [{ name: "libFixture.dylib", sha256: require("node:crypto").createHash("sha256").update("first").digest("hex") }] };
    await f.module.prepare(options);hold(dependency);
    const watched = new Set([path.join(f.framework, "PlayTools"), dependency]), reads = new Map(), open = fs.openSync;
    t.mock.method(fs, "openSync", (file, ...args) => { if (watched.has(String(file))) reads.set(String(file), (reads.get(String(file)) || 0) + 1);return open(file, ...args); });
    const tools = require("../src/modules/shared/runtime/tool-command").runToolCommand, calls = tools.mock.callCount();
    await f.module.prepare(options);
    for (const file of watched) assert.ok(reads.get(file) >= 2, "Coarse runtime inputs retain stable byte validation");
    assert.equal(tools.mock.callCount(), calls, "Unchanged coarse inputs do not reconvert or sign");
    const meta = path.join(f.root, "prepared.json"), record = fs.readFileSync(meta);fs.writeFileSync(dependency, "other");
    await assert.rejects(f.module.prepare(options), /dependencies changed since installation/);
    assert.deepEqual(fs.readFileSync(meta), record);assert.equal(fs.readFileSync(path.join(f.root, "prepared/Owned.app/resource"), "utf8"), "one");noStaging(f.root);
  });
});
