const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Overlay = require("../src/modules/bgi/native/source-overlay");

const upstream = path.resolve("src/external/openbgi");
const config = flag => spawnSync("sdl2-config", [flag], { encoding: "utf8" });
const prefix = config("--prefix"), cflags = config("--cflags"), libs = config("--libs");
const initialized = fs.existsSync(path.join(upstream, "src/engine.h")) && [prefix, cflags, libs].every(result => result.status === 0);

test("BGI SDL window callbacks preserve sizing, visibility, scene pixels and fullscreen state with the dummy driver", { skip: !initialized }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-native-window-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["engine.h", "thread.h"]) fs.writeFileSync(path.join(root, name), Overlay.patch(`src/${name}`, fs.readFileSync(path.join(upstream, "src", name))));
  const driver = path.join(root, "window.c"), binary = path.join(root, "window");
  fs.writeFileSync(driver, `#define SDL_MAIN_HANDLED
#include "platform-window.h"
#include "platform-renderer.h"
#include "vm-dialect.h"
#include <string.h>
#include <stdio.h>
static void stage(const char*name){fprintf(stderr,"BGI dummy-window stage: %s\\n",name);fflush(stderr);}
static int sceneEnabled=1;
int MLBGI_DrawScene(const Engine_t*e,uint8_t*rgba,size_t capacity,uint32_t width,uint32_t height,size_t stride){(void)e;if(!sceneEnabled||!rgba||stride*height>capacity)return 0;
for(uint32_t y=0;y<height;y++)for(uint32_t x=0;x<width;x++){uint8_t*p=rgba+y*stride+x*4;p[0]=32;p[1]=64;p[2]=192;p[3]=255;}return 1;}
int main(void){stage("main");SDL_SetMainReady();stage("video-init");if(SDL_Init(SDL_INIT_VIDEO))return 1;stage("video-ready");
if(!SDL_GetCurrentVideoDriver()||strcmp(SDL_GetCurrentVideoDriver(),"dummy"))return 2;
Engine_t e={0};MLBGI_Runtime s={0};e.mlRuntime=&s;s.dialect=MLBGI_ETHORNELL_172;s.displayKind=1;s.displayWidths[0]=640;s.displayHeights[0]=480;
s.captionConfigured=1;strcpy(s.windowCaption,"Queued caption");
if(MLBGI_AttachSDLWindow(&e))return 3;
stage("create-window");e.window=SDL_CreateWindow("BGI fixture",0,0,320,240,SDL_WINDOW_HIDDEN);if(!e.window||!MLBGI_AttachSDLWindow(&e)||!s.configureWindow||!s.showWindow)return 4;
if(!s.setCaption||strcmp(SDL_GetWindowTitle(e.window),"Queued caption"))return 13;s.setCaption(&e,"Updated caption");if(strcmp(SDL_GetWindowTitle(e.window),"Updated caption"))return 14;s.setCaption(&e,"");if(*SDL_GetWindowTitle(e.window))return 15;
stage("configure-window");
if(!s.configureWindow(&e,1,640,480))return 5;int w=0,h=0;SDL_GetWindowSize(e.window,&w,&h);if(w!=640||h!=480||(SDL_GetWindowFlags(e.window)&SDL_WINDOW_SHOWN))return 6;
if(s.configureWindow(&e,1,0,480)||s.configureWindow(&e,2,640,480)||s.configureWindow(&e,1,16385,480))return 7;
stage("present-scene");if(!MLBGI_PresentSDLScene(&e))return 16;
SDL_Surface*surface=SDL_GetWindowSurface(e.window);if(!surface||surface->format->BytesPerPixel!=4)return 17;uint32_t pixel=0;memcpy(&pixel,surface->pixels,4);uint8_t red=0,green=0,blue=0;SDL_GetRGB(pixel,surface->format,&red,&green,&blue);if(red!=32||green!=64||blue!=192)return 18;
sceneEnabled=0;if(MLBGI_PresentSDLScene(&e))return 19;uint32_t preserved=0;memcpy(&preserved,surface->pixels,4);if(preserved!=pixel)return 20;sceneEnabled=1;
stage("show-hide-window");s.showWindow(&e,1);if(!(SDL_GetWindowFlags(e.window)&SDL_WINDOW_SHOWN))return 8;
s.showWindow(&e,0);if(!(SDL_GetWindowFlags(e.window)&SDL_WINDOW_HIDDEN))return 9;
stage("fullscreen-enter");MLBGI_ToggleSDLWindow(&e);if(s.displayKind||(SDL_GetWindowFlags(e.window)&SDL_WINDOW_FULLSCREEN_DESKTOP)!=SDL_WINDOW_FULLSCREEN_DESKTOP)return 10;
stage("fullscreen-leave");
MLBGI_ToggleSDLWindow(&e);if(s.displayKind!=1||(SDL_GetWindowFlags(e.window)&SDL_WINDOW_FULLSCREEN))return 11;
SDL_GetWindowSize(e.window,&w,&h);if(w!=640||h!=480)return 12;
stage("destroy-window");SDL_DestroyWindow(e.window);stage("video-quit");SDL_Quit();stage("done");return 0;}
`);
  const compileFlags = cflags.stdout.trim().split(/\s+/), linkFlags = libs.stdout.trim().split(/\s+/).filter(flag => flag !== "-lSDL2main");
  assert.ok(path.isAbsolute(prefix.stdout.trim()));
  assert.ok(compileFlags.every(flag => /^(-I\S+|-D\S+)$/.test(flag)));
  const result = spawnSync("clang", ["-std=c11", "-fsanitize=address,undefined", "-I", root,
    "-I", path.join(prefix.stdout.trim(), "include"), "-I", path.resolve("src/modules/bgi/native"), ...compileFlags,
    path.resolve("src/modules/bgi/native/platform-window.c"), path.resolve("src/modules/bgi/native/platform-renderer.c"), driver, ...linkFlags, "-o", binary], { encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10000,
    env: { ...process.env, SDL_VIDEODRIVER: "dummy", ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1",
      /* Homebrew SDL2-compat loads SDL3 before main(). macOS system
         shells remove inherited DYLD variables, including under pnpm.
         Use the same explicit prefix as compilation for this child. */
      ...(process.platform === "darwin" ? { DYLD_FALLBACK_LIBRARY_PATH: path.join(prefix.stdout.trim(), "lib") } : {}) } });
  assert.ok(!run.error, `${run.error?.message || ""}\n${JSON.stringify({ pid: run.pid, status: run.status, signal: run.signal })}\n${run.stderr}`);
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /runtime error|AddressSanitizer/);
});
