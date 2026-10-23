const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Overlay = require("../src/modules/bgi/native/versions/modern-vm-v4/source-overlay");
const Parent = require("../src/modules/bgi/native/versions/modern-vm-v3/source-overlay");
const upstream = path.resolve("src/external/openbgi");
const initialized = Overlay.INPUTS.files.every(file => fs.existsSync(path.join(upstream, file.path)));

test("BGI v4 stages separate bitmap format contracts and refuses altered v3 context before writing", { skip: !initialized }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-format-stage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, "v4");
  const receipt = Overlay.stageSource({ sourceRoot: upstream, destination });
  assert.equal(receipt.version, "0.0.1-build734-mac-vm-v4");
  assert.equal(receipt.parentVersion, Parent.VERSION);
  assert.equal(receipt.gameplayQualified, false);
  assert.match(fs.readFileSync(path.join(destination, "src/main.c"), "utf8"), /0\.0\.1-build734-mac-vm-v4/);
  for (const file of receipt.files) assert.equal(Overlay.sha256(fs.readFileSync(path.join(destination, file.path))), file.sha256);
  assert.equal(receipt.sourceTreeSha256, Overlay.sha256(JSON.stringify(receipt.files)));
  assert.doesNotThrow(() => Overlay.verifyBase());
  assert.throws(() => Overlay.applyGraphics(destination), /source context changed/);
  const parentStage = path.join(root, "v3"); Parent.stageSource({ sourceRoot: upstream, destination: parentStage });
  const preserved = new Map(["vm-dialect.h", "bitmap-loader.c", "main.c"].map(file => [file, fs.readFileSync(path.join(parentStage, "src", file))]));
  fs.appendFileSync(path.join(parentStage, "src/vm-dialect.c"), "\n");
  assert.throws(() => Overlay.applyGraphics(parentStage), /source context changed/);
  for (const [file, bytes] of preserved) assert.deepEqual(fs.readFileSync(path.join(parentStage, "src", file)), bytes);
  assert.equal(fs.existsSync(path.join(parentStage, "src/bitmap-format.c")), false);
});

