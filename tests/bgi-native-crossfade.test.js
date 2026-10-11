const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Overlay = require("../src/modules/bgi/native/versions/modern-vm-v8/source-overlay");
const Parent = require("../src/modules/bgi/native/versions/modern-vm-v7/source-overlay");
const upstream = path.resolve("src/external/openbgi");
const initialized = Overlay.INPUTS.files.every(file => fs.existsSync(path.join(upstream, file.path)));

test("BGI v8 stages a separate guarded compositor without changing the frozen v7 sources", { skip: !initialized }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-crossfade-stage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, "v8"), receipt = Overlay.stageSource({ sourceRoot: upstream, destination });
  assert.equal(receipt.version, "0.0.1-build734-mac-vm-v8"); assert.equal(receipt.parentVersion, Parent.VERSION);
  assert.equal(receipt.gameplayQualified, false);
  for (const file of receipt.files) assert.equal(Overlay.sha256(fs.readFileSync(path.join(destination, file.path))), file.sha256);
  assert.equal(receipt.sourceTreeSha256, Overlay.sha256(JSON.stringify(receipt.files)));
  assert.match(fs.readFileSync(path.join(destination, "src/main.c"), "utf8"), /0\.0\.1-build734-mac-vm-v8/);
  assert.doesNotThrow(() => Overlay.verifyBase()); assert.throws(() => Overlay.applyCrossfade(destination), /source context changed/);
  const prior = path.join(root, "v7"); Parent.stageSource({ sourceRoot: upstream, destination: prior });
  const preserved = new Map(["current-draw.c", "immediate-bitmap.c", "immediate-bitmap.h", "main.c"].map(file => [file, fs.readFileSync(path.join(prior, "src", file))]));
  fs.appendFileSync(path.join(prior, "src/vm-dialect.c"), "\n");
  assert.throws(() => Overlay.applyCrossfade(prior), /source context changed/);
  for (const [file, bytes] of preserved) assert.deepEqual(fs.readFileSync(path.join(prior, "src", file)), bytes);
  assert.equal(fs.existsSync(path.join(prior, "src/bitmap-crossfade.c")), false);
});

