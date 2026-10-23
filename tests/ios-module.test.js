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
