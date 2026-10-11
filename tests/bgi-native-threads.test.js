const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const Overlay = require("../src/modules/bgi/native/source-overlay");
const upstream = path.resolve("src/external/openbgi");
const initialized = Overlay.INPUTS.files.every(row => fs.existsSync(path.join(upstream, row.path)));

test("BGI program threads use the actual guarded allocator, isolated buffers and ready-thread ordering", { skip: !initialized }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-native-threads-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const headers = path.join(root, "headers"); fs.mkdirSync(path.join(headers, "SDL2"), { recursive: true });
  fs.writeFileSync(path.join(headers, "SDL2/SDL.h"), "typedef struct SDL_Window SDL_Window;\n");
  for (const name of ["engine.h", "thread.h"]) fs.writeFileSync(path.join(headers, name), Overlay.patch(`src/${name}`, fs.readFileSync(path.join(upstream, "src", name))));
  const patchedEngine = Overlay.patch("src/engine.c", fs.readFileSync(path.join(upstream, "src/engine.c"))).toString();
  const first = patchedEngine.indexOf("Thread_t* Engine_CreateThread("), last = patchedEngine.indexOf("char* Engine_SearchForArchive(", first);
  assert.ok(first >= 0 && last > first); const actualAllocator = patchedEngine.slice(first, last);
  const programs = [["child._bp", true], ["bad._bp", false], ["ipl._bp", true]].map(([name, valid]) => {
    const bytes = Buffer.alloc(19); bytes.writeUInt32LE(valid ? 16 : 8, 0); bytes.writeUInt32LE(3, 4); bytes[16] = 0; bytes[17] = 7; bytes[18] = 0x17;
    return [name, bytes];
  });
  const header = Buffer.alloc(16); header.write("BURIKO ARC20"); header.writeUInt32LE(programs.length, 12);
  let offset = 0; const records = programs.map(([name, bytes]) => {
    const record = Buffer.alloc(128); record.write(name); record.writeUInt32LE(offset, 96); record.writeUInt32LE(bytes.length, 100); offset += bytes.length; return record;
  });
  fs.writeFileSync(path.join(root, "system.arc"), Buffer.concat([header, ...records, ...programs.map(([, bytes]) => bytes)]));
  const original = fs.readFileSync(path.join(root, "system.arc"));
  const driver = path.join(root, "threads.c"), binary = path.join(root, "threads");
  fs.writeFileSync(driver, `#include "vm-dialect.h"
#include "vm-threads.h"
#include "vm-guards.h"
#include "archive-reader.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
uint32_t Thread_PopStack(Thread_t*t){if(!t->stackPointer){t->error=1;return 0;}return t->stack[--t->stackPointer];}
void Thread_PushStack(Thread_t*t,uint32_t value){if(t->stackPointer>=t->stackSize){t->error=1;return;}t->stack[t->stackPointer++]=value;}
uint8_t Thread_ReadCode8(Thread_t*t){return MLBGI_CodeAvailable(t,1)?t->code[t->nextInstructionPointer++]:0;}
${actualAllocator}
static unsigned count(const Engine_t*e){unsigned n=0;for(Thread_t*t=e->threads;t;t=t->previousThread)n++;return n;}
static void release(Engine_t*e){while(e->threads){Thread_t*t=e->threads;e->threads=t->previousThread;
 while(t->programs){Program_t*p=t->programs;t->programs=p->previousProgram;free(p->filename);free(p);}
 free(t->stack);free(t->code);free(t->localMem);free(t);}MLBGI_FreeDialect(e);free(e->globalMem);}
int main(void){Engine_t e={0};e.threadCounter=2;if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960)||!MLBGI_AttachThreads(&e)||MLBGI_AttachThreads(&e))return 1;
Thread_t*parent=Engine_CreateThread(&e,32,128,128);if(!parent||parent->error)return 2;parent->running=1;parent->codeSpaceUsed=64;
memcpy(parent->code,"system.arc",11);memcpy(parent->code+16,"child._bp",10);MLBGI_Runtime*state=e.mlRuntime;
uint32_t args[5]={0x04000000,0x04000010,512,32768,32768},result=99;
for(unsigned i=0;i<5;i++)Thread_PushStack(parent,args[i]);if(!MLBGI_TryService(parent,0x80,0x44,&result)||result||parent->error||Thread_PopStack(parent)!=3)return 3;
Thread_t*child=e.threads;if(child==parent||child->previousThread!=parent||child->threadId!=3||!child->running||child->programCount!=1||child->codeSpaceUsed!=3||child->code[1]!=7)return 4;
if(child->stackSize!=512||child->codeSize!=32768||child->localMemSize!=32768||child->stack==parent->stack||child->code==parent->code||child->localMem==parent->localMem)return 5;
child->localMem[1]=0xab;if(parent->localMem[1]||child->stackPointer||child->basePointer||child->mlWaitActive)return 6;
if(MLBGI_NextReadyThread(&e,2,100)!=child||MLBGI_NextReadyThread(&e,3,100)!=parent)return 7;
Thread_PushStack(child,0x12345678);Thread_PushStack(child,0xabcdef01);
if(!MLBGI_TryService(child,0x80,0x5f,&result)||result!=1||child->stackPointer!=2||child->stack[0]!=0x12345678||child->stack[1]!=0xabcdef01||child->mlWaitActive||MLBGI_NextReadyThread(&e,child->threadId,100)!=parent)return 15;
child->stackPointer=0;
uint32_t query=child->threadId;Thread_PushStack(parent,query);if(!MLBGI_TryService(parent,0x80,0x47,&result)||result||Thread_PopStack(parent)!=1)return 23;
Thread_PushStack(parent,999);MLBGI_TryService(parent,0x80,0x47,&result);if(result||Thread_PopStack(parent))return 24;
for(unsigned i=0;i<1024;i++){Thread_PushStack(parent,query);Thread_PushStack(parent,i);MLBGI_TryService(parent,0x80,0x48,&result);if(result||parent->error||parent->stackPointer||child->mlMessageCount!=i+1||parent->mlMessageCount)return 25;}
Thread_PushStack(parent,query);Thread_PushStack(parent,0xabcdef01);MLBGI_TryService(parent,0x80,0x48,&result);if(result!=UINT32_MAX-3||!parent->error||child->mlMessageCount!=1024)return 26;parent->error=0;parent->running=1;
Thread_PushStack(child,0x08007ffe);MLBGI_TryService(child,0x80,0x49,&result);if(result!=UINT32_MAX-3||!child->error||child->mlMessageCount!=1024||child->stackPointer)return 27;child->error=0;child->running=1;
for(unsigned i=0;i<512;i++){Thread_PushStack(child,0x08000004);MLBGI_TryService(child,0x80,0x49,&result);if(result||child->error||Thread_PopStack(child)!=1||MLBGI_ReadInteger(child,child->localMem+4,2)!=i)return 28;}
for(unsigned i=1024;i<1536;i++){Thread_PushStack(parent,query);Thread_PushStack(parent,i);MLBGI_TryService(parent,0x80,0x48,&result);if(result||parent->error)return 29;}
for(unsigned i=512;i<1536;i++){Thread_PushStack(child,0x08000004);MLBGI_TryService(child,0x80,0x49,&result);if(result||child->error||Thread_PopStack(child)!=1||MLBGI_ReadInteger(child,child->localMem+4,2)!=i)return 30;}
Thread_PushStack(child,0x08000004);MLBGI_TryService(child,0x80,0x49,&result);if(result||Thread_PopStack(child)||MLBGI_ReadInteger(child,child->localMem+4,2)!=1535||child->mlMessageCount)return 31;
Thread_PushStack(parent,999);Thread_PushStack(parent,9);MLBGI_TryService(parent,0x80,0x48,&result);if(result!=UINT32_MAX-3||!parent->error||parent->stackPointer||child->mlMessageCount)return 32;parent->error=0;parent->running=1;
MLBGI_WriteInteger(parent,parent->localMem+8,2,0x12345678);MLBGI_WriteInteger(parent,parent->localMem+12,2,0xabcdef01);
Thread_PushStack(parent,query);Thread_PushStack(parent,2);Thread_PushStack(parent,0x08000008);MLBGI_TryService(parent,0x80,0x4a,&result);
if(result||parent->error||parent->stackPointer||child->mlMessageCount!=2||parent->mlMessageCount)return 33;
memset(parent->localMem+8,0,8);memset(child->localMem+8,0x7f,12);
Thread_PushStack(child,3);Thread_PushStack(child,0x08000008);MLBGI_TryService(child,0x80,0x4b,&result);
if(result||child->error||Thread_PopStack(child)!=2||MLBGI_ReadInteger(child,child->localMem+8,2)!=0x12345678||MLBGI_ReadInteger(child,child->localMem+12,2)!=0xabcdef01||child->localMem[16]!=0x7f||child->mlMessageCount)return 34;
Thread_PushStack(child,3);Thread_PushStack(child,0x08000008);MLBGI_TryService(child,0x80,0x4b,&result);
if(result||child->error||Thread_PopStack(child)||child->localMem[8]!=0x78)return 35;
unsigned oldHead=child->mlMessageHead;child->mlMessageCount=1023;Thread_PushStack(parent,query);Thread_PushStack(parent,2);Thread_PushStack(parent,0x08000008);MLBGI_TryService(parent,0x80,0x4a,&result);
if(result!=UINT32_MAX-3||!parent->error||parent->stackPointer||child->mlMessageCount!=1023||child->mlMessageHead!=oldHead)return 36;parent->error=0;parent->running=1;child->mlMessageCount=0;
Thread_PushStack(parent,query);Thread_PushStack(parent,33);Thread_PushStack(parent,0x08000000);MLBGI_TryService(parent,0x80,0x4a,&result);
if(result!=UINT32_MAX-3||!parent->error||child->mlMessageCount||parent->stackPointer)return 37;parent->error=0;parent->running=1;
for(unsigned i=0;i<3;i++){Thread_PushStack(parent,i==0?999:query);Thread_PushStack(parent,i==1?0:i==2?1025:2);Thread_PushStack(parent,0x08000008);MLBGI_TryService(parent,0x80,0x4a,&result);if(result!=UINT32_MAX-3||!parent->error||child->mlMessageCount||parent->stackPointer)return 38;parent->error=0;parent->running=1;}
Thread_PushStack(parent,query);Thread_PushStack(parent,1);Thread_PushStack(parent,0x08000008);MLBGI_TryService(parent,0x80,0x4a,&result);if(result||child->mlMessageCount!=1)return 39;
Thread_PushStack(child,2);Thread_PushStack(child,0x08007ffc);MLBGI_TryService(child,0x80,0x4b,&result);
if(result!=UINT32_MAX-3||!child->error||child->stackPointer||child->mlMessageCount!=1||child->mlMessageHead!=oldHead)return 40;child->error=0;child->running=1;
Thread_PushStack(child,1);Thread_PushStack(child,0x08000008);MLBGI_TryService(child,0x80,0x4b,&result);if(result||Thread_PopStack(child)!=1||child->mlMessageCount)return 41;
parent->mlWaitActive=1;parent->mlWaitDeadline=500;if(MLBGI_NextReadyThread(&e,3,100)!=child)return 8;
child->mlWaitActive=1;child->mlWaitDeadline=600;if(MLBGI_NextReadyThread(&e,0,400)||MLBGI_NextReadyThread(&e,3,550)!=parent||parent->mlWaitActive||!child->mlWaitActive)return 9;
parent->running=0;if(MLBGI_NextReadyThread(&e,0,550)||MLBGI_NextReadyThread(&e,0,600)!=child||child->mlWaitActive)return 10;
if(state->createThread(parent,"system.arc","absent",512,32768,32768)||count(&e)!=2)return 11;
if(state->createThread(parent,"system.arc","bad._bp",512,32768,32768)||count(&e)!=2||e.threads!=child)return 12;
if(state->createThread(parent,"system.arc","child._bp",0,32768,32768)||state->createThread(parent,"system.arc","child._bp",512,0x2000001,32768)||count(&e)!=2)return 13;
memcpy(parent->code+16,"bad._bp",8);for(unsigned i=0;i<5;i++)Thread_PushStack(parent,args[i]);if(!MLBGI_TryService(parent,0x80,0x44,&result)||result!=UINT32_MAX-3||!parent->error||parent->stackPointer||count(&e)!=2)return 14;
if(MLBGI_LoadBootProgram(&e)||count(&e)!=2)return 16;
release(&e);MLBGI_FreeArchiveCache();
Engine_t boot={0};boot.threadCounter=2;if(!MLBGI_ConfigureDialect(&boot,"ethornell-1.72",1280,960)||MLBGI_LoadBootProgram(&boot)!=2)return 17;
Thread_t*main=boot.threads;if(!main||main->previousThread||main->stackSize!=0x1000||main->codeSize!=0x800000||main->localMemSize!=0x400000||main->programCount!=1||main->codeSpaceUsed!=3||main->code[1]!=7||!main->running)return 18;
/* The startup program can load a valid nested body larger than the old
   diagnostic buffer, while the fixed authored capacity remains enforced. */
size_t n=0x24000;unsigned char*body=calloc(1,n+16);if(!body)return 19;body[0]=16;uint32_t bytes=(uint32_t)n;memcpy(body+4,&bytes,4);body[n+15]=0x17;
if(MLBGI_LoadCode(main,body,n+16,"nested._bp")!=3||main->codeSpaceUsed!=n+3||main->code[n+2]!=0x17||main->error)return 20;free(body);
if(MLBGI_LoadBootProgram(&boot)||count(&boot)!=1)return 21;release(&boot);MLBGI_FreeArchiveCache();
Engine_t legacy={0};legacy.threadCounter=2;if(!MLBGI_ConfigureDialect(&legacy,"legacy-v1",1280,960)||MLBGI_LoadBootProgram(&legacy)||legacy.threads)return 22;release(&legacy);return 0;}
`);
  const build = spawnSync("clang", ["-std=c11", process.platform === "darwin" ? "-D_DARWIN_C_SOURCE" : "-D_POSIX_C_SOURCE=200809L", "-fsanitize=address,undefined", "-I", headers,
    "-I", path.resolve("src/modules/bgi/native"), ...["vm-threads.c", "vm-dialect.c", "vm-guards.c", "archive-reader.c", "state-files.c", "vm-strings.c", "vm-input.c"].map(name => path.resolve("src/modules/bgi/native", name)), driver,
    ...(process.platform === "darwin" ? ["-liconv"] : []), "-lm", "-o", binary], { encoding: "utf8", timeout: 30000 });
  assert.ifError(build.error); assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [], { cwd: root, encoding: "utf8", timeout: 10000, env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" } });
  assert.ifError(run.error); assert.equal(run.status, 0, run.stderr); assert.doesNotMatch(run.stderr, /AddressSanitizer|runtime error/);
  assert.deepEqual(fs.readFileSync(path.join(root, "system.arc")), original);
});
