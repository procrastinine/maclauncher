const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const Overlay = require("../src/modules/bgi/native/source-overlay");
const Archive = require("../src/modules/bgi/archive");
const ArchivedOverlay = require("../src/modules/bgi/native/versions/probe-v1/source-overlay");

const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
function archive(file, items, format = "ARC20") {
  const stride = format === "ARC20" ? 128 : 32, nameBytes = format === "ARC20" ? 96 : 16;
  const header = Buffer.alloc(16); header.write(format === "ARC20" ? "BURIKO ARC20" : "PackFile    "); header.writeUInt32LE(items.length, 12);
  const records = [], payloads = []; let offset = 0;
  for (const [name, value] of items) {
    const bytes = Buffer.from(value), record = Buffer.alloc(stride); Buffer.from(name).copy(record, 0, 0, nameBytes);
    record.writeUInt32LE(offset, nameBytes); record.writeUInt32LE(bytes.length, nameBytes + 4);
    records.push(record); payloads.push(bytes); offset += bytes.length;
  }
  fs.writeFileSync(file, Buffer.concat([header, ...records, ...payloads])); return file;
}
function dsc({ lengths = { 65: 1, 66: 2, 256: 2 }, bits = "01011" + "0".repeat(12), size = 4, count = 3 } = {}) {
  const bytes = Buffer.alloc(0x220 + Math.ceil(bits.length / 8)); bytes.write("DSC FORMAT 1.00"); bytes.writeUInt32LE(7, 16); bytes.writeUInt32LE(size, 20); bytes.writeUInt32LE(count, 24);
  let key = 7;
  for (let i = 0; i < 512; i++) {
    const low = Math.imul(key & 0xffff, 20021) >>> 0, high = (Math.imul(key >>> 16, 20021) + Math.imul(key, 346) + (low >>> 16)) >>> 0;
    key = ((high << 16) + (low & 0xffff) + 1) >>> 0; bytes[32 + i] = ((lengths[i] || 0) + high) & 255;
  }
  for (let i = 0; i < bits.length; i++) if (bits[i] === "1") bytes[0x220 + (i >>> 3)] |= 1 << (7 - (i & 7));
  return bytes;
}
let nativeRoot, binary;
test.before(() => {
  nativeRoot = temp("bgi-native-reader-"); binary = path.join(nativeRoot, "reader");
  const driver = path.join(nativeRoot, "driver.c");
  fs.writeFileSync(driver, `#include "archive-reader.h"\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <unistd.h>\nint main(int argc,char **argv) { if(argc<4||chdir(argv[1]))return 2;
if(argc==5&&!strcmp(argv[2],"@status")){int found=MLBGI_ResourceStatus(strcmp(argv[3],"-")?argv[3]:NULL,argv[4],NULL,0,0);printf("%d\\n",found);if(found<0)fprintf(stderr,"%s\\n",MLBGI_ArchiveError());MLBGI_FreeArchiveCache();return found<0?2:0;}
size_t n=0; unsigned char *b=NULL; if(argc==4)b=MLBGI_ReadFile(argv[2],argv[3],&n); else if(!strcmp(argv[2],"@resource"))b=MLBGI_ReadResource(NULL,argv[3],(const char*const*)(argv+5),argc-5,atoi(argv[4]),&n); if(!b){fprintf(stderr,"%s\\n",MLBGI_ArchiveError());MLBGI_FreeArchiveCache();return 2;} if(n)fwrite(b,1,n,stdout);free(b);MLBGI_FreeArchiveCache();return 0;}\n`);
  const compiler = spawnSync("clang", ["-std=c11", process.platform === "darwin" ? "-D_DARWIN_C_SOURCE" : "-D_POSIX_C_SOURCE=200809L", "-g", "-fsanitize=address,undefined", "-I", path.resolve("src/modules/bgi/native"),
    path.resolve("src/modules/bgi/native/archive-reader.c"), driver, ...(process.platform === "darwin" ? ["-liconv"] : []), "-o", binary], { encoding: "utf8", timeout: 30000 });
  assert.ifError(compiler.error); assert.equal(compiler.status, 0, compiler.stderr);
});
test.after(() => { if (nativeRoot) fs.rmSync(nativeRoot, { recursive: true, force: true }); });
function fixture(t) { const root = temp("bgi-original-"); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function read(root, arc, member) {
  return spawnSync(binary, [root, arc, member], { env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" }, timeout: 10000, maxBuffer: 1024 * 1024 });
}
function resource(root, member, paths = [], enabled = true) {
  return spawnSync(binary, [root, "@resource", member, enabled ? "1" : "0", ...paths], {
    env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" }, timeout: 10000, maxBuffer: 1024 * 1024
  });
}
function status(root, arc, member) {
  return spawnSync(binary, [root, "@status", arc || "-", member], {
    env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" }, timeout: 10000, maxBuffer: 1024 * 1024
  });
}

test("native resource existence checks indexes without decoding payloads or consuming extraction budgets", t => {
  const root = fixture(t), invalidCodec = Buffer.alloc(32); invalidCodec.write("DSC FORMAT 1.00");
  const file = archive(path.join(root, "system.arc"), [["compressed", invalidCodec], ["plain", "original"]]);
  const original = fs.readFileSync(file), beforeNames = fs.readdirSync(root);
  for (const name of ["compressed", "plain"]) {
    const query = status(root, "SYSTEM", name); assert.ifError(query.error); assert.equal(query.status, 0, query.stderr.toString()); assert.equal(query.stdout.toString(), "1\n");
  }
  const absent = status(root, "system", "absent"); assert.equal(absent.status, 0, absent.stderr.toString()); assert.equal(absent.stdout.toString(), "0\n");
  assert.equal(read(root, "system", "compressed").status, 2);
  assert.deepEqual(fs.readFileSync(file), original); assert.deepEqual(fs.readdirSync(root), beforeNames);
  const large = path.join(root, "large"); const fd = fs.openSync(large, "wx"); fs.ftruncateSync(fd, 33 * 1024 * 1024); fs.closeSync(fd);
  const largeQuery = status(root, null, "large"); assert.equal(largeQuery.status, 0, largeQuery.stderr.toString()); assert.equal(largeQuery.stdout.toString(), "1\n"); assert.equal(fs.statSync(large).size, 33 * 1024 * 1024);
  fs.writeFileSync(path.join(root, "broken.arc"), "not an archive");
  const broken = status(root, "broken", "plain"); assert.equal(broken.status, 2); assert.equal(broken.stdout.toString(), "-1\n");
  fs.symlinkSync(file, path.join(root, "linked.arc"));
  const linked = status(root, "linked", "plain"); assert.equal(linked.status, 2); assert.match(linked.stderr.toString(), /symbolic links/);
});

test("native ARC20 and PackFile readers use original archives without extraction or writes", t => {
  const root = fixture(t);
  for (const format of ["ARC20", "PackFile"]) {
    const file = archive(path.join(root, `${format}.arc`), [["IPL._BP", "program"], ["graphic", "bitmap"]], format), original = fs.readFileSync(file);
    const result = read(root, format.toLowerCase(), "ipl._bp"); assert.equal(result.status, 0, result.stderr.toString()); assert.equal(result.stdout.toString(), "program");
    assert.deepEqual(fs.readFileSync(file), original); assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith(format)), [`${format}.arc`]);
  }
});
test("native DSC1 independently matches the bounded Node decoder for literals and overlapping LZ", t => {
  const root = fixture(t), compressed = dsc(); archive(path.join(root, "system.arc"), [["ipl._bp", compressed]]);
  const result = read(root, "SYSTEM.ARC", "IPL._BP"); assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout.toString(), "ABAB"); assert.deepEqual(result.stdout, Archive.decodeDsc(compressed));
});
test("native archive names reject traversal, case collisions, out-of-range payloads and links", t => {
  const root = fixture(t);
  for (const [name, members, reason] of [
    ["traversal", [["../outside", "bad"]], /Unsafe/], ["duplicate", [["FILE", "a"], ["file", "b"]], /Duplicate/]
  ]) {
    archive(path.join(root, `${name}.arc`), members); const result = read(root, name, "file");
    assert.equal(result.status, 2); assert.match(result.stderr.toString(), reason);
  }
  const file = archive(path.join(root, "range.arc"), [["file", "valid"]]), bytes = fs.readFileSync(file); bytes.writeUInt32LE(0xffffffff, 16 + 96); fs.writeFileSync(file, bytes);
  assert.match(read(root, "range", "file").stderr.toString(), /outside/);
  archive(path.join(root, "valid.arc"), [["file", "valid"]]); fs.symlinkSync(path.join(root, "valid.arc"), path.join(root, "alias.arc"));
  assert.match(read(root, "alias", "file").stderr.toString(), /symbolic links/);
  assert.match(read(root, "../valid", "file").stderr.toString(), /Unsafe/);
});
test("native archives accept repeated identities only after bounded byte-for-byte payload verification", t => {
  const root = fixture(t);
  for (const format of ["ARC20", "PackFile"]) {
    const name = `repeated-${format}`;
    archive(path.join(root, `${name}.arc`), [["FILE", "shared bytes"], ["file", "shared bytes"], ["other", "other bytes"], ["FiLe", "shared bytes"]], format);
    const result = read(root, name, "file");
    assert.equal(result.status, 0, result.stderr.toString()); assert.equal(result.stdout.toString(), "shared bytes");
    assert.equal(read(root, name, "other").stdout.toString(), "other bytes");
  }
  archive(path.join(root, "empty.arc"), [["file", ""], ["FILE", ""]]);
  assert.equal(read(root, "empty", "file").status, 0);
  const chunks = Buffer.alloc(8193, 0x39), changed = Buffer.from(chunks); changed[8192] ^= 1;
  archive(path.join(root, "chunks.arc"), [["file", chunks], ["FILE", chunks]]);
  assert.deepEqual(read(root, "chunks", "file").stdout, chunks);
  archive(path.join(root, "different-tail.arc"), [["file", chunks], ["FILE", changed]]);
  const tail = read(root, "different-tail", "file");
  assert.equal(tail.status, 2); assert.match(tail.stderr.toString(), /different payloads/);
  archive(path.join(root, "different-size.arc"), [["file", "same"], ["FILE", "longer"]]);
  const different = read(root, "different-size", "file");
  assert.equal(different.status, 2); assert.match(different.stderr.toString(), /different payloads/);
});
test("native archive identity preserves Shift-JIS trail bytes while folding ASCII", t => {
  const root = fixture(t), name = Buffer.from([0x81, 0x5c, 0x41]);
  // A valid Shift-JIS trail byte 0x5c is part of the character, not a path.
  archive(path.join(root, "system.arc"), [[name, "character"], ["file", "ascii"]]);
  const result = read(root, "system", "FILE"); assert.equal(result.status, 0, result.stderr.toString()); assert.equal(result.stdout.toString(), "ascii");
});
test("native DSC1 rejects invalid trees, truncated streams, backreferences and oversized output", t => {
  const root = fixture(t);
  for (const [name, compressed, reason] of [
    ["depth", dsc({ lengths: { 65: 255 } }), /Huffman depth/],
    ["tree", dsc({ lengths: { 65: 1, 66: 1, 67: 1 } }), /Oversubscribed/],
    ["truncated", dsc({ bits: "", size: 1, count: 1 }), /Truncated/],
    ["match", dsc({ bits: "11" + "0".repeat(12), size: 2, count: 1 }), /output window/],
    ["size", dsc({ size: 5 }), /decoded size/],
    ["large", dsc({ size: 32 * 1024 * 1024 + 1 }), /output exceeds/]
  ]) {
    archive(path.join(root, `${name}.arc`), [["ipl._bp", compressed]]); const result = read(root, name, "ipl._bp");
    assert.equal(result.status, 2, result.stderr.toString()); assert.match(result.stderr.toString(), reason);
  }
});
test("native reader keeps bounded loose-directory compatibility and rejects ambiguous archive sources", t => {
  const root = fixture(t); fs.mkdirSync(path.join(root, "system")); fs.writeFileSync(path.join(root, "system", "IPL._BP"), "loose");
  const result = read(root, "system.arc", "ipl._bp"); assert.equal(result.status, 0, result.stderr.toString()); assert.equal(result.stdout.toString(), "loose");
  archive(path.join(root, "system.arc"), [["ipl._bp", "archive"]]); assert.match(read(root, "system", "ipl._bp").stderr.toString(), /Ambiguous/);
});
test("native registered search paths use original loose resources and unique ARC members without preparation", t => {
  const root = fixture(t), file = archive(path.join(root, "data01000.arc"), [["BUTTON", "packaged"]]), original = fs.readFileSync(file);
  for (const name of ["old", "New"]) { fs.mkdirSync(path.join(root, name, "Converted"), { recursive: true }); fs.writeFileSync(path.join(root, name, "Converted", "Button"), name); }
  let result = resource(root, "button", ["old/Converted", "new\\converted", "absent\\converted"]);
  assert.equal(result.status, 0, result.stderr.toString()); assert.equal(result.stdout.toString(), "New");
  result = resource(root, "button", ["old/Converted", "new\\converted"], false);
  assert.equal(result.status, 0, result.stderr.toString()); assert.equal(result.stdout.toString(), "packaged");
  assert.deepEqual(fs.readFileSync(file), original); assert.deepEqual(fs.readdirSync(root).sort(), ["New", "data01000.arc", "old"]);
  archive(path.join(root, "data02000.arc"), [["button", "other"]]);
  assert.match(resource(root, "button").stderr.toString(), /multiple source archives/);
  assert.equal(read(root, "data01000", "button").stdout.toString(), "packaged");
});
test("native resource search rejects unsafe relative directories, invalid names and linked directory escape", t => {
  const root = fixture(t), outside = fixture(t); fs.writeFileSync(path.join(outside, "secret"), "outside");
  fs.symlinkSync(outside, path.join(root, "linked"));
  for (const directory of ["../outside", "/outside", "C:\\outside", "sub//path", "sub\\..\\path", ".", "a".repeat(257)])
    assert.match(resource(root, "secret", [directory]).stderr.toString(), /Unsafe/);
  const linked = resource(root, "secret", ["linked"]); assert.equal(linked.status, 2); assert.equal(linked.stdout.length, 0);
  assert.match(resource(root, "../secret").stderr.toString(), /Unsafe/);
});

