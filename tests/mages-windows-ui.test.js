const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const UI = require("../src/modules/mages/native/windows-ui-data");
const Session = require("../src/modules/mages/native/windows-ui-session");
const { archive, script } = require("./helpers/mages-fixture");
const { peFixture, withVersion } = require("./helpers/mages-windows-ui-fixture");

const parse = bytes => UI.parseWindowsUiData((offset, length) => bytes.subarray(offset, offset + length), bytes.length);

test("Windows UI metadata resolves relocated PE pointers without a game name or a fixed address", () => {
  const original = parse(peFixture().bytes), relocated = parse(peFixture({ base: 0x10000000 }).bytes);
  assert.deepEqual(original.regions, relocated.regions);
  assert.equal(original.descriptorSha256, relocated.descriptorSha256);
  assert.equal(original.abi, UI.ABI);
  assert.equal(original.regions.length, 2);
  assert.deepEqual(original.selectors, { enabledLeft: 1, enabledRight: 3, savedSlot: 0 });
  assert.notEqual(original.originalOperations.handler, relocated.originalOperations.handler);
  assert.ok(original.bytesRead <= UI.LIMITS.totalBytes);
});

test("unknown, ambiguous, incomplete and mismatched Windows UI operation layouts fail closed", () => {
  assert.throws(() => parse(peFixture({ duplicateDispatch: true }).bytes), /ambiguous/);
  for (const change of [f => f.bytes.writeUInt16LE(0x8664, 0x84), f => f.bytes[f.enable + 43] = 2,
    f => f.bytes[f.disable + 15] ^= 1, f => f.bytes[f.register] = 0, f => f.bytes[f.enable + 35] = 0,
    f => f.bytes[0x200 + 0x580 + 9] ^= 1,
    f => f.bytes.writeUInt32LE(0xffff0000, f.table + 13 * 4),
    f => f.bytes.writeUInt32LE(0xffffff00, f.sections + 20)]) {
    const fixture = peFixture(); change(fixture); assert.throws(() => parse(fixture.bytes));
  }
  assert.throws(() => parse(peFixture().bytes.subarray(0, 0x80)), /read bounds/);
});

test("input descriptors reject ambiguity, parent cycles, overflowing coordinates and unbounded tables", () => {
  for (const change of [f => f.bytes.writeInt32LE(0, f.regionTable + 32),
    f => f.bytes.writeInt32LE(3, f.regionTable + 36), f => f.bytes.writeInt32LE(1 << 30, f.regionTable + 52),
    f => f.bytes.writeUInt32LE(0x10000, f.regionTable + 28),
    f => f.bytes.writeInt32LE(1, f.regionTable + 64)]) {
    const fixture = peFixture(); change(fixture); assert.throws(() => parse(fixture.bytes));
  }
  const r = parse(peFixture().bytes);
  assert.throws(() => UI.luaInputData({ ...r, abi: "unknown" }), /version/);
  assert.throws(() => UI.luaInputData({ ...r, descriptorSha256: "0".repeat(64) }), /checksum/);
  assert.match(UI.luaInputData(r), /root.WindowsUiInput = \{ Version = 1/);
  assert.match(UI.luaInputData(r), /Id = 3, ParentId = 0, Relative = 1/);
});

test("input metadata stays in owned session files and refuses linked or mismatched state", t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mages-ui-session-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = path.join(root, "session"), original = path.join(root, "original.lua");
  fs.mkdirSync(path.join(session, "patches"), { recursive: true }); fs.writeFileSync(original, "original content");
  const metadata = parse(peFixture().bytes), first = Session.writeInputMetadata(session, metadata), before = fs.readFileSync(original);
  assert.match(fs.readFileSync(first.file, "utf8"), /Version = 1/);
  assert.equal(Session.writeInputMetadata(session, metadata).sha256, first.sha256);
  fs.unlinkSync(first.file); fs.symlinkSync(original, first.file);
  assert.throws(() => Session.writeInputMetadata(session, metadata), /without links/);
  fs.unlinkSync(first.file); fs.linkSync(original, first.file);
  assert.throws(() => Session.writeInputMetadata(session, metadata), /without links/);
  assert.deepEqual(fs.readFileSync(original), before);
  fs.unlinkSync(first.file); fs.rmdirSync(path.join(session, "patches")); fs.symlinkSync(root, path.join(session, "patches"));
  assert.throws(() => Session.writeInputMetadata(session, metadata), /linked/);
  assert.equal(require("../src/modules/mages/native/adapter").hash(Session.PROFILE_SOURCE), Session.PROFILE_SHA256);
});