const sdl = spawnSync("sdl2-config", ["--prefix"], { encoding: "utf8" });
test("BGI two-image draws prove transparency pixels, independent clipping, live formats and both source lifetimes", {
  skip: !initialized || sdl.status !== 0
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-crossfade-native-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); Overlay.stageSource({ sourceRoot: upstream, destination: source });
  const driver = path.join(root, "crossfade.c"), binary = path.join(root, "crossfade");
  fs.writeFileSync(driver, `#define SDL_MAIN_HANDLED
#include "bitmap-crossfade.h"
#include "current-draw.h"
#include "graphic-offset.h"
#include "bitmap-loader.h"
#include "bitmap-format.h"
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
static uint32_t service(Thread_t*t,uint32_t id,const uint32_t*values,unsigned count){
    uint32_t result=99;for(unsigned i=0;i<count;i++)Thread_PushStack(t,values[i]);
    if(!MLBGI_TryService(t,0x90,id,&result))return UINT32_MAX;return result;
}
static int rgb(const uint8_t*p,unsigned r,unsigned g,unsigned b){return p[0]==r&&p[1]==g&&p[2]==b&&p[3]==255;}
int main(void){
    Engine_t engine={0};Renderer_t*renderer=calloc(1,sizeof(*renderer));CHECK(renderer);engine.renderer=renderer;renderer->engine=&engine;
    CHECK(MLBGI_ConfigureDialect(&engine,"ethornell-1.72",640,480)&&MLBGI_AttachBitmapLoader(&engine));
    MLBGI_Runtime*state=engine.mlRuntime;MLBGI_ImmediateBitmap*object=&state->immediateBitmap;
    uint32_t stack[64]={0};Thread_t thread={0};thread.engine=&engine;thread.stack=stack;thread.stackSize=64;
    uint32_t request[9]={0,0,0,0,0,1,UINT32_MAX,0,0};uint8_t pixel[4];
    CHECK(state->createBitmap(&engine,0,1,1,MLBGI_COLOR32)&&state->createBitmap(&engine,1,1,1,MLBGI_COLOR32));
    uint8_t primary[4]={200,50,10,128},secondary[4]={20,100,220,96};memcpy(renderer->bitmaps[0]->bitmap,primary,4);memcpy(renderer->bitmaps[1]->bitmap,secondary,4);
    Thread_PushStack(&thread,0x12345678);CHECK(!service(&thread,0x43,request,9)&&!thread.error&&thread.stackPointer==1&&thread.stack[0]==0x12345678);
    CHECK(object->type==4&&object->hasSecond==1&&object->transparency==0&&object->sourceIdentity==renderer->bitmaps[0]&&object->secondSourceIdentity==renderer->bitmaps[1]&&object->drawSequence==2&&state->imageCacheBytes==8);
    CHECK(MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,200,50,10));request[8]=128;CHECK(!service(&thread,0x43,request,9));
    CHECK(MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,110,75,115));request[8]=256;CHECK(!service(&thread,0x43,request,9));CHECK(MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,20,100,220));
    request[8]=1;CHECK(!service(&thread,0x43,request,9)&&MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,200,50,10));
    renderer->bitmaps[0]->format=MLBGI_ALPHA32;request[8]=0;CHECK(!service(&thread,0x43,request,9)&&MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,110,75,115));
    request[8]=128;CHECK(!service(&thread,0x43,request,9)&&MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,65,87,167));
    request[8]=1;CHECK(!service(&thread,0x43,request,9)&&MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,108,75,116));
    renderer->bitmaps[0]->bitmap[3]=254;request[8]=0;CHECK(!service(&thread,0x43,request,9)&&MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,200,50,10));
    request[8]=1;CHECK(!service(&thread,0x43,request,9)&&MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,197,50,13));
    renderer->bitmaps[0]->bitmap[3]=255;CHECK(MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,197,50,13));
    renderer->bitmaps[0]->bitmap[3]=1;request[8]=0;CHECK(!service(&thread,0x43,request,9)&&MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,20,100,220));
    memcpy(renderer->bitmaps[0]->bitmap,primary,4);renderer->bitmaps[1]->format=MLBGI_ALPHA32;request[8]=128;
    CHECK(!service(&thread,0x43,request,9)&&MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,55,40,64));
    renderer->bitmaps[0]->format=MLBGI_COLOR32;CHECK(MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,103,43,46));
    request[8]=256;CHECK(!service(&thread,0x43,request,9)&&MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,7,37,82));
    renderer->bitmaps[1]->bitmap[3]=254;CHECK(MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,20,100,220));renderer->bitmaps[1]->bitmap[3]=255;
    CHECK(MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,20,100,220));renderer->bitmaps[1]->bitmap[3]=1;CHECK(MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,0,0,0));
    memcpy(renderer->bitmaps[1]->bitmap,secondary,4);const void*secondIdentity=object->secondSourceIdentity;CHECK(!MLBGI_SetBitmapFormat(&engine,1,MLBGI_COLOR32)&&object->secondSourceIdentity==secondIdentity&&object->sourceValid);
    CHECK(MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,20,100,220));
    uint8_t preserved[sizeof(*object)];memcpy(preserved,object,sizeof(*object));uint64_t sequence=state->drawSequence;
    for(unsigned i=0;i<5;i++){uint32_t bad[9];memcpy(bad,request,sizeof(bad));if(i==0)bad[5]=0x7000;else if(i==1)bad[6]=0;else if(i==2)bad[8]=257;else if(i==3)bad[5]=5;else{bad[5]=0x7fff;bad[8]=1;}
        CHECK(!MLBGI_SetImmediateBitmap(&engine,bad)&&!memcmp(preserved,object,sizeof(*object))&&state->drawSequence==sequence);}
    CHECK(!MLBGI_DrawImmediateBitmap(&engine,renderer->bitmaps[0]->bitmap,4,1,1,4)&&!memcmp(renderer->bitmaps[0]->bitmap,primary,4));
    CHECK(!MLBGI_DrawImmediateBitmap(&engine,renderer->bitmaps[1]->bitmap,4,1,1,4)&&!memcmp(renderer->bitmaps[1]->bitmap,secondary,4));
    memset(pixel,99,4);renderer->bitmaps[1]->format=3;CHECK(!MLBGI_DrawImmediateBitmap(&engine,pixel,4,1,1,4)&&pixel[0]==99);renderer->bitmaps[1]->format=1;
    CHECK(state->freeBitmap(&engine,1)&&!object->sourceValid&&!object->sourceIdentity&&!object->secondSourceIdentity);CHECK(state->createBitmap(&engine,1,1,1,1)&&state->clearBitmap(&engine,1,0xffffff));
    CHECK(MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,0,0,0));CHECK(!service(&thread,0x43,request,9)&&object->drawSequence==2&&MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,255,255,255));
    CHECK(state->clearBitmap(&engine,1,0x00ff00)&&MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,0,255,0));
    request[8]=0;CHECK(!service(&thread,0x43,request,9));CHECK(state->freeBitmap(&engine,1)&&MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,0,0,0));
    CHECK(state->createBitmap(&engine,1,1,1,1)&&!service(&thread,0x43,request,9));request[8]=256;CHECK(!service(&thread,0x43,request,9));
    CHECK(state->cropBitmap(&engine,0,1,0,0,1,1)&&MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,0,0,0));
    CHECK(state->createBitmap(&engine,0,2,1,1)&&state->createBitmap(&engine,1,2,1,1));
    uint8_t stripA[8]={255,0,0,17,0,255,0,99},stripB[8]={0,0,255,0,255,255,255,128};memcpy(renderer->bitmaps[0]->bitmap,stripA,8);memcpy(renderer->bitmaps[1]->bitmap,stripB,8);
    request[0]=(uint32_t)-1;request[3]=1;request[8]=128;CHECK(!service(&thread,0x43,request,9));state->canvasBackground=0x0a141e;
    uint8_t pixels[16];memset(pixels,69,sizeof(pixels));uint8_t clipped[16]={255,255,255,255,132,10,15,255,5,137,15,255,69,69,69,69};
    CHECK(MLBGI_DrawScene(&engine,pixels,sizeof(pixels),3,1,16)&&!memcmp(pixels,clipped,sizeof(pixels)));
    uint32_t offsets[3]={0,1,0};CHECK(!service(&thread,0x37,offsets,3)&&!service(&thread,0x43,request,9)&&object->drawSequence==2&&object->offsetX==1);
    CHECK(MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,132,10,15));offsets[1]=(uint32_t)-1;CHECK(!service(&thread,0x36,offsets,3));
    CHECK(MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,255,255,255));offsets[1]=INT32_MAX;CHECK(!service(&thread,0x37,offsets,3));offsets[1]=1;CHECK(!service(&thread,0x36,offsets,3));
    CHECK(MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,10,20,30));
    offsets[1]=0;CHECK(!service(&thread,0x37,offsets,3)&&!service(&thread,0x36,offsets,3));request[0]=0;request[3]=1;request[5]=0;request[8]=256;
    CHECK(!service(&thread,0x43,request,9)&&MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,0,255,0));
    request[5]=0x7fff;request[8]=0;CHECK(!service(&thread,0x43,request,9)&&!object->hasSecond&&!object->secondSourceIdentity&&!object->transparency&&object->drawSequence==2);
    CHECK(state->freeBitmap(&engine,1)&&object->sourceValid&&MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&rgb(pixel,255,0,0));
    thread.stackPointer=0;CHECK(service(&thread,0x43,request,8)==UINT32_MAX-3&&thread.error&&!thread.stackPointer);
    CHECK(state->freeBitmap(&engine,0));state->freeParticleResources(&engine);MLBGI_FreeDialect(&engine);MLBGI_FreeArchiveCache();free(renderer);
    puts("two-image contracts passed");return 0;
}
`);
  const names = ["bitmap-crossfade.c", "current-draw.c", "graphic-offset.c", "immediate-bitmap.c", "bitmap-format.c", "bitmap-loader.c", "particle-resources.c", "raw-bitmap.c", "cbg-bitmap.c", "vm-dialect.c",
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
  assert.equal(run.stdout.trim(), "two-image contracts passed"); assert.doesNotMatch(run.stderr, /AddressSanitizer|runtime error/);
});
