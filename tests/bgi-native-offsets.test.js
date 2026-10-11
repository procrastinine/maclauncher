const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Overlay = require("../src/modules/bgi/native/versions/modern-vm-v6/source-overlay");
const Parent = require("../src/modules/bgi/native/versions/modern-vm-v5/source-overlay");
const upstream = path.resolve("src/external/openbgi");
const initialized = Overlay.INPUTS.files.every(file => fs.existsSync(path.join(upstream, file.path)));

test("BGI v6 stages separate secondary offsets and refuses altered v5 context before writing", { skip: !initialized }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-offsets-stage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, "v6"), receipt = Overlay.stageSource({ sourceRoot: upstream, destination });
  assert.equal(receipt.version, "0.0.1-build734-mac-vm-v6"); assert.equal(receipt.parentVersion, Parent.VERSION);
  assert.equal(receipt.gameplayQualified, false);
  assert.match(fs.readFileSync(path.join(destination, "src/main.c"), "utf8"), /0\.0\.1-build734-mac-vm-v6/);
  for (const file of receipt.files) assert.equal(Overlay.sha256(fs.readFileSync(path.join(destination, file.path))), file.sha256);
  assert.equal(receipt.sourceTreeSha256, Overlay.sha256(JSON.stringify(receipt.files)));
  assert.doesNotThrow(() => Overlay.verifyBase()); assert.throws(() => Overlay.applyOffsets(destination), /source context changed/);
  const prior = path.join(root, "v5"); Parent.stageSource({ sourceRoot: upstream, destination: prior });
  const preserved = new Map(["vm-dialect.h", "immediate-bitmap.c", "immediate-bitmap.h", "main.c"].map(file => [file, fs.readFileSync(path.join(prior, "src", file))]));
  fs.appendFileSync(path.join(prior, "src/vm-dialect.c"), "\n");
  assert.throws(() => Overlay.applyOffsets(prior), /source context changed/);
  for (const [file, bytes] of preserved) assert.deepEqual(fs.readFileSync(path.join(prior, "src", file)), bytes);
  assert.equal(fs.existsSync(path.join(prior, "src/graphic-offset.c")), false);
});

