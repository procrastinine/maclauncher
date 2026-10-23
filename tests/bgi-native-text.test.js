const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Overlay = require("../src/modules/bgi/native/source-overlay");
const upstream = path.resolve("src/external/openbgi");
const sdl = spawnSync("sdl2-config", ["--prefix"], { encoding: "utf8" });
const initialized = process.platform === "darwin" && fs.existsSync(path.join(upstream, "src/renderer.h")) && sdl.status === 0;

test("BGI macOS text draws CP932 glyphs, bounded native effects and exact service operands without modifying invalid destinations", { skip: !initialized }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-native-text-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); Overlay.stageSource({ sourceRoot: upstream, destination: source });
  const driver = path.join(root, "text.c"), binary = path.join(root, "text");
  fs.writeFileSync(driver, `#include "platform-text.h"
#include "vm-dialect.h"
#include "vm-strings.h"
#include "bitmap-loader.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
uint32_t Thread_PopStack(Thread_t*t){if(!t->stackPointer){t->error=1;return 0;}return t->stack[--t->stackPointer];}
void Thread_PushStack(Thread_t*t,uint32_t v){if(t->stackPointer>=t->stackSize){t->error=1;return;}t->stack[t->stackPointer++]=v;}
uint8_t Thread_ReadCode8(Thread_t*t){(void)t;return 0;}
static unsigned used(const unsigned char*p,unsigned*minX,unsigned*minY,unsigned*maxX,unsigned*maxY){unsigned count=0;*minX=*minY=UINT32_MAX;*maxX=*maxY=0;
for(unsigned y=0;y<64;y++)for(unsigned x=0;x<128;x++)if(p[(y*128+x)*4+3]){count++;if(x<*minX)*minX=x;if(y<*minY)*minY=y;if(x>*maxX)*maxX=x;if(y>*maxY)*maxY=y;}return count;}
int main(void){Engine_t e={0};Renderer_t*r=calloc(1,sizeof(*r));Bitmap_t b={0};unsigned char pixels[128*64*4]={0},prior[sizeof(pixels)],base[sizeof(pixels)];
if(!r)return 1;e.renderer=r;r->engine=&e;b.width=128;b.height=64;b.format=MLBGI_ALPHA32;b.bitmap=pixels;r->bitmaps[7]=&b;
if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",640,480)||!MLBGI_AttachTextRenderer(&e))return 2;MLBGI_Runtime*s=e.mlRuntime;s->antialiasLevel=2;
MLBGI_BitmapText request={7,8,6,"\\x82\\xa0""A","Hiragino Sans",24,100,0,0xc80000,0,0,0,0,0};unsigned count=99;
if(!MLBGI_RenderBitmapText(&e,&request,&count)||count!=2)return 3;
unsigned x1,y1,x2,y2;unsigned face=used(pixels,&x1,&y1,&x2,&y2);if(face<20||x1<8||y1<6||y2>=30||x2>=100){fprintf(stderr,"glyph bounds %u [%u,%u,%u,%u]\\n",face,x1,y1,x2,y2);return 4;}
memcpy(base,pixels,sizeof(pixels));for(unsigned i=0;i<128*64;i++)if(pixels[i*4+3]&&(pixels[i*4]!=200||pixels[i*4+1]||pixels[i*4+2]))return 5;
memset(pixels,0,sizeof(pixels));request.widthPercent=50;if(!MLBGI_RenderBitmapText(&e,&request,&count)||count!=2)return 6;
unsigned narrow=used(pixels,&x1,&y1,&x2,&y2),nx=x2;if(!narrow||nx>=30)return 7;
memset(pixels,0,sizeof(pixels));request.widthPercent=100;request.effectType=2;request.effectWidthPercent=request.effectHeightPercent=1;request.effectColor=0x0000ff;request.effectOpacity=192;
if(!MLBGI_RenderBitmapText(&e,&request,&count)||count!=2||used(pixels,&x1,&y1,&x2,&y2)<=face)return 8;
unsigned onlyEffect=0;for(unsigned i=0;i<128*64;i++)if(pixels[i*4+3]&&!base[i*4+3]){if(pixels[i*4]||pixels[i*4+1]||pixels[i*4+2]!=255||pixels[i*4+3]>191)return 9;onlyEffect++;}if(!onlyEffect)return 10;
memcpy(prior,pixels,sizeof(pixels));request.text="bad\\ncontrol";count=77;if(MLBGI_RenderBitmapText(&e,&request,&count)||count!=77||memcmp(prior,pixels,sizeof(pixels)))return 11;
request.text="\\x81";if(MLBGI_RenderBitmapText(&e,&request,&count)||memcmp(prior,pixels,sizeof(pixels)))return 12;
request.text="";if(!MLBGI_RenderBitmapText(&e,&request,&count)||count||memcmp(prior,pixels,sizeof(pixels)))return 13;
request.text="A";request.effectWidthPercent=101;if(MLBGI_RenderBitmapText(&e,&request,&count)||memcmp(prior,pixels,sizeof(pixels)))return 14;request.effectWidthPercent=1;
request.bitmap=16384;if(MLBGI_RenderBitmapText(&e,&request,&count)||memcmp(prior,pixels,sizeof(pixels)))return 15;request.bitmap=7;
b.format=255;if(MLBGI_RenderBitmapText(&e,&request,&count)||memcmp(prior,pixels,sizeof(pixels)))return 16;b.format=MLBGI_ALPHA32;
request.height=201;if(MLBGI_RenderBitmapText(&e,&request,&count)||memcmp(prior,pixels,sizeof(pixels)))return 17;request.height=24;
request.family="";if(MLBGI_RenderBitmapText(&e,&request,&count)||memcmp(prior,pixels,sizeof(pixels)))return 18;request.family="Hiragino Sans";
request.x=INT32_MIN;request.y=INT32_MAX;if(!MLBGI_RenderBitmapText(&e,&request,&count)||count!=1||memcmp(prior,pixels,sizeof(pixels)))return 19;
request.x=8;request.y=6;request.text="\\x82\\xa0""A";request.effectOpacity=0;memset(pixels,0,sizeof(pixels));if(!MLBGI_RenderBitmapText(&e,&request,&count)||count!=2||memcmp(base,pixels,sizeof(pixels)))return 24;
request.effectOpacity=256;memset(pixels,0,sizeof(pixels));if(!MLBGI_RenderBitmapText(&e,&request,&count)||count!=2||used(pixels,&x1,&y1,&x2,&y2)<=face)return 25;
unsigned opaqueEffect=0;for(unsigned i=0;i<128*64;i++)if(!base[i*4+3]&&pixels[i*4+3]==255)opaqueEffect++;if(!opaqueEffect)return 26;
Thread_t thread={0};unsigned char code[16]={0};uint32_t stack[64]={0},result=99;thread.engine=&e;e.threads=&thread;thread.code=code;thread.codeSize=thread.codeSpaceUsed=16;thread.stack=stack;thread.stackSize=64;memcpy(code+4,"AB",3);
uint32_t args[]={7,8,6,0x04000004,0,0,0,0,0,24,100,0,0xc80000,0,0,2,1,1,0x0000ff,192,123};
for(unsigned i=0;i<21;i++)Thread_PushStack(&thread,args[i]);if(!MLBGI_TryService(&thread,0x92,0x9c,&result)||result||thread.error||thread.stackPointer!=1||Thread_PopStack(&thread)!=2)return 20;
memcpy(prior,pixels,sizeof(pixels));args[5]=1;for(unsigned i=0;i<21;i++)Thread_PushStack(&thread,args[i]);if(!MLBGI_TryService(&thread,0x92,0x9c,&result)||result!=UINT32_MAX-3||!thread.error||memcmp(prior,pixels,sizeof(pixels)))return 21;
thread.error=0;thread.stackPointer=0;args[5]=0;args[9]=3;for(unsigned i=0;i<21;i++)Thread_PushStack(&thread,args[i]);if(!MLBGI_TryService(&thread,0x92,0x9c,&result)||result!=UINT32_MAX-3||!thread.error||memcmp(prior,pixels,sizeof(pixels)))return 22;
thread.error=0;thread.stackPointer=0;args[9]=24;args[3]=0;for(unsigned i=0;i<21;i++)Thread_PushStack(&thread,args[i]);if(!MLBGI_TryService(&thread,0x92,0x9c,&result)||result!=UINT32_MAX-3||!thread.error||memcmp(prior,pixels,sizeof(pixels)))return 23;
const char substitution[]={'A',92,'n','a','m','e',0};if(MLBGI_RegisterTextRules(&e,substitution)!=1)return 27;
request.text="A";count=77;if(MLBGI_RenderBitmapText(&e,&request,&count)||count!=77||memcmp(prior,pixels,sizeof(pixels)))return 28;
request.text="C";request.x=INT32_MIN;request.y=INT32_MAX;if(!MLBGI_RenderBitmapText(&e,&request,&count)||count!=1||memcmp(prior,pixels,sizeof(pixels)))return 29;
MLBGI_FreeDialect(&e);free(e.globalMem);free(r);return 0;}
`);
  const names = ["platform-text.c", "vm-dialect.c", "vm-guards.c", "vm-input.c", "vm-strings.c", "archive-reader.c", "state-files.c"];
  const build = spawnSync("clang", ["-std=c11", "-fsanitize=address,undefined", "-I", path.join(source, "src"), "-I", path.join(sdl.stdout.trim(), "include"),
    ...names.map(name => path.join(source, "src", name)), driver, "-framework", "CoreFoundation", "-framework", "CoreGraphics", "-framework", "CoreText", "-liconv", "-lm", "-o", binary], { encoding: "utf8", timeout: 30000 });
  assert.ifError(build.error); assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10000, env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" } });
  assert.ifError(run.error); assert.equal(run.status, 0, `${run.stderr}\nexit ${run.status}`); assert.doesNotMatch(run.stderr, /runtime error|AddressSanitizer/);
});
