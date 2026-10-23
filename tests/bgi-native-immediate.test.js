const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Overlay = require("../src/modules/bgi/native/versions/modern-vm-v5/source-overlay");
const Parent = require("../src/modules/bgi/native/versions/modern-vm-v4/source-overlay");
const upstream = path.resolve("src/external/openbgi");
const initialized = Overlay.INPUTS.files.every(file => fs.existsSync(path.join(upstream, file.path)));

test("BGI v5 stages a separate compositor and refuses altered v4 context before writing", { skip: !initialized }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-immediate-stage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, "v5");
  const receipt = Overlay.stageSource({ sourceRoot: upstream, destination });
  assert.equal(receipt.version, "0.0.1-build734-mac-vm-v5"); assert.equal(receipt.parentVersion, Parent.VERSION);
  assert.equal(receipt.gameplayQualified, false);
  assert.match(fs.readFileSync(path.join(destination, "src/main.c"), "utf8"), /0\.0\.1-build734-mac-vm-v5/);
  for (const file of receipt.files) assert.equal(Overlay.sha256(fs.readFileSync(path.join(destination, file.path))), file.sha256);
  assert.equal(receipt.sourceTreeSha256, Overlay.sha256(JSON.stringify(receipt.files)));
  assert.doesNotThrow(() => Overlay.verifyBase());
  assert.throws(() => Overlay.applyCompositor(destination), /source context changed/);
  const prior = path.join(root, "v4"); Parent.stageSource({ sourceRoot: upstream, destination: prior });
  const preserved = new Map(["vm-dialect.h", "bitmap-loader.c", "main.c"].map(file => [file, fs.readFileSync(path.join(prior, "src", file))]));
  fs.appendFileSync(path.join(prior, "src/vm-dialect.c"), "\n");
  assert.throws(() => Overlay.applyCompositor(prior), /source context changed/);
  for (const [file, bytes] of preserved) assert.deepEqual(fs.readFileSync(path.join(prior, "src", file)), bytes);
  assert.equal(fs.existsSync(path.join(prior, "src/immediate-bitmap.c")), false);
});

