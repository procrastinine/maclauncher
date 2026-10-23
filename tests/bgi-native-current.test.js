const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Overlay = require("../src/modules/bgi/native/versions/modern-vm-v7/source-overlay");
const Parent = require("../src/modules/bgi/native/versions/modern-vm-v6/source-overlay");
const upstream = path.resolve("src/external/openbgi");
const initialized = Overlay.INPUTS.files.every(file => fs.existsSync(path.join(upstream, file.path)));

test("BGI v7 stages a guarded current-object version without changing its frozen v6 parent", { skip: !initialized }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-current-stage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, "v7"), receipt = Overlay.stageSource({ sourceRoot: upstream, destination });
  assert.equal(receipt.version, "0.0.1-build734-mac-vm-v7"); assert.equal(receipt.parentVersion, Parent.VERSION);
  assert.equal(receipt.gameplayQualified, false);
  for (const file of receipt.files) assert.equal(Overlay.sha256(fs.readFileSync(path.join(destination, file.path))), file.sha256);
  assert.equal(receipt.sourceTreeSha256, Overlay.sha256(JSON.stringify(receipt.files)));
  assert.match(fs.readFileSync(path.join(destination, "src/main.c"), "utf8"), /0\.0\.1-build734-mac-vm-v7/);
  assert.doesNotThrow(() => Overlay.verifyBase()); assert.throws(() => Overlay.applyCurrentDraw(destination), /source context changed/);
  const prior = path.join(root, "v6"); Parent.stageSource({ sourceRoot: upstream, destination: prior });
  const preserved = new Map(["graphic-offset.c", "immediate-bitmap.c", "immediate-bitmap.h", "main.c"].map(file => [file, fs.readFileSync(path.join(prior, "src", file))]));
  fs.appendFileSync(path.join(prior, "src/vm-dialect.c"), "\n");
  assert.throws(() => Overlay.applyCurrentDraw(prior), /source context changed/);
  for (const [file, bytes] of preserved) assert.deepEqual(fs.readFileSync(path.join(prior, "src", file)), bytes);
  assert.equal(fs.existsSync(path.join(prior, "src/current-draw.c")), false);
});