test("the file reader uses a bounded regular original and leaves it unchanged", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mages-ui-input-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "input.exe"), bytes = peFixture().bytes; fs.writeFileSync(file, bytes);
  assert.deepEqual(UI.inspectWindowsUiData(file).regions, parse(bytes).regions);
  assert.deepEqual(fs.readFileSync(file), bytes);
  const link = path.join(root, "linked.exe"); fs.symlinkSync(file, link);
  assert.throws(() => UI.inspectWindowsUiData(link));
});

test("ordinary Windows session setup loads original input descriptors without copying game data or adding diagnostic flags", t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mages-ui-ordinary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, "game"), data = path.join(game, "USRDIR"), runtime = path.join(root, "runtime"), sessionDir = path.join(root, "session");
  fs.mkdirSync(data, { recursive: true });
  archive(path.join(data, "script.mpk"), [{ name: "_STARTUP_WIN.SCX", id: 2, bytes: script({ returns: [16] }) }]);
  archive(path.join(data, "system.mpk"), [["DATA01.DDS", 6], ["FONT.PNG", 9], ["BACKLOG.DDS", 2], ["TITLE_CHIP.DDS", 30], ["WAVTABLE.DAT", 31]]
    .map(([name, id]) => ({ name, id, bytes: "synthetic resource" })));
  for (const name of ["bgm", "se", "voice", "bg", "chara", "mask"]) archive(path.join(data, name + ".mpk"), [{ name: "original.dat", bytes: "synthetic data" }]);
  fs.mkdirSync(path.join(data, "movie", "1920x1080"), { recursive: true });
  const movie = Buffer.alloc(40); movie.write("KB2j"); movie.writeUInt32LE(1920, 20); movie.writeUInt32LE(1080, 24);
  fs.writeFileSync(path.join(data, "movie", "1920x1080", "title.bk2"), movie);
  const original = withVersion(peFixture().bytes), executable = path.join(game, "Game.exe"); fs.writeFileSync(executable, original);
  assert.equal(require("../src/modules/shared/runtime/pe-version").readPeVersion(executable)?.strings.ProductName, "Steins;Gate");
  fs.writeFileSync(path.join(game, "bink2w32.dll"), "synthetic library");
  fs.mkdirSync(path.join(runtime, "Impacto.app", "Contents", "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(runtime, "Impacto.app", "Contents", "Resources")); fs.mkdirSync(path.join(runtime, "profiles"));
  fs.writeFileSync(path.join(runtime, "Impacto.app", "Contents", "MacOS", "Impacto"), "not executed");
  const input = Session.prepareWindowsInputSession({ gamePath: game, runtimeRoot: runtime, sessionDir });
  assert.deepEqual(input.env, {}); assert.equal(input.args.includes("--diagnostic-frames"), false);
  assert.equal(input.profileSha256, Session.PROFILE_SHA256); assert.equal(input.inputMetadata.regions, 2);
  assert.deepEqual(fs.readFileSync(executable), original);
  assert.match(fs.readFileSync(path.join(sessionDir, "windows-game.lua"), "utf8"), /windows-ui-input\.lua/);
  assert.match(fs.readFileSync(input.inputMetadata.file, "utf8"), /Id = 3, ParentId = 0/);
  const unsupported = withVersion(peFixture({ duplicateDispatch: true }).bytes); fs.writeFileSync(executable, unsupported);
  const otherSession = path.join(root, "unsupported-session");
  assert.throws(() => Session.prepareWindowsInputSession({ gamePath: game, runtimeRoot: runtime, sessionDir: otherSession }), /ambiguous/);
  assert.equal(fs.existsSync(otherSession), false);
});