const sdl = spawnSync("sdl2-config", ["--prefix"], { encoding: "utf8" });
test("BGI immediate bitmap draws obey viewport pixels, clipping, source lifetime, ordering and finite service branches", {
  skip: !initialized || sdl.status !== 0
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-immediate-native-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); Overlay.stageSource({ sourceRoot: upstream, destination: source });
  const driver = path.join(root, "immediate.c"), binary = path.join(root, "immediate");
  fs.writeFileSync(driver, `#define SDL_MAIN_HANDLED
#include "immediate-bitmap.h"
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
static uint32_t service(Thread_t*t,uint32_t id,const uint32_t*values,unsigned count){
    uint32_t result=99;for(unsigned i=0;i<count;i++)Thread_PushStack(t,values[i]);
    if(!MLBGI_TryService(t,0x90,id,&result))return UINT32_MAX;return result;
}
int main(void){
    Engine_t engine={0};Renderer_t*renderer=calloc(1,sizeof(*renderer));CHECK(renderer);
    engine.renderer=renderer;renderer->engine=&engine;
    CHECK(MLBGI_ConfigureDialect(&engine,"ethornell-1.72",640,480)&&MLBGI_AttachBitmapLoader(&engine));
    MLBGI_Runtime*state=engine.mlRuntime;state->canvasEnabled=1;state->canvasBackground=0x334455;
    CHECK(state->createBitmap(&engine,0,3,2,MLBGI_COLOR32));
    uint8_t sourcePixels[24]={255,0,0,0, 0,255,0,128, 0,0,255,255, 255,255,0,1, 0,255,255,64, 255,0,255,254};
    memcpy(renderer->bitmaps[0]->bitmap,sourcePixels,24);uint32_t budget=state->imageCacheBytes;
    uint32_t stack[32]={0};Thread_t thread={0};thread.engine=&engine;thread.stack=stack;thread.stackSize=32;
    uint32_t request[9]={0,0,0,0,0,0x7fff,UINT32_MAX,0,0};Thread_PushStack(&thread,0x12345678);
    CHECK(!service(&thread,0x43,request,9)&&!thread.error&&thread.stackPointer==1&&thread.stack[0]==0x12345678);
    CHECK(state->immediateBitmap.allocated&&state->immediateBitmap.sourceValid&&state->drawSequence==1&&state->imageCacheBytes==budget&&!state->framePending);
    uint8_t scene[24];CHECK(MLBGI_DrawScene(&engine,scene,sizeof(scene),3,2,12));
    uint8_t expected[24]={255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,0,255, 0,255,255,255, 255,0,255,255};
    CHECK(!memcmp(scene,expected,24)&&!memcmp(renderer->bitmaps[0]->bitmap,sourcePixels,24));
    request[0]=1;request[3]=INT32_MAX;request[4]=(uint32_t)INT32_MIN;request[7]=UINT32_MAX;
    CHECK(!service(&thread,0x43,request,9)&&state->immediateBitmap.drawSequence==1&&state->drawSequence==1);
    uint8_t viewport[16],cropped[16]={0,255,0,255,0,0,255,255,0,255,255,255,255,0,255,255};
    CHECK(MLBGI_DrawScene(&engine,viewport,16,2,2,8)&&!memcmp(viewport,cropped,16));
    request[0]=0;CHECK(!service(&thread,0x43,request,9));uint32_t offset[3]={0,1,0};CHECK(!service(&thread,0x37,offset,3));
    CHECK(MLBGI_DrawScene(&engine,viewport,16,2,2,8)&&!memcmp(viewport,cropped,16));
    offset[1]=0;CHECK(!service(&thread,0x37,offset,3));
    request[0]=(uint32_t)-1;CHECK(!service(&thread,0x43,request,9));
    uint8_t padding[32];memset(padding,0x99,sizeof(padding));
    CHECK(MLBGI_DrawImmediateBitmap(&engine,padding,32,3,2,16));
    uint8_t clipped[32]={0,0,0,255,255,0,0,255,0,255,0,255,0x99,0x99,0x99,0x99,0,0,0,255,255,255,0,255,0,255,255,255,0x99,0x99,0x99,0x99};
    CHECK(!memcmp(padding,clipped,32));
    request[0]=INT32_MAX;request[1]=(uint32_t)INT32_MIN;CHECK(!service(&thread,0x43,request,9));
    CHECK(MLBGI_DrawScene(&engine,scene,24,3,2,12));for(unsigned i=0;i<24;i+=4)CHECK(!scene[i]&&!scene[i+1]&&!scene[i+2]&&scene[i+3]==255);
    request[0]=request[1]=0;request[5]=UINT32_MAX;CHECK(!service(&thread,0x43,request,9));
    MLBGI_ImmediateBitmap prior=state->immediateBitmap;uint32_t valid[9];memcpy(valid,request,sizeof(valid));
    for(unsigned i=0;i<5;i++){
        memcpy(request,valid,sizeof(valid));if(i==0)request[5]=0x7000;else if(i==1)request[5]=1;else if(i==2)request[6]=0;else if(i==3)request[8]=1;else request[2]=16384;
        CHECK(service(&thread,0x43,request,9)==UINT32_MAX-3&&thread.error&&thread.stackPointer==1&&!memcmp(&prior,&state->immediateBitmap,sizeof(prior)));
        thread.error=0;thread.running=1;
    }
    memcpy(request,valid,sizeof(valid));CHECK(state->clearBitmap(&engine,0,0x123456));
    CHECK(MLBGI_DrawScene(&engine,scene,24,3,2,12));for(unsigned i=0;i<24;i+=4)CHECK(scene[i]==0x12&&scene[i+1]==0x34&&scene[i+2]==0x56&&scene[i+3]==255);
    CHECK(!MLBGI_DrawImmediateBitmap(&engine,renderer->bitmaps[0]->bitmap,24,3,2,12));
    CHECK(!MLBGI_DrawImmediateBitmap(&engine,scene,23,3,2,12)&&!MLBGI_DrawImmediateBitmap(&engine,scene,24,3,2,11));
    CHECK(state->freeBitmap(&engine,0)&&!state->immediateBitmap.sourceValid&&state->immediateBitmap.drawSequence==1);
    CHECK(state->createBitmap(&engine,0,3,2,MLBGI_COLOR32)&&state->clearBitmap(&engine,0,0xabcdef));
    CHECK(MLBGI_DrawScene(&engine,scene,24,3,2,12));for(unsigned i=0;i<24;i+=4)CHECK(!scene[i]&&!scene[i+1]&&!scene[i+2]&&scene[i+3]==255);
    CHECK(!service(&thread,0x43,request,9)&&state->immediateBitmap.drawSequence==1);
    CHECK(state->cropBitmap(&engine,0,0,0,0,2,1)&&!state->immediateBitmap.sourceValid);
    CHECK(!service(&thread,0x43,request,9));
    CHECK(state->createBitmap(&engine,1,2,1,MLBGI_ALPHA32));uint8_t alpha[8]={200,100,50,128,10,20,30,254};memcpy(renderer->bitmaps[1]->bitmap,alpha,8);
    request[2]=1;CHECK(!service(&thread,0x43,request,9));uint8_t conversion[8],premultiplied[8]={100,50,25,255,10,20,30,255};
    CHECK(MLBGI_DrawScene(&engine,conversion,8,2,1,8)&&!memcmp(conversion,premultiplied,8));
    CHECK(!service(&thread,0x50,NULL,0));uint32_t handle=Thread_PopStack(&thread);
    uint32_t sprite[7]={handle,0,0,0,128,0,0};CHECK(!service(&thread,0x56,sprite,7));uint32_t visible[2]={handle,1};CHECK(!service(&thread,0x54,visible,2));
    CHECK(MLBGI_DrawScene(&engine,conversion,8,2,1,8));for(unsigned i=0;i<8;i+=4)CHECK(conversion[i]==0xab&&conversion[i+1]==0xcd&&conversion[i+2]==0xef);
    CHECK(!service(&thread,0x51,&handle,1));thread.stackPointer=0;
    CHECK(service(&thread,0x43,request,8)==UINT32_MAX-3&&thread.error&&thread.stackPointer==0);
    CHECK(state->freeBitmap(&engine,0)&&state->freeBitmap(&engine,1)&&!state->imageCacheBytes);
    state->freeParticleResources(&engine);MLBGI_FreeDialect(&engine);MLBGI_FreeArchiveCache();free(renderer);
    puts("immediate bitmap contracts passed");return 0;
}
`);
  const names = ["immediate-bitmap.c", "bitmap-format.c", "bitmap-loader.c", "particle-resources.c", "raw-bitmap.c", "cbg-bitmap.c", "vm-dialect.c",
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
  assert.equal(run.stdout.trim(), "immediate bitmap contracts passed"); assert.doesNotMatch(run.stderr, /AddressSanitizer|runtime error/);
});
