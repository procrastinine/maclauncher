const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const Overlay = require("../src/modules/bgi/native/source-overlay");
const upstream = path.resolve("src/external/openbgi");
const sdl = spawnSync("sdl2-config", ["--prefix"], { encoding: "utf8" });
const initialized = fs.existsSync(path.join(upstream, "src/spng.c")) && sdl.status === 0;
function crc(bytes) {
  let n = 0xffffffff;
  for (const byte of bytes) { n ^= byte; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); }
  return (n ^ 0xffffffff) >>> 0;
}
function chunk(name, bytes) {
  const tag = Buffer.from(name), size = Buffer.alloc(4), sum = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length); sum.writeUInt32BE(crc(Buffer.concat([tag, bytes])));
  return Buffer.concat([size, tag, bytes, sum]);
}
function png(width = 2, height = 1) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = height === 2 ? [0, 255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 0, 255, 64, 255, 255, 255, 32] : [0, 255, 0, 0, 128, 0, 255, 0, 255];
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.from(pixels))), chunk("IEND", Buffer.alloc(0))]);
}
function transparentPng(palette) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = palette ? 3 : 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    ...(palette ? [chunk("PLTE", Buffer.from([255, 0, 0]))] : []),
    chunk("tRNS", Buffer.from(palette ? [64] : [0, 255, 0, 0, 0, 0])),
    chunk("IDAT", zlib.deflateSync(Buffer.from(palette ? [0, 0] : [0, 255, 0, 0]))), chunk("IEND", Buffer.alloc(0))]);
}
test("BGI archive bitmap loading decodes original resources and preserves slots on invalid replacements", { skip: !initialized }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-native-loader-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); Overlay.stageSource({ sourceRoot: upstream, destination: source });
  const raw = Buffer.alloc(22); raw.writeUInt16LE(2); raw.writeUInt16LE(1, 2); raw.writeUInt32LE(24, 4); Buffer.from([0, 0, 255, 0, 255, 0]).copy(raw, 16);
  const entries = [["raw", raw], ["png", png()], ["grid", png(2, 2)], ["bad", Buffer.from("invalid")], ["huge", png(8193)],
    ["rgb-transparency", transparentPng(false)], ["palette-transparency", transparentPng(true)]];
  const index = Buffer.alloc(16 + entries.length * 128); index.write("BURIKO ARC20"); index.writeUInt32LE(entries.length, 12); let offset = 0;
  for (let i = 0; i < entries.length; i++) { index.write(entries[i][0], 16 + i * 128); index.writeUInt32LE(offset, 16 + i * 128 + 96); index.writeUInt32LE(entries[i][1].length, 16 + i * 128 + 100); offset += entries[i][1].length; }
  fs.writeFileSync(path.join(root, "sprites.arc"), Buffer.concat([index, ...entries.map(row => row[1])]));
  const driver = path.join(root, "loader.c"), binary = path.join(root, "loader");
  fs.writeFileSync(driver, `#define SDL_MAIN_HANDLED
#include "bitmap-loader.h"
#include "particle-resources.h"
#include "archive-reader.h"
#include "vm-dialect.h"
#include <stdlib.h>
#include <string.h>
uint32_t Thread_PopStack(Thread_t*t){if(!t->stackPointer){t->error=1;return 0;}return t->stack[--t->stackPointer];}
void Thread_PushStack(Thread_t*t,uint32_t v){if(t->stackPointer>=t->stackSize){t->error=1;return;}t->stack[t->stackPointer++]=v;}
uint8_t Thread_ReadCode8(Thread_t*t){(void)t;return 0;}
uint8_t *Engine_ReadFile(Engine_t*e,const char*arc,const char*name,size_t*out){(void)e;return MLBGI_ReadResource(arc,name,NULL,0,0,out);}
int main(void){Engine_t e={0};Renderer_t*r=calloc(1,sizeof(*r));if(!r)return 1;e.renderer=r;r->engine=&e;
if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",640,480)||!MLBGI_AttachBitmapLoader(&e))return 2;MLBGI_Runtime*s=e.mlRuntime;
if(!s->loadBitmap(&e,16383,"sprites","raw")||s->imageCacheBytes!=8)return 3;
Bitmap_t*b=r->bitmaps[16383];if(!b||b->width!=2||b->height!=1||b->format!=1||b->bitmap[0]!=255||b->bitmap[3]!=255)return 4;
uint32_t meta[6]={99,99,99,99,99,99};if(!s->bitmapInfo(&e,16383,meta)||meta[0]||meta[1]!=8||meta[2]!=2||meta[3]!=1||meta[4]!=1||meta[5]!=4)return 5;
if(!s->loadBitmap(&e,0,"sprites","rgb-transparency")||r->bitmaps[0]->format!=2||r->bitmaps[0]->bitmap[3]||!s->freeBitmap(&e,0))return 45;
if(!s->loadBitmap(&e,0,"sprites","palette-transparency")||r->bitmaps[0]->format!=2||r->bitmaps[0]->bitmap[3]!=64||!s->freeBitmap(&e,0))return 46;
if(s->loadBitmap(&e,16383,"sprites","bad")||s->loadBitmap(&e,16383,"sprites","huge")||s->loadBitmap(&e,16384,"sprites","raw")||s->imageCacheBytes!=8||r->bitmaps[16383]!=b)return 6;
if(!s->loadBitmap(&e,16383,"sprites","png")||s->imageCacheBytes!=8)return 7;b=r->bitmaps[16383];if(b->format!=2||b->bitmap[0]!=255||b->bitmap[3]!=128||b->bitmap[5]!=255)return 8;
s->imageCacheLimit=8;if(s->loadBitmap(&e,0,"sprites","raw")||r->bitmaps[0]||s->imageCacheBytes!=8)return 9;
if(s->bitmapInfo(&e,0,meta)||s->bitmapInfo(&e,16384,meta))return 10;
s->imageCacheLimit=128;if(!s->loadBitmap(&e,1,"sprites","grid")||s->imageCacheBytes!=24)return 11;
if(!s->cropBitmap(&e,2,1,1,0,1,2)||s->imageCacheBytes!=32)return 12;
Bitmap_t*c=r->bitmaps[2];if(!c||c->width!=1||c->height!=2||c->format!=2||c->bitmap[1]!=255||c->bitmap[3]!=255||c->bitmap[4]!=255||c->bitmap[7]!=32)return 13;
if(!s->bitmapInfo(&e,2,meta)||meta[1]!=4||meta[2]!=1||meta[3]!=2||meta[4]!=2||meta[5]!=4)return 14;
if(s->cropBitmap(&e,2,1,-1,0,1,2)||s->cropBitmap(&e,2,1,1,0,2,2)||s->cropBitmap(&e,16384,1,0,0,1,1)||s->cropBitmap(&e,2,1,0,0,8192,8192)||r->bitmaps[2]!=c||s->imageCacheBytes!=32)return 15;
if(!s->cropBitmap(&e,1,1,0,1,2,1)||s->imageCacheBytes!=24||r->bitmaps[1]->bitmap[2]!=255||r->bitmaps[1]->bitmap[3]!=64)return 16;
uint32_t stack[32]={0};Thread_t t={0};t.engine=&e;t.stack=stack;t.stackSize=32;uint32_t values[6]={3,1,1,0,1,1},result=99;
for(unsigned i=0;i<6;i++)Thread_PushStack(&t,values[i]);if(!MLBGI_TryService(&t,0x90,0x1f,&result)||result||t.stackPointer||s->imageCacheBytes!=28||r->bitmaps[3]->bitmap[3]!=32)return 17;
Thread_PushStack(&t,3);if(!MLBGI_TryService(&t,0x90,0x12,&result)||result||t.stackPointer!=1||Thread_PopStack(&t)!=1||r->bitmaps[3]||s->imageCacheBytes!=24)return 18;
if(s->freeBitmap(&e,3)||s->freeBitmap(&e,16384)||s->imageCacheBytes!=24)return 19;
if(!s->blitBitmap(&e,16383,-1,0,2,128,0)||r->bitmaps[16383]->bitmap[0]!=255||r->bitmaps[16383]->bitmap[3]!=128)return 21;
if(!s->loadBitmap(&e,4,"sprites","raw")||!s->loadBitmap(&e,5,"sprites","grid")||!s->blitBitmap(&e,4,-1,-1,5,128,0)||r->bitmaps[4]->bitmap[0]!=31||r->bitmaps[4]->bitmap[1]!=31||r->bitmaps[4]->bitmap[2]!=31||r->bitmaps[4]->bitmap[3]!=255)return 27;
if(!s->loadBitmap(&e,1,"sprites","grid")||!s->blitBitmap(&e,1,1,0,1,128,0))return 22;
b=r->bitmaps[1];if(b->bitmap[4]!=255||b->bitmap[7]!=128||b->bitmap[12]||b->bitmap[14]!=255||b->bitmap[15]!=64)return 23;
unsigned char before[16];memcpy(before,b->bitmap,16);if(s->blitBitmap(&e,1,0,0,2,128,257)||s->blitBitmap(&e,1,0,0,2,2,128)||s->blitBitmap(&e,1,0,0,2,255,0)||memcmp(before,b->bitmap,16))return 24;
if(!s->blitBitmap(&e,1,INT32_MIN,INT32_MAX,2,128,0)||memcmp(before,b->bitmap,16))return 25;
values[0]=1;values[1]=0;values[2]=1;values[3]=2;values[4]=128;values[5]=0;for(unsigned i=0;i<6;i++)Thread_PushStack(&t,values[i]);if(!MLBGI_TryService(&t,0x90,0x18,&result)||result||t.stackPointer||b->bitmap[9]!=255||b->bitmap[11]!=255)return 26;
if(!s->createBitmap(&e,6,2,2,1)||r->bitmaps[6]->bitmap[0]||r->bitmaps[6]->bitmap[3]!=255||!s->createBitmap(&e,7,2,2,2)||r->bitmaps[7]->bitmap[3])return 28;
if(!s->clearBitmap(&e,7,0x80224466)||!s->blitBitmap(&e,7,0,0,5,64,0)||r->bitmaps[7]->bitmap[0]!=0x22||r->bitmaps[7]->bitmap[3]!=128||r->bitmaps[7]->bitmap[4]||r->bitmaps[7]->bitmap[7]||r->bitmaps[7]->bitmap[15]!=128)return 47;
if(!s->clearBitmap(&e,7,0x80224466)||!s->blitBitmap(&e,7,0,0,5,64,1))return 48;
for(unsigned i=0;i<16;i++)if(r->bitmaps[7]->bitmap[i])return 49;
if(!s->clearBitmap(&e,7,0x80224466)||!s->blitBitmap(&e,7,0,0,4,64,0)||r->bitmaps[7]->bitmap[0]||r->bitmaps[7]->bitmap[7]||r->bitmaps[7]->bitmap[8]!=0x22)return 50;
b=r->bitmaps[6];if(s->createBitmap(&e,6,0,2,1)||s->createBitmap(&e,6,2,2,3)||s->createBitmap(&e,6,8192,8192,2)||s->createBitmap(&e,16384,2,2,1)||r->bitmaps[6]!=b)return 29;
values[0]=6;values[1]=1;values[2]=2;values[3]=2;for(unsigned i=0;i<4;i++)Thread_PushStack(&t,values[i]);if(!MLBGI_TryService(&t,0x90,0x11,&result)||result||t.stackPointer||r->bitmaps[6]->width!=1||r->bitmaps[6]->height!=2||r->bitmaps[6]->format!=2)return 30;
values[0]=6;values[1]=0x80224466;for(unsigned i=0;i<2;i++)Thread_PushStack(&t,values[i]);if(!MLBGI_TryService(&t,0x90,0x13,&result)||result||t.stackPointer||r->bitmaps[6]->bitmap[0]!=0x22||r->bitmaps[6]->bitmap[1]!=0x44||r->bitmaps[6]->bitmap[2]!=0x66||r->bitmaps[6]->bitmap[7]!=0x80)return 31;
if(!s->clearBitmap(&e,4,0x0000ff)||!s->blitBitmap(&e,4,0,0,5,0,200)||r->bitmaps[4]->bitmap[0]!=127||r->bitmaps[4]->bitmap[2]!=127||r->bitmaps[4]->bitmap[5]!=255||r->bitmaps[4]->bitmap[7]!=255)return 78;
if(!s->clearBitmap(&e,4,0x0000ff)||!s->blitBitmap(&e,4,0,0,5,1,128)||r->bitmaps[4]->bitmap[0]!=63||r->bitmaps[4]->bitmap[2]!=191||r->bitmaps[4]->bitmap[5]!=125||r->bitmaps[4]->bitmap[6]!=129)return 79;
if(!s->clearBitmap(&e,7,0x800000ff)||!s->blitBitmap(&e,7,0,0,5,1,128)||r->bitmaps[7]->bitmap[0]!=101||r->bitmaps[7]->bitmap[2]!=152||r->bitmaps[7]->bitmap[3]!=160||r->bitmaps[7]->bitmap[5]!=169||r->bitmaps[7]->bitmap[6]!=84||r->bitmaps[7]->bitmap[7]!=191)return 80;
unsigned char alphaBefore[16];memcpy(alphaBefore,r->bitmaps[7]->bitmap,16);if(!s->blitBitmap(&e,7,0,0,5,1,256)||memcmp(alphaBefore,r->bitmaps[7]->bitmap,16))return 81;
if(!s->clearBitmap(&e,7,0x800000ff)||!s->blitBitmap(&e,7,0,0,5,0,256)||r->bitmaps[7]->bitmap[0]!=169||r->bitmaps[7]->bitmap[2]!=84||r->bitmaps[7]->bitmap[3]!=192||r->bitmaps[7]->bitmap[5]!=255||r->bitmaps[7]->bitmap[6]||r->bitmaps[7]->bitmap[7]!=255)return 82;
if(!s->clearBitmap(&e,4,0x00ff00)||!s->clearBitmap(&e,7,0x800000ff)||!s->blitBitmap(&e,7,0,0,4,1,128)||r->bitmaps[7]->bitmap[1]!=169||r->bitmaps[7]->bitmap[2]!=85||r->bitmaps[7]->bitmap[3]!=191)return 83;
if(!s->clearBitmap(&e,4,0)||r->bitmaps[4]->bitmap[0]||r->bitmaps[4]->bitmap[3]!=255||s->clearBitmap(&e,16384,0)||s->clearBitmap(&e,0,0))return 32;
values[0]=8;values[1]=6;for(unsigned i=0;i<2;i++)Thread_PushStack(&t,values[i]);if(!MLBGI_TryService(&t,0x91,0x1f,&result)||result||t.stackPointer||r->bitmaps[8]->width!=1||r->bitmaps[8]->height!=2||r->bitmaps[8]->format!=2||memcmp(r->bitmaps[8]->bitmap,r->bitmaps[6]->bitmap,8))return 33;
if(!s->clearBitmap(&e,6,0)||r->bitmaps[8]->bitmap[3]!=0x80||r->bitmaps[8]->bitmap==r->bitmaps[6]->bitmap)return 34;
values[0]=63;values[1]=4;for(unsigned i=0;i<2;i++)Thread_PushStack(&t,values[i]);if(!MLBGI_TryService(&t,0xc0,0x24,&result)||result||t.stackPointer)return 35;
const Bitmap_t*p=MLBGI_ParticleResource(&e,63,0);if(!p||p->width!=2||p->height!=1||p->format!=1||p->bitmap[3]!=255||MLBGI_ParticleResource(&e,64,0)||MLBGI_ParticleResource(&e,63,32)||MLBGI_ParticleResource(&e,63,1))return 36;
if(s->registerParticleImage(&e,64,4)||s->registerParticleImage(&e,63,16384)||s->registerParticleImage(&e,63,0)||MLBGI_ParticleResource(&e,63,0)!=p)return 37;
if(!s->clearBitmap(&e,4,0x123456)||p->bitmap[0]||p->bitmap==r->bitmaps[4]->bitmap)return 38;
unsigned char canvas[8]={9,9,9,9,9,9,9,9};if(!MLBGI_DrawParticleResource(&e,63,0,canvas,2,1,8,0,0)||canvas[0]||canvas[3]!=255||MLBGI_DrawParticleResource(&e,63,0,canvas,2,1,7,0,0))return 39;
unsigned char pattern[32*32*4];for(unsigned i=0;i<sizeof(pattern);i+=4){pattern[i]=pattern[i+1]=pattern[i+2]=120;pattern[i+3]=255;}
s->imageCacheLimit=65536;if(!s->createBitmap(&e,9,32,32,1))return 40;memcpy(r->bitmaps[9]->bitmap,pattern,sizeof(pattern));
if(!s->registerParticleImage(&e,0,9)||!MLBGI_ParticleResource(&e,0,31)||MLBGI_ParticleResource(&e,0,31)->width!=1||MLBGI_ParticleResource(&e,0,31)->bitmap[0]!=120||MLBGI_ParticleResource(&e,0,16)->width!=16)return 41;
if(!s->clearBitmap(&e,4,0)||!s->blitBitmap(&e,4,0,0,9,1,128)||r->bitmaps[4]->bitmap[0]!=60||r->bitmaps[4]->bitmap[3]!=255)return 75;
if(!s->clearBitmap(&e,4,0)||!s->blitBitmap(&e,4,0,0,9,1,129)||r->bitmaps[4]->bitmap[0]!=60)return 76;
if(!s->blitBitmap(&e,4,0,0,9,1,256)||r->bitmaps[4]->bitmap[0]!=60||!s->blitBitmap(&e,4,0,0,9,1,0)||r->bitmaps[4]->bitmap[0]!=120)return 77;
MLBGI_WriteInteger(&t,e.globalMem+128,2,0xffff0000);uint32_t parameters[11]={63,(uint32_t)-20480,(uint32_t)-147456,0x80000000,20480,65536,0,20480,0,51200,128};for(unsigned i=0;i<11;i++)Thread_PushStack(&t,parameters[i]);if(!MLBGI_TryService(&t,0xc0,0x25,&result)||result||t.stackPointer)return 42;
const int32_t*q=MLBGI_ParticleConfiguration(&e,63);if(!q||q[0]!=80||q[1]!=-576||q[2]!=-8388608||q[3]!=80||q[4]!=256||q[9]!=-256||MLBGI_ParticleConfiguration(&e,64))return 43;
if(s->configureParticle(&e,64,parameters+1)||MLBGI_ParticleConfiguration(&e,63)!=q||q[0]!=80)return 44;
if(!s->createBitmap(&e,10,2,2,2)||!s->createBitmap(&e,11,2,2,2)||!s->clearBitmap(&e,10,0xffff0000)||!s->clearBitmap(&e,11,0x400000ff))return 51;
uint32_t protocol[7]={1,63,2,10,100,200,8};for(unsigned i=0;i<7;i++)Thread_PushStack(&t,protocol[i]);if(!MLBGI_TryService(&t,0xc0,0x18,&result)||result||t.stackPointer)return 52;
uint32_t protocolInfo[3]={0};const Bitmap_t*frame=MLBGI_ImageProtocolResource(&e,1,63,1,0);
if(!frame||frame->bitmap[2]!=255||frame->bitmap[3]!=64||!MLBGI_ImageProtocolInfo(&e,1,63,protocolInfo)||protocolInfo[0]!=2||protocolInfo[1]!=5242||protocolInfo[2]!=2621||MLBGI_ParticleResource(&e,63,0)!=p)return 53;
if(!s->clearBitmap(&e,11,0)||frame->bitmap[2]!=255||frame->bitmap==r->bitmaps[11]->bitmap)return 54;
if(s->registerImageProtocol(&e,2,63,2,10,100,200,8)||s->registerImageProtocol(&e,1,64,2,10,100,200,8)||s->registerImageProtocol(&e,1,63,33,10,100,200,8)||s->registerImageProtocol(&e,1,63,2,16383,100,200,8)||MLBGI_ImageProtocolResource(&e,1,63,1,0)!=frame)return 55;
if(!s->createBitmap(&e,11,1,2,2)||s->registerImageProtocol(&e,1,63,2,10,100,200,8)||MLBGI_ImageProtocolResource(&e,1,63,1,0)!=frame)return 56;
Thread_PushStack(&t,1);if(!MLBGI_TryService(&t,0xc0,0x1f,&result)||result||t.stackPointer||s->imageProtocolRateMode!=1)return 57;
if(!s->registerImageProtocol(&e,1,62,1,10,100,200,8)||!MLBGI_ImageProtocolInfo(&e,1,62,protocolInfo)||protocolInfo[1]!=5242||protocolInfo[2]!=(uint32_t)(1747u-5242u))return 58;
if(s->registerImageProtocol(&e,1,62,1,10,1,UINT32_MAX,8)||!MLBGI_ImageProtocolInfo(&e,1,62,protocolInfo)||protocolInfo[1]!=5242)return 59;
Thread_PushStack(&t,2);if(!MLBGI_TryService(&t,0xc0,0x1f,&result)||result||t.stackPointer||!s->registerImageProtocol(&e,1,62,1,10,100,200,8)||!MLBGI_ImageProtocolInfo(&e,1,62,protocolInfo)||protocolInfo[1]!=5242||protocolInfo[2]!=10484)return 60;
if(!s->registerImageProtocol(&e,1,62,0,10,100,200,8)||MLBGI_ImageProtocolInfo(&e,1,62,protocolInfo)||MLBGI_ImageProtocolResource(&e,1,62,0,0)||!s->registerImageProtocol(&e,1,63,33,UINT32_MAX,100,200,8)||MLBGI_ImageProtocolResource(&e,1,63,0,0))return 61;
uint32_t frameParameters[18]={63,(uint32_t)-10,3,(uint32_t)-20480,(uint32_t)-147456,0x80000000,20480,65536,0,(uint32_t)-20480,(uint32_t)-51200,51200,120,80,128,0,0,32};
for(unsigned i=0;i<18;i++)Thread_PushStack(&t,frameParameters[i]);if(!MLBGI_TryService(&t,0xc0,0x2d,&result)||result||t.stackPointer)return 62;
const int32_t*f=MLBGI_ImageProtocolConfiguration(&e,63);if(!f||f[0]!=-10||f[1]!=3||f[2]!=80||f[3]!=-576||f[4]!=-8388608||f[5]!=80||f[9]!=-200||f[10]!=200||f[11]!=120||f[12]!=80||f[13]!=-256||f[14]!=1||f[15]!=1||f[16]!=32||MLBGI_ImageProtocolConfiguration(&e,64))return 63;
if(s->configureImageProtocol(&e,64,frameParameters+1)||MLBGI_ImageProtocolConfiguration(&e,63)!=f||f[2]!=80)return 64;
size_t windowBudget=s->imageCacheBytes;uint32_t windowSize[]={32,20};for(unsigned i=0;i<2;i++)Thread_PushStack(&t,windowSize[i]);if(!MLBGI_TryService(&t,0x90,0x80,&result)||result||t.error)return 66;
uint32_t windowHandle=Thread_PopStack(&t);if(windowHandle!=0xb0000000||s->imageCacheBytes!=windowBudget+32u*20*4)return 67;
if(!s->windowBitmap(&e,0,9)||!s->windows[0].backgroundEnabled||s->windows[0].pixels[0]!=120||s->windows[0].pixels[3]!=255||s->windows[0].pixels[(32*20-1)*4]!=120)return 68;
uint8_t windowBefore[8];memcpy(windowBefore,s->windows[0].pixels,8);if(s->windowBitmap(&e,0,16384)||s->windowBitmap(&e,1,9)||memcmp(windowBefore,s->windows[0].pixels,8))return 69;
int sourceWidth=r->bitmaps[9]->width;r->bitmaps[9]->width=-1;if(s->windowBitmap(&e,0,9)||memcmp(windowBefore,s->windows[0].pixels,8))return 92;r->bitmaps[9]->width=sourceWidth;
uint8_t*sourcePixels=r->bitmaps[9]->bitmap;r->bitmaps[9]->bitmap=s->windows[0].pixels;if(s->windowBitmap(&e,0,9)||memcmp(windowBefore,s->windows[0].pixels,8))return 93;r->bitmaps[9]->bitmap=sourcePixels;
uint32_t attachment[]={windowHandle,UINT32_MAX,UINT32_MAX,10};for(unsigned i=0;i<4;i++)Thread_PushStack(&t,attachment[i]);if(!MLBGI_TryService(&t,0x90,0x86,&result)||result||t.error||t.stackPointer||s->windows[0].pixels[0]!=255||s->windows[0].pixels[3]!=255||s->windows[0].pixels[8]||s->windows[0].pixels[11])return 70;
if(!s->clearBitmap(&e,10,0)||s->windows[0].pixels[0]!=255||s->windows[0].pixels==r->bitmaps[10]->bitmap)return 71;
uint32_t capture[]={12,windowHandle};for(unsigned i=0;i<2;i++)Thread_PushStack(&t,capture[i]);if(!MLBGI_TryService(&t,0x90,0x83,&result)||result||t.error||t.stackPointer||!r->bitmaps[12]||r->bitmaps[12]->format!=2||r->bitmaps[12]->width!=32||r->bitmaps[12]->height!=20||memcmp(r->bitmaps[12]->bitmap,s->windows[0].pixels,32*20*4)||r->bitmaps[12]->bitmap==s->windows[0].pixels)return 88;
capture[0]=16384;for(unsigned i=0;i<2;i++)Thread_PushStack(&t,capture[i]);if(!MLBGI_TryService(&t,0x90,0x83,&result)||result!=UINT32_MAX-3||!t.error||s->windows[0].pixels[0]!=255)return 72;t.error=0;
s->imageCacheLimit=s->imageCacheBytes;if(s->exportWindowBitmap(&e,13,0)||r->bitmaps[13]||r->bitmaps[12]->bitmap[0]!=255)return 89;s->imageCacheLimit=65536;
uint32_t oldDisplayWidth=s->displayWidths[s->displaySlot],oldDisplayHeight=s->displayHeights[s->displaySlot];
s->displayWidths[s->displaySlot]=s->displayHeights[s->displaySlot]=2;s->windows[0].visible=1;s->windows[0].order=3;
if(!s->captureScene(&e,14,2)||!r->bitmaps[14]||r->bitmaps[14]->format!=1||r->bitmaps[14]->width!=2||r->bitmaps[14]->height!=2||r->bitmaps[14]->bitmap[0]||r->bitmaps[14]->bitmap[3]!=255)return 94;
uint32_t sceneCapture[]={14,3};for(unsigned i=0;i<2;i++)Thread_PushStack(&t,sceneCapture[i]);
if(!MLBGI_TryService(&t,0x90,0x05,&result)||result||t.error||t.stackPointer||r->bitmaps[14]->bitmap[0]!=255||r->bitmaps[14]->bitmap[1]||r->bitmaps[14]->bitmap[3]!=255||r->bitmaps[14]->bitmap==s->windows[0].pixels)return 95;
Bitmap_t*captured=r->bitmaps[14];size_t sceneBudget=s->imageCacheBytes;
s->windows[0].blendMode=17;if(s->captureScene(&e,14,3)||r->bitmaps[14]!=captured||s->imageCacheBytes!=sceneBudget||captured->bitmap[0]!=255)return 96;
if(!s->captureScene(&e,14,2)||r->bitmaps[14]->bitmap[0])return 97;s->windows[0].blendMode=0;
if(!MLBGI_TryService(&t,0x90,0x60,&result)||result)return 98;uint32_t snapshotFilter=Thread_PopStack(&t);
s->filters[0].visible=1;s->filters[0].parameter=0x0000ff;s->filters[0].opacity=256;s->filters[0].order=4;
if(!s->captureScene(&e,14,3)||r->bitmaps[14]->bitmap[0]!=255||r->bitmaps[14]->bitmap[2])return 99;
if(!s->captureScene(&e,14,4)||r->bitmaps[14]->bitmap[0]||r->bitmaps[14]->bitmap[2]!=255)return 100;
captured=r->bitmaps[14];sceneBudget=s->imageCacheBytes;s->imageCacheLimit=sceneBudget;
if(s->captureScene(&e,15,4)||r->bitmaps[15]||r->bitmaps[14]!=captured||s->imageCacheBytes!=sceneBudget||s->captureScene(&e,16384,4)||s->captureScene(&e,14,65536))return 101;
sceneCapture[0]=16384;for(unsigned i=0;i<2;i++)Thread_PushStack(&t,sceneCapture[i]);if(!MLBGI_TryService(&t,0x90,0x05,&result)||result!=UINT32_MAX-3||!t.error||t.stackPointer||r->bitmaps[14]!=captured)return 102;t.error=0;
Thread_PushStack(&t,snapshotFilter);if(!MLBGI_TryService(&t,0x90,0x61,&result)||result||t.error)return 103;
if(!s->freeBitmap(&e,14)||s->imageCacheBytes!=sceneBudget-16)return 104;
s->imageCacheLimit=65536;s->windows[0].visible=s->windows[0].order=0;s->displayWidths[s->displaySlot]=oldDisplayWidth;s->displayHeights[s->displaySlot]=oldDisplayHeight;
attachment[0]=0xc0000000;for(unsigned i=0;i<4;i++)Thread_PushStack(&t,attachment[i]);if(!MLBGI_TryService(&t,0x90,0x86,&result)||result!=UINT32_MAX-3||!t.error||s->windows[0].pixels[0]!=255)return 90;t.error=0;attachment[0]=windowHandle;
attachment[3]=UINT32_MAX;for(unsigned i=0;i<4;i++)Thread_PushStack(&t,attachment[i]);if(!MLBGI_TryService(&t,0x90,0x86,&result)||result||t.error||s->windows[0].backgroundEnabled||s->windows[0].pixels[0]||s->windows[0].pixels[3]||r->bitmaps[12]->bitmap[0]!=255||r->bitmaps[12]->bitmap[3]!=255)return 73;
if(!s->freeBitmap(&e,12))return 91;
Thread_PushStack(&t,windowHandle);if(!MLBGI_TryService(&t,0x90,0x81,&result)||result||s->windowCount||s->imageCacheBytes!=windowBudget)return 74;
frameParameters[14]=e.globalBufferSize-2;for(unsigned i=0;i<18;i++)Thread_PushStack(&t,frameParameters[i]);if(!MLBGI_TryService(&t,0xc0,0x2d,&result)||result!=UINT32_MAX-3||!t.error||f[13]!=-256||t.stackPointer)return 65;
s->freeBitmap(&e,10);s->freeBitmap(&e,11);
s->freeParticleResources(&e);s->freeBitmap(&e,9);
s->freeBitmap(&e,1);s->freeBitmap(&e,2);s->freeBitmap(&e,4);s->freeBitmap(&e,5);s->freeBitmap(&e,6);s->freeBitmap(&e,7);s->freeBitmap(&e,8);s->freeBitmap(&e,16383);if(s->imageCacheBytes)return 20;
free(r);MLBGI_FreeDialect(&e);free(e.globalMem);MLBGI_FreeArchiveCache();return 0;}
`);
  const names = ["bitmap-loader.c", "particle-resources.c", "raw-bitmap.c", "cbg-bitmap.c", "vm-dialect.c", "vm-guards.c", "vm-strings.c", "vm-input.c", "archive-reader.c", "state-files.c", "spng.c", "miniz.c"];
  const result = spawnSync("clang", ["-std=c11", "-DSPNG_USE_MINIZ", process.platform === "darwin" ? "-D_DARWIN_C_SOURCE" : "-D_POSIX_C_SOURCE=200809L", "-fsanitize=address,undefined",
    "-I", path.join(source, "src"), "-I", path.join(sdl.stdout.trim(), "include"), ...names.map(name => path.join(source, "src", name)),
    driver, ...(process.platform === "darwin" ? ["-liconv"] : []), "-lm", "-o", binary], { encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  const run = spawnSync(binary, [], { cwd: root, encoding: "utf8", timeout: 10000,
    env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" } });
  assert.ifError(run.error); assert.equal(run.status, 0, run.stderr); assert.doesNotMatch(run.stderr, /runtime error|AddressSanitizer/);
});
