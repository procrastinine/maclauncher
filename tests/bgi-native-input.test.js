const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const sdl = spawnSync("sdl2-config", ["--cflags"], { encoding: "utf8" });
const flags = sdl.status === 0 ? sdl.stdout.trim().split(/\s+/).filter(Boolean) : [];

test("BGI native input maps physical SDL events to versioned actions without a window", { skip: !flags.length }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-native-input-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const driver = path.join(root, "input.c"), binary = path.join(root, "input");
  fs.writeFileSync(driver, `#include "platform-input.h"
#include <string.h>
static void key(MLBGI_Input *i, SDL_Keycode k, int down, int repeat, uint32_t now){SDL_Event e={0};e.type=down?SDL_KEYDOWN:SDL_KEYUP;e.key.keysym.sym=k;e.key.repeat=repeat;MLBGI_SDLInputEvent(i,&e,now);}
int main(void){MLBGI_Input i;MLBGI_InitInput(&i);
if(MLBGI_InputMapIndex(256)!=7||MLBGI_InputMapIndex(257)!=-1||MLBGI_SDLKey(SDLK_a)!=65||MLBGI_SDLKey(SDLK_KP_9)!=105||MLBGI_SDLKey(SDLK_F24)!=135)return 1;
key(&i,SDLK_RETURN,1,0,100);if(!i.held[13]||i.events[13]!=1||MLBGI_InputEventCount(&i,256)!=1||MLBGI_ConsumeKey(&i,13)!=0x80000001||MLBGI_ConsumeKey(&i,13))return 2;
key(&i,SDLK_RETURN,1,1,120);if(i.events[13]!=2||i.presses[13]||MLBGI_ConsumeKey(&i,13))return 3;
key(&i,SDLK_RETURN,0,0,130);key(&i,SDLK_RETURN,1,0,140);if(MLBGI_ConsumeKey(&i,13)!=0x80000001||MLBGI_InputEventCount(&i,256)!=3)return 4;
uint32_t keys[]={32,13};if(!MLBGI_SetInputMap(&i,256,keys,2))return 5;key(&i,SDLK_SPACE,1,0,160);if(MLBGI_InputEventCount(&i,256)!=4)return 6;
if(MLBGI_SetInputMap(&i,1,keys,2)||MLBGI_SetInputMap(&i,65536,keys,2)||MLBGI_SetInputMap(&i,256,keys,16)||i.maps[7][0]!=32)return 7;
keys[1]=256;if(MLBGI_SetInputMap(&i,256,keys,2)||i.maps[7][1]!=13)return 8;
key(&i,SDLK_LCTRL,1,0,170);key(&i,SDLK_RCTRL,1,0,180);if(!i.held[17]||i.events[17]!=2)return 9;
key(&i,SDLK_LCTRL,0,0,190);if(!i.held[17]||i.events[17]!=2)return 10;
key(&i,SDLK_RCTRL,0,0,200);if(i.held[17]||i.events[17]!=2)return 11;
SDL_Event e={0};e.type=SDL_MOUSEBUTTONDOWN;e.button.button=SDL_BUTTON_RIGHT;MLBGI_SDLInputEvent(&i,&e,210);if(!i.held[2]||MLBGI_InputEventCount(&i,2)!=1)return 12;
e.type=SDL_MOUSEWHEEL;e.wheel.y=3;e.wheel.direction=SDL_MOUSEWHEEL_NORMAL;MLBGI_SDLInputEvent(&i,&e,220);if(i.held[14]||MLBGI_InputEventCount(&i,64)!=3||MLBGI_ConsumeKey(&i,14)!=3)return 13;
e.wheel.direction=SDL_MOUSEWHEEL_FLIPPED;MLBGI_SDLInputEvent(&i,&e,230);if(MLBGI_InputEventCount(&i,128)!=3)return 14;
e.type=SDL_WINDOWEVENT;e.window.event=SDL_WINDOWEVENT_FOCUS_LOST;MLBGI_SDLInputEvent(&i,&e,240);if(i.held[2]||i.held[13]||i.held[32]||MLBGI_InputEventCount(&i,256)!=4)return 15;
MLBGI_InputEvent(&i,256,1,0,250);if(MLBGI_ConsumeKey(&i,256))return 16;
uint32_t baseline[256];memcpy(baseline,i.events,sizeof(baseline));if(MLBGI_InputInterrupted(&i,0xffffffff,baseline))return 17;
key(&i,SDLK_a,1,0,260);if(MLBGI_InputInterrupted(&i,0x80000181,baseline))return 18;
key(&i,SDLK_RETURN,1,0,270);if(!MLBGI_InputInterrupted(&i,0x80000181,baseline))return 19;
memcpy(baseline,i.events,sizeof(baseline));key(&i,SDLK_LCTRL,1,0,280);if(!MLBGI_InputInterrupted(&i,0x80000181,baseline))return 20;
memcpy(baseline,i.events,sizeof(baseline));if(!MLBGI_InputInterrupted(&i,0x80000181,baseline))return 21;
key(&i,SDLK_LCTRL,0,0,290);if(MLBGI_InputInterrupted(&i,0x80000181,baseline))return 22;
return 0;}
`);
  assert.ok(flags.every(flag => /^(-I\S+|-D\S+)$/.test(flag)), "finite SDL compiler flags");
  const compiled = spawnSync("clang", ["-std=c11", "-fsanitize=address,undefined", ...flags,
    "-I", path.resolve("src/modules/bgi/native"), path.resolve("src/modules/bgi/native/vm-input.c"),
    path.resolve("src/modules/bgi/native/platform-input.c"), driver, "-o", binary], { encoding: "utf8", timeout: 30000 });
  assert.ifError(compiled.error); assert.equal(compiled.status, 0, compiled.stderr);
  const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10000,
    env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" } });
  assert.ifError(run.error); assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /runtime error|AddressSanitizer/);
});
