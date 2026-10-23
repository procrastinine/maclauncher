const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
let root, binary;
test.before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-native-files-")); binary = path.join(root, "files");
  const driver = path.join(root, "files.c");
  fs.writeFileSync(driver, `#include "state-files.h"
#include <stdio.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
int main(int argc,char**argv){if(argc<3||chdir(argv[1]))return 1;MLBGI_Files f={-1,-1};
if(MLBGI_ConfigureFiles(&f,argv[1])||!MLBGI_ConfigureFiles(&f,argv[2]))return 2;
if(argc==7&&!strcmp(argv[3],"--find")){
 size_t capacity=strtoul(argv[5],NULL,10),written=99;unsigned limit=(unsigned)strtoul(argv[6],NULL,10);
 unsigned char*output=!strcmp(argv[5],"query")?NULL:malloc(capacity?capacity:1);if(output)memset(output,0x7e,capacity);
 int count=MLBGI_FindFiles(&f,argv[4],limit,output,capacity,&written);printf("%d %zu\\n",count,written);
 if(output)fwrite(output,1,count<0?capacity:written,stdout);free(output);MLBGI_CloseFiles(&f);return 0;
}
if(argc==4){printf("%d",MLBGI_GlobalDatabaseStatus(&f));MLBGI_CloseFiles(&f);return 0;}
if(argc==5&&!strcmp(argv[3],"--delete")){printf("%d",MLBGI_DeleteFile(&f,argv[4]));MLBGI_CloseFiles(&f);return 0;}
if(!MLBGI_PathStatus(&f,"original.dat",0)||MLBGI_PathStatus(&f,"original.dat",1)||!MLBGI_CreateDirectory(&f,"relative-write")||!MLBGI_PathStatus(&f,"relative-write",1))return 3;
if(!MLBGI_CreateDirectory(&f,"C:\\\\Game\\\\Project")||MLBGI_CreateDirectory(&f,"C:\\\\Game\\\\Project")||!MLBGI_PathStatus(&f,"C:\\\\Game\\\\Project",1))return 4;
if(MLBGI_CreateDirectory(&f,"C:\\\\Game\\\\Missing\\\\Nested")||MLBGI_CreateDirectory(&f,"C:\\\\Game\\\\Project\\\\..\\\\Escaped"))return 5;
if(MLBGI_PathStatus(&f,"C:\\\\Game\\\\linked\\\\secret",0)||MLBGI_CreateDirectory(&f,"C:\\\\Game\\\\linked\\\\Created"))return 6;
if(MLBGI_GlobalDatabaseStatus(&f))return 7;MLBGI_CloseFiles(&f);if(f.sourceFd!=-1||f.stateFd!=-1)return 8;return 0;}
`);
  const compile = spawnSync("clang", ["-std=c11", process.platform === "darwin" ? "-D_DARWIN_C_SOURCE" : "-D_POSIX_C_SOURCE=200809L", "-fsanitize=address,undefined", "-I", path.resolve("src/modules/bgi/native"),
    ...["state-files.c", "archive-reader.c"].map(name => path.resolve("src/modules/bgi/native", name)), driver, ...(process.platform === "darwin" ? ["-mmacosx-version-min=13.0", "-liconv"] : []), "-o", binary], { encoding: "utf8", timeout: 30000 });
  assert.ifError(compile.error); assert.equal(compile.status, 0, compile.stderr);
});
test.after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-files-original-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const game = path.join(parent, "game"), state = path.join(parent, "state"), outside = path.join(parent, "outside");
  for (const directory of [game, state, outside]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(game, "original.dat"), "original"); fs.writeFileSync(path.join(outside, "secret"), "outside"); fs.symlinkSync(outside, path.join(state, "linked"));
  return { parent, game, state, outside };
}
function run(args, encoding = "utf8") { return spawnSync(binary, args, { encoding, timeout: 10000, env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" } }); }
test("BGI native filesystem state stays separate from original game files and prevents traversal and linked-directory writes", t => {
  const { game, state, outside } = fixture(t), result = run([game, state]);
  assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(result.stderr, /runtime error|AddressSanitizer/);
  assert.deepEqual(fs.readdirSync(game), ["original.dat"]); assert.equal(fs.readFileSync(path.join(game, "original.dat"), "utf8"), "original");
  assert.deepEqual(fs.readdirSync(outside), ["secret"]); assert.deepEqual(fs.readdirSync(state).sort(), ["Project", "linked", "relative-write"]);
});
test("BGI script deletion affects only regular files inside isolated state for relative and virtual paths", t => {
  const { game, state, outside } = fixture(t);
  fs.mkdirSync(path.join(state, "UserData")); fs.mkdirSync(path.join(game, "UserData"));
  const source = path.join(game, "UserData", "state.dat"), file = path.join(state, "UserData", "state.dat");
  fs.writeFileSync(source, "original state"); fs.writeFileSync(file, "native state");
  const remove = name => { const result = run([game, state, "--delete", name]); assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(result.stderr, /AddressSanitizer|runtime error/); return result.stdout; };
  assert.equal(remove("UserData\\state.dat"), "1"); assert.equal(fs.existsSync(file), false); assert.equal(fs.readFileSync(source, "utf8"), "original state");
  assert.equal(remove("UserData\\state.dat"), "0"); fs.writeFileSync(file, "native state again");
  assert.equal(remove("C:\\Game\\UserData\\state.dat"), "1"); assert.equal(fs.readFileSync(source, "utf8"), "original state");
  fs.symlinkSync(path.join(outside, "secret"), file);
  for (const name of ["UserData\\state.dat", "linked\\secret", "UserData", "../outside/secret", "C:\\outside\\secret", "C:\\Game\\UserData\\..\\linked\\secret"]) assert.equal(remove(name), "0");
  assert.ok(fs.lstatSync(file).isSymbolicLink()); assert.equal(fs.readFileSync(path.join(outside, "secret"), "utf8"), "outside");
  assert.deepEqual(fs.readdirSync(game).sort(), ["UserData", "original.dat"]);
});
test("BGI missing, existing and linked global databases have distinct real filesystem outcomes", t => {
  const { game, state, outside } = fixture(t);
  assert.equal(run([game, state, "--database"]).stdout, "0");
  const file = path.join(state, "BGI.gdb"); fs.writeFileSync(file, "existing database");
  assert.equal(run([game, state, "--database"]).stdout, "1"); assert.equal(fs.readFileSync(file, "utf8"), "existing database");
  fs.rmSync(file); fs.symlinkSync(path.join(outside, "secret"), file);
  assert.equal(run([game, state, "--database"]).stdout, "-1"); assert.equal(fs.readFileSync(path.join(outside, "secret"), "utf8"), "outside");
});
test("BGI filename search keeps CP932 identities, bounded output and source-only traversal", t => {
  const { game, state, outside } = fixture(t);
  for (const name of ["data00001.arc", "DATA00002.ARC", "withoutExtension", "テスト.dat", "、.pair", "∥.pair"]) fs.writeFileSync(path.join(game, name), name);
  fs.mkdirSync(path.join(game, "sub")); fs.writeFileSync(path.join(game, "sub", "inner.dat"), "nested");
  fs.symlinkSync(outside, path.join(game, "linked"));
  const before = fs.readdirSync(game).sort(), listing = (pattern, capacity = "256", limit = "0") => {
    const result = run([game, state, "--find", pattern, capacity, limit], "latin1");
    assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(result.stderr, /runtime error|AddressSanitizer/);
    return Buffer.from(result.stdout, "binary");
  };
  assert.equal(listing("data0????.arc").toString(), "2 28\ndata00001.arc\0DATA00002.ARC\0");
  assert.equal(listing("DATA*.ARC", "query").toString(), "2 28\n");
  assert.equal(listing("data*.arc", "14", "1").toString(), "1 14\ndata00001.arc\0");
  assert.equal(listing("data*.arc", "4").toString(), "-1 0\n~~~~");
  assert.equal(listing("absent*.arc").toString(), "0 0\n");
  assert.equal(listing("sub\\inner.*").toString(), "1 10\ninner.dat\0");
  for (const pattern of ["../outside/*", "linked/*", "/outside/*", "C:\\outside\\*", "s*\\*.dat"])
    assert.match(listing(pattern, "1").toString(), /^-1 0\n~$/);
  // One wildcard consumes a complete CP932 character, including its trail byte.
  const japanese = listing("???.dat");
  assert.deepEqual(japanese.subarray(japanese.indexOf(10) + 1), Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 46, 100, 97, 116, 0]));
  const pair = listing("?.pair");
  assert.deepEqual(pair.subarray(pair.indexOf(10) + 1), Buffer.from([0x81, 0x41, 46, 112, 97, 105, 114, 0, 0x81, 0x61, 46, 112, 97, 105, 114, 0]));
  assert.match(listing("*.*", "1").toString(), /^-1 0\n~$/); // A matching link cannot cross the source root.
  fs.unlinkSync(path.join(game, "linked"));
  const all = listing("*.*").subarray(0, 4).toString(); assert.match(all, /^7 /);
  fs.symlinkSync(outside, path.join(game, "linked"));
  assert.deepEqual(fs.readdirSync(game).sort(), before); assert.deepEqual(fs.readdirSync(outside), ["secret"]);
  assert.deepEqual(fs.readdirSync(state), ["linked"]);
});
