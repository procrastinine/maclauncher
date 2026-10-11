const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Overlay = require("../src/modules/mages/native/windows-sfx-overlay");
const Session = require("../src/modules/mages/native/windows-sfx-session");
const Build = require("../src/modules/mages/native/portable-sfx-build");
const Base = require("../src/modules/mages/native/portable-backlog-build");

const nativeRoot = path.resolve(__dirname, "../src/modules/mages/native");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

test("the Windows sound-effect profile preserves the previous profile and recipe", () => {
  assert.equal(Build.VERSION, "0.10.8.810-windows-v9");
  assert.equal(Build.PROFILE, "windows-mpk2-sc3-sfx-macos13-v9");
  assert.equal(Overlay.ABI, "windows-sc3-sfx-v1");
  assert.equal(hash(fs.readFileSync(Session.PROFILE_SOURCE)), Session.PROFILE_SHA256);
  const current = fs.readFileSync(Session.PROFILE_SOURCE, "utf8");
  assert.equal(current.replace("    WindowsSoundEffectOpcodeExtensions = true,\n", ""),
    fs.readFileSync(Base.PROFILE_SOURCE, "utf8"));
  assert.equal(Base.overlayIdentity(), Build.BASE_RECIPE_SHA256);
  assert.equal(Build.RECIPE_FILES.length, Base.RECIPE_FILES.length + 6);
  for (const file of ["portable-sfx-build.js", "windows-sfx-overlay.js", "windows-sfx-session.js",
    "windows-sfx.h", "windows-sfx.cpp", "windows-game-v9.lua"])
    assert.ok(Build.RECIPE_FILES.includes(path.join(nativeRoot, file)));
});

test("sound-effect adapters reject unsafe or mismatched exports before writes", t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mages-sfx-overlay-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); fs.mkdirSync(source);
  fs.mkdirSync(path.join(source, ".git"));
  assert.throws(() => Overlay.applyWindowsSoundEffectOverlay(source), /separate source export/);
  fs.rmdirSync(path.join(source, ".git"));
  fs.writeFileSync(path.join(source, "CMakeLists.txt"), "different source\n");
  assert.throws(() => Overlay.applyWindowsSoundEffectOverlay(source), /checksum/);
  assert.equal(fs.readFileSync(path.join(source, "CMakeLists.txt"), "utf8"), "different source\n");
  const linked = path.join(root, "linked"); fs.symlinkSync(source, linked);
  assert.throws(() => Overlay.applyWindowsSoundEffectOverlay(linked), /separate source export/);
  assert.throws(() => Overlay.applyWindowsSoundEffectOverlay(path.resolve(__dirname, "../src/external")), /external checkouts/);
  const badProfile = path.join(root, "profile.lua"); fs.writeFileSync(badProfile, "changed profile\n");
  assert.throws(() => Session.prepareWindowsSoundEffectSession({ profileSource: badProfile }), /checksum/);
});

test("sound-effect engine reuse rejects wrong versions, CPUs and missing prior contracts", () => {
  for (const reuse of [undefined, {}, { schemaVersion: 2 }, { schemaVersion: 1, base: { version: Build.VERSION } }])
    assert.throws(() => Build.validateReuseInputs(reuse), /exact Windows v8/);
  const base = { version: Base.VERSION, profile: Base.PROFILE, architecture: "arm64", minimumMacOS: "13.0",
    overlaySha256: Build.BASE_RECIPE_SHA256, profileSha256: Base.PROFILE_SHA256,
    sourceTrees: require("../src/modules/mages/native/portable-build").SOURCE_TREES,
    windowsAudioOverlay: { abi: "windows-sc3-voice-v1" },
    windowsCheckpointOverlay: { abi: "windows-sc3-checkpoint-u16-v1" },
    windowsBacklogOverlay: { abi: "backlog-zero-capacity-v1" }, engineReuse: {} };
  for (const change of [{ architecture: "x64" }, { minimumMacOS: "27.0" }, { overlaySha256: "0".repeat(64) },
    { profileSha256: "0".repeat(64) }, { sourceTrees: {} }, { windowsAudioOverlay: {} },
    { windowsCheckpointOverlay: {} }, { windowsBacklogOverlay: {} }])
    assert.throws(() => Build.validateReuseInputs({ schemaVersion: 1, base: { ...base, ...change } }), /exact Windows v8/);
  assert.throws(() => Build.validateReuseInputs({ schemaVersion: 1, base }), /exact macOS 13 dependency/);
});