const sdl = spawnSync("sdl2-config", ["--prefix"], { encoding: "utf8" });
test("BGI bitmap format service preserves storage, reports exact statuses and changes subsequent color semantics", {
  skip: !initialized || sdl.status !== 0
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-format-native-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); Overlay.stageSource({ sourceRoot: upstream, destination: source });
  const driver = path.join(root, "format.c"), binary = path.join(root, "format");
  fs.writeFileSync(driver, `#define SDL_MAIN_HANDLED
#include "bitmap-format.h"
#include "bitmap-loader.h"
#include "vm-dialect.h"
#include "archive-reader.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define CHECK(value) do { if(!(value)){fprintf(stderr,"contract failure at line %d\\n",__LINE__);return 1;} } while(0)
uint32_t Thread_PopStack(Thread_t*t){if(!t->stackPointer){t->error=1;return 0;}return t->stack[--t->stackPointer];}
void Thread_PushStack(Thread_t*t,uint32_t v){if(t->stackPointer>=t->stackSize){t->error=1;return;}t->stack[t->stackPointer++]=v;}
uint8_t Thread_ReadCode8(Thread_t*t){(void)t;return 0;}
uint8_t *Engine_ReadFile(Engine_t*e,const char*arc,const char*name,size_t*out){(void)e;return MLBGI_ReadResource(arc,name,NULL,0,0,out);}
static int service(Thread_t*t,uint32_t slot,uint32_t format,uint32_t expected){
    uint32_t result=99;Thread_PushStack(t,slot);Thread_PushStack(t,format);
    return MLBGI_TryService(t,0x90,0x17,&result)&&!result&&!t->error&&Thread_PopStack(t)==expected;
}
int main(void){
    Engine_t engine={0};Renderer_t*renderer=calloc(1,sizeof(*renderer));CHECK(renderer);
    engine.renderer=renderer;renderer->engine=&engine;
    CHECK(MLBGI_ConfigureDialect(&engine,"ethornell-1.72",640,480)&&MLBGI_AttachBitmapLoader(&engine));
    MLBGI_Runtime*state=engine.mlRuntime;CHECK(state->setBitmapFormat);
    CHECK(state->createBitmap(&engine,16383,2,1,MLBGI_ALPHA32));
    Bitmap_t*bitmap=renderer->bitmaps[16383];uint8_t pixels[8]={10,20,30,0,40,50,60,128};
    memcpy(bitmap->bitmap,pixels,sizeof(pixels));uint8_t*storage=bitmap->bitmap;
    uint32_t budget=state->imageCacheBytes;state->imageCacheLimit=budget;
    uint32_t stack[8]={0};Thread_t thread={0};thread.engine=&engine;thread.stack=stack;thread.stackSize=8;
    Thread_PushStack(&thread,0x12345678);
    CHECK(service(&thread,16383,2,0)&&thread.stackPointer==1&&thread.stack[0]==0x12345678);
    CHECK(bitmap->format==2&&bitmap->bitmap==storage&&!memcmp(pixels,storage,8)&&state->imageCacheBytes==budget);
    CHECK(service(&thread,16383,1,0)&&thread.stackPointer==1&&thread.stack[0]==0x12345678);
    CHECK(renderer->bitmaps[16383]==bitmap&&bitmap->format==1&&bitmap->bitmap==storage&&!memcmp(pixels,storage,8)&&state->imageCacheBytes==budget);
    uint32_t metadata[6]={0};CHECK(state->bitmapInfo(&engine,16383,metadata));
    CHECK(metadata[1]==8&&metadata[2]==2&&metadata[3]==1&&metadata[4]==1&&metadata[5]==4);
    CHECK(service(&thread,16383,1,0)&&service(&thread,16383,2,2)&&service(&thread,16383,3,2)&&service(&thread,16383,UINT32_MAX,2));
    CHECK(service(&thread,0,1,1)&&service(&thread,16384,1,1)&&service(&thread,UINT32_MAX,1,1));
    CHECK(bitmap->format==1&&bitmap->bitmap==storage&&!memcmp(pixels,storage,8)&&state->imageCacheBytes==budget);
    MLBGI_MenuImage copy={0};CHECK(state->copyMenuImage(&engine,16383,&copy)==1);
    CHECK(copy.format==1&&copy.pixels!=storage&&copy.pixels[0]==10&&copy.pixels[3]==255&&copy.pixels[7]==255);free(copy.pixels);
    state->imageCacheLimit=32;CHECK(state->createBitmap(&engine,1,2,1,MLBGI_ALPHA32));
    CHECK(state->blitBitmap(&engine,1,0,0,16383,128,0));
    CHECK(renderer->bitmaps[1]->bitmap[0]==10&&renderer->bitmaps[1]->bitmap[3]==255&&renderer->bitmaps[1]->bitmap[7]==255);
    bitmap->width=0;CHECK(MLBGI_SetBitmapFormat(&engine,16383,1)==UINT32_MAX);bitmap->width=2;
    uint32_t result=99;thread.stackPointer=0;Thread_PushStack(&thread,1);
    CHECK(MLBGI_TryService(&thread,0x90,0x17,&result)&&result==UINT32_MAX-3&&thread.error&&thread.stackPointer==0);
    CHECK(!memcmp(pixels,storage,8));thread.error=0;thread.running=1;state->setBitmapFormat=NULL;
    Thread_PushStack(&thread,16383);Thread_PushStack(&thread,1);
    CHECK(MLBGI_TryService(&thread,0x90,0x17,&result)&&result==UINT32_MAX-3&&thread.error&&thread.stackPointer==0);
    CHECK(!memcmp(pixels,storage,8));
    CHECK(state->freeBitmap(&engine,1)&&state->freeBitmap(&engine,16383)&&state->imageCacheBytes==0);
    state->freeParticleResources(&engine);MLBGI_FreeDialect(&engine);MLBGI_FreeArchiveCache();free(renderer);
    puts("bitmap format contracts passed");return 0;
}
`);
  const names = ["bitmap-format.c", "bitmap-loader.c", "particle-resources.c", "raw-bitmap.c", "cbg-bitmap.c", "vm-dialect.c",
    "vm-guards.c", "vm-strings.c", "vm-input.c", "archive-reader.c", "state-files.c", "spng.c", "miniz.c"];
  const result = spawnSync("clang", ["-std=c11", "-DSPNG_USE_MINIZ", process.platform === "darwin" ? "-D_DARWIN_C_SOURCE" : "-D_POSIX_C_SOURCE=200809L",
    "-fsanitize=address,undefined", "-I", path.join(source, "src"), "-I", path.join(sdl.stdout.trim(), "include"),
    ...names.map(name => path.join(source, "src", name)), driver, ...(process.platform === "darwin" ? ["-liconv"] : []), "-lm", "-o", binary], {
    encoding: "utf8", timeout: 30000
  });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  const run = spawnSync(binary, [], { cwd: root, encoding: "utf8", timeout: 10000,
    env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" }
  });
  assert.ifError(run.error); assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "bitmap format contracts passed"); assert.doesNotMatch(run.stderr, /AddressSanitizer|runtime error/);
});