const upstream = path.resolve("src/external/openbgi");
const initialized = Overlay.INPUTS.files.every(file => fs.existsSync(path.join(upstream, file.path)));
test("OpenBGI reapplication stages exact guarded source and owned overlays without changing upstream", { skip: !initialized }, t => {
  const root = fixture(t), source = path.join(root, "source");
  const before = Overlay.INPUTS.files.map(file => Overlay.sha256(fs.readFileSync(path.join(upstream, file.path))));
  const receipt = Overlay.stageSource({ sourceRoot: upstream, destination: source });
  assert.equal(receipt.sourceRevision, Overlay.SOURCE_REVISION); assert.equal(receipt.version, Overlay.VERSION); assert.equal(receipt.gameplayQualified, false);
  for (const record of receipt.files) assert.equal(Overlay.sha256(fs.readFileSync(path.join(source, record.path))), record.sha256, record.path);
  assert.equal(new Set(receipt.files.map(file => file.path)).size, receipt.files.length);
  assert.deepEqual(Overlay.INPUTS.files.map(file => Overlay.sha256(fs.readFileSync(path.join(upstream, file.path)))), before);
  assert.match(fs.readFileSync(path.join(source, "src/main.c"), "utf8"), /gameplayQualified/);
  assert.doesNotMatch(fs.readFileSync(path.join(source, "src/main.c"), "utf8"), /GoldenLog_Load/);
  assert.throws(() => Overlay.stageSource({ sourceRoot: upstream, destination: source }), /fresh directory/);
});
test("OpenBGI input drift fails before creating output, including source aliases", { skip: !initialized }, t => {
  const root = fixture(t), source = path.join(root, "input"); fs.mkdirSync(source);
  for (const record of Overlay.INPUTS.files) {
    const target = path.join(source, record.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(upstream, record.path), target);
  }
  assert.throws(() => Overlay.stageSource({ sourceRoot: source, destination: path.join(source, "output") }), /read-only source/);
  const changed = path.join(source, "src/thread.c"); fs.appendFileSync(changed, "\n/* drift */\n");
  const output = path.join(root, "output"); assert.throws(() => Overlay.stageSource({ sourceRoot: source, destination: output }), /input changed/); assert.equal(fs.existsSync(output), false);
});
test("OpenBGI V1 reapplication preserves every historical owned and adapted source identity", { skip: !initialized }, t => {
  const recipe = require("../scripts/upstream-overlays.json").recipes.find(row => row.project === "openbgi" && row.version === ArchivedOverlay.VERSION);
  assert.ok(recipe, "The archived version has an independent source recipe");
  const expected = recipe.outputRoots.find(row => row.name === "configured-probe-source").reviewedAdaptedFiles;
  const root = fixture(t), receipt = ArchivedOverlay.stageSource({ sourceRoot: upstream, destination: path.join(root, "source") });
  assert.equal(receipt.sourceRevision, ArchivedOverlay.SOURCE_REVISION);
  assert.equal(receipt.files.length, Object.keys(expected).length);
  assert.deepEqual(Object.fromEntries(receipt.files.map(row => [row.path, row.sha256])), expected);
  for (const row of recipe.ownedFiles) {
    const file = path.resolve("src/modules/bgi/native/versions/probe-v1", path.basename(row.path));
    assert.equal(ArchivedOverlay.sha256(fs.readFileSync(file)), row.sha256);
  }
});
test("native program loading and bytecode guards preserve valid state and fail malformed ranges", { skip: !initialized }, t => {
  const root = fixture(t), headers = path.join(root, "headers"); fs.mkdirSync(path.join(headers, "SDL2"), { recursive: true });
  fs.writeFileSync(path.join(headers, "SDL2/SDL.h"), "typedef struct SDL_Window SDL_Window;\n");
  for (const name of ["engine.h", "thread.h"]) fs.writeFileSync(path.join(headers, name), Overlay.patch(`src/${name}`, fs.readFileSync(path.join(upstream, "src", name))));
  const driver = path.join(root, "guards.c"), binary = path.join(root, "guards");
  fs.writeFileSync(driver, `#include "vm-guards.h"\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\nint main(void) {
    Engine_t e={0}; Thread_t t={0}; unsigned char code[8]={0}, local[8]={0};
    unsigned char b[21]={16,0,0,0,5,0,0,0,0,0,0,0,0,0,0,0,0x80,0x52,0x00,0x01,0x17};
    t.engine=&e; t.code=code; t.codeSize=sizeof(code); t.localMem=local; t.localMemSize=sizeof(local); e.threads=&t;
    if(MLBGI_LoadCode(&t,b,sizeof(b),"ipl._bp")!=0||t.codeSpaceUsed!=5||t.programCount!=1||memcmp(code,b+16,5))return 1;
    t.nextInstructionPointer=4; if(!MLBGI_CodeAvailable(&t,1))return 2;
    if(MLBGI_CodeAvailable(&t,2)||t.error!=1)return 3;
    t.error=0; if(MLBGI_LoadCode(&t,b,sizeof(b),"second._bp")!=UINT32_MAX||t.programCount!=1||t.codeSpaceUsed!=5)return 4;
    t.error=0; if(MLBGI_LoadCode(&t,b,7,"truncated._bp")!=UINT32_MAX||t.programCount!=1)return 5;
    if(MLBGI_MemoryRemaining(&e,local+3)!=5||MLBGI_MemoryRemaining(&e,local+8)!=0)return 6;
    e.auxMemory[2]=local; e.auxMemorySizes[2]=8; e.threads=NULL;
    if(MLBGI_MemoryRemaining(&e,local+4)!=4)return 7;
    free(t.programs->filename); free(t.programs); return 0;
  }\n`);
  const compile = spawnSync("clang", ["-std=c11", process.platform === "darwin" ? "-D_DARWIN_C_SOURCE" : "-D_POSIX_C_SOURCE=200809L", "-fsanitize=address,undefined",
    "-I", headers, "-I", path.resolve("src/modules/bgi/native"), path.resolve("src/modules/bgi/native/vm-guards.c"), driver, "-o", binary], { encoding: "utf8", timeout: 30000 });
  assert.ifError(compile.error); assert.equal(compile.status, 0, compile.stderr);
  const result = spawnSync(binary, [], { encoding: "utf8", env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" }, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(result.stderr, /runtime error|AddressSanitizer/);
});