test("compiled Windows sound effects preserve instruction boundaries, preload/resume and legacy widths",
  { skip: process.platform !== "darwin" }, t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mages-sfx-native-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const vm = path.join(root, "vm"), audio = path.join(root, "audio"), profile = path.join(root, "profile");
    for (const directory of [vm, audio, profile]) fs.mkdirSync(directory);
    fs.writeFileSync(path.join(vm, "vm.h"), `#pragma once
#include <cstdint>
#include <vector>
#include <stdexcept>
namespace Impacto::Vm {
struct Sc3VmThread {
  std::vector<uint8_t> Bytes; uint32_t IpOffset = 0;
  uint8_t* GetIp(size_t length = 1) {
    if (IpOffset > Bytes.size() || length > Bytes.size() - IpOffset)
      throw std::runtime_error("bounded operand read");
    return Bytes.data() + IpOffset;
  }
};
inline bool BlockCurrentScriptThread = false;
inline unsigned ExpressionCount = 0;
}
#define VmInstruction(name) void name(Impacto::Vm::Sc3VmThread* thread, float dt)
`);
    fs.writeFileSync(path.join(vm, "inst_macros.inc"), `#define StartInstruction thread->GetIp(2); thread->IpOffset += 2
#define BlockThread BlockCurrentScriptThread = true
#define PopUint8(name) uint8_t name = *thread->GetIp(); thread->IpOffset += 1
#define PopExpression(name) [[maybe_unused]] int name = ExpressionEval(thread)
`);
    fs.writeFileSync(path.join(vm, "expression.h"), `#pragma once
#include "vm.h"
namespace Impacto::Vm {
inline int ExpressionEval(Sc3VmThread* thread) {
  ++ExpressionCount;
  auto byte = [&] { auto value = *thread->GetIp(); ++thread->IpOffset; return value; };
  const auto token = byte(); if (!token) return 0;
  if (!(token & 0x80)) throw std::runtime_error("fixture needs one immediate operand");
  int value = token & 0x1f;
  if ((token & 0x60) == 0x20) value = value * 256 + byte();
  else if ((token & 0x60) == 0x40) { const auto low=byte(); const auto high=byte(); value=value*65536+low+high*256; }
  else if ((token & 0x60) != 0) throw std::runtime_error("fixture immediate width");
  if (token & 0x10) value |= (token & 0x60) == 0x40 ? ~0x1fffff : (token & 0x60) == 0x20 ? ~0x1fff : ~0x1f;
  if (byte() != 0 || byte() != 0) throw std::runtime_error("unterminated expression");
  return value;
}
}
`);
    fs.writeFileSync(path.join(profile, "scriptvars.h"), `#pragma once
namespace Impacto::Profile::ScriptVars { inline constexpr int SW_SEREQNO = 10, SW_SEVOL = 20; }
`);
    fs.writeFileSync(path.join(root, "mem.h"), `#pragma once
#include <array>
namespace Impacto { inline std::array<int, 100> ScrWork{}; }
`);
    fs.writeFileSync(path.join(audio, "audiochannel.h"), `#pragma once
#include <string>
#include <cstdint>
namespace Impacto::Audio {
enum AudioChannelState { ACS_Stopped, ACS_Playing, ACS_Paused, ACS_FadingIn, ACS_FadingOut };
struct AudioChannel {
  AudioChannelState State = ACS_Stopped; bool Loaded = false;
  unsigned Plays = 0, Stops = 0, Pauses = 0, Resumes = 0, VolumeWrites = 0;
  uint32_t File = 0; bool Loop = false; float Fade = -1, Volume = -1;
  void Play(std::string const& mount, uint32_t file, bool loop, float fade) {
    if (mount != "se") throw std::runtime_error("unexpected mount");
    ++Plays; File = file; Loop = loop; Fade = fade; State = ACS_Playing; Loaded = true;
  }
  void Stop(float fade) { ++Stops; Fade = fade; State = ACS_Stopped; Loaded = false; }
  void Pause() { ++Pauses; if(State == ACS_Playing) State = ACS_Paused; }
  void Resume() { ++Resumes; if(State == ACS_Paused) State = ACS_Playing; }
  void SetVolume(float volume) { ++VolumeWrites; Volume = volume; }
  AudioChannelState GetState() const { return State; }
  bool IsLooping() const { return Loop; }
  const void* GetStream() const { return Loaded ? this : nullptr; }
};
}
`);
    fs.writeFileSync(path.join(audio, "audiosystem.h"), `#pragma once
#include "audiochannel.h"
#include <array>
#include <memory>
namespace Impacto::Audio {
inline constexpr unsigned AC_SE0 = 6;
inline std::array<std::unique_ptr<AudioChannel>, 9> Channels;
}
`);
    const oldSource = fs.readFileSync(path.join(__dirname, "../src/external/impacto/src/vm/inst_sound.cpp"), "utf8");
    const legacy = oldSource.match(/VmInstruction\(InstSEplayMO6\) \{\n[\s\S]*?\n\}/)?.[0];
    assert.ok(legacy, "the pinned older sound operand layout is required for comparison");
    const fixture = path.join(root, "fixture.cpp"), executable = path.join(root, "fixture");
    fs.writeFileSync(fixture, `#include "windows-sfx.h"
#include "vm.h"
#include "inst_macros.inc"
#include "expression.h"
#include "../audio/audiosystem.h"
#include "../profile/scriptvars.h"
#include "../mem.h"
#include <cassert>
#include <cmath>
#include <iostream>
namespace Impacto::Vm { using namespace Impacto::Profile::ScriptVars; ${legacy} }
using namespace Impacto;
using namespace Impacto::Vm;
using namespace Impacto::Audio;
using namespace Impacto::Profile::ScriptVars;
void reset() {
  BlockCurrentScriptThread = false; ExpressionCount = 0; ScrWork.fill(0);
  for(auto& channel : Channels) channel = std::make_unique<AudioChannel>();
  for(int i=0;i<3;i++) { ScrWork[SW_SEREQNO+i] = 0xffff; ScrWork[SW_SEVOL+i] = 50; }
}
void noChanges() {
  assert(!BlockCurrentScriptThread);
  for(int i=0;i<3;i++) {
    const auto& sound = *Channels[AC_SE0+i];
    assert(!sound.Plays && !sound.Stops && !sound.Pauses && !sound.Resumes && !sound.VolumeWrites);
    assert(ScrWork[SW_SEREQNO+i] == 0xffff && ScrWork[SW_SEVOL+i] == 50);
  }
}
template<class F> void rejects(F action) { bool rejected = false; try { action(); } catch(const std::runtime_error&) { rejected = true; } assert(rejected); }
int main() {
  // This generic Windows request leaves the next FE assignment untouched.
  reset(); Sc3VmThread play{{0x00,0x23,0,0,0x83,0,0,0x81,0,0,0xfe,0x28}};
  InstWindowsSePlay(&play,0); assert(play.IpOffset==10 && *play.GetIp()==0xfe && ExpressionCount==2);
  assert(Channels[AC_SE0]->File==3 && Channels[AC_SE0]->Loop && BlockCurrentScriptThread);
  assert(ScrWork[SW_SEREQNO]==3 && std::abs(Channels[AC_SE0]->Volume-0.15f)<0.00001f);
  reset(); Sc3VmThread wrongLayout{{0x00,0x23,0,0,0x83,0,0,0x81,0,0,0xfe,0x28}};
  InstSEplayMO6(&wrongLayout,0); assert(wrongLayout.IpOffset==7 && *wrongLayout.GetIp()==0x81);
  assert(Channels[AC_SE0]->File==0 && Channels[AC_SE0]->Loop);
  for(uint8_t channel : {0,1,2}) {
    reset(); Sc3VmThread preload{{0x00,0x23,channel,1,0x86,0,0,0x81,0,0,0xfe}};
    InstWindowsSePlay(&preload,0); auto& sound=*Channels[AC_SE0+channel];
    assert(preload.IpOffset==10 && sound.Loaded && sound.State==ACS_Paused && sound.Pauses==1);
    assert(sound.File==6 && sound.Loop && BlockCurrentScriptThread && ScrWork[SW_SEREQNO+channel]==6);
    BlockCurrentScriptThread=false; ExpressionCount=0; Sc3VmThread resume{{0x00,0x23,channel,2,0xfe}};
    InstWindowsSePlay(&resume,0); assert(resume.IpOffset==4 && *resume.GetIp()==0xfe);
    assert(sound.State==ACS_Playing && sound.Resumes==1 && ExpressionCount==0 && !BlockCurrentScriptThread);
    Sc3VmThread repeat{{0x00,0x23,channel,0,0x86,0,0,0x81,0,0,0xfe}};
    InstWindowsSePlay(&repeat,0); assert(repeat.IpOffset==10 && sound.Plays==1 && !BlockCurrentScriptThread);
    Sc3VmThread preloadAgain{{0x00,0x23,channel,1,0x86,0,0,0x81,0,0,0xfe}};
    InstWindowsSePlay(&preloadAgain,0); assert(sound.Plays==1 && BlockCurrentScriptThread);
  }
  reset(); Sc3VmThread once{{0x00,0x23,2,0,0x85,0,0,0x80,0,0}};
  InstWindowsSePlay(&once,0); assert(once.IpOffset==10 && !Channels[AC_SE0+2]->Loop && ScrWork[SW_SEREQNO+2]==0xffff);
  reset(); Sc3VmThread stop{{0x00,0x23,1,0,0x9f,0,0,0x80,0,0,0xfe}};
  InstWindowsSePlay(&stop,0); assert(stop.IpOffset==10 && Channels[AC_SE0+1]->Stops==1 && !Channels[AC_SE0+1]->Plays);
  assert(ScrWork[SW_SEREQNO+1]==0xffff && BlockCurrentScriptThread);
  for(uint8_t channel : {3,6,7,8,255}) {
    reset(); Sc3VmThread unknown{{0x00,0x23,channel,0,0x83,0,0,0x81,0,0}};
    rejects([&] { InstWindowsSePlay(&unknown,0); }); noChanges(); assert(unknown.IpOffset==0 && ExpressionCount==0);
  }
  for(uint8_t type : {3,255}) {
    reset(); Sc3VmThread unknown{{0x00,0x23,0,type,0x83,0,0,0x81,0,0}};
    rejects([&] { InstWindowsSePlay(&unknown,0); }); noChanges(); assert(unknown.IpOffset==0 && ExpressionCount==0);
  }
  for(auto bytes : {std::vector<uint8_t>{}, {0x00}, {0x00,0x23}, {0x00,0x23,0},
    {0x00,0x23,0,0}, {0x00,0x23,0,0,0x83}, {0x00,0x23,0,0,0x83,0},
    {0x00,0x23,0,0,0x83,0,0}, {0x00,0x23,0,0,0x83,0,0,0x81,0},
    {0x00,0x23,0,0,0x83,0,0,0x81,0,1}}) {
    reset(); Sc3VmThread truncated{bytes}; rejects([&] { InstWindowsSePlay(&truncated,0); }); noChanges();
  }
  reset(); Sc3VmThread invalidId{{0x00,0x23,0,0,0x9e,0,0,0x80,0,0}};
  rejects([&] { InstWindowsSePlay(&invalidId,0); }); noChanges();
  reset(); Sc3VmThread highId{{0x00,0x23,0,0,0xc0,0x10,0x27,0,0,0x80,0,0}};
  rejects([&] { InstWindowsSePlay(&highId,0); }); noChanges();
  reset(); Sc3VmThread maximumId{{0x00,0x23,0,0,0xc0,0x0f,0x27,0,0,0x80,0,0}};
  InstWindowsSePlay(&maximumId,0); assert(maximumId.IpOffset==12 && Channels[AC_SE0]->File==9999);
  reset(); Sc3VmThread resumeEnd{{0x00,0x23,2,2}};
  InstWindowsSePlay(&resumeEnd,0); assert(resumeEnd.IpOffset==4 && !ExpressionCount && !BlockCurrentScriptThread);
  reset(); Sc3VmThread legacyCode{{0x00,0x23,0,0x83,0,0,0x81,0,0,0xfe}};
  InstSEplayMO6(&legacyCode,0); assert(legacyCode.IpOffset==9 && *legacyCode.GetIp()==0xfe && !BlockCurrentScriptThread);
  std::cout << "Windows sound-effect operands and playback semantics pass\\n";
}
`);
    execFileSync("/usr/bin/clang++", ["-std=c++20", "-arch", "arm64", "-mmacosx-version-min=13.0",
      "-I", nativeRoot, "-I", vm, path.join(nativeRoot, "windows-sfx.cpp"), fixture, "-o", executable], { stdio: "pipe" });
    assert.equal(execFileSync(executable, [], { encoding: "utf8" }), "Windows sound-effect operands and playback semantics pass\n");
  });