test("native input-bank transitions preserve click boundaries, wheel flags and saved mouse selectors", { skip: process.platform !== "darwin" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mages-native-input-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "state.cpp"), executable = path.join(root, "state");
  fs.writeFileSync(source, `#include "windows-input-state.h"
#include <cassert>
#include <iostream>
using namespace Impacto::Vm::WindowsInput;
int main() {
  InputBank bank;
  bank.Configure({{0,65535,0,10,20,100,80,0x608},{1,0,1,50,30,10,10,9}});
  bank.Apply(13); assert(bank.Enabled && bank.LeftSelector==1 && bank.RightSelector==3);
  PointerFrame press{65,55,0,{true,false},{true,false}};
  assert(bank.Poll(press)==0);
  PointerFrame release{65,55,0,{false,false},{false,false}};
  assert(bank.Poll(release)==0x1000);
  bool parent=false,child=false; for(const auto& e:bank.Events) if(e.Type==8){parent|=e.Id==0;child|=e.Id==1;} assert(parent&&child);
  press.X=70; assert(bank.Poll(press)==0); release.X=70; bank.Poll(release);
  for(const auto& e:bank.Events) assert(e.Id!=1 || e.Type!=8);
  press.X=65; press.Y=55; bank.Poll(press); release.X=111; bank.Poll(release);
  for(const auto& e:bank.Events) assert(e.Type!=8);
  PointerFrame wheel{20,25,-2,{false,false},{false,false}}; bank.Poll(wheel);
  bool scroll=false; for(const auto& e:bank.Events) scroll|=e.Type==0x400&&e.Id==0&&e.Value==2; assert(scroll);
  PointerFrame right{40,40,0,{false,true},{false,true}}; assert(bank.Poll(right)==0);
  right.WentDown[1]=false; right.IsDown[1]=false; assert(bank.Poll(right)==0x10&&bank.MenuRequested);
  PointerFrame both{40,40,0,{true,true},{true,true}}; assert(bank.Poll(both)==0);
  both.WentDown={false,false}; both.IsDown={false,false}; assert(bank.Poll(both)==0);
  bank.Apply(14); assert(!bank.Enabled&&bank.RightSelector==2&&bank.LeftSelector==1);
  right.WentDown[1]=true; right.IsDown[1]=true; bank.Poll(right);
  right.WentDown[1]=false; right.IsDown[1]=false; assert(bank.Poll(right)==0x2000&&bank.Events.empty());
  try{bank.Apply(99);assert(false);}catch(const std::runtime_error&){} assert(!bank.Enabled&&bank.RightSelector==2);
  try{bank.Configure({{1,1,1,0,0,10,10,9}});assert(false);}catch(const std::runtime_error&){}
  bank.Apply(13); wheel.Wheel=1; bank.Poll(wheel); assert(!bank.Events.empty());
  bank.Apply(13); bank.Apply(14); assert(bank.RightSelector==3);
  bank.Reset(); assert(!bank.Enabled&&bank.RightSelector==2&&bank.LeftSelector==1&&!bank.MenuRequested);
  std::cout<<"input-bank semantics pass\\n";
}`);
  execFileSync("/usr/bin/clang++", ["-std=c++20", "-arch", "arm64", "-mmacosx-version-min=13.0",
    "-I", path.resolve(__dirname, "../src/modules/mages/native"), source, "-o", executable], { stdio: "pipe" });
  assert.equal(execFileSync(executable, [], { encoding: "utf8" }), "input-bank semantics pass\n");
});