const sdl = spawnSync("sdl2-config", ["--prefix"], { encoding: "utf8" });
test("BGI secondary offsets preserve independent positions, move pixels, propagate to children and resolve the current draw only", {
  skip: !initialized || sdl.status !== 0
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-offsets-native-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); Overlay.stageSource({ sourceRoot: upstream, destination: source });
  const driver = path.join(root, "offsets.c"), binary = path.join(root, "offsets");
  fs.writeFileSync(driver, `#define SDL_MAIN_HANDLED
#include "graphic-offset.h"
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
    MLBGI_Runtime*state=engine.mlRuntime;uint32_t stack[32]={0};Thread_t thread={0};thread.engine=&engine;thread.stack=stack;thread.stackSize=32;
    uint32_t offset[3]={0,1,0};CHECK(service(&thread,0x36,offset,3)==UINT32_MAX-3&&thread.error&&!thread.stackPointer&&!state->immediateBitmap.allocated);
    thread.error=0;thread.running=1;CHECK(service(&thread,0x37,offset,3)==UINT32_MAX-3&&thread.error&&!thread.stackPointer&&!state->immediateBitmap.allocated&&!state->rootOffsetX&&!state->rootOffsetY);
    thread.error=0;thread.running=1;CHECK(state->createBitmap(&engine,0,3,1,MLBGI_COLOR32));
    uint8_t sourcePixels[12]={255,0,0,255,0,255,0,255,0,0,255,255};memcpy(renderer->bitmaps[0]->bitmap,sourcePixels,12);
    uint32_t request[9]={0,0,0,0,0,0x7fff,UINT32_MAX,0,0};CHECK(!service(&thread,0x43,request,9));
    CHECK(!service(&thread,0x50,NULL,0));uint32_t sprite=Thread_PopStack(&thread);
    uint32_t image[7]={sprite,0,0,0,128,0,0};CHECK(!service(&thread,0x56,image,7));
    CHECK(!service(&thread,0x60,NULL,0));uint32_t filter=Thread_PopStack(&thread);
    uint32_t windowSize[2]={1,1};CHECK(!service(&thread,0x80,windowSize,2));uint32_t window=Thread_PopStack(&thread);
    uint32_t budget=state->imageCacheBytes;Thread_PushStack(&thread,0x12345678);
    CHECK(!service(&thread,0x36,offset,3)&&!thread.error&&thread.stackPointer==1&&thread.stack[0]==0x12345678);
    CHECK(state->immediateBitmap.secondOffsetX==1&&!state->immediateBitmap.offsetX&&!state->sprites[0].object.secondOffsetX&&!state->windows[0].secondOffsetX&&state->imageCacheBytes==budget);
    uint8_t pixel[4];CHECK(MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&!pixel[0]&&pixel[1]==255&&!pixel[2]);
    CHECK(!service(&thread,0x37,offset,3));CHECK(state->immediateBitmap.offsetX==1&&state->immediateBitmap.secondOffsetX==1&&!state->sprites[0].object.offsetX&&!state->windows[0].offsetX);
    CHECK(MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&!pixel[0]&&!pixel[1]&&pixel[2]==255);
    CHECK(!service(&thread,0x43,request,9)&&state->immediateBitmap.offsetX==1&&state->immediateBitmap.secondOffsetX==1&&state->immediateBitmap.drawSequence==1);
    offset[1]=INT32_MAX;CHECK(!service(&thread,0x37,offset,3));offset[1]=1;CHECK(!service(&thread,0x36,offset,3));
    CHECK(MLBGI_DrawScene(&engine,pixel,4,1,1,4)&&!pixel[0]&&!pixel[1]&&!pixel[2]&&pixel[3]==255);
    offset[1]=0;CHECK(!service(&thread,0x37,offset,3)&&!service(&thread,0x36,offset,3));
    CHECK(!service(&thread,0xe0,NULL,0));uint32_t parent=Thread_PopStack(&thread);CHECK(!service(&thread,0xe0,NULL,0));uint32_t child=Thread_PopStack(&thread);
    uint32_t attach[4]={child,sprite,0,0};CHECK(!service(&thread,0xe8,attach,4));attach[0]=parent;attach[1]=child;CHECK(!service(&thread,0xe8,attach,4));
    attach[1]=window;CHECK(!service(&thread,0xe8,attach,4));attach[1]=filter;CHECK(!service(&thread,0xe8,attach,4));
    offset[0]=parent;offset[1]=2;offset[2]=(uint32_t)-1;CHECK(!service(&thread,0x36,offset,3)&&thread.stackPointer==1);
    CHECK(state->groups[0].secondOffsetX==2&&state->groups[1].secondOffsetY==-1&&state->sprites[0].object.secondOffsetX==2&&state->windows[0].secondOffsetY==-1&&state->filters[0].secondOffsetX==2);
    CHECK(!state->sprites[0].object.x&&!state->sprites[0].object.y&&!state->sprites[0].object.offsetX&&!state->sprites[0].object.offsetY&&!state->immediateBitmap.secondOffsetX);
    uint32_t savedChild=state->groups[1].members[0].handle;state->groups[1].members[0].handle=parent;
    CHECK(!MLBGI_SetGraphicSecondOffset(&engine,parent,7,8)&&state->groups[0].secondOffsetX==2&&state->groups[1].secondOffsetY==-1&&state->windows[0].secondOffsetX==2);
    state->groups[1].members[0].handle=0x800001ff;CHECK(!MLBGI_SetGraphicSecondOffset(&engine,parent,7,8)&&state->groups[0].secondOffsetX==2);
    state->groups[1].members[0].handle=savedChild;
    uint32_t savedMembers[3];for(unsigned i=0;i<3;i++)savedMembers[i]=state->groups[0].members[i].handle;
    state->groups[0].memberCount=1024;for(unsigned i=0;i<1024;i++)state->groups[0].members[i].handle=child;
    state->groups[0].members[1023].handle=0x800001ff;CHECK(!MLBGI_SetGraphicSecondOffset(&engine,parent,7,8)&&state->groups[0].secondOffsetX==2&&state->groups[1].secondOffsetY==-1);
    state->groups[0].members[1023].handle=child;CHECK(MLBGI_SetGraphicSecondOffset(&engine,parent,2,-1)&&state->sprites[0].object.secondOffsetX==2);
    state->groups[0].memberCount=3;for(unsigned i=0;i<3;i++)state->groups[0].members[i].handle=savedMembers[i];
    for(unsigned i=0;i<5;i++)CHECK(!MLBGI_SetGraphicSecondOffset(&engine,(uint32_t[]){0x80000200,0x90000008,0xb0000010,0xf1000008,0x7fffffff}[i],4,5));
    offset[0]=sprite;offset[1]=2;offset[2]=0;CHECK(!service(&thread,0x36,offset,3));offset[1]=(uint32_t)-1;CHECK(!service(&thread,0x37,offset,3));
    CHECK(state->sprites[0].object.secondOffsetX==2&&state->sprites[0].object.offsetX==-1);
    uint32_t show[2]={sprite,1};CHECK(!service(&thread,0x54,show,2));state->immediateBitmap.sourceValid=0;
    uint8_t scene[12],expected[12]={0,0,0,255,255,0,0,255,0,255,0,255};CHECK(MLBGI_DrawScene(&engine,scene,12,3,1,12)&&!memcmp(scene,expected,12));
    CHECK(state->createBitmap(&engine,1,1,1,MLBGI_COLOR32)&&state->clearBitmap(&engine,1,0xffffff));
    CHECK(state->windowBitmap(&engine,0,1));state->windows[0].visible=1;state->windows[0].opacity=state->windows[0].secondaryOpacity=0;state->windows[0].opacityScale=256;state->windows[0].blendMode=1;state->windows[0].order=0;
    offset[0]=window;offset[1]=2;offset[2]=0;CHECK(!service(&thread,0x36,offset,3));CHECK(MLBGI_DrawScene(&engine,scene,12,3,1,12)&&scene[8]==255&&scene[9]==255&&scene[10]==255);
    thread.stackPointer=0;CHECK(service(&thread,0x36,offset,2)==UINT32_MAX-3&&thread.error&&!thread.stackPointer);
    CHECK(state->freeBitmap(&engine,0)&&state->freeBitmap(&engine,1));state->freeParticleResources(&engine);MLBGI_FreeDialect(&engine);MLBGI_FreeArchiveCache();free(renderer);
    puts("secondary offset contracts passed");return 0;
}
`);
  const names = ["graphic-offset.c", "immediate-bitmap.c", "bitmap-format.c", "bitmap-loader.c", "particle-resources.c", "raw-bitmap.c", "cbg-bitmap.c", "vm-dialect.c",
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
  assert.equal(run.stdout.trim(), "secondary offset contracts passed"); assert.doesNotMatch(run.stderr, /AddressSanitizer|runtime error/);
});