const sdl = spawnSync("sdl2-config", ["--prefix"], { encoding: "utf8" });
test("BGI initial current object draws black, owns its offsets and is replaced only by a validated bitmap draw", {
  skip: !initialized || sdl.status !== 0
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-current-native-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); Overlay.stageSource({ sourceRoot: upstream, destination: source });
  const driver = path.join(root, "current.c"), binary = path.join(root, "current");
  fs.writeFileSync(driver, `#define SDL_MAIN_HANDLED
#include "current-draw.h"
#include "graphic-offset.h"
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
    Engine_t legacy={0};CHECK(MLBGI_ConfigureDialect(&legacy,"legacy-v1",640,480));MLBGI_Runtime*legacyState=legacy.mlRuntime;
    CHECK(!legacyState->immediateBitmap.allocated&&!legacyState->drawSequence);MLBGI_FreeDialect(&legacy);
    Engine_t engine={0};Renderer_t*renderer=calloc(1,sizeof(*renderer));CHECK(renderer);engine.renderer=renderer;renderer->engine=&engine;
    CHECK(MLBGI_ConfigureDialect(&engine,"ethornell-1.72",640,480)&&MLBGI_AttachBitmapLoader(&engine));
    MLBGI_Runtime*state=engine.mlRuntime;MLBGI_ImmediateBitmap*object=&state->immediateBitmap;
    CHECK(object->allocated&&object->type==1&&!object->sourceValid&&object->bitmapSlot==UINT32_MAX&&!object->sourceIdentity&&object->drawSequence==1&&state->drawSequence==1&&!state->imageCacheBytes);
    CHECK(MLBGI_CurrentDrawSupported(object)&&!MLBGI_InitializeCurrentDraw(&engine));
    state->canvasBackground=0x204080;uint8_t pixels[24];memset(pixels,77,sizeof(pixels));
    uint8_t black[24]={0,0,0,255,0,0,0,255,77,77,77,77,0,0,0,255,0,0,0,255,77,77,77,77};
    CHECK(MLBGI_DrawScene(&engine,pixels,sizeof(pixels),2,2,12)&&!memcmp(pixels,black,sizeof(pixels)));
    uint32_t stack[64]={0};Thread_t thread={0};thread.engine=&engine;thread.stack=stack;thread.stackSize=64;
    CHECK(!service(&thread,0x50,NULL,0));uint32_t sprite=Thread_PopStack(&thread);CHECK(sprite==0x80000000&&state->sprites[0].object.drawSequence==2);
    uint32_t offsets[3]={0,(uint32_t)INT32_MAX,9};Thread_PushStack(&thread,0x12345678);
    CHECK(!service(&thread,0x37,offsets,3)&&!thread.error&&thread.stackPointer==1&&thread.stack[0]==0x12345678);
    offsets[1]=1;offsets[2]=(uint32_t)-3;CHECK(!service(&thread,0x36,offsets,3)&&!thread.error&&thread.stackPointer==1);
    CHECK(object->offsetX==INT32_MAX&&object->offsetY==9&&object->secondOffsetX==1&&object->secondOffsetY==-3&&object->drawSequence==1&&!state->rootOffsetX&&!state->rootOffsetY);
    CHECK(!state->sprites[0].object.offsetX&&!state->sprites[0].object.secondOffsetX&&!state->imageCacheBytes);
    CHECK(MLBGI_DrawScene(&engine,pixels,sizeof(pixels),2,2,12)&&!memcmp(pixels,black,sizeof(pixels)));
    CHECK(state->createBitmap(&engine,0,2,1,MLBGI_COLOR32));uint8_t image[8]={255,0,0,255,0,255,0,255};memcpy(renderer->bitmaps[0]->bitmap,image,8);
    uint32_t request[9]={0,0,0,0,0,0x7fff,UINT32_MAX,0,0};uint8_t preserved[sizeof(*object)];memcpy(preserved,object,sizeof(*object));uint64_t sequence=state->drawSequence;
    request[5]=1;CHECK(!MLBGI_SetImmediateBitmap(&engine,request)&&!memcmp(preserved,object,sizeof(*object))&&state->drawSequence==sequence);
    request[5]=0x7fff;request[8]=256;CHECK(!MLBGI_SetImmediateBitmap(&engine,request)&&!memcmp(preserved,object,sizeof(*object))&&state->drawSequence==sequence);
    request[8]=0;request[6]=0;CHECK(!MLBGI_SetImmediateBitmap(&engine,request)&&!memcmp(preserved,object,sizeof(*object))&&state->drawSequence==sequence);
    request[6]=UINT32_MAX;request[2]=5;CHECK(!MLBGI_SetImmediateBitmap(&engine,request)&&!memcmp(preserved,object,sizeof(*object))&&state->drawSequence==sequence);
    request[2]=0;CHECK(!service(&thread,0x43,request,9)&&!thread.error&&thread.stackPointer==1);
    CHECK(object->type==4&&object->sourceValid&&object->sourceIdentity==renderer->bitmaps[0]&&object->drawSequence==3&&state->drawSequence==3&&!object->offsetX&&!object->offsetY&&!object->secondOffsetX&&!object->secondOffsetY&&state->imageCacheBytes==8);
    CHECK(MLBGI_DrawScene(&engine,pixels,8,2,1,8)&&!memcmp(pixels,image,8));
    offsets[1]=1;offsets[2]=0;CHECK(!service(&thread,0x37,offsets,3));offsets[1]=0;CHECK(!service(&thread,0x36,offsets,3));
    CHECK(!service(&thread,0x43,request,9)&&object->offsetX==1&&object->drawSequence==3&&state->drawSequence==3);
    CHECK(MLBGI_DrawScene(&engine,pixels,4,1,1,4)&&!pixels[0]&&pixels[1]==255&&!pixels[2]&&pixels[3]==255);
    CHECK(state->clearBitmap(&engine,0,0x0000ff));CHECK(MLBGI_DrawScene(&engine,pixels,4,1,1,4)&&!pixels[0]&&!pixels[1]&&pixels[2]==255);
    CHECK(state->freeBitmap(&engine,0)&&!object->sourceValid&&!object->sourceIdentity&&object->drawSequence==3&&!state->imageCacheBytes);
    CHECK(state->createBitmap(&engine,0,2,1,MLBGI_COLOR32)&&state->clearBitmap(&engine,0,0xffffff));
    CHECK(MLBGI_DrawScene(&engine,pixels,4,1,1,4)&&!pixels[0]&&!pixels[1]&&!pixels[2]);
    CHECK(!service(&thread,0x43,request,9)&&object->drawSequence==3&&object->offsetX==1);CHECK(MLBGI_DrawScene(&engine,pixels,4,1,1,4)&&pixels[0]==255&&pixels[1]==255&&pixels[2]==255);
    MLBGI_ImmediateBitmap current=*object;*object=(MLBGI_ImmediateBitmap){.allocated=1,.type=3,.drawSequence=3};memset(pixels,99,4);
    CHECK(!MLBGI_CurrentDrawSupported(object)&&!MLBGI_SetGraphicSecondOffset(&engine,0,7,8)&&!MLBGI_DrawImmediateBitmap(&engine,pixels,4,1,1,4)&&pixels[0]==99);
    CHECK(!MLBGI_SetImmediateBitmap(&engine,request)&&object->type==3&&state->drawSequence==3);
    CHECK(service(&thread,0x37,offsets,3)==UINT32_MAX-3&&thread.error&&thread.stackPointer==1&&!object->offsetX);
    thread.error=0;thread.running=1;*object=(MLBGI_ImmediateBitmap){.allocated=1,.type=1,.bitmapSlot=UINT32_MAX,.drawSequence=3,.sourceValid=1};
    CHECK(!MLBGI_CurrentDrawSupported(object)&&!MLBGI_SetGraphicSecondOffset(&engine,0,7,8)&&!MLBGI_SetImmediateBitmap(&engine,request)&&!MLBGI_DrawImmediateBitmap(&engine,pixels,4,1,1,4)&&pixels[0]==99);
    object->sourceValid=0;uint64_t savedSequence=state->drawSequence;state->drawSequence=UINT64_MAX;memcpy(preserved,object,sizeof(*object));
    CHECK(!MLBGI_SetImmediateBitmap(&engine,request)&&!memcmp(preserved,object,sizeof(*object))&&state->drawSequence==UINT64_MAX);
    state->drawSequence=savedSequence;*object=current;CHECK(state->freeBitmap(&engine,0));state->freeParticleResources(&engine);MLBGI_FreeDialect(&engine);MLBGI_FreeArchiveCache();free(renderer);
    puts("current draw contracts passed");return 0;
}
`);
  const names = ["current-draw.c", "graphic-offset.c", "immediate-bitmap.c", "bitmap-format.c", "bitmap-loader.c", "particle-resources.c", "raw-bitmap.c", "cbg-bitmap.c", "vm-dialect.c",
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
  assert.equal(run.stdout.trim(), "current draw contracts passed"); assert.doesNotMatch(run.stderr, /AddressSanitizer|runtime error/);
});
