const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const Overlay = require("../src/modules/bgi/native/source-overlay");
const Dialects = require("../src/modules/bgi/native/dialects");

function evidence(version = "1.643.1.0", compatibility = "1.72") {
  return { originalRunner: { fileVersion: version, strings: {
    FileDescription: "Ethornell - BURIKO General Interpreter", FileVersion: `Version : 1.643.1 - Compatibility : ${compatibility}`
  } }, boot: { codeOffset: 16, codeBytes: 256, headerWords: [16, 256, 0, 0] } };
}
test("BGI native dialect requires original engine compatibility and program-header evidence", () => {
  assert.equal(Dialects.selectVerifiedDialect(evidence()).id, "ethornell-1.72");
  assert.equal(Dialects.selectVerifiedDialect(evidence("1.720.2.0")).addressBits, 26);
  for (const input of [evidence("2.0.0.0"), evidence("0.0.0.0"), evidence("1.643.1.0", "1.71"), { boot: evidence().boot },
    { ...evidence(), boot: { ...evidence().boot, codeOffset: 8 } }, { ...evidence(), boot: { ...evidence().boot, headerWords: [16, 256, 1, 0] } }])
    assert.throws(() => Dialects.selectVerifiedDialect(input), /supported native VM dialect/);
  const other = evidence(); other.originalRunner.strings.FileDescription = "A different game engine";
  assert.throws(() => Dialects.selectVerifiedDialect(other), /supported native VM dialect/);
});

const upstream = path.resolve("src/external/openbgi");
const initialized = Overlay.INPUTS.files.every(row => fs.existsSync(path.join(upstream, row.path)));
test("native 1.72 addresses and startup services obey independently derived stack/state contracts", { skip: !initialized }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-dialect-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-dialect-state-")); t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  for (const name of ["data00001.arc", "DATA00002.ARC"]) fs.writeFileSync(path.join(root, name), "original");
  const compressed = Buffer.alloc(0x223); compressed.write("DSC FORMAT 1.00");
  compressed.writeUInt32LE(7, 16); compressed.writeUInt32LE(4, 20); compressed.writeUInt32LE(3, 24);
  let compressionKey = 7;
  for (let i = 0; i < 512; i++) {
    const low = Math.imul(compressionKey & 0xffff, 20021) >>> 0;
    const high = (Math.imul(compressionKey >>> 16, 20021) + Math.imul(compressionKey, 346) + (low >>> 16)) >>> 0;
    compressionKey = ((high << 16) + (low & 0xffff) + 1) >>> 0;
    compressed[32 + i] = ((i === 65 ? 1 : i === 66 || i === 256 ? 2 : 0) + high) & 255;
  }
  compressed[0x220] = 0x58; fs.writeFileSync(path.join(root, "packed.bin"), compressed);
  const headers = path.join(root, "headers"); fs.mkdirSync(path.join(headers, "SDL2"), { recursive: true });
  fs.writeFileSync(path.join(headers, "SDL2/SDL.h"), "typedef struct SDL_Window SDL_Window;\n");
  for (const name of ["engine.h", "thread.h"]) fs.writeFileSync(path.join(headers, name), Overlay.patch(`src/${name}`, fs.readFileSync(path.join(upstream, "src", name))));
  for (const [name, member, valid, marker = 9] of [["system", "child._bp", true], ["bad", "bad._bp", false], ["other", "child._bp", true, 12]]) {
    const program = Buffer.alloc(19); program.writeUInt32LE(valid ? 16 : 8, 0); program.writeUInt32LE(3, 4); program[16] = 0; program[17] = marker; program[18] = 0x17;
    const bytes = Buffer.alloc(16 + 128 + program.length); bytes.write("BURIKO ARC20"); bytes.writeUInt32LE(1, 12); bytes.write(member, 16); bytes.writeUInt32LE(program.length, 16 + 100); program.copy(bytes, 144);
    fs.writeFileSync(path.join(root, `${name}.arc`), bytes);
  }
  const driver = path.join(root, "contract.c"), executable = path.join(root, "contract");
  fs.writeFileSync(driver, `#include "vm-dialect.h"
#include "vm-guards.h"
#include "vm-strings.h"
#include "archive-reader.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
uint32_t Thread_PopStack(Thread_t *t) { if(!t->stackPointer) {t->error=1;return 0;}return t->stack[--t->stackPointer]; }
void Thread_PushStack(Thread_t *t,uint32_t v) { if(t->stackPointer>=t->stackSize){t->error=1;return;}t->stack[t->stackPointer++]=v; }
uint8_t Thread_ReadCode8(Thread_t *t) { return MLBGI_CodeAvailable(t,1)?t->code[t->nextInstructionPointer++]:0; }
static int service(Thread_t*t,unsigned group,unsigned id,uint32_t*a,unsigned n,uint32_t*out) { for(unsigned i=0;i<n;i++)Thread_PushStack(t,a[i]);return MLBGI_TryService(t,group,id,out); }
static int memoryContracts(void) {
 Engine_t e={0};Thread_t t={0};uint32_t stack[32]={0},result=0;t.engine=&e;e.threads=&t;t.stack=stack;t.stackSize=32;
 if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960))return 1;
 const uint32_t sizes[5]={1,4097,65537,1048577,16777217};
 const uint32_t addresses[5]={0x40000000,0x50000000,0x60000000,0x70000000,0x80000000};
 uint32_t live[5]={0};
 for(unsigned i=0;i<5;i++){
  uint32_t size=sizes[i];if(!service(&t,0x80,0x20,&size,1,&result)||result||t.error||t.stackPointer!=1)return 2;
  live[i]=Thread_PopStack(&t);if(live[i]!=addresses[i])return 3;
  uint8_t*p=MLBGI_ResolveAddress(&t,live[i]);if(!p||MLBGI_MemoryRemaining(&e,p)!=sizes[i])return 4;
  p[sizes[i]-1]=0xa5;if(MLBGI_ResolveAddress(&t,live[i]+sizes[i]-1)!=p+sizes[i]-1||MLBGI_MemoryRemaining(&e,p+sizes[i]-1)!=1)return 5;
  if(sizes[i]>1&&MLBGI_FreeMemory(&e,live[i]+1))return 6;
  if(MLBGI_ResolveAddress(&t,live[i]+sizes[i])||!t.error)return 7;t.error=0;
 }
 if(MLBGI_AllocateMemory(&e,0)||MLBGI_AllocateMemory(&e,0x04000001)||MLBGI_FreeMemory(&e,0x0c000000)||MLBGI_FreeMemory(&e,0x10000000))return 8;
 uint32_t second=MLBGI_AllocateMemory(&e,17);if(second!=0x40001000||!MLBGI_FreeMemory(&e,second)||MLBGI_FreeMemory(&e,second))return 9;
 for(unsigned i=0;i<5;i++)if(!service(&t,0x80,0x21,&live[i],1,&result)||result||Thread_PopStack(&t)||t.error)return 10;
 if(((MLBGI_Runtime*)e.mlRuntime)->allocatedBytes||!MLBGI_FreeMemory(&e,0))return 11;
 if(!service(&t,0x80,0x21,&live[2],1,&result)||result!=UINT32_MAX-3||!t.error||t.stackPointer)return 12;t.error=0;
 uint32_t released=0;if(!service(&t,0x80,0x21,&released,1,&result)||result||Thread_PopStack(&t))return 13;
 for(unsigned i=0;i<65536;i++){
  uint32_t expected=0x40000000+(i<<12);if(MLBGI_AllocateMemory(&e,1)!=expected)return 14;
 }
 if(MLBGI_AllocateMemory(&e,1)!=0x50000000||!MLBGI_FreeMemory(&e,0x44000000)||MLBGI_AllocateMemory(&e,3)!=0x44000000)return 15;
 MLBGI_FreeDialect(&e);free(e.globalMem);e.globalMem=NULL;e.globalBufferSize=0;
 if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960))return 16;
 for(unsigned i=0;i<4;i++)if(MLBGI_AllocateMemory(&e,0x04000000)!=(0x80000000+(i<<26)))return 17;
 if(MLBGI_AllocateMemory(&e,1)||((MLBGI_Runtime*)e.mlRuntime)->allocatedBytes!=256u*1024*1024)return 18;
 if(!MLBGI_FreeMemory(&e,0x88000000)||MLBGI_AllocateMemory(&e,0x04000000)!=0x88000000)return 19;
 MLBGI_FreeDialect(&e);free(e.globalMem);return 0;
}
static int persistentStringContracts(void) {
 Engine_t e={0},other={0};Thread_t t={0},ot={0};uint8_t local[64]={0};uint32_t stack[8]={0},otherStack[8]={0},result=0;
 t.engine=&e;e.threads=&t;t.localMem=local;t.localMemSize=sizeof(local);t.stack=stack;t.stackSize=8;
 if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960)||!MLBGI_ConfigureDialect(&other,"ethornell-1.72",1280,960))return 1;
 MLBGI_Runtime*s=e.mlRuntime;ot.engine=&other;other.threads=&ot;ot.localMem=local;ot.localMemSize=sizeof(local);ot.stack=otherStack;ot.stackSize=8;
 uint32_t ptr=0x08000000;strcpy((char*)local,"Record");service(&t,0x80,0x85,&ptr,1,&result);
 if(result||Thread_PopStack(&t)||s->persistentStringCount||s->nameCount!=2)return 2;
 service(&t,0x80,0x84,&ptr,1,&result);if(result||Thread_PopStack(&t)!=1||s->persistentStringCount!=1||s->persistentStringBytes!=7||strcmp(s->persistentStrings[0].text,"Record")||s->nameCount!=2)return 3;
 service(&t,0x80,0x84,&ptr,1,&result);if(result||Thread_PopStack(&t)!=1||s->persistentStringCount!=1||s->persistentStringBytes!=7)return 4;
 service(&t,0x80,0x85,&ptr,1,&result);if(result||Thread_PopStack(&t)!=1)return 5;
 service(&ot,0x80,0x85,&ptr,1,&result);if(result||Thread_PopStack(&ot)||((MLBGI_Runtime*)other.mlRuntime)->persistentStringCount)return 6;
 local[0]='r';service(&t,0x80,0x85,&ptr,1,&result);if(result||Thread_PopStack(&t)||strcmp(s->persistentStrings[0].text,"Record"))return 7;
 service(&t,0x80,0x84,&ptr,1,&result);if(result||Thread_PopStack(&t)!=1||s->persistentStringCount!=2)return 8;
 const uint8_t collisionA[]={102,80,85,55,46,57,108,99,0},collisionB[]={92,57,39,52,40,84,46,62,0};
 memcpy(local,collisionA,sizeof(collisionA));service(&t,0x80,0x84,&ptr,1,&result);if(result||Thread_PopStack(&t)!=1)return 9;
 memcpy(local,collisionB,sizeof(collisionB));service(&t,0x80,0x85,&ptr,1,&result);if(result||Thread_PopStack(&t))return 10;
 service(&t,0x80,0x84,&ptr,1,&result);if(result||Thread_PopStack(&t)!=1||s->persistentStringCount!=4||s->persistentStrings[2].hash!=1090518160||s->persistentStrings[3].hash!=1090518160)return 11;
 memcpy(local,collisionA,sizeof(collisionA));service(&t,0x80,0x85,&ptr,1,&result);if(result||Thread_PopStack(&t)!=1)return 12;
 local[0]=0x83;local[1]=0x65;local[2]=0;service(&t,0x80,0x84,&ptr,1,&result);if(result||Thread_PopStack(&t)!=1||s->persistentStringCount!=5||s->persistentStrings[4].hash!=(uint32_t)-29024)return 13;
 for(unsigned i=0;i<40;i++){snprintf((char*)local,sizeof(local),"Entry-%u",i);service(&t,0x80,0x84,&ptr,1,&result);if(result||Thread_PopStack(&t)!=1)return 14;}
 if(s->persistentStringCount!=45||s->persistentStringCapacity!=64||strcmp(s->persistentStrings[2].text,(const char*)collisionA)||strcmp(s->persistentStrings[3].text,(const char*)collisionB))return 15;
 size_t bytes=s->persistentStringBytes;unsigned count=s->persistentStringCount,capacity=s->persistentStringCapacity;MLBGI_PersistentString*entries=s->persistentStrings;
 s->persistentStringBytes=16u*1024*1024;strcpy((char*)local,"Overflow");service(&t,0x80,0x84,&ptr,1,&result);
 if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->persistentStringCount!=count||s->persistentStringCapacity!=capacity||s->persistentStrings!=entries)return 16;t.error=0;s->persistentStringBytes=bytes;
 ptr=0x08000040;service(&t,0x80,0x84,&ptr,1,&result);if(result!=UINT32_MAX-3||!t.error||s->persistentStringCount!=count||s->persistentStringBytes!=bytes)return 17;t.error=0;ptr=0x08000000;
 memset(local,'x',sizeof(local));service(&t,0x80,0x84,&ptr,1,&result);if(result!=UINT32_MAX-3||!t.error||s->persistentStringCount!=count||s->persistentStringBytes!=bytes)return 18;t.error=0;
 service(&t,0x80,0x85,&ptr,1,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->persistentStringCount!=count)return 19;t.error=0;
 local[0]=0;service(&t,0x80,0x84,&ptr,1,&result);if(result||Thread_PopStack(&t)!=1||s->persistentStringCount!=count+1||s->persistentStrings[count].hash)return 20;
 service(&t,0x80,0x85,&ptr,1,&result);if(result||Thread_PopStack(&t)!=1||t.error||t.stackPointer)return 21;
 MLBGI_FreeDialect(&e);MLBGI_FreeDialect(&other);free(e.globalMem);free(other.globalMem);return 0;
}
static int recordContracts(void) {
 Engine_t e={0};Thread_t t={0};uint8_t local[64]={0};uint32_t stack[32]={0},result=99;
 t.engine=&e;e.threads=&t;t.localMem=local;t.localMemSize=64;t.stack=stack;t.stackSize=32;
 if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960))return 1;MLBGI_Runtime*s=e.mlRuntime;
 uint32_t config[]={0x08000004,2,4};service(&t,0x80,0x98,config,3,&result);
 uint32_t id=MLBGI_ReadInteger(&t,local+4,2);if(result||Thread_PopStack(&t)||id!=1||s->recordBytes)return 2;
 uint32_t add[]={id,0x08000010};
 for(unsigned value=7;value<=11;value+=2){MLBGI_WriteInteger(&t,local+16,2,value);service(&t,0x80,0x9c,add,2,&result);if(result||Thread_PopStack(&t)||t.error)return 3;}
 MLBGI_WriteInteger(&t,local+16,2,0xabcdef01);if(s->recordBytes!=8||s->recordLists[0].count!=2)return 4;
 uint32_t get[]={0x08000018,id,0};service(&t,0x80,0x9d,get,3,&result);if(result||Thread_PopStack(&t)||MLBGI_ReadInteger(&t,local+24,2)!=11)return 5;
 get[2]=1;service(&t,0x80,0x9d,get,3,&result);if(result||Thread_PopStack(&t)||MLBGI_ReadInteger(&t,local+24,2)!=9)return 6;
 get[2]=2;service(&t,0x80,0x9d,get,3,&result);if(result||Thread_PopStack(&t)!=2||MLBGI_ReadInteger(&t,local+24,2)!=9)return 7;
 uint32_t count[]={0x0800001c,id};service(&t,0x80,0x9a,count,2,&result);if(result||Thread_PopStack(&t)||MLBGI_ReadInteger(&t,local+28,2)!=2)return 8;
 add[1]=0x0800003e;service(&t,0x80,0x9c,add,2,&result);if(result!=UINT32_MAX-3||!t.error||s->recordBytes!=8||s->recordLists[0].count!=2)return 9;t.error=0;
 uint32_t erase[]={id,0,1};service(&t,0x80,0x9e,erase,3,&result);if(result||Thread_PopStack(&t)||s->recordBytes!=4)return 10;
 get[2]=0;service(&t,0x80,0x9d,get,3,&result);if(result||Thread_PopStack(&t)||MLBGI_ReadInteger(&t,local+24,2)!=9)return 11;
 erase[1]=1;service(&t,0x80,0x9e,erase,3,&result);if(result||Thread_PopStack(&t)!=2||s->recordBytes!=4)return 12;
 erase[1]=0;erase[2]=0;service(&t,0x80,0x9e,erase,3,&result);if(result||Thread_PopStack(&t)||s->recordBytes!=4)return 13;
 erase[2]=100;service(&t,0x80,0x9e,erase,3,&result);if(result||Thread_PopStack(&t)||s->recordBytes)return 14;
 service(&t,0x80,0x99,&id,1,&result);if(result||Thread_PopStack(&t)||s->recordLists[0].id)return 15;
 service(&t,0x80,0x99,&id,1,&result);if(result||Thread_PopStack(&t)!=1)return 16;
 service(&t,0x80,0x9d,get,3,&result);if(result||Thread_PopStack(&t)!=1||MLBGI_ReadInteger(&t,local+24,2)!=9)return 17;
 config[1]=0;service(&t,0x80,0x98,config,3,&result);if(result||Thread_PopStack(&t)!=2||MLBGI_ReadInteger(&t,local+4,2)!=1||s->lastRecordListId!=1)return 18;
 config[1]=2;config[2]=0;service(&t,0x80,0x98,config,3,&result);if(result||Thread_PopStack(&t)!=2||s->lastRecordListId!=1)return 19;
 config[1]=65537;config[2]=4;service(&t,0x80,0x98,config,3,&result);if(result!=UINT32_MAX-3||!t.error||s->lastRecordListId!=1||t.stackPointer)return 20;t.error=0;
 config[1]=2;service(&t,0x80,0x98,config,3,&result);if(result||Thread_PopStack(&t)||MLBGI_ReadInteger(&t,local+4,2)!=2)return 21;
 for(unsigned i=0;i<63;i++){service(&t,0x80,0x98,config,3,&result);if(result||Thread_PopStack(&t)||t.error)return 22;}
 service(&t,0x80,0x98,config,3,&result);if(result!=UINT32_MAX-3||!t.error||s->lastRecordListId!=65||t.stackPointer)return 23;t.error=0;
 add[0]=2;add[1]=0x08000010;service(&t,0x80,0x9c,add,2,&result);if(result||Thread_PopStack(&t)||s->recordBytes!=4)return 24;
 MLBGI_FreeDialect(&e);free(e.globalMem);return 0;
}
static int keyedRecordContracts(void) {
 Engine_t e={0},other={0};Thread_t t={0};uint8_t local[256]={0};uint32_t stack[32]={0},result=99;
 t.engine=&e;e.threads=&t;t.localMem=local;t.localMemSize=sizeof(local);t.stack=stack;t.stackSize=32;
 if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960)||!MLBGI_ConfigureDialect(&other,"ethornell-1.72",1280,960))return 1;
 MLBGI_Runtime*s=e.mlRuntime,*independent=other.mlRuntime;
 uint32_t config[]={0x08000004,1};MLBGI_WriteInteger(&t,local+4,2,0xabcdef01);
 service(&t,0x80,0xd0,config,2,&result);if(result||t.error||Thread_PopStack(&t)!=0x80000001||MLBGI_ReadInteger(&t,local+4,2)!=0xabcdef01||s->lastKeyedContainerId)return 2;
 config[1]=32;service(&t,0x80,0xd0,config,2,&result);uint32_t id=MLBGI_ReadInteger(&t,local+4,2);
 if(result||t.error||Thread_PopStack(&t)||id!=1||s->keyedBytes||s->keyedContainers[0].bytes!=32||independent->lastKeyedContainerId)return 3;
 service(&t,0x80,0xd0,config,2,&result);uint32_t second=MLBGI_ReadInteger(&t,local+4,2);if(result||t.error||Thread_PopStack(&t)||second!=2)return 4;
 memcpy(local+96,"Unit",5);memcpy(local+112,"unit",5);memcpy(local+128,"missing",8);
 uint8_t first[32],replacement[32];for(unsigned i=0;i<32;i++){first[i]=(uint8_t)(i*17);replacement[i]=(uint8_t)(255-i*7);local[32+i]=first[i];}
 uint32_t put[]={id,0x08000060,0x08000020};service(&t,0x80,0xd2,put,3,&result);size_t firstBytes=s->keyedBytes;
 if(result||t.error||Thread_PopStack(&t)||s->keyedContainers[0].count!=1||firstBytes<=32)return 5;
 memset(local+32,0x5a,32);uint32_t get[]={0x080000a0,id,0x08000060,UINT32_MAX};service(&t,0x80,0xd4,get,4,&result);
 if(result||t.error||Thread_PopStack(&t)||memcmp(local+160,first,32))return 6;
 put[1]=0x08000070;memcpy(local+32,replacement,32);service(&t,0x80,0xd2,put,3,&result);if(result||t.error||Thread_PopStack(&t)||s->keyedContainers[0].count!=2)return 7;
 put[1]=0x08000060;service(&t,0x80,0xd2,put,3,&result);size_t twoBytes=s->keyedBytes;
 if(result||t.error||Thread_PopStack(&t)||s->keyedContainers[0].count!=2||twoBytes!=firstBytes*2)return 8;
 get[2]=0;get[3]=0;service(&t,0x80,0xd4,get,4,&result);if(result||t.error||Thread_PopStack(&t)||memcmp(local+160,replacement,32))return 9;
 get[3]=1;service(&t,0x80,0xd4,get,4,&result);if(result||t.error||Thread_PopStack(&t)||memcmp(local+160,replacement,32))return 10;
 get[3]=2;local[160]=0x87;service(&t,0x80,0xd4,get,4,&result);if(result||t.error||Thread_PopStack(&t)!=0x80000003||local[160]!=0x87)return 11;
 get[2]=0x08000080;get[3]=0;service(&t,0x80,0xd4,get,4,&result);if(result||t.error||Thread_PopStack(&t)!=0x80000003||local[160]!=0x87)return 12;
 get[1]=99;service(&t,0x80,0xd4,get,4,&result);if(result||t.error||Thread_PopStack(&t)!=0x80000002||local[160]!=0x87)return 13;
 get[1]=id;get[2]=0x08000060;get[0]=0x080000f0;service(&t,0x80,0xd4,get,4,&result);
 if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->keyedBytes!=twoBytes||local[240])return 14;t.error=0;get[0]=0x080000a0;
 put[2]=0x080000f0;service(&t,0x80,0xd2,put,3,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->keyedBytes!=twoBytes)return 15;t.error=0;put[2]=0x08000020;
 local[255]='x';put[1]=0x080000ff;service(&t,0x80,0xd2,put,3,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->keyedBytes!=twoBytes)return 16;t.error=0;
 put[1]=0;service(&t,0x80,0xd2,put,3,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->keyedBytes!=twoBytes)return 17;t.error=0;
 put[0]=99;put[1]=0x08000060;service(&t,0x80,0xd2,put,3,&result);if(result||t.error||Thread_PopStack(&t)!=0x80000002||s->keyedBytes!=twoBytes)return 18;
 put[0]=id;put[1]=0x08000090;local[144]=0;service(&t,0x80,0xd2,put,3,&result);if(result||t.error||Thread_PopStack(&t)||s->keyedContainers[0].count!=3)return 19;
 get[2]=0x08000090;service(&t,0x80,0xd4,get,4,&result);if(result||t.error||Thread_PopStack(&t)||memcmp(local+160,replacement,32))return 20;
 uint32_t erase[]={id,0x08000060};service(&t,0x80,0xd3,erase,2,&result);if(result||t.error||Thread_PopStack(&t)||s->keyedContainers[0].count!=2)return 21;
 service(&t,0x80,0xd3,erase,2,&result);if(result||t.error||Thread_PopStack(&t)!=0x80000003||s->keyedContainers[0].count!=2)return 22;
 put[1]=0x08000070;memcpy(local+32,first,32);service(&t,0x80,0xd2,put,3,&result);if(result||t.error||Thread_PopStack(&t))return 23;
 get[2]=0;get[3]=0;service(&t,0x80,0xd4,get,4,&result);if(result||t.error||Thread_PopStack(&t)||memcmp(local+160,first,32))return 24;
 service(&t,0x80,0xd1,&id,1,&result);if(result||t.error||Thread_PopStack(&t)||s->keyedBytes||s->keyedContainers[0].id)return 25;
 service(&t,0x80,0xd1,&id,1,&result);if(result||t.error||Thread_PopStack(&t)!=0x80000002)return 26;
 service(&t,0x80,0xd0,config,2,&result);if(result||t.error||Thread_PopStack(&t)||MLBGI_ReadInteger(&t,local+4,2)!=3)return 27;
 config[0]=0x080000fe;service(&t,0x80,0xd0,config,2,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->lastKeyedContainerId!=3)return 28;t.error=0;
 config[0]=0x08000004;config[1]=32u*1024*1024+1;service(&t,0x80,0xd0,config,2,&result);
 if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->lastKeyedContainerId!=3)return 29;t.error=0;
 MLBGI_FreeDialect(&e);MLBGI_FreeDialect(&other);free(e.globalMem);free(other.globalMem);return 0;
}
static int flagContracts(void) {
 Engine_t e={0},other={0};Thread_t t={0};uint8_t code[64]={0},local[32]={0};uint32_t stack[32]={0},result=99;
 t.engine=&e;e.threads=&t;t.code=code;t.codeSpaceUsed=sizeof(code);t.localMem=local;t.localMemSize=sizeof(local);t.stack=stack;t.stackSize=32;
 if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960)||!MLBGI_ConfigureDialect(&other,"ethornell-1.72",1280,960))return 1;
 MLBGI_Runtime*s=e.mlRuntime,*independent=other.mlRuntime;memcpy(code+16,"Script",7);memcpy(code+32,"script",7);
 uint32_t config[]={0x04000010,9};service(&t,0x80,0x88,config,2,&result);
 if(result||t.error||Thread_PopStack(&t)!=1||s->flagGroups[0].count!=9||s->flagGroups[0].bits[0]||s->flagGroups[0].bits[1]||independent->flagBytes)return 2;
 uint32_t get[]={0x08000004,0x04000010,8};service(&t,0x80,0x8b,get,3,&result);if(result||t.error||Thread_PopStack(&t)||MLBGI_ReadInteger(&t,local+4,2))return 3;
 uint32_t set[]={0x04000010,7,UINT32_MAX};service(&t,0x80,0x89,set,3,&result);
 if(result||t.error||Thread_PopStack(&t)||s->flagGroups[0].bits[0]!=1||s->flagGroups[0].bits[1])return 4;
 set[1]=8;service(&t,0x80,0x89,set,3,&result);if(result||t.error||Thread_PopStack(&t)||s->flagGroups[0].bits[0]!=1||s->flagGroups[0].bits[1]!=0x80)return 5;
 service(&t,0x80,0x8b,get,3,&result);if(result||t.error||Thread_PopStack(&t)||MLBGI_ReadInteger(&t,local+4,2)!=1)return 6;
 set[1]=7;set[2]=0;service(&t,0x80,0x89,set,3,&result);if(result||t.error||Thread_PopStack(&t)||s->flagGroups[0].bits[0]||s->flagGroups[0].bits[1]!=0x80)return 7;
 uint32_t range[]={0x04000010,1,5,7};service(&t,0x80,0x8a,range,4,&result);
 if(result||t.error||Thread_PopStack(&t)||s->flagGroups[0].bits[0]!=0x7f||s->flagGroups[0].bits[1]!=0x80)return 8;
 config[1]=16;service(&t,0x80,0x88,config,2,&result);if(result||t.error||Thread_PopStack(&t)!=1||s->flagGroups[0].bits[0]!=0x7f||s->flagGroups[0].bits[1]!=0x80)return 9;
 config[1]=1;service(&t,0x80,0x88,config,2,&result);if(result||t.error||Thread_PopStack(&t)!=1||s->flagGroups[0].bits[0]!=0x7f||s->flagGroups[0].count!=1)return 10;
 config[1]=9;service(&t,0x80,0x88,config,2,&result);if(result||t.error||Thread_PopStack(&t)!=1||s->flagGroups[0].bits[0]!=0x7f||s->flagGroups[0].bits[1])return 11;
 get[2]=7;service(&t,0x80,0x8b,get,3,&result);if(result||t.error||Thread_PopStack(&t)||MLBGI_ReadInteger(&t,local+4,2)!=1)return 12;
 get[2]=8;service(&t,0x80,0x8b,get,3,&result);if(result||t.error||Thread_PopStack(&t)||MLBGI_ReadInteger(&t,local+4,2))return 13;
 get[1]=0x04000020;MLBGI_WriteInteger(&t,local+4,2,0xabcdef01);service(&t,0x80,0x8b,get,3,&result);
 if(result||t.error||Thread_PopStack(&t)!=1||MLBGI_ReadInteger(&t,local+4,2)!=0xabcdef01)return 14;
 get[1]=0x04000010;get[2]=9;service(&t,0x80,0x8b,get,3,&result);if(result||t.error||Thread_PopStack(&t)!=2||MLBGI_ReadInteger(&t,local+4,2)!=0xabcdef01)return 15;
 set[1]=9;set[2]=1;service(&t,0x80,0x89,set,3,&result);if(result||t.error||Thread_PopStack(&t)!=2||s->flagGroups[0].bits[0]!=0x7f)return 16;
 range[3]=0;service(&t,0x80,0x8a,range,4,&result);if(result||t.error||Thread_PopStack(&t)!=3||s->flagGroups[0].bits[0]!=0x7f)return 17;
 range[3]=9;service(&t,0x80,0x8a,range,4,&result);if(result||t.error||Thread_PopStack(&t)!=3||s->flagGroups[0].bits[0]!=0x7f)return 18;
 range[3]=65537;service(&t,0x80,0x8a,range,4,&result);if(result||t.error||Thread_PopStack(&t)!=3||s->flagGroups[0].bits[0]!=0x7f)return 19;
 config[1]=0;service(&t,0x80,0x88,config,2,&result);if(result||t.error||Thread_PopStack(&t)||s->flagGroups[0].count!=9)return 20;
 config[1]=UINT32_MAX;service(&t,0x80,0x88,config,2,&result);if(result||t.error||Thread_PopStack(&t)||s->flagGroups[0].count!=9)return 21;
 config[1]=64u*1024*1024+1;service(&t,0x80,0x88,config,2,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->flagGroups[0].count!=9)return 22;t.error=0;
 get[0]=0x0800001e;get[2]=0;service(&t,0x80,0x8b,get,3,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||local[30])return 23;t.error=0;
 range[1]=0;range[2]=0;range[3]=9;service(&t,0x80,0x8a,range,4,&result);if(result||t.error||Thread_PopStack(&t)||s->flagGroups[0].bits[0]||s->flagGroups[0].bits[1])return 24;
 MLBGI_FreeDialect(&e);MLBGI_FreeDialect(&other);free(e.globalMem);free(other.globalMem);return 0;
}
static int textRuleContracts(void) {
 Engine_t e={0},other={0};Thread_t t={0};uint8_t local[1024]={0};uint32_t stack[32]={0},result=99;
 t.engine=&e;e.threads=&t;t.localMem=local;t.localMemSize=sizeof(local);t.stack=stack;t.stackSize=32;
 if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960)||!MLBGI_ConfigureDialect(&other,"ethornell-1.72",1280,960))return 1;
 MLBGI_Runtime*s=e.mlRuntime,*independent=other.mlRuntime;
 uint32_t argument=0;service(&t,0x91,0x96,&argument,1,&result);if(result||t.error||Thread_PopStack(&t)||s->textRuleCount)return 2;
 argument=0x08000010;service(&t,0x91,0x96,&argument,1,&result);if(result||t.error||Thread_PopStack(&t)!=1||s->textRuleCount)return 3;
 const char pairs[]={'A',92,'x',10,'A','B',92,'y',10,'B','C',92,'z',0};memcpy(local+16,pairs,sizeof(pairs));
 service(&t,0x91,0x96,&argument,1,&result);
 if(result||t.error||Thread_PopStack(&t)!=1||s->textRuleCount!=3||strcmp(s->textRules[0].source,"BC")||strcmp(s->textRules[1].source,"AB")||strcmp(s->textRules[2].source,"A")||independent->textRuleCount)return 4;
 const char replace[]={'A','B',92,'n','e','w',0};memcpy(local+16,replace,sizeof(replace));service(&t,0x91,0x96,&argument,1,&result);
 if(result||t.error||Thread_PopStack(&t)!=1||s->textRuleCount!=3||strcmp(s->textRules[1].replacement,"new")||strcmp(s->textRules[0].source,"BC"))return 5;
 if(!MLBGI_TextRulesAffect(&e,"AB")||!MLBGI_TextRulesAffect(&e,"prefixBC")||MLBGI_TextRulesAffect(&e,"plain")||MLBGI_TextRulesAffect(&other,"AB"))return 6;
 const uint8_t trail[]={0x81,0x5c,92,0x82,0xa0,10,0};memcpy(local+16,trail,sizeof(trail));service(&t,0x91,0x96,&argument,1,&result);
 if(result||t.error||Thread_PopStack(&t)!=1||s->textRuleCount!=4||memcmp(s->textRules[0].source,trail,2)||s->textRules[0].source[2]||memcmp(s->textRules[0].replacement,trail+3,2))return 7;
 const uint8_t raw[]={0x81,0x5c,0};if(!MLBGI_TextRulesAffect(&e,(const char*)raw))return 8;
 MLBGI_TextRule saved[64];memcpy(saved,s->textRules,sizeof(saved));
 memcpy(local+16,"missing separator",18);service(&t,0x91,0x96,&argument,1,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->textRuleCount!=4||memcmp(saved,s->textRules,sizeof(saved)))return 9;t.error=0;
 const char empty[]={'x',92,0};memcpy(local+16,empty,sizeof(empty));service(&t,0x91,0x96,&argument,1,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||memcmp(saved,s->textRules,sizeof(saved)))return 10;t.error=0;
 local[16]=(char)0x82;local[17]=92;local[18]=0;service(&t,0x91,0x96,&argument,1,&result);
 if(result!=UINT32_MAX-3||!t.error||t.stackPointer||memcmp(saved,s->textRules,sizeof(saved)))return 11;t.error=0;
 for(unsigned i=0;i<60;i++){char pair[32];snprintf(pair,sizeof(pair),"key%u%cvalue",i,92);if(MLBGI_RegisterTextRules(&e,pair)!=1)return 12;}
 char overflow[32];snprintf(overflow,sizeof(overflow),"overflow%cvalue",92);
 if(s->textRuleCount!=64||MLBGI_RegisterTextRules(&e,overflow)!=-1||s->textRuleCount!=64)return 13;
 MLBGI_FreeDialect(&e);MLBGI_FreeDialect(&other);free(e.globalMem);free(other.globalMem);return 0;
}
static int skipControlContracts(void) {
 Engine_t e={0};Thread_t t={0};uint32_t stack[32]={0},result=99;t.engine=&e;t.stack=stack;t.stackSize=32;
 if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960))return 1;MLBGI_Runtime*s=e.mlRuntime;
 if(s->skipKeysEnabled!=1||s->skipOutputEnabled!=1||s->skipOverride||s->skipLatch)return 2;
 service(&t,0x80,0x17,NULL,0,&result);if(result||t.error||Thread_PopStack(&t))return 3;
 MLBGI_UpdateCursor(&e,1,0,0,32,32,1);MLBGI_InputEvent(&s->input,17,1,0,2);service(&t,0x80,0x17,NULL,0,&result);
 if(result||t.error||Thread_PopStack(&t)!=1)return 4;
 uint32_t setting=0;service(&t,0x80,0x14,&setting,1,&result);service(&t,0x80,0x17,NULL,0,&result);if(result||t.error||Thread_PopStack(&t))return 5;
 setting=UINT32_MAX;service(&t,0x80,0x15,&setting,1,&result);service(&t,0x80,0x17,NULL,0,&result);if(result||t.error||Thread_PopStack(&t))return 6;
 service(&t,0x80,0x14,&setting,1,&result);MLBGI_UpdateCursor(&e,0,0,0,32,32,3);service(&t,0x80,0x17,NULL,0,&result);if(result||t.error||Thread_PopStack(&t)!=1)return 7;
 setting=0;service(&t,0x80,0x15,&setting,1,&result);service(&t,0x80,0x17,NULL,0,&result);if(result||t.error||Thread_PopStack(&t))return 8;
 MLBGI_UpdateCursor(&e,1,0,0,32,32,4);service(&t,0x80,0x13,&setting,1,&result);service(&t,0x80,0x17,NULL,0,&result);if(result||t.error||Thread_PopStack(&t))return 9;
 setting=1;service(&t,0x80,0x13,&setting,1,&result);service(&t,0x80,0x16,NULL,0,&result);service(&t,0x80,0x17,NULL,0,&result);
 if(result||t.error||Thread_PopStack(&t)||!s->skipLatch)return 10;
 MLBGI_InputEvent(&s->input,17,1,1,5);service(&t,0x80,0x17,NULL,0,&result);if(result||t.error||Thread_PopStack(&t)||!s->skipLatch)return 11;
 MLBGI_InputEvent(&s->input,17,0,0,6);service(&t,0x80,0x17,NULL,0,&result);if(result||t.error||Thread_PopStack(&t)||s->skipLatch)return 12;
 MLBGI_InputEvent(&s->input,17,1,0,7);service(&t,0x80,0x17,NULL,0,&result);if(result||t.error||Thread_PopStack(&t)!=1)return 13;
 uint32_t keys[]={17,65};if(!MLBGI_SetInputMap(&s->input,0x80000000,keys,2))return 14;
 service(&t,0x80,0x16,NULL,0,&result);MLBGI_InputEvent(&s->input,65,1,0,8);service(&t,0x80,0x17,NULL,0,&result);
 if(result||t.error||Thread_PopStack(&t)!=1||!s->skipLatch)return 15;
 MLBGI_InputEvent(&s->input,17,0,0,9);MLBGI_InputEvent(&s->input,65,0,0,9);service(&t,0x80,0x17,NULL,0,&result);if(result||t.error||Thread_PopStack(&t)||s->skipLatch)return 16;
 MLBGI_FreeDialect(&e);free(e.globalMem);return 0;
}
static int inputRouteContracts(void) {
 Engine_t e={0},other={0};Thread_t t={0};uint32_t stack[32]={0},result=99;t.engine=&e;t.stack=stack;t.stackSize=32;
 if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960)||!MLBGI_ConfigureDialect(&other,"ethornell-1.72",1280,960))return 1;
 MLBGI_Runtime*s=e.mlRuntime,*independent=other.mlRuntime;
 if(s->keyboardRouteCount!=1||s->mouseRouteCount!=1||s->keyboardRoutes[0]!=1||s->mouseRoutes[0].priority!=1||s->mouseRoutes[0].bounds[0]!=INT32_MIN||s->mouseRoutes[0].bounds[3]!=INT32_MAX)return 2;
 MLBGI_UpdateCursor(&e,1,4,5,32,32,1);if(s->cursorX!=4||s->cursorY!=5)return 3;
 service(&t,0x80,0x08,NULL,0,&result);if(result||t.error||Thread_PopStack(&t)!=5||Thread_PopStack(&t)!=4||t.stackPointer)return 33;
 MLBGI_UpdateCursor(&e,1,-8,0,32,32,1);service(&t,0x80,0x08,NULL,0,&result);
 if(result||Thread_PopStack(&t)||Thread_PopStack(&t)!=(uint32_t)-8)return 34;
 MLBGI_UpdateCursor(&e,1,4,5,32,32,1);
 uint32_t key=65;MLBGI_InputEvent(&s->input,key,1,0,1);uint32_t keyEvents=s->input.events[key],keyPresses=s->input.presses[key];
 service(&t,0x80,0x11,&key,1,&result);service(&t,0x80,0x11,&key,1,&result);
 if(result||t.error||Thread_PopStack(&t)!=1||Thread_PopStack(&t)!=1||s->input.events[key]!=keyEvents||s->input.presses[key]!=keyPresses)return 35;
 MLBGI_UpdateCursor(&e,0,4,5,32,32,1);service(&t,0x80,0x11,&key,1,&result);if(result||Thread_PopStack(&t))return 36;
 MLBGI_UpdateCursor(&e,1,4,5,32,32,1);MLBGI_InputEvent(&s->input,key,0,0,1);service(&t,0x80,0x11,&key,1,&result);if(result||Thread_PopStack(&t))return 37;
 key=7;service(&t,0x80,0x11,&key,1,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer)return 38;t.error=0;
 MLBGI_ClearInput(&s->input);
 MLBGI_InputEvent(&s->input,13,1,0,2);MLBGI_InputEvent(&s->input,1,1,0,2);
 uint32_t priority=2;service(&t,0x80,0x18,&priority,1,&result);
 if(result||t.error||t.stackPointer||s->keyboardRouteCount!=2||s->mouseRouteCount!=2||s->keyboardRoutes[0]!=0x2ffff||s->mouseRoutes[0].priority!=0x2ffff||s->input.presses[13]||s->input.presses[1]||!s->input.reportedHeld[13]||!s->input.reportedHeld[1]||independent->keyboardRouteCount!=1)return 4;
 MLBGI_InputEvent(&s->input,13,0,0,3);MLBGI_InputEvent(&s->input,1,0,0,3);MLBGI_InputEvent(&s->input,13,1,0,4);MLBGI_InputEvent(&s->input,1,1,0,4);
 priority=1;service(&t,0x80,0x1a,&priority,1,&result);if(result||t.error||Thread_PopStack(&t)||s->input.presses[13]!=1||s->input.presses[1]!=1)return 5;
 priority=3;service(&t,0x80,0x1a,&priority,1,&result);if(result||Thread_PopStack(&t)!=256||s->input.presses[13]||s->input.presses[1]!=1)return 6;
 priority=2;service(&t,0x80,0x1a,&priority,1,&result);if(result||Thread_PopStack(&t)!=1||s->input.presses[1])return 7;
 service(&t,0x80,0x1a,&priority,1,&result);if(result||Thread_PopStack(&t)||t.stackPointer)return 8;
 service(&t,0x80,0x19,&priority,1,&result);if(result||t.error||t.stackPointer||s->keyboardRouteCount!=1||s->mouseRouteCount!=1)return 9;
 for(unsigned i=0;i<3;i++){priority=i==2?3:5;service(&t,0x80,0x18,&priority,1,&result);if(result||t.error)return 10;}
 if(s->keyboardRouteCount!=4||s->keyboardRoutes[0]!=0x5ffff||s->keyboardRoutes[1]!=0x5ffff||s->keyboardRoutes[2]!=0x3ffff||s->keyboardRoutes[3]!=1)return 11;
 priority=5;service(&t,0x80,0x19,&priority,1,&result);if(result||s->keyboardRouteCount!=3||s->mouseRouteCount!=3||s->keyboardRoutes[0]!=0x5ffff)return 12;
 service(&t,0x80,0x19,&priority,1,&result);if(result||s->keyboardRouteCount!=2||s->keyboardRoutes[0]!=0x3ffff)return 13;
 priority=99;service(&t,0x80,0x19,&priority,1,&result);if(result||s->keyboardRouteCount!=2||s->mouseRouteCount!=2)return 14;
 uint32_t mapped[]={32,13};if(!MLBGI_SetInputMap(&s->input,256,mapped,2))return 15;
 MLBGI_ClearInput(&s->input);MLBGI_InputEvent(&s->input,32,1,0,5);MLBGI_InputEvent(&s->input,13,1,0,5);
 priority=3;service(&t,0x80,0x1a,&priority,1,&result);if(result||Thread_PopStack(&t)!=256||s->input.presses[32]||s->input.presses[13]!=1)return 16;
 service(&t,0x80,0x1a,&priority,1,&result);if(result||Thread_PopStack(&t)!=256||s->input.presses[13])return 17;
 MLBGI_InputEvent(&s->input,65,1,0,6);uint32_t raw[]={2,65};service(&t,0x80,0x1d,raw,2,&result);if(result||Thread_PopStack(&t)||s->input.presses[65]!=1)return 18;
 raw[0]=4;service(&t,0x80,0x1d,raw,2,&result);if(result||Thread_PopStack(&t)!=0x80000001||s->input.presses[65])return 19;
 MLBGI_InputEvent(&s->input,2,1,0,7);raw[1]=2;service(&t,0x80,0x1d,raw,2,&result);if(result||Thread_PopStack(&t)||s->input.presses[2]!=1)return 20;
 raw[0]=3;service(&t,0x80,0x1d,raw,2,&result);if(result||Thread_PopStack(&t)!=0x80000001)return 21;
 MLBGI_InputEvent(&s->input,4,1,0,8);raw[0]=4;raw[1]=4;service(&t,0x80,0x1d,raw,2,&result);if(result||Thread_PopStack(&t)!=0x80000001)return 22;
 MLBGI_ReleaseInput(&s->input);MLBGI_InputEvent(&s->input,13,1,0,9);uint32_t events=s->input.events[13],setting=0;
 service(&t,0x80,0x13,&setting,1,&result);if(result||s->input.presses[13]||s->input.events[13]!=events||!s->input.held[13]||s->input.reportedHeld[13])return 23;
 service(&t,0x80,0x1a,&priority,1,&result);if(result||Thread_PopStack(&t))return 24;
 setting=1;service(&t,0x80,0x13,&setting,1,&result);service(&t,0x80,0x1a,&priority,1,&result);if(result||Thread_PopStack(&t)!=256)return 25;
 raw[1]=256;service(&t,0x80,0x1d,raw,2,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer)return 26;t.error=0;
 priority=65538;service(&t,0x80,0x18,&priority,1,&result);if(result||s->keyboardRouteCount!=3||s->keyboardRoutes[1]!=0x2ffff)return 27;
 priority=2;service(&t,0x80,0x19,&priority,1,&result);if(result||s->keyboardRouteCount!=2)return 28;
 priority=3;service(&t,0x80,0x19,&priority,1,&result);if(result||s->keyboardRouteCount!=1||s->mouseRouteCount!=1)return 29;
 for(unsigned i=1;i<256;i++){priority=i;service(&t,0x80,0x18,&priority,1,&result);if(result||t.error||t.stackPointer)return 30;}
 if(s->keyboardRouteCount!=256||s->mouseRouteCount!=256||s->keyboardRoutes[0]!=0xffffff||s->keyboardRoutes[255]!=1)return 31;
 priority=1000;service(&t,0x80,0x18,&priority,1,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->keyboardRouteCount!=256||s->mouseRouteCount!=256||s->keyboardRoutes[0]!=0xffffff)return 32;
 MLBGI_FreeDialect(&e);MLBGI_FreeDialect(&other);free(e.globalMem);free(other.globalMem);return 0;
}
static int controllerContracts(void) {
 Engine_t e={0},other={0};Thread_t t={0};uint32_t stack[32]={0},result=99;t.engine=&e;t.stack=stack;t.stackSize=32;
 if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960)||!MLBGI_ConfigureDialect(&other,"ethornell-1.72",1280,960))return 1;
 MLBGI_Runtime*s=e.mlRuntime,*independent=other.mlRuntime;uint32_t target=0xb0000000;
 service(&t,0x91,0xb8,&target,1,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->controllerCount||s->lastControllerId)return 2;t.error=0;
 uint32_t dimensions[]={64,32};service(&t,0x90,0x80,dimensions,2,&result);if(result||t.error||Thread_PopStack(&t)!=target)return 3;
 service(&t,0x90,0xb8,&target,1,&result);uint32_t first=Thread_PopStack(&t);
 if(result||t.error||first!=1||s->controllerCount!=1||s->controllers[0].target!=target||s->controllers[0].kind||s->controllers[0].enabled!=1||independent->controllerCount)return 4;
 service(&t,0x91,0xb8,&target,1,&result);uint32_t second=Thread_PopStack(&t);if(result||t.error||second!=2||s->controllerCount!=2||s->controllers[1].kind!=1)return 5;
 service(&t,0x90,0x81,&target,1,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->windowCount!=1||!s->windows[0].pixels||s->controllerCount!=2)return 6;t.error=0;
 service(&t,0x90,0xb9,&first,1,&result);if(result||t.error||Thread_PopStack(&t)!=1||s->controllerCount!=1||s->controllers[0].id)return 7;
 service(&t,0x90,0xb9,&first,1,&result);if(result||Thread_PopStack(&t)||s->controllerCount!=1)return 8;
 service(&t,0x91,0xb8,&target,1,&result);if(result||Thread_PopStack(&t)!=3||s->controllers[0].id!=3||s->controllerCount!=2)return 9;
 uint32_t third=3;service(&t,0x90,0xb9,&third,1,&result);if(result||Thread_PopStack(&t)!=1)return 10;
 service(&t,0x90,0xb9,&second,1,&result);if(result||Thread_PopStack(&t)!=1||s->controllerCount)return 11;
 for(unsigned i=0;i<64;i++){service(&t,0x91,0xb8,&target,1,&result);if(result||t.error||Thread_PopStack(&t)!=4+i)return 12;}
 service(&t,0x90,0xb8,&target,1,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->controllerCount!=64||s->lastControllerId!=67)return 13;t.error=0;
 for(unsigned i=0;i<64;i++){uint32_t id=4+i;service(&t,0x90,0xb9,&id,1,&result);if(result||t.error||Thread_PopStack(&t)!=1)return 14;}
 s->lastControllerId=UINT32_MAX;service(&t,0x91,0xb8,&target,1,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->controllerCount)return 15;t.error=0;
 service(&t,0x90,0x81,&target,1,&result);if(result||t.error||s->windowCount||s->imageCacheBytes)return 16;
 MLBGI_FreeDialect(&e);MLBGI_FreeDialect(&other);free(e.globalMem);free(other.globalMem);return 0;
}
static unsigned menuCopyRequests;
static uint8_t menuRed=255;
static int copyMenuFixture(Engine_t*e,uint32_t slot,MLBGI_MenuImage*out) {
 (void)e;menuCopyRequests++;if(slot==4)return 0;if(!slot||slot>4)return -1;
 uint8_t*p=malloc(16);if(!p)return -1;
 for(unsigned i=0;i<4;i++){p[i*4]=slot==1?menuRed:0;p[i*4+1]=slot==2?255:0;p[i*4+2]=slot==3?255:0;p[i*4+3]=slot==2?128:255;}
 *out=(MLBGI_MenuImage){2,2,slot==2?2:1,p};return 1;
}
static int imageMenuContracts(void) {
 Engine_t e={0};Thread_t t={0};uint8_t local[1024]={0},pixels[64],saved[64];uint32_t stack[32]={0},result=99;
 t.engine=&e;e.threads=&t;t.localMem=local;t.localMemSize=sizeof(local);t.stack=stack;t.stackSize=32;
 if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960))return 1;MLBGI_Runtime*s=e.mlRuntime;s->copyMenuImage=copyMenuFixture;
 uint32_t dimensions[]={64,32};service(&t,0x90,0x80,dimensions,2,&result);uint32_t target=Thread_PopStack(&t);if(result||target!=0xb0000000)return 2;
 uint32_t visible[]={target,1};service(&t,0x90,0x84,visible,2,&result);service(&t,0x91,0xb8,&target,1,&result);uint32_t id=Thread_PopStack(&t);if(result||id!=1)return 3;
 uint32_t header[10]={1,0x08000080,UINT32_MAX,0,0,2,0,1,0,0};
 uint32_t group[16]={2,0,0x08000100,UINT32_MAX,0,0,0,0,UINT32_MAX,0,0,UINT32_MAX,0,0,UINT32_MAX,0};
 uint32_t item[49]={0};item[0]=item[1]=item[6]=1;item[2]=item[3]=1;item[8]=1;item[9]=2;item[10]=3;item[11]=item[44]=item[47]=UINT32_MAX;item[12]=1;
 memcpy(local+16,header,sizeof(header));memcpy(local+128,group,sizeof(group));memcpy(local+256,item,sizeof(item));item[2]=UINT32_MAX;memcpy(local+452,item,sizeof(item));
 uint32_t configure[]={id,0x08000010};service(&t,0x91,0xba,configure,2,&result);MLBGI_Menu*menu=s->controllers[0].menu;
 if(result||t.error||Thread_PopStack(&t)||!menu||menu->itemCount!=2||menu->imageCount!=3||menu->bytes!=48||menuCopyRequests!=3||s->imageCacheBytes!=8240||menu->items[0].images[0]!=menu->items[0].images[3])return 4;
 uint32_t eventQuery[]={0x08000300,id};memset(local+768,0x7f,12);
 service(&t,0x90,0xbf,eventQuery,2,&result);if(result||t.error||Thread_PopStack(&t)!=1)return 23;
 for(unsigned i=0;i<12;i++)if(local[768+i])return 24;
 if(!MLBGI_PostControllerEvent(&e,id,7,11,13)||!MLBGI_PostControllerEvent(&e,id,17,19,23))return 25;
 eventQuery[0]=0x080003f8;service(&t,0x90,0xbf,eventQuery,2,&result);
 if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->controllers[0].eventCount!=2)return 26;t.error=0;
 eventQuery[0]=0x08000300;service(&t,0x90,0xbf,eventQuery,2,&result);uint32_t eventValues[3];memcpy(eventValues,local+768,12);
 if(result||t.error||Thread_PopStack(&t)!=1||eventValues[0]!=7||eventValues[1]!=11||eventValues[2]!=13||s->controllers[0].eventCount!=1)return 27;
 eventQuery[1]=99;memset(local+768,0x7f,12);service(&t,0x90,0xbf,eventQuery,2,&result);
 if(result||t.error||Thread_PopStack(&t)||s->controllers[0].eventCount!=1||MLBGI_PostControllerEvent(&e,99,1,2,3))return 28;
 for(unsigned i=0;i<12;i++)if(local[768+i]!=0x7f)return 29;
 eventQuery[1]=id;service(&t,0x90,0xbf,eventQuery,2,&result);memcpy(eventValues,local+768,12);
 if(result||t.error||Thread_PopStack(&t)!=1||eventValues[0]!=17||eventValues[1]!=19||eventValues[2]!=23||s->controllers[0].eventCount)return 30;
 for(unsigned i=0;i<1024;i++)if(!MLBGI_PostControllerEvent(&e,id,i,i+1,i+2))return 31;
 if(MLBGI_PostControllerEvent(&e,id,1,2,3)||s->controllers[0].eventCount!=1024)return 32;
 for(unsigned i=0;i<1024;i++){service(&t,0x90,0xbf,eventQuery,2,&result);memcpy(eventValues,local+768,12);if(result||t.error||Thread_PopStack(&t)!=1||eventValues[0]!=i||eventValues[1]!=i+1||eventValues[2]!=i+2)return 33;}
 if(s->controllers[0].eventCount||!MLBGI_PostControllerEvent(&e,id,UINT32_MAX,0x80000000,17))return 34;
 service(&t,0x90,0xbf,eventQuery,2,&result);memcpy(eventValues,local+768,12);if(result||t.error||Thread_PopStack(&t)!=1||eventValues[0]!=UINT32_MAX||eventValues[1]!=0x80000000||eventValues[2]!=17)return 35;
 memset(local+256,0,196);menuRed=0;memset(pixels,0x82,sizeof(pixels));
 if(!MLBGI_DrawScene(&e,pixels,sizeof(pixels),4,4,16)||pixels[20]!=255||pixels[21]||pixels[22]||pixels[16]!=255||pixels[19]!=255||menu->images[0].pixels[0]!=255)return 5;
 uint8_t imageSaved[16];memcpy(imageSaved,menu->images[0].pixels,16);
 if(MLBGI_DrawScene(&e,menu->images[0].pixels,16,2,2,8)||memcmp(imageSaved,menu->images[0].pixels,16))return 6;
 memcpy(saved,pixels,sizeof(pixels));uint32_t invalid=menu->items[0].images[0];menu->items[0].images[0]=99;
 if(MLBGI_DrawScene(&e,pixels,sizeof(pixels),4,4,16)||memcmp(saved,pixels,sizeof(saved)))return 7;menu->items[0].images[0]=invalid;
 header[3]=1;memcpy(local+16,header,sizeof(header));size_t oldBytes=s->imageCacheBytes;
 service(&t,0x91,0xba,configure,2,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->controllers[0].menu!=menu||s->imageCacheBytes!=oldBytes||menuCopyRequests!=3)return 8;t.error=0;
 header[3]=0;header[1]=0x080003e0;memcpy(local+16,header,sizeof(header));service(&t,0x91,0xba,configure,2,&result);
 if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->controllers[0].menu!=menu||s->imageCacheBytes!=oldBytes)return 9;t.error=0;
 header[1]=0x08000080;header[2]=0;group[3]=0;memcpy(local+16,header,sizeof(header));memcpy(local+128,group,sizeof(group));
 item[2]=item[3]=1;memcpy(local+256,item,sizeof(item));item[2]=UINT32_MAX;memcpy(local+452,item,sizeof(item));menuRed=255;
 service(&t,0x91,0xba,configure,2,&result);menu=s->controllers[0].menu;if(result||t.error||Thread_PopStack(&t)||!menu||s->imageCacheBytes!=oldBytes)return 10;
 if(!MLBGI_DrawScene(&e,pixels,sizeof(pixels),4,4,16)||pixels[20]||pixels[22]!=255||pixels[16]!=255)return 11;
 s->windows[0].blendMode=1;s->windows[0].secondaryOpacity=256;
 if(!MLBGI_DrawScene(&e,pixels,sizeof(pixels),4,4,16)||pixels[20]||pixels[21]||pixels[22])return 20;
 s->windows[0].secondaryOpacity=128;
 if(!MLBGI_DrawScene(&e,pixels,sizeof(pixels),4,4,16)||pixels[20]||pixels[22]!=125)return 21;
 s->windows[0].secondaryOpacity=0;s->windows[0].opacityScale=128;
 if(!MLBGI_DrawScene(&e,pixels,sizeof(pixels),4,4,16)||pixels[20]||pixels[22]!=125)return 22;
 s->windows[0].opacityScale=256;s->windows[0].blendMode=128;
 header[2]=UINT32_MAX;memcpy(local+16,header,sizeof(header));item[8]=4;item[2]=1;memcpy(local+256,item,sizeof(item));item[2]=UINT32_MAX;memcpy(local+452,item,sizeof(item));
 service(&t,0x91,0xba,configure,2,&result);menu=s->controllers[0].menu;
 if(result||t.error||Thread_PopStack(&t)||menu->images[0].pixels[0]||menu->items[0].images[0]!=UINT32_MAX||menu->imageCount!=3)return 12;
 if(!MLBGI_DrawScene(&e,pixels,sizeof(pixels),4,4,16)||pixels[20]||pixels[21]||pixels[22])return 13;
 item[48]=1;item[2]=1;memcpy(local+256,item,sizeof(item));oldBytes=s->imageCacheBytes;service(&t,0x91,0xba,configure,2,&result);
 if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->controllers[0].menu!=menu||s->imageCacheBytes!=oldBytes)return 14;t.error=0;
 uint32_t plain=target;service(&t,0x90,0xb8,&plain,1,&result);plain=Thread_PopStack(&t);configure[0]=plain;service(&t,0x91,0xba,configure,2,&result);if(result||Thread_PopStack(&t)!=4)return 15;
 configure[0]=99;service(&t,0x91,0xba,configure,2,&result);if(result||Thread_PopStack(&t)!=1)return 16;
 service(&t,0x90,0xb9,&id,1,&result);if(result||Thread_PopStack(&t)!=1||s->imageCacheBytes!=8192||s->controllers[0].menu)return 17;
 service(&t,0x90,0xb9,&plain,1,&result);if(result||Thread_PopStack(&t)!=1)return 18;
 service(&t,0x90,0x81,&target,1,&result);if(result||t.error||s->imageCacheBytes||s->windowCount)return 19;
 MLBGI_FreeDialect(&e);free(e.globalMem);return 0;
}
static int timedOpacityContracts(void) {
 Engine_t e={0},other={0};Thread_t t={0};uint32_t stack[32]={0},result=99;t.engine=&e;t.stack=stack;t.stackSize=32;t.threadId=2;
 if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960)||!MLBGI_ConfigureDialect(&other,"ethornell-1.72",1280,960))return 1;
 MLBGI_Runtime*s=e.mlRuntime,*independent=other.mlRuntime;
 service(&t,0x90,0x60,NULL,0,&result);uint32_t target=Thread_PopStack(&t);if(result||target!=0x90000000)return 2;
 uint32_t color[]={target,0,256,0};service(&t,0x90,0x65,color,4,&result);if(result||t.error)return 3;
 uint32_t fade[]={target,0,3,250,0,0};service(&t,0x90,0x20,fade,6,&result);
 if(result!=2||t.error||t.stackPointer||!t.mlWaitActive||s->transitions[0].thread!=&t||!s->filters[0].visible||s->filters[0].opacity!=256||independent->transitions[0].thread)return 4;
 uint32_t start=s->transitions[0].startMilliseconds;
 if(MLBGI_ThreadReady(&t,start)||s->filters[0].opacity!=256||t.stackPointer||MLBGI_ThreadReady(&t,start+1)||s->filters[0].opacity!=170)return 5;
 MLBGI_FramePresented(&e,start+1);if(MLBGI_ThreadReady(&t,start+2)||s->filters[0].opacity!=85||!s->framePending)return 6;
 if(!MLBGI_ThreadReady(&t,start+3)||s->filters[0].opacity||t.mlWaitActive||s->transitions[0].thread||Thread_PopStack(&t)||Thread_PopStack(&t)!=333||t.stackPointer)return 7;
 fade[1]=256;fade[2]=6;service(&t,0x90,0x20,fade,6,&result);if(result!=2)return 8;start=s->transitions[0].startMilliseconds;
 if(MLBGI_ThreadReady(&t,start+1)||s->filters[0].opacity!=42||MLBGI_ThreadReady(&t,start+3)||s->filters[0].opacity!=128)return 9;
 if(!MLBGI_ThreadReady(&t,start+20)||s->filters[0].opacity!=256||Thread_PopStack(&t)||Thread_PopStack(&t)||t.stackPointer)return 10;
 fade[1]=0;fade[2]=4;service(&t,0x90,0x20,fade,6,&result);if(result!=2)return 11;
 s->transitions[0].startMilliseconds=UINT32_MAX-2;
 if(MLBGI_ThreadReady(&t,0)||s->filters[0].opacity!=64||!MLBGI_ThreadReady(&t,1)||s->filters[0].opacity||Thread_PopStack(&t)||Thread_PopStack(&t))return 12;
 fade[1]=256;fade[2]=0;service(&t,0x90,0x20,fade,6,&result);if(result!=2||s->transitions[0].duration!=1)return 13;start=s->transitions[0].startMilliseconds;
 if(!MLBGI_ThreadReady(&t,start+1)||s->filters[0].opacity!=256||Thread_PopStack(&t)||Thread_PopStack(&t))return 14;
 fade[3]=0;service(&t,0x90,0x20,fade,6,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->filters[0].opacity!=256||s->transitions[0].thread)return 15;t.error=0;
 fade[3]=250;fade[4]=1;service(&t,0x90,0x20,fade,6,&result);if(result!=UINT32_MAX-3||!t.error||s->transitions[0].thread||t.stackPointer)return 16;t.error=0;fade[4]=0;
 fade[1]=257;service(&t,0x90,0x20,fade,6,&result);if(result!=UINT32_MAX-3||!t.error||s->transitions[0].thread||t.stackPointer)return 17;t.error=0;fade[1]=0;
 service(&t,0x90,0x20,fade,6,&result);if(result!=2)return 18;start=s->transitions[0].startMilliseconds;s->filters[0].allocated=0;
 if(MLBGI_ThreadReady(&t,start+1)||!t.error||s->transitions[0].thread||t.mlWaitActive||t.stackPointer)return 19;
 MLBGI_FreeDialect(&e);MLBGI_FreeDialect(&other);free(e.globalMem);free(other.globalMem);return 0;
}
static int resourceSizeContracts(void) {
 Engine_t e={0};Thread_t t={0};uint8_t code[128]={0},local[64]={0};uint32_t stack[32]={0},result=99;
 t.engine=&e;e.threads=&t;t.code=code;t.codeSpaceUsed=sizeof(code);t.localMem=local;t.localMemSize=sizeof(local);t.stack=stack;t.stackSize=32;
 if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960))return 1;
 memcpy(code+16,"system",7);memcpy(code+32,"child._bp",10);memcpy(code+48,"absent",7);memcpy(code+64,"../outside",11);
 memcpy(code+80,"packed.bin",11);
 uint32_t query[]={0x04000010,0x04000020};service(&t,0x80,0x35,query,2,&result);
 if(result||t.error||Thread_PopStack(&t)!=19||t.stackPointer)return 2;
 const char *names[]={"system.arc"};if(!MLBGI_RegisterArchiveGroup(&e,"alias",names,1))return 3;
 memcpy(code+16,"alias",6);service(&t,0x80,0x35,query,2,&result);if(result||t.error||Thread_PopStack(&t)!=19)return 4;
 query[1]=0x04000030;service(&t,0x80,0x35,query,2,&result);if(result||t.error||Thread_PopStack(&t))return 5;
 query[1]=0x04000040;service(&t,0x80,0x35,query,2,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer)return 6;t.error=0;
 query[1]=0;service(&t,0x80,0x35,query,2,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer)return 7;t.error=0;
 query[0]=0;query[1]=0x04000050;service(&t,0x80,0x35,query,2,&result);if(result||t.error||Thread_PopStack(&t)!=4)return 8;
 uint32_t load[]={0x08000010,0,0x04000050};memset(local+16,0x93,32);service(&t,0x80,0x30,load,3,&result);
 if(result||t.error||Thread_PopStack(&t)!=4||memcmp(local+16,"ABAB",4)||local[20]||local[31]||local[32]!=0x93)return 9;
 load[1]=0x04000010;load[2]=0x04000020;service(&t,0x80,0x30,load,3,&result);
 if(result||t.error||Thread_PopStack(&t)!=19||local[16]!=16||local[20]!=3||local[32]||local[33]!=9||local[34]!=0x17||local[35]!=0x93)return 10;
 load[0]=0x08000034;service(&t,0x80,0x30,load,3,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||local[52])return 11;t.error=0;
 load[0]=0x0800002e;local[46]=0x82;service(&t,0x80,0x30,load,3,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||local[46]!=0x82)return 12;t.error=0;
 load[0]=0x08000010;load[2]=0x04000030;memset(local+16,0x93,32);service(&t,0x80,0x30,load,3,&result);
 if(result||t.error||Thread_PopStack(&t)||local[16]||local[31]||local[32]!=0x93)return 13;
 MLBGI_FreeDialect(&e);free(e.globalMem);MLBGI_FreeArchiveCache();return 0;
}
static int spriteObjectContracts(void) {
 Engine_t e={0},other={0};Thread_t t={0};uint32_t stack[32]={0},result=99;t.engine=&e;t.stack=stack;t.stackSize=32;
 if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960)||!MLBGI_ConfigureDialect(&other,"ethornell-1.72",1280,960))return 1;
 MLBGI_Runtime*s=e.mlRuntime,*independent=other.mlRuntime;
 service(&t,0x90,0x50,NULL,0,&result);uint32_t handle=Thread_PopStack(&t);
 if(result||t.error||handle!=0x80000000||s->spriteCount!=1||independent->spriteCount||s->sprites[0].object.visible||s->sprites[0].object.opacity||s->sprites[0].object.opacityScale!=256||s->sprites[0].bitmapSlot!=UINT32_MAX||s->sprites[0].blendMode!=128||s->sprites[0].image.pixels)return 2;
 s->copyMenuImage=copyMenuFixture;menuRed=255;
 uint32_t imageArgs[]={handle,1,UINT32_MAX,1,128,0,10};service(&t,0x90,0x56,imageArgs,7,&result);
 uint8_t scene[64],before[64];if(result||t.error||t.stackPointer||s->sprites[0].image.width!=2||s->sprites[0].bitmapSlot!=1||s->imageCacheBytes!=16)return 13;
 if(!MLBGI_DrawScene(&e,scene,sizeof(scene),4,4,16)||scene[4]||scene[8])return 14;
 uint32_t visible[]={handle,1};service(&t,0x90,0x54,visible,2,&result);if(result||!s->sprites[0].object.visible)return 3;
 menuRed=0;if(!MLBGI_DrawScene(&e,scene,sizeof(scene),4,4,16)||scene[4]!=255||scene[8]!=255||scene[0]||scene[20]||scene[7]!=255)return 15;
 if(MLBGI_DrawScene(&e,s->sprites[0].image.pixels,16,2,2,8)||s->sprites[0].image.pixels[0]!=255)return 16;
 uint8_t*oldImage=s->sprites[0].image.pixels;imageArgs[4]=17;service(&t,0x90,0x56,imageArgs,7,&result);
 if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->sprites[0].image.pixels!=oldImage||s->imageCacheBytes!=16||oldImage[0]!=255)return 17;t.error=0;
 imageArgs[4]=128;imageArgs[3]=4;service(&t,0x90,0x56,imageArgs,7,&result);
 if(result!=UINT32_MAX-3||!t.error||s->sprites[0].image.pixels!=oldImage||s->imageCacheBytes!=16)return 18;t.error=0;
 imageArgs[3]=1;s->imageCacheLimit=8;service(&t,0x90,0x56,imageArgs,7,&result);
 if(result!=UINT32_MAX-3||!t.error||s->sprites[0].image.pixels!=oldImage||s->imageCacheBytes!=16)return 19;t.error=0;s->imageCacheLimit=64*1024*1024;
 memcpy(before,scene,sizeof(scene));s->sprites[0].image.format=17;
 if(MLBGI_DrawScene(&e,scene,sizeof(scene),4,4,16)||memcmp(scene,before,sizeof(scene)))return 20;s->sprites[0].image.format=1;
 menuRed=255;imageArgs[4]=1;imageArgs[5]=128;imageArgs[1]=imageArgs[2]=1;service(&t,0x90,0x56,imageArgs,7,&result);
 if(result||t.error||!MLBGI_DrawScene(&e,scene,sizeof(scene),4,4,16)||scene[20]!=125||scene[24]!=125||scene[4])return 21;
 if(!MLBGI_DrawSceneThroughOrder(&e,9,scene,sizeof(scene),4,4,16)||scene[20])return 22;
 if(!MLBGI_DrawSceneThroughOrder(&e,10,scene,sizeof(scene),4,4,16)||scene[20]!=125)return 23;
 uint32_t place[]={handle,(uint32_t)-4,17};service(&t,0x90,0x33,place,3,&result);if(result||s->sprites[0].object.x!=-4||s->sprites[0].object.y!=17)return 4;
 visible[1]=128;service(&t,0x90,0x32,visible,2,&result);service(&t,0x90,0x34,visible,2,&result);service(&t,0x90,0x35,visible,2,&result);
 if(result||t.error||s->sprites[0].object.opacity!=128||s->sprites[0].object.secondaryOpacity!=128||s->sprites[0].object.opacityScale!=128)return 5;
 place[0]=0;service(&t,0x90,0x37,place,3,&result);if(result||s->sprites[0].object.offsetX!=-4||s->sprites[0].object.offsetY!=17)return 6;
 uint32_t data[]={handle,0x7fffffff,2,29};service(&t,0x90,0x38,data,4,&result);if(result||s->sprites[0].object.data.slots[2]!=29)return 7;
 for(unsigned i=1;i<512;i++){service(&t,0x90,0x50,NULL,0,&result);if(result||t.error||Thread_PopStack(&t)!=(0x80000000|i)||s->spriteCount!=i+1)return 8;}
 service(&t,0x90,0x50,NULL,0,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->spriteCount!=512)return 9;t.error=0;
 for(unsigned i=0;i<512;i++){uint32_t remove=0x80000000|i;service(&t,0x90,0x51,&remove,1,&result);if(result||t.error||t.stackPointer||s->spriteCount!=511-i||s->sprites[i].object.allocated)return 10;}
 service(&t,0x90,0x51,&handle,1,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->spriteCount)return 11;t.error=0;
 service(&t,0x90,0x50,NULL,0,&result);if(result||Thread_PopStack(&t)!=handle||s->sprites[0].object.offsetX||s->sprites[0].object.data.slots[2]||s->spriteCount!=1)return 12;
 MLBGI_FreeDialect(&e);MLBGI_FreeDialect(&other);free(e.globalMem);free(other.globalMem);return 0;
}
static int filterContracts(void) {
 Engine_t e={0},other={0};Thread_t t={0};uint32_t stack[32]={0},result=99;
 t.engine=&e;t.stack=stack;t.stackSize=32;if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960)||!MLBGI_ConfigureDialect(&other,"ethornell-1.72",1280,960))return 1;
 MLBGI_Runtime*s=e.mlRuntime,*independent=other.mlRuntime;
 for(unsigned i=0;i<8;i++){service(&t,0x90,0x60,NULL,0,&result);if(result||t.error||Thread_PopStack(&t)!=(0x90000000|i)||s->filterCount!=i+1||!s->filters[i].allocated||s->filters[i].visible||s->filters[i].opacity)return 2;}
 service(&t,0x90,0x60,NULL,0,&result);if(result!=UINT32_MAX-3||!t.error||s->filterCount!=8||t.stackPointer)return 3;t.error=0;
 uint32_t show[]={0x90000004,0xffffffff};service(&t,0x90,0x64,show,2,&result);if(result||t.error||t.stackPointer||s->filters[4].visible!=0xffffffff||independent->filterCount)return 4;
 show[0]=0x90000008;service(&t,0x90,0x64,show,2,&result);if(result!=UINT32_MAX-3||!t.error||s->filters[4].visible!=0xffffffff)return 5;t.error=0;
 uint32_t handle=0x90000004;service(&t,0x90,0x61,&handle,1,&result);if(result||t.error||s->filterCount!=7||s->filters[4].allocated||s->filters[4].visible)return 6;
 service(&t,0x90,0x61,&handle,1,&result);if(result!=UINT32_MAX-3||!t.error||s->filterCount!=7)return 7;t.error=0;
 service(&t,0x90,0x60,NULL,0,&result);if(result||Thread_PopStack(&t)!=handle||s->filterCount!=8||s->filters[4].visible)return 8;
 show[0]=0x80000004;service(&t,0x90,0x64,show,2,&result);if(result!=UINT32_MAX-3||!t.error||s->filters[4].visible)return 9;t.error=0;
 uint32_t color[]={handle,0x804020,128,208};service(&t,0x90,0x65,color,4,&result);if(result||t.error||t.stackPointer||s->filters[4].parameter!=0x804020||s->filters[4].opacity!=128||s->filters[4].order!=208)return 10;
 uint8_t pixels[8]={64,192,255,73,255,127,0,255},original[8];memcpy(original,pixels,8);
 if(!MLBGI_ApplyFilter(&e,handle,pixels,8)||memcmp(original,pixels,8))return 11;
 show[0]=handle;show[1]=1;service(&t,0x90,0x64,show,2,&result);if(result||!MLBGI_ApplyFilter(&e,handle,pixels,8))return 12;
 const uint8_t half[]={96,128,143,73,191,95,16,255};if(memcmp(pixels,half,8))return 13;
 color[2]=256;service(&t,0x90,0x65,color,4,&result);if(result||!MLBGI_ApplyFilter(&e,handle,pixels,8))return 14;
 const uint8_t opaque[]={128,64,32,73,128,64,32,255};if(memcmp(pixels,opaque,8))return 15;
 color[2]=257;service(&t,0x90,0x65,color,4,&result);if(result!=UINT32_MAX-3||!t.error||s->filters[4].opacity!=256||s->filters[4].order!=208)return 16;t.error=0;
 color[2]=0;color[3]=65536;service(&t,0x90,0x65,color,4,&result);if(result!=UINT32_MAX-3||!t.error||s->filters[4].opacity!=256)return 17;t.error=0;
 if(MLBGI_ApplyFilter(&e,handle,pixels,7)||MLBGI_ApplyFilter(&other,handle,pixels,8)||memcmp(pixels,opaque,8))return 18;
 s->filters[4].kind=1;if(MLBGI_ApplyFilter(&e,handle,pixels,8)||memcmp(pixels,opaque,8))return 19;
 MLBGI_FreeDialect(&e);MLBGI_FreeDialect(&other);free(e.globalMem);free(other.globalMem);return 0;
}
static int groupContracts(void) {
 Engine_t e={0};Thread_t t={0};uint32_t stack[32]={0},result=99;t.engine=&e;t.stack=stack;t.stackSize=32;
 if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960))return 1;MLBGI_Runtime*s=e.mlRuntime;
 for(unsigned i=0;i<8;i++){service(&t,0x90,0xe0,NULL,0,&result);if(result||t.error||Thread_PopStack(&t)!=(0xf1000000|i)||s->groupCount!=i+1||s->groups[i].visible||s->groups[i].memberCount)return 2;}
 service(&t,0x90,0xe0,NULL,0,&result);if(result!=UINT32_MAX-3||!t.error||s->groupCount!=8)return 3;t.error=0;
 service(&t,0x90,0x60,NULL,0,&result);uint32_t filter=Thread_PopStack(&t);if(result||filter!=0x90000000)return 4;
 uint32_t add[]={0xf1000001,filter,7,(uint32_t)-5};service(&t,0x90,0xe8,add,4,&result);if(result||t.error||s->filters[0].owner!=add[0]||s->filters[0].x!=7||s->filters[0].y!=-5)return 5;
 add[0]=0xf1000000;add[1]=0xf1000001;add[2]=10;add[3]=20;service(&t,0x90,0xe8,add,4,&result);if(result||s->groups[1].owner!=add[0]||s->filters[0].x!=17||s->filters[0].y!=15)return 6;
 uint32_t place[]={0xf1000000,(uint32_t)-20,30,128};service(&t,0x90,0xe5,place,4,&result);if(result||t.error||s->groups[1].x!=-10||s->groups[1].y!=50||s->filters[0].x!=-3||s->filters[0].y!=45||s->filters[0].opacity!=128||s->groups[1].opacity!=128)return 7;
 uint32_t show[]={0xf1000000,1};service(&t,0x90,0xe4,show,2,&result);if(result||!s->groups[0].visible||!s->groups[1].visible||!s->filters[0].visible)return 8;
 uint32_t cycle[]={0xf1000001,0xf1000000,0,0};service(&t,0x90,0xe8,cycle,4,&result);if(result!=UINT32_MAX-3||!t.error||s->groups[0].owner||s->groups[1].memberCount!=1)return 9;t.error=0;
 add[1]=filter;service(&t,0x90,0xe8,add,4,&result);if(result!=UINT32_MAX-3||!t.error||s->filters[0].owner!=0xf1000001||s->groups[0].memberCount!=1)return 10;t.error=0;
 uint32_t remove[]={0xf1000001,filter};service(&t,0x90,0xe9,remove,2,&result);if(result||t.error||s->filters[0].owner||s->groups[1].memberCount||s->filters[0].x!=-3)return 11;
 service(&t,0x90,0xe9,remove,2,&result);if(result!=UINT32_MAX-3||!t.error)return 12;t.error=0;
 add[0]=0xf1000001;add[1]=filter;add[2]=0;add[3]=0;service(&t,0x90,0xe8,add,4,&result);if(result||s->groups[1].memberCount!=1)return 13;
 uint32_t destroy=0xf1000001;service(&t,0x90,0xe1,&destroy,1,&result);if(result||t.error||s->groupCount!=7||s->groups[1].allocated||s->groups[0].memberCount||s->filters[0].owner||!s->filters[0].allocated)return 14;
 service(&t,0x90,0xe0,NULL,0,&result);if(result||Thread_PopStack(&t)!=destroy||s->groups[1].memberCount||s->groups[1].visible)return 15;
 add[0]=0xf1000001;service(&t,0x90,0xe8,add,4,&result);if(result||s->groups[1].memberCount!=1)return 16;
 service(&t,0x90,0x61,&filter,1,&result);if(result||t.error||s->groups[1].memberCount||s->filterCount)return 17;
 place[3]=257;service(&t,0x90,0xe5,place,4,&result);if(result!=UINT32_MAX-3||!t.error||s->groups[0].opacity!=128||s->groups[0].x!=-20)return 18;t.error=0;
 show[0]=0xf0000000;service(&t,0x90,0xe4,show,2,&result);if(result!=UINT32_MAX-3||!t.error||!s->groups[0].visible)return 19;
 MLBGI_FreeDialect(&e);free(e.globalMem);return 0;
}
static int windowObjectContracts(void) {
 Engine_t e={0};Thread_t t={0};uint32_t stack[32]={0},result=99;t.engine=&e;t.stack=stack;t.stackSize=32;
 if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960))return 1;MLBGI_Runtime*s=e.mlRuntime;
 uint32_t dimensions[]={25,19};service(&t,0x90,0x80,dimensions,2,&result);uint32_t handle=Thread_PopStack(&t);
 if(result||t.error||handle!=0xb0000000||s->windowCount!=1||s->windows[0].width!=800||s->windows[0].height!=608||s->windows[0].visible||s->windows[0].backgroundEnabled||s->windows[0].opacity||s->windows[0].pixels[0]||s->windows[0].pixels[3]||s->imageCacheBytes!=800u*608*4)return 2;
 uint32_t rect[]={handle,64,56,1128,208};service(&t,0x90,0x88,rect,5,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].textWidth!=800||s->windows[0].textX)return 12;t.error=0;
 rect[3]=736;rect[4]=552;service(&t,0x90,0x88,rect,5,&result);if(result||t.error||s->windows[0].textX!=64||s->windows[0].textY!=56||s->windows[0].textWidth!=736||s->windows[0].textHeight!=552)return 13;
 rect[3]=0;service(&t,0x90,0x88,rect,5,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].textWidth!=736)return 14;t.error=0;
 uint32_t spacing[]={handle,25};service(&t,0x91,0x89,spacing,2,&result);if(result||t.error||t.stackPointer||s->windows[0].textLineSpacingPercent!=25)return 15;
 spacing[1]=800;service(&t,0x91,0x89,spacing,2,&result);if(result||s->windows[0].textLineSpacingPercent!=800)return 16;
 spacing[1]=801;service(&t,0x91,0x89,spacing,2,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].textLineSpacingPercent!=800)return 17;t.error=0;
 spacing[0]=0xc0000000;spacing[1]=0;service(&t,0x91,0x89,spacing,2,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].textLineSpacingPercent!=800)return 18;t.error=0;
 uint32_t configure[]={handle,0,0,1,256,0,117};service(&t,0x90,0x85,configure,7,&result);
 if(result||t.error||t.stackPointer||s->windows[0].x||s->windows[0].y||s->windows[0].blendMode!=1||s->windows[0].opacity!=256||s->windows[0].order!=117)return 19;
 configure[5]=257;service(&t,0x90,0x85,configure,7,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].order!=117||s->windows[0].opacity!=256)return 20;t.error=0;configure[5]=0;
 configure[3]=255;service(&t,0x90,0x85,configure,7,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].blendMode!=1)return 21;t.error=0;configure[3]=1;
 configure[6]=65536;service(&t,0x90,0x85,configure,7,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].order!=117)return 22;t.error=0;configure[6]=117;
 uint8_t canvas[12]={10,20,30,255,100,110,120,255,77,78,79,80},expected[12];memcpy(expected,canvas,12);
 s->windows[0].pixels[0]=255;s->windows[0].pixels[1]=0;s->windows[0].pixels[2]=60;s->windows[0].pixels[3]=255;
 s->windows[0].pixels[4]=0;s->windows[0].pixels[5]=255;s->windows[0].pixels[6]=180;s->windows[0].pixels[7]=255;
 if(!MLBGI_DrawWindow(&e,handle,canvas,sizeof(canvas),2,1,12)||memcmp(canvas,expected,12))return 23;
 s->windows[0].visible=1;if(!MLBGI_DrawWindow(&e,handle,canvas,sizeof(canvas),2,1,12)||memcmp(canvas,expected,12))return 24;
 configure[4]=128;service(&t,0x90,0x85,configure,7,&result);if(result||!MLBGI_DrawWindow(&e,handle,canvas,sizeof(canvas),2,1,12))return 25;
 const uint8_t half[]={130,10,44,255,50,181,149,255,77,78,79,80};if(memcmp(canvas,half,12))return 26;
 memcpy(canvas,expected,12);configure[4]=129;service(&t,0x90,0x85,configure,7,&result);if(result||!MLBGI_DrawWindow(&e,handle,canvas,sizeof(canvas),2,1,12)||memcmp(canvas,half,12))return 27;
 configure[4]=0;service(&t,0x90,0x85,configure,7,&result);if(result||!MLBGI_DrawWindow(&e,handle,canvas,sizeof(canvas),2,1,12)||canvas[0]!=255||canvas[5]!=255||canvas[8]!=77)return 28;
 configure[1]=(uint32_t)-1;service(&t,0x90,0x85,configure,7,&result);memcpy(canvas,expected,12);if(result||!MLBGI_DrawWindow(&e,handle,canvas,sizeof(canvas),2,1,12)||canvas[0]||canvas[1]!=255||canvas[2]!=180||canvas[4]!=100||canvas[5]!=110||canvas[6]!=120||canvas[8]!=77)return 29;
 configure[1]=INT32_MIN;configure[2]=INT32_MAX;service(&t,0x90,0x85,configure,7,&result);memcpy(canvas,expected,12);if(result||!MLBGI_DrawWindow(&e,handle,canvas,sizeof(canvas),2,1,12)||memcmp(canvas,expected,12))return 30;
 if(MLBGI_DrawWindow(&e,handle,canvas,sizeof(canvas),2,1,7)||MLBGI_DrawWindow(&e,handle,s->windows[0].pixels,8,2,1,8)||MLBGI_DrawWindow(&e,0xc0000000,canvas,sizeof(canvas),2,1,12)||memcmp(canvas,expected,12))return 31;
 s->windows[0].visible=0;
 uint32_t font[]={handle,0,32,100,0,0xabcdef,0};service(&t,0x91,0x88,font,7,&result);
 if(result||t.error||t.stackPointer||!s->windows[0].fontConfigured||s->windows[0].fontHeight!=32||s->windows[0].fontColor!=0xabcdef||MLBGI_WindowLineHeight(&e,handle)!=288)return 32;
 spacing[0]=handle;spacing[1]=25;service(&t,0x91,0x89,spacing,2,&result);if(result||MLBGI_WindowLineHeight(&e,handle)!=40)return 33;
 font[2]=3;service(&t,0x91,0x88,font,7,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].fontHeight!=32||MLBGI_WindowLineHeight(&e,handle)!=40)return 34;t.error=0;font[2]=32;
 font[3]=201;service(&t,0x91,0x88,font,7,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].fontWidthPercent!=100)return 35;t.error=0;font[3]=100;
 font[1]=256;service(&t,0x91,0x88,font,7,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].fontFamily)return 36;t.error=0;
 uint32_t layout[]={handle,1};service(&t,0x91,0x8a,layout,2,&result);if(result||t.error||s->windows[0].textDirection!=1)return 37;
 layout[1]=2;service(&t,0x91,0x8a,layout,2,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].textDirection!=1)return 38;t.error=0;
 service(&t,0x91,0x8b,layout,2,&result);if(result||t.error||s->windows[0].textAlignment!=2)return 39;
 layout[1]=3;service(&t,0x91,0x8b,layout,2,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].textAlignment!=2)return 40;t.error=0;
 uint32_t backdrop[]={handle,0xffffffff};service(&t,0x90,0x87,backdrop,2,&result);if(result||t.error||t.stackPointer||s->windows[0].textBackdropKnockout!=0xffffffff)return 41;
 backdrop[1]=0;service(&t,0x90,0x87,backdrop,2,&result);if(result||s->windows[0].textBackdropKnockout)return 42;
 backdrop[0]=0xb0000010;backdrop[1]=1;service(&t,0x90,0x87,backdrop,2,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].textBackdropKnockout)return 43;t.error=0;
 service(&t,0x91,0x8d,&handle,1,&result);if(result||t.error||t.stackPointer!=3||Thread_PopStack(&t)!=56||Thread_PopStack(&t)!=799||Thread_PopStack(&t)!=1)return 53;
 uint32_t textCursor[]={handle,(uint32_t)-123,INT32_MAX};service(&t,0x91,0x8c,textCursor,3,&result);if(result||t.error||t.stackPointer||s->windows[0].textCursorX!=-123||s->windows[0].textCursorY!=INT32_MAX)return 54;
 service(&t,0x91,0x8d,&handle,1,&result);if(result||t.error||Thread_PopStack(&t)!=INT32_MAX||Thread_PopStack(&t)!=(uint32_t)-123||Thread_PopStack(&t)!=1)return 55;
 textCursor[0]=0xc0000000;service(&t,0x91,0x8d,textCursor,1,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].textCursorX!=-123)return 56;t.error=0;
 layout[1]=0;service(&t,0x91,0x8a,layout,2,&result);if(result||t.error||s->windows[0].textCursorX!=64||s->windows[0].textCursorY!=56)return 57;
 uint32_t property[]={handle,0};service(&t,0x90,0x32,property,2,&result);if(result||t.error||t.stackPointer||s->windows[0].opacity)return 44;
 property[1]=257;service(&t,0x90,0x32,property,2,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].opacity)return 45;t.error=0;
 uint32_t position[]={handle,(uint32_t)-12,31};service(&t,0x90,0x33,position,3,&result);if(result||t.error||t.stackPointer||s->windows[0].x!=-12||s->windows[0].y!=31)return 46;
 property[1]=1;service(&t,0x90,0x30,property,2,&result);if(result||t.error||t.stackPointer||!s->windows[0].visible)return 47;
 property[0]=0xb0000010;service(&t,0x90,0x30,property,2,&result);if(result!=UINT32_MAX-3||!t.error||!s->windows[0].visible)return 48;t.error=0;
 position[1]=position[2]=0;service(&t,0x90,0x33,position,3,&result);property[0]=handle;property[1]=128;service(&t,0x90,0x34,property,2,&result);memcpy(canvas,expected,12);
 if(result||t.error||s->windows[0].secondaryOpacity!=128||!MLBGI_DrawWindow(&e,handle,canvas,sizeof(canvas),2,1,12)||memcmp(canvas,half,12))return 49;
 property[1]=0;service(&t,0x90,0x35,property,2,&result);memcpy(canvas,expected,12);if(result||t.error||s->windows[0].opacityScale||!MLBGI_DrawWindow(&e,handle,canvas,sizeof(canvas),2,1,12)||memcmp(canvas,expected,12))return 50;
 property[1]=256;service(&t,0x90,0x35,property,2,&result);if(result||s->windows[0].opacityScale!=256)return 51;
 property[1]=257;service(&t,0x90,0x34,property,2,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].secondaryOpacity!=128)return 52;t.error=0;
 service(&t,0x90,0xe0,NULL,0,&result);uint32_t group=Thread_PopStack(&t);uint32_t member[]={group,handle,5,9};service(&t,0x90,0xe8,member,4,&result);
 uint32_t place[]={group,30,(uint32_t)-8,128};service(&t,0x90,0xe5,place,4,&result);uint32_t show[]={group,1};service(&t,0x90,0xe4,show,2,&result);
 if(result||t.error||s->windows[0].owner!=group||s->windows[0].x!=35||s->windows[0].y!=1||s->windows[0].opacity!=128||!s->windows[0].visible)return 3;
 service(&t,0x90,0x81,&handle,1,&result);if(result||t.error||s->windowCount||s->imageCacheBytes||s->groups[0].memberCount||s->windows[0].pixels)return 4;
 dimensions[0]=32;dimensions[1]=20;for(unsigned i=0;i<16;i++){service(&t,0x90,0x80,dimensions,2,&result);if(result||t.error||Thread_PopStack(&t)!=(0xb0000000|i)||s->windows[i].width!=32||s->windows[i].height!=20)return 5;}
 size_t before=s->imageCacheBytes;service(&t,0x90,0x80,dimensions,2,&result);if(result!=UINT32_MAX-3||!t.error||s->windowCount!=16||s->imageCacheBytes!=before)return 6;t.error=0;
 handle=0xb0000005;service(&t,0x90,0x81,&handle,1,&result);if(result||t.error||s->windowCount!=15)return 7;
 s->imageCacheLimit=(uint32_t)s->imageCacheBytes;service(&t,0x90,0x80,dimensions,2,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[5].allocated||s->windowCount!=15)return 8;t.error=0;s->imageCacheLimit=0;
 service(&t,0x90,0x80,dimensions,2,&result);if(result||Thread_PopStack(&t)!=handle||s->windowCount!=16)return 9;
 dimensions[0]=0;service(&t,0x90,0x80,dimensions,2,&result);if(result!=UINT32_MAX-3||!t.error||s->windowCount!=16)return 10;t.error=0;
 show[0]=0xc0000000;service(&t,0x90,0x84,show,2,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].visible)return 11;
 MLBGI_FreeDialect(&e);free(e.globalMem);return 0;
}
static int sceneContracts(void) {
 Engine_t e={0};Thread_t t={0};uint32_t stack[32]={0},result=99;t.engine=&e;t.stack=stack;t.stackSize=32;
 if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960))return 1;MLBGI_Runtime*s=e.mlRuntime;
 uint32_t dimensions[]={32,20};for(unsigned i=0;i<2;i++){service(&t,0x90,0x80,dimensions,2,&result);if(result||Thread_PopStack(&t)!=(0xb0000000|i))return 2;
  for(unsigned p=0;p<32*20;p++){s->windows[i].pixels[p*4]=i?0:255;s->windows[i].pixels[p*4+2]=i?255:0;s->windows[i].pixels[p*4+3]=255;}
  uint32_t show[]={0xb0000000|i,1};service(&t,0x90,0x30,show,2,&result);if(result)return 3;
 }
 service(&t,0x90,0x60,NULL,0,&result);uint32_t filter=Thread_PopStack(&t);if(result||filter!=0x90000000)return 4;
 uint32_t color[]={filter,0x00ff00,256,0},show[]={filter,1};service(&t,0x90,0x65,color,4,&result);service(&t,0x90,0x30,show,2,&result);
 uint8_t canvas[12];memset(canvas,77,sizeof(canvas));if(result||!MLBGI_DrawScene(&e,canvas,sizeof(canvas),2,1,12)||canvas[0]||canvas[1]!=255||canvas[2]||canvas[3]!=255||canvas[8]!=77)return 5;
 uint32_t configure[]={0xb0000000,0,0,1,0,0,1};service(&t,0x90,0x85,configure,7,&result);
 if(result||!MLBGI_DrawScene(&e,canvas,sizeof(canvas),2,1,12)||canvas[0]!=255||canvas[1]||canvas[2]||canvas[8]!=77)return 6;
 configure[0]=0xb0000001;service(&t,0x90,0x85,configure,7,&result);if(result||!MLBGI_DrawScene(&e,canvas,sizeof(canvas),2,1,12)||canvas[0]||canvas[1]||canvas[2]!=255)return 7;
 configure[0]=0xb0000000;service(&t,0x90,0x85,configure,7,&result);if(result||!MLBGI_DrawScene(&e,canvas,sizeof(canvas),2,1,12)||canvas[0]!=255||canvas[2])return 8;
 uint32_t secondary[]={0xb0000000,256};service(&t,0x90,0x34,secondary,2,&result);if(result||!MLBGI_DrawScene(&e,canvas,sizeof(canvas),2,1,12)||canvas[0]||canvas[2]!=255)return 9;
 uint8_t prior[12];memcpy(prior,canvas,12);s->windows[1].blendMode=255;if(MLBGI_DrawScene(&e,canvas,sizeof(canvas),2,1,12)||memcmp(prior,canvas,12))return 10;s->windows[1].blendMode=1;
 if(MLBGI_DrawScene(&e,canvas,7,2,1,12)||MLBGI_DrawScene(&e,s->windows[0].pixels,8,2,1,8)||memcmp(prior,canvas,12)||s->windows[0].pixels[0]!=255)return 11;
 s->windows[0].visible=s->windows[1].visible=s->filters[0].visible=0;s->canvasEnabled=1;s->canvasBackground=0x2040c0;
 if(!MLBGI_DrawScene(&e,canvas,sizeof(canvas),2,1,12)||canvas[0]!=32||canvas[1]!=64||canvas[2]!=192||canvas[3]!=255||canvas[8]!=77)return 12;
 MLBGI_FreeDialect(&e);free(e.globalMem);return 0;
}
static int objectOffsetContracts(void) {
 Engine_t e={0},other={0};Thread_t t={0};uint32_t stack[32]={0},result=99;t.engine=&e;t.stack=stack;t.stackSize=32;
 if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960)||!MLBGI_ConfigureDialect(&other,"ethornell-1.72",1280,960))return 1;
 MLBGI_Runtime*s=e.mlRuntime,*independent=other.mlRuntime;uint32_t dimensions[]={1,1};service(&t,0x90,0x80,dimensions,2,&result);uint32_t handle=Thread_PopStack(&t);
 if(result||t.error||handle!=0xb0000000)return 2;
 uint32_t show[]={handle,1};service(&t,0x90,0x84,show,2,&result);
 s->windows[0].pixels[0]=255;s->windows[0].pixels[3]=255;s->windows[0].pixels[5]=255;s->windows[0].pixels[7]=255;
 uint8_t output[16]={0};uint32_t offset[]={handle,1,0};service(&t,0x90,0x37,offset,3,&result);
 if(result||t.error||t.stackPointer||s->windows[0].x||s->windows[0].offsetX!=1||!MLBGI_DrawScene(&e,output,sizeof(output),2,1,8)||output[0]||output[4]!=255||output[5])return 3;
 offset[0]=0;service(&t,0x90,0x37,offset,3,&result);if(result||t.error||s->rootOffsetX!=1||s->windows[0].offsetX!=1||independent->rootOffsetX)return 4;
 service(&t,0x90,0x80,dimensions,2,&result);if(result||Thread_PopStack(&t)!=0xb0000001||s->windows[1].offsetX)return 5;
 service(&t,0x90,0xe0,NULL,0,&result);uint32_t child=Thread_PopStack(&t);uint32_t add[]={child,handle,0,0};service(&t,0x90,0xe8,add,4,&result);
 show[0]=child;service(&t,0x90,0xe4,show,2,&result);
 offset[0]=child;offset[1]=(uint32_t)-1;service(&t,0x90,0x37,offset,3,&result);
 if(result||t.error||s->groups[0].offsetX!=-1||s->windows[0].offsetX!=-1||!MLBGI_DrawScene(&e,output,sizeof(output),2,1,8)||output[0]||output[1]!=255||output[4]||output[5])return 6;
 service(&t,0x90,0xe0,NULL,0,&result);uint32_t parent=Thread_PopStack(&t);add[0]=parent;add[1]=child;service(&t,0x90,0xe8,add,4,&result);
 show[0]=parent;service(&t,0x90,0xe4,show,2,&result);
 offset[0]=parent;offset[1]=0;offset[2]=1;service(&t,0x90,0x37,offset,3,&result);
 if(result||t.error||s->groups[0].offsetY!=1||s->groups[1].offsetY!=1||s->windows[0].offsetY!=1||!MLBGI_DrawScene(&e,output,sizeof(output),2,2,8)||output[0]||output[1]||output[8]!=255||output[13]!=255)return 7;
 offset[0]=0xb0000010;service(&t,0x90,0x37,offset,3,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].offsetY!=1)return 8;t.error=0;
 offset[0]=0;offset[1]=offset[2]=0;service(&t,0x90,0x37,offset,3,&result);
 if(result||t.error||s->rootOffsetX||s->rootOffsetY||s->groups[0].offsetY||s->windows[0].offsetY||!MLBGI_DrawScene(&e,output,sizeof(output),2,1,8)||output[0]!=255||output[5]!=255)return 9;
 uint32_t position[]={handle,INT32_MAX,0};service(&t,0x90,0x33,position,3,&result);offset[0]=handle;offset[1]=1;service(&t,0x90,0x37,offset,3,&result);
 if(result||t.error||!MLBGI_DrawScene(&e,output,sizeof(output),2,1,8)||output[0]||output[1]||output[4]||output[5])return 10;
 uint32_t property[]={0,0x7fff0000,0xabcdef01,UINT32_MAX};service(&t,0x90,0x38,property,4,&result);
 if(result||t.error||t.stackPointer||s->rootData.value!=0xabcdef01||independent->rootData.value)return 11;
 property[0]=handle;property[2]=0x12345678;service(&t,0x90,0x38,property,4,&result);
 if(result||t.error||s->windows[0].data.value!=0x12345678||s->rootData.value!=0xabcdef01)return 12;
 property[1]=0x7fffffff;property[2]=15;property[3]=0x76543210;service(&t,0x90,0x38,property,4,&result);
 if(result||t.error||s->windows[0].data.slots[15]!=0x76543210||s->windows[0].data.slots[0])return 13;
 property[2]=16;service(&t,0x90,0x38,property,4,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->windows[0].data.slots[15]!=0x76543210)return 14;t.error=0;
 property[1]=0x1234;property[2]=0;service(&t,0x90,0x38,property,4,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].data.value!=0x12345678)return 15;t.error=0;
 property[0]=0xb0000010;property[1]=0x7fff0000;service(&t,0x90,0x38,property,4,&result);if(result!=UINT32_MAX-3||!t.error||s->windows[0].data.value!=0x12345678)return 16;
 MLBGI_FreeDialect(&e);MLBGI_FreeDialect(&other);free(e.globalMem);free(other.globalMem);return 0;
}
int main(int argc,char**argv) {
 Engine_t e={0};Thread_t t={0};unsigned char local[32]={0},code[128]={0},global[16]={0};uint32_t stack[32]={0},result=99;
 t.engine=&e;t.localMem=local;t.localMemSize=sizeof(local);t.code=code;t.codeSize=sizeof(code);t.codeSpaceUsed=64;t.stack=stack;t.stackSize=32;e.threads=&t;e.globalMem=global;e.globalBufferSize=sizeof(global);
 if(MLBGI_ConfigureDialect(&e,"unknown",1280,960)||!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1280,960))return 1;
 MLBGI_Runtime*s=e.mlRuntime;
 int memoryResult=memoryContracts();if(memoryResult){fprintf(stderr,"memory contract %d\\n",memoryResult);return 110;}
 int persistentResult=persistentStringContracts();if(persistentResult){fprintf(stderr,"persistent string contract %d\\n",persistentResult);return 152;}
 int recordResult=recordContracts();if(recordResult){fprintf(stderr,"record contract %d\\n",recordResult);return 136;}
 int keyedResult=keyedRecordContracts();if(keyedResult){fprintf(stderr,"keyed record contract %d\\n",keyedResult);return 141;}
 int resourceSizeResult=resourceSizeContracts();if(resourceSizeResult){fprintf(stderr,"resource size contract %d\\n",resourceSizeResult);return 142;}
 int flagResult=flagContracts();if(flagResult){fprintf(stderr,"flag contract %d\\n",flagResult);return 143;}
 int textRulesResult=textRuleContracts();if(textRulesResult){fprintf(stderr,"text rule contract %d\\n",textRulesResult);return 145;}
 int skipResult=skipControlContracts();if(skipResult){fprintf(stderr,"skip control contract %d\\n",skipResult);return 146;}
 int routesResult=inputRouteContracts();if(routesResult){fprintf(stderr,"input layer contract %d\\n",routesResult);return 147;}
 int controllerResult=controllerContracts();if(controllerResult){fprintf(stderr,"controller contract %d\\n",controllerResult);return 148;}
 int menuResult=imageMenuContracts();if(menuResult){fprintf(stderr,"image menu contract %d\\n",menuResult);return 149;}
 int opacityResult=timedOpacityContracts();if(opacityResult){fprintf(stderr,"timed opacity contract %d\\n",opacityResult);return 150;}
 int spriteResult=spriteObjectContracts();if(spriteResult){fprintf(stderr,"sprite object contract %d\\n",spriteResult);return 151;}
 int filterResult=filterContracts();if(filterResult){fprintf(stderr,"filter contract %d\\n",filterResult);return 137;}
 int groupResult=groupContracts();if(groupResult){fprintf(stderr,"group contract %d\\n",groupResult);return 138;}
 int windowResult=windowObjectContracts();if(windowResult){fprintf(stderr,"window object contract %d\\n",windowResult);return 139;}
 int sceneResult=sceneContracts();if(sceneResult){fprintf(stderr,"scene contract %d\\n",sceneResult);return 140;}
 int offsetResult=objectOffsetContracts();if(offsetResult){fprintf(stderr,"object offset contract %d\\n",offsetResult);return 144;}
 if(argc!=2||!MLBGI_ConfigureFiles(&s->files,argv[1]))return 111;
 memcpy(code+32,"data0????.arc",14);uint32_t listMemory=MLBGI_AllocateMemory(&e,32);
 uint32_t find[]={listMemory,32,0x04000020,0,0};service(&t,0x80,0x25,find,5,&result);
 uint8_t*list=MLBGI_ResolveAddress(&t,listMemory);if(result||t.error||Thread_PopStack(&t)!=2||memcmp(list,"data00001.arc\\0DATA00002.ARC\\0",28))return 112;
 find[0]=0;service(&t,0x80,0x25,find,5,&result);if(result||Thread_PopStack(&t)!=28)return 113;
 find[0]=listMemory;find[1]=1;list[0]=0x6a;service(&t,0x80,0x25,find,5,&result);if(result||Thread_PopStack(&t)!=UINT32_MAX||list[0]!=0x6a)return 114;
 find[1]=33;service(&t,0x80,0x25,find,5,&result);if(result!=UINT32_MAX-3||!t.error||list[0]!=0x6a||t.stackPointer)return 115;t.error=0;
 find[1]=32;find[3]=1;service(&t,0x80,0x25,find,5,&result);if(result!=UINT32_MAX-3||!t.error||list[0]!=0x6a||t.stackPointer)return 116;t.error=0;
 if(!MLBGI_FreeMemory(&e,listMemory))return 117;
 memcpy(code+32,"group.arc",10);uint32_t groupMemory=MLBGI_AllocateMemory(&e,64);uint8_t*groupBytes=MLBGI_ResolveAddress(&t,groupMemory);
 memcpy(groupBytes+24,"system.arc",11);memcpy(groupBytes+40,"other.arc",10);
 MLBGI_WriteInteger(&t,groupBytes,2,groupMemory+24);MLBGI_WriteInteger(&t,groupBytes+4,2,groupMemory+40);
 uint32_t groupArgs[]={0x04000020,groupMemory};service(&t,0x80,0x38,groupArgs,2,&result);
 if(result||t.error||Thread_PopStack(&t)!=1||s->archiveGroupCount!=1||s->archiveGroups[0].count!=2)return 118;
 memcpy(code+32,"GROUP.ARC",10);service(&t,0x80,0x38,groupArgs,2,&result);if(result||Thread_PopStack(&t)||s->archiveGroupCount!=1)return 119;
 groupBytes[24]='x';if(!MLBGI_FreeMemory(&e,groupMemory))return 120;size_t groupSize=0;
 uint8_t*groupData=MLBGI_ReadEngineResource(&e,"GROUP.arc","CHILD._BP",&groupSize);
 if(!groupData||groupSize!=19||groupData[17]!=9)return 121;free(groupData);
 const char*reverse[]={"other.arc","system.arc"};if(!MLBGI_RegisterArchiveGroup(&e,"reverse.arc",reverse,2))return 122;
 groupData=MLBGI_ReadEngineResource(&e,"reverse.arc","child._bp",&groupSize);if(!groupData||groupSize!=19||groupData[17]!=12)return 123;free(groupData);
 const char*missFirst[]={"bad.arc","system.arc"};groupData=MLBGI_ReadArchiveList(missFirst,2,"child._bp",NULL,0,0,&groupSize);
 if(!groupData||groupSize!=19||groupData[17]!=9)return 124;free(groupData);
 memcpy(code+32,"group.arc",10);memcpy(code+48,"child._bp",10);uint32_t queryArgs[]={0x04000020,0x04000030};
 service(&t,0x80,0x34,queryArgs,2,&result);if(result||Thread_PopStack(&t)!=1||t.error)return 129;
 memcpy(code+48,"absent",7);service(&t,0x80,0x34,queryArgs,2,&result);if(result||Thread_PopStack(&t)||t.error)return 130;
 memcpy(code+32,"broken.arc",11);const char*brokenNames[]={"data00001.arc"};if(!MLBGI_RegisterArchiveGroup(&e,"broken.arc",brokenNames,1))return 131;
 service(&t,0x80,0x34,queryArgs,2,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer)return 132;t.error=0;
 const char*malformed[]={"data00001.arc","system.arc"};if(MLBGI_ReadArchiveList(malformed,2,"child._bp",NULL,0,0,&groupSize)||groupSize)return 125;
 if(MLBGI_ReadEngineResource(&e,"group.arc","absent",&groupSize)||groupSize)return 126;
 groupMemory=MLBGI_AllocateMemory(&e,4);groupBytes=MLBGI_ResolveAddress(&t,groupMemory);MLBGI_WriteInteger(&t,groupBytes,2,0x04000020);
 groupArgs[1]=groupMemory;service(&t,0x80,0x38,groupArgs,2,&result);if(result!=UINT32_MAX-3||!t.error||t.stackPointer||s->archiveGroupCount!=3)return 127;t.error=0;
 if(!MLBGI_FreeMemory(&e,groupMemory))return 128;
 if(MLBGI_LocalAddress(&t,7)!=0x08000007||MLBGI_CodeAddress(&t,12)!=0x0400000c)return 2;
 if(MLBGI_ResolveAddress(&t,0x08000007)!=local+7||MLBGI_ResolveAddress(&t,0x0400000c)!=code+12||MLBGI_ResolveAddress(&t,5)!=global+5)return 3;
 if(MLBGI_WriteInteger(&t,local+1,2,0x89abcdef)||local[1]!=0xef||local[4]!=0x89||MLBGI_ReadInteger(&t,local+1,2)!=0x89abcdef)return 4;
 if(MLBGI_ReadInteger(&t,local+1,0)!=0xffffffef||MLBGI_ReadInteger(&t,local+1,1)!=0xffffcdef)return 5;
 uint32_t bg[]={2};if(!service(&t,0x80,0x52,bg,1,&result)||result||t.stackPointer||s->backgroundPolicy!=2||!MLBGI_ShouldExecute(&e,0))return 6;
 uint32_t wheelPolicy[]={0};service(&t,0x90,0xdd,wheelPolicy,1,&result);if(result||Thread_PopStack(&t)!=1||s->wheelObjectNavigation)return 133;
 wheelPolicy[0]=0xffffffff;service(&t,0x90,0xdd,wheelPolicy,1,&result);if(result||Thread_PopStack(&t)||s->wheelObjectNavigation!=0xffffffff)return 134;
 wheelPolicy[0]=1;service(&t,0x90,0xdd,wheelPolicy,1,&result);if(result||Thread_PopStack(&t)!=0xffffffff||s->wheelObjectNavigation!=1)return 135;
 uint32_t order[]={65535};service(&t,0x90,9,order,1,&result);if(result||t.stackPointer||s->drawOrderBase!=0xffff0000||!s->drawOrderDirty)return 137;
 order[0]=65536;service(&t,0x90,9,order,1,&result);if(result!=UINT32_MAX-3||!t.error||s->drawOrderBase!=0xffff0000||!s->drawOrderDirty)return 138;t.error=0;
 order[0]=0;service(&t,0x90,9,order,1,&result);if(result||t.stackPointer||s->drawOrderBase)return 139;
 uint32_t textTiming[]={0xfffffff9,0x7fffffff};service(&t,0x90,0x9b,textTiming,2,&result);if(result||t.stackPointer||s->textTiming[0]!=-7||s->textTiming[1]!=INT32_MAX)return 140;
 textTiming[0]=textTiming[1]=0;service(&t,0x90,0x9b,textTiming,2,&result);if(result||t.stackPointer||s->textTiming[0]||s->textTiming[1])return 141;
 bg[0]=0;service(&t,0x80,0x52,bg,1,&result);if(MLBGI_ShouldExecute(&e,0)||!MLBGI_ShouldExecute(&e,1))return 7;
 uint32_t dims[]={7,1280,960};service(&t,0x81,0x60,dims,3,&result);if(t.stackPointer!=1||Thread_PopStack(&t)||s->displayWidths[7]!=1280||s->displayHeights[7]!=960)return 8;
 dims[0]=8;service(&t,0x81,0x60,dims,3,&result);if(Thread_PopStack(&t)!=1||s->displayWidths[7]!=1280)return 9;
 dims[0]=7;dims[1]=0;service(&t,0x81,0x60,dims,3,&result);if(Thread_PopStack(&t)!=2||s->displayWidths[7]!=1280)return 10;
 uint32_t request[]={7,1,0};service(&t,0x80,0x60,request,3,&result);if(t.stackPointer||s->displaySlot!=7||s->displayKind!=1||s->displayFlags)return 11;
 uint32_t policy[]={1};service(&t,0x81,0x62,policy,1,&result);if(Thread_PopStack(&t)!=1||s->windowPolicy!=1)return 12;
 policy[0]=2;service(&t,0x81,0x62,policy,1,&result);if(Thread_PopStack(&t)!=0||s->windowPolicy!=1)return 13;
 policy[0]=2;service(&t,0x81,0x63,policy,1,&result);if(Thread_PopStack(&t)!=1||s->scalingPolicy!=2)return 14;
 uint32_t output[]={0x08000008};service(&t,0x81,0x0e,output,1,&result);if(t.stackPointer||MLBGI_ReadInteger(&t,local+8,2)!=1280||MLBGI_ReadInteger(&t,local+12,2)!=960)return 15;
 s->monitorWidth=5120;s->monitorHeight=1440;service(&t,0x81,0x0e,output,1,&result);if(MLBGI_ReadInteger(&t,local+8,2)!=2560||MLBGI_ReadInteger(&t,local+12,2)!=1440)return 16;
 uint32_t client[]={1024,768};service(&t,0x81,0x64,client,2,&result);if(s->clientWidth!=1024||s->clientHeight!=768||s->automaticClientSize||t.stackPointer)return 26;
 client[0]=0;service(&t,0x81,0x64,client,2,&result);if(s->clientWidth!=1280||s->clientHeight!=960||!s->automaticClientSize)return 27;
 if(!MLBGI_TryService(&t,0x81,0x77,&result)||result!=0xffffffff||t.stackPointer||t.error)return 17;
 if(!MLBGI_TryService(&t,0x90,0x04,&result)||result!=0xffffffff||t.stackPointer||t.error)return 28;
 uint32_t fps[]={60};service(&t,0x90,0x02,fps,1,&result);if(s->frameMilliseconds!=16||t.stackPointer)return 30;
 uint32_t frame[]={0};service(&t,0x90,0,frame,1,&result);if(!s->framePending||s->frameFlags||MLBGI_FrameDue(&e,15)||!MLBGI_FrameDue(&e,16))return 31;
 frame[0]=1;service(&t,0x90,0,frame,1,&result);if(s->frameFlags!=1)return 32;
 MLBGI_FramePresented(&e,16);if(s->framePending||MLBGI_FrameDue(&e,40))return 33;
 uint32_t cache[]={1024};service(&t,0x90,3,cache,1,&result);if(s->imageCacheLimit!=1024||!MLBGI_AccountBitmap(&e,0,800)||MLBGI_AccountBitmap(&e,0,300)||s->imageCacheBytes!=800||!MLBGI_AccountBitmap(&e,800,500))return 34;
 uint32_t codec[]={0x01220000,1};service(&t,0x91,0x0a,codec,2,&result);if(Thread_PopStack(&t)!=1||s->codecOptions[0]!=1)return 35;
 codec[0]=0x80111600;codec[1]=7;service(&t,0x91,0x0a,codec,2,&result);if(Thread_PopStack(&t)!=1||s->codecOptions[1]!=7)return 36;
 codec[0]=0x01220001;service(&t,0x91,0x0a,codec,2,&result);if(Thread_PopStack(&t)!=0||s->codecOptions[1]!=7)return 37;
 if(!MLBGI_TryService(&t,0x80,0x0d,&result)||result||t.stackPointer!=2)return 38;
 uint32_t available=Thread_PopStack(&t),total=Thread_PopStack(&t);if(!total||available>total||total>0x7fffffff)return 39;
 uint32_t before=MLBGI_Milliseconds();service(&t,0x80,4,NULL,0,&result);uint32_t now=Thread_PopStack(&t);if(result||now-before>1000||now==0xdeadbeef)return 40;
 uint32_t timer[]={100};service(&t,0x80,0x58,timer,1,&result);if(result||t.unknownTimestamp-now<100||t.unknownTimestamp-now>1100)return 41;
 t.mlWaitActive=1;t.mlWaitDeadline=100;t.nextInstructionPointer=19;
 if(MLBGI_ThreadReady(&t,99)||t.nextInstructionPointer!=19||!t.mlWaitActive||!MLBGI_ThreadReady(&t,100)||t.mlWaitActive)return 69;
 t.mlWaitActive=1;t.mlWaitDeadline=5;if(MLBGI_ThreadReady(&t,UINT32_MAX-4)||MLBGI_ThreadReady(&t,4)||!MLBGI_ThreadReady(&t,5)||t.mlWaitActive)return 70;
 t.unknownTimestamp=MLBGI_Milliseconds()+2000;service(&t,0x80,0x5a,NULL,0,&result);
 if(result!=2||Thread_PopStack(&t)!=1||!t.mlWaitActive||t.mlWaitDeadline!=t.unknownTimestamp||MLBGI_ThreadReady(&t,t.mlWaitDeadline-1)||!MLBGI_ThreadReady(&t,t.mlWaitDeadline))return 71;
 t.unknownTimestamp=MLBGI_Milliseconds()-1;service(&t,0x80,0x5a,NULL,0,&result);if(result!=2||Thread_PopStack(&t)||t.mlWaitActive)return 72;
 timer[0]=2000;service(&t,0x80,0x59,timer,1,&result);if(result||Thread_PopStack(&t)!=1||t.stackPointer)return 73;
 uint32_t timedWait[]={50,0,27};service(&t,0x80,0x5c,timedWait,3,&result);
 if(result!=2||t.error||t.stackPointer||!t.mlWaitOutputPending||!t.mlWaitActive||t.mlWaitInputEnabled)return 220;
 t.mlWaitDeadline=100;if(MLBGI_ThreadReady(&t,99)||t.stackPointer||!MLBGI_ThreadReady(&t,100)||t.stackPointer!=1||Thread_PopStack(&t)||t.mlWaitOutputPending||t.mlWaitActive)return 221;
 if(!MLBGI_ThreadReady(&t,101)||t.stackPointer)return 222;
 MLBGI_InputEvent(&s->input,13,1,0,90);MLBGI_InputEvent(&s->input,13,0,0,91);
 timedWait[1]=1;timedWait[2]=0;service(&t,0x80,0x5c,timedWait,3,&result);t.mlWaitDeadline=100;
 if(result!=2||t.stackPointer||MLBGI_ThreadReady(&t,99)||!t.mlWaitActive)return 223;
 MLBGI_InputEvent(&s->input,65,1,0,92);if(MLBGI_ThreadReady(&t,99)||t.stackPointer)return 224;
 MLBGI_InputEvent(&s->input,13,1,0,93);if(!MLBGI_ThreadReady(&t,99)||Thread_PopStack(&t)!=1||t.mlWaitActive||t.mlWaitOutputPending||!MLBGI_ThreadReady(&t,99)||t.stackPointer)return 225;
 MLBGI_InputEvent(&s->input,17,1,0,94);service(&t,0x80,0x5c,timedWait,3,&result);t.mlWaitDeadline=100;
 if(result!=2||t.stackPointer||!MLBGI_ThreadReady(&t,95)||Thread_PopStack(&t)!=1)return 226;MLBGI_ReleaseInput(&s->input);
 timedWait[0]=0;timedWait[1]=0;service(&t,0x80,0x5c,timedWait,3,&result);if(result!=2||t.stackPointer||!MLBGI_ThreadReady(&t,t.mlWaitDeadline)||Thread_PopStack(&t))return 227;
 timedWait[0]=0x80000000;service(&t,0x80,0x5c,timedWait,3,&result);if(result!=UINT32_MAX-3||!t.error||t.mlWaitActive||t.mlWaitOutputPending||t.stackPointer)return 228;t.error=0;
 timedWait[0]=50;timedWait[1]=1;timedWait[2]=1;service(&t,0x80,0x5c,timedWait,3,&result);if(result!=UINT32_MAX-3||!t.error||t.mlWaitActive||t.stackPointer)return 229;t.error=0;
 MLBGI_ClearInput(&s->input);
 uint32_t messageOutput[]={0x08000001},messageArgs[]={0x76543210,0xfedcba98};memset(local+1,0xa5,12);
 service(&t,0x80,0xa0,messageOutput,1,&result);if(result||Thread_PopStack(&t)||s->messageCount)return 201;
 for(unsigned i=1;i<13;i++)if(local[i]!=0xa5)return 202;
 service(&t,0x80,0xa1,messageArgs,2,&result);if(result||t.stackPointer||s->messageCount!=1)return 203;
 if(!MLBGI_PostMessage(&e,7,8,9))return 204;
 messageOutput[0]=0x0800001a;service(&t,0x80,0xa0,messageOutput,1,&result);
 if(result!=UINT32_MAX-3||!t.error||s->messageCount!=2||t.stackPointer)return 205;t.error=0;
 messageOutput[0]=0x08000001;service(&t,0x80,0xa0,messageOutput,1,&result);
 if(result||Thread_PopStack(&t)!=1||s->messageCount!=1||MLBGI_ReadInteger(&t,local+1,2)||MLBGI_ReadInteger(&t,local+5,2)!=messageArgs[0]||MLBGI_ReadInteger(&t,local+9,2)!=messageArgs[1])return 206;
 service(&t,0x80,0xa0,messageOutput,1,&result);
 if(result||Thread_PopStack(&t)!=1||s->messageCount||MLBGI_ReadInteger(&t,local+1,2)!=7||MLBGI_ReadInteger(&t,local+5,2)!=8||MLBGI_ReadInteger(&t,local+9,2)!=9)return 207;
 Engine_t otherEngine={0};if(!MLBGI_ConfigureDialect(&otherEngine,"ethornell-1.72",1280,960)||!MLBGI_PostMessage(&otherEngine,1,2,3))return 208;
 for(unsigned i=0;i<MLBGI_MESSAGE_CAPACITY;i++)if(!MLBGI_PostMessage(&e,4,i,~i))return 209;
 if(MLBGI_PostMessage(&e,5,6,7)||((MLBGI_Runtime*)otherEngine.mlRuntime)->messageCount!=1)return 210;
 service(&t,0x80,0xa1,messageArgs,2,&result);if(result!=UINT32_MAX-3||!t.error||s->messageCount!=MLBGI_MESSAGE_CAPACITY)return 211;t.error=0;
 for(unsigned i=0;i<MLBGI_MESSAGE_CAPACITY;i++){
  service(&t,0x80,0xa0,messageOutput,1,&result);if(result||Thread_PopStack(&t)!=1||MLBGI_ReadInteger(&t,local+1,2)!=4||MLBGI_ReadInteger(&t,local+5,2)!=i||MLBGI_ReadInteger(&t,local+9,2)!=~i)return 212;
 }
 if(s->messageCount||!MLBGI_PostMessage(&e,10,11,12))return 213;
 service(&t,0x80,0xa0,messageOutput,1,&result);if(result||Thread_PopStack(&t)!=1||MLBGI_ReadInteger(&t,local+1,2)!=10||MLBGI_ReadInteger(&t,local+5,2)!=11||MLBGI_ReadInteger(&t,local+9,2)!=12)return 214;
 MLBGI_FreeDialect(&otherEngine);free(otherEngine.globalMem);
 const unsigned char encodedCaption[]={0x83,0x65,0x83,0x58,0x83,0x67,0},utf8Caption[]={0xe3,0x83,0x86,0xe3,0x82,0xb9,0xe3,0x83,0x88,0};
 memcpy(code+48,encodedCaption,sizeof(encodedCaption));uint32_t captionArgs[]={0x04000030};
 service(&t,0x80,0x66,captionArgs,1,&result);if(result||t.stackPointer||!s->captionConfigured||strcmp(s->windowCaption,(const char*)utf8Caption))return 74;
 code[48]=0x81;code[49]=0;service(&t,0x80,0x66,captionArgs,1,&result);if(result!=UINT32_MAX-3||!t.error||strcmp(s->windowCaption,(const char*)utf8Caption)||t.stackPointer)return 75;t.error=0;
 uint32_t close[]={1};service(&t,0x80,0x68,close,1,&result);if(MLBGI_WindowCloseAllowed(&e)||t.stackPointer)return 42;
 close[0]=0;service(&t,0x80,0x68,close,1,&result);if(!MLBGI_WindowCloseAllowed(&e))return 43;
 uint32_t seed[]={0x80111600};service(&t,0x80,0,seed,1,&result);if(s->randomState!=seed[0]||t.stackPointer)return 44;
 service(&t,0x80,0xfd,NULL,0,&result);if(Thread_PopStack(&t))return 45;s->launcherContext=1;service(&t,0x80,0xfd,NULL,0,&result);if(Thread_PopStack(&t)!=1)return 46;
 memcpy(code+32,"Typeface",9);uint32_t name[]={0x04000020,0xffffffff};service(&t,0xb0,0xc1,name,2,&result);if(result||Thread_PopStack(&t)!=2||s->nameCount!=3||strcmp(s->names[2],"Typeface"))return 47;
 name[1]=0;service(&t,0xb0,0xc1,name,2,&result);if(Thread_PopStack(&t)!=2||s->nameCount!=3||s->nameFlags[2]!=0x80)return 48;
 name[1]=1;service(&t,0xb0,0xc1,name,2,&result);if(Thread_PopStack(&t)!=2||s->nameFlags[2]!=1)return 49;
 uint32_t transform[]={0x04000020,0,0,0,0};service(&t,0x91,0x0e,transform,5,&result);if(result||t.stackPointer||s->nameCount!=3)return 53;
 transform[1]=0x10000;transform[2]=0x20000;transform[3]=0;transform[4]=(uint32_t)-32768;service(&t,0x91,0x0e,transform,5,&result);if(result||s->fontTransforms[2][1]!=0x20000||s->fontTransforms[2][3]!=-32768)return 54;
 transform[4]=0;service(&t,0x91,0x0e,transform,5,&result);if(result!=0xfffffffc||!t.error||s->fontTransforms[2][3]!=-32768)return 55;t.error=0;
 uint32_t font[]={2,32,100,0,1024};service(&t,0x90,0x0e,font,5,&result);if(result||t.stackPointer||s->fontCount!=1||s->fonts[0].family!=2||s->fonts[0].cacheKiB!=1024)return 56;
 font[4]=512;service(&t,0x90,0x0e,font,5,&result);if(result||s->fontCount!=1||s->fonts[0].cacheKiB!=512)return 57;
 font[1]=3;service(&t,0x90,0x0e,font,5,&result);if(result!=0xfffffffc||!t.error||s->fontCount!=1)return 58;t.error=0;
 uint32_t aa[]={2};service(&t,0x90,0x0d,aa,1,&result);if(result||s->antialiasLevel!=2)return 59;
 uint32_t shadow[]={1,1,192};service(&t,0x90,0x9d,shadow,3,&result);if(result||t.error||t.stackPointer||s->textShadowWidthPercent!=1||s->textShadowHeightPercent!=1||s->textShadowOpacity!=192)return 137;
 shadow[0]=101;shadow[2]=255;service(&t,0x90,0x9d,shadow,3,&result);if(result||t.error||s->textShadowWidthPercent!=1||s->textShadowOpacity!=192)return 138;
 shadow[0]=UINT32_MAX;service(&t,0x90,0x9d,shadow,3,&result);if(result!=UINT32_MAX-3||!t.error||s->textShadowOpacity!=192)return 139;t.error=0;
 shadow[0]=1;shadow[2]=257;service(&t,0x90,0x9d,shadow,3,&result);if(result!=UINT32_MAX-3||!t.error||s->textShadowOpacity!=192)return 140;t.error=0;
 uint32_t shadowEnabled=UINT32_MAX;service(&t,0x90,0x9c,&shadowEnabled,1,&result);if(result||t.error||t.stackPointer||s->textShadowEnabled!=UINT32_MAX)return 141;
 uint32_t ruby[]={0,0,0,34,0,1};service(&t,0x91,0x98,ruby,6,&result);if(result||t.stackPointer||s->rubyConfiguration[1]!=1||s->rubyConfiguration[3]!=34||s->rubyConfiguration[5]!=1)return 71;
 ruby[3]=24;service(&t,0x91,0x98,ruby,6,&result);if(result!=0xfffffffc||!t.error||s->rubyConfiguration[3]!=34)return 72;t.error=0;
 uint32_t pair[]={1,0xffffffff};service(&t,0x90,0x95,pair,2,&result);if(result||t.stackPointer||s->renderPairs[0][0]!=1||s->renderPairs[0][1]!=0xffffffff)return 73;
 pair[0]=256;pair[1]=0;service(&t,0x90,0x96,pair,2,&result);if(result||t.stackPointer||s->renderPairs[1][0]!=256||s->renderPairs[1][1])return 74;
 pair[0]=257;service(&t,0x90,0x96,pair,2,&result);if(result!=0xfffffffc||!t.error||s->renderPairs[1][0]!=256)return 75;t.error=0;
 pair[0]=0;service(&t,0x90,0x95,pair,2,&result);if(result!=0xfffffffc||!t.error||s->renderPairs[0][0]!=1||s->renderPairs[0][1]!=0xffffffff)return 76;t.error=0;
 pair[0]=0xffffffff;pair[1]=0x80000000;service(&t,0x90,0x97,pair,2,&result);if(result||t.stackPointer||s->renderPairs[2][0]!=0xffffffff||s->renderPairs[2][1]!=0x80000000)return 77;
 uint32_t cursor[]={30};service(&t,0xb0,5,cursor,1,&result);if(result||t.stackPointer||!s->cursorDelayEnabled||s->cursorDelay!=30||!s->cursorVisible)return 78;
 if(!MLBGI_UpdateCursor(&e,1,2,3,1280,960,100)||s->cursorDeadline!=130||!MLBGI_UpdateCursor(&e,1,2,3,1280,960,129)||MLBGI_UpdateCursor(&e,1,2,3,1280,960,130))return 79;
 if(!MLBGI_UpdateCursor(&e,1,3,3,1280,960,140)||s->cursorDeadline!=170||MLBGI_UpdateCursor(&e,1,3,3,1280,960,170)||!MLBGI_UpdateCursor(&e,0,3,3,1280,960,180))return 80;
 if(!MLBGI_UpdateCursor(&e,1,-1,3,1280,960,220)||s->cursorDeadline!=250||!MLBGI_UpdateCursor(&e,1,1280,960,1280,960,260))return 81;
 cursor[0]=0;service(&t,0xb0,5,cursor,1,&result);if(result||s->cursorDelayEnabled||!s->cursorVisible||!MLBGI_UpdateCursor(&e,1,3,3,1280,960,500))return 82;
 service(&t,0x80,0x61,NULL,0,&result);if(result||Thread_PopStack(&t)!=s->displayKind)return 83;
 MLBGI_WriteInteger(&t,local+8,2,13);MLBGI_WriteInteger(&t,local+12,2,122);MLBGI_WriteInteger(&t,local+16,2,0);
 uint32_t hotkeys[]={1,0x08000008};service(&t,0x80,0x62,hotkeys,2,&result);if(result||t.stackPointer||!MLBGI_DisplayHotkey(&e,13)||!MLBGI_DisplayHotkey(&e,122)||MLBGI_DisplayHotkey(&e,32))return 84;
 hotkeys[1]=0x0800001e;service(&t,0x80,0x62,hotkeys,2,&result);if(result!=0xfffffffc||!t.error||!MLBGI_DisplayHotkey(&e,13))return 85;t.error=0;
 hotkeys[0]=0;hotkeys[1]=0;service(&t,0x80,0x62,hotkeys,2,&result);if(result||MLBGI_DisplayHotkey(&e,13)||s->displayHotkeys[1]!=122)return 86;
 hotkeys[0]=1;service(&t,0x80,0x62,hotkeys,2,&result);if(result||s->displayHotkeys[0]||MLBGI_DisplayHotkey(&e,13))return 87;
 if(s->audioChannelVolumes[0]!=128||s->audioEffectVolumes[127]!=128)return 88;
 uint32_t volume[]={15,76};service(&t,0xa0,8,volume,2,&result);if(result||t.stackPointer||s->audioChannelVolumes[15]!=76)return 89;
 volume[0]=127;volume[1]=0;service(&t,0xa0,9,volume,2,&result);if(result||s->audioEffectVolumes[127])return 90;
 volume[0]=16;volume[1]=75;service(&t,0xa0,8,volume,2,&result);if(result!=0xfffffffc||!t.error||s->audioChannelVolumes[15]!=76)return 91;t.error=0;
 volume[0]=127;volume[1]=129;service(&t,0xa0,9,volume,2,&result);if(result!=0xfffffffc||!t.error||s->audioEffectVolumes[127])return 92;t.error=0;
 MLBGI_WriteInteger(&t,local+8,2,32);MLBGI_WriteInteger(&t,local+12,2,13);MLBGI_WriteInteger(&t,local+16,2,0);
 uint32_t mapping[]={256,0x08000008};service(&t,0x80,0x1b,mapping,2,&result);if(result||t.stackPointer||s->input.maps[7][0]!=32||s->input.maps[7][1]!=13)return 93;
 MLBGI_InputEvent(&s->input,32,1,0,100);uint32_t mask[]={256};service(&t,0x80,0x1c,mask,1,&result);if(result||Thread_PopStack(&t)!=1)return 94;
 mapping[0]=1;service(&t,0x80,0x1b,mapping,2,&result);if(result!=0xfffffffc||!t.error||s->input.maps[0][0]!=1)return 95;t.error=0;
 uint32_t visible[]={1};service(&t,0x80,0x64,visible,1,&result);if(result||t.stackPointer||!s->windowVisible||s->input.events[32]||s->input.held[32]||s->input.maps[7][0]!=32)return 96;
 visible[0]=0;service(&t,0x80,0x64,visible,1,&result);if(result||s->windowVisible)return 97;
 t.threadId=77;service(&t,0x80,0x46,NULL,0,&result);if(result||Thread_PopStack(&t)!=77)return 98;
 uint32_t opacity[]={1,256};service(&t,0x90,0x0c,opacity,2,&result);if(result||t.stackPointer||s->effectOpacity!=256||s->effectOpacityEnabled!=1)return 99;
 opacity[1]=257;service(&t,0x90,0x0c,opacity,2,&result);if(result!=0xfffffffc||!t.error||s->effectOpacity!=256)return 100;t.error=0;
 uint32_t canvas[]={0,2};service(&t,0x90,0x4c,canvas,2,&result);if(result||t.stackPointer||s->canvasEnabled||s->canvasBackground!=2)return 101;
 uint32_t skip[]={100};service(&t,0x90,7,skip,1,&result);if(result||t.stackPointer||s->skipInterval!=100||!MLBGI_SkipWait(&e,0,100)||s->skipDeadline!=200||!MLBGI_SkipWait(&e,0,199)||!MLBGI_SkipWait(&e,1,200)||MLBGI_SkipWait(&e,0,201)||s->skipDeadline)return 102;
 skip[0]=0;service(&t,0x90,7,skip,1,&result);if(result||MLBGI_SkipWait(&e,0,210)||!MLBGI_SkipWait(&e,1,220))return 103;
 uint32_t attribute[]={0x80000004,1};service(&t,0x91,0x9a,attribute,2,&result);if(result||t.stackPointer||s->renderAttributes[5]!=1)return 63;
 attribute[0]=0x80000001;attribute[1]=0xffffffff;service(&t,0x91,0x9a,attribute,2,&result);if(result!=0xfffffffc||!t.error)return 64;t.error=0;
 uint32_t focus[]={1};service(&t,0x90,0xaf,focus,1,&result);if(result||MLBGI_ShouldRender(&e,0)||!MLBGI_ShouldRender(&e,1))return 65;
 uint32_t actor[]={1};service(&t,0x80,0xaf,actor,1,&result);if(result||Thread_PopStack(&t)!=1||s->actorPolicy!=1)return 66;
 actor[0]=2;service(&t,0x80,0xaf,actor,1,&result);if(Thread_PopStack(&t)||s->actorPolicy!=1)return 67;
 memcpy(code+32,"Script\\\\CVTD",12);uint32_t path[]={0x04000020};service(&t,0x80,0x37,path,1,&result);if(result||t.stackPointer||s->searchPathCount!=1||strcmp(s->searchPaths[0],"Script\\\\CVTD"))return 60;
 uint32_t enable[]={1};service(&t,0x80,0x36,enable,1,&result);if(result||s->searchDirectoriesEnabled!=1||t.stackPointer)return 61;
 memcpy(code+32,"../Escape",10);service(&t,0x80,0x37,path,1,&result);if(result!=0xfffffffc||!t.error||s->searchPathCount!=1)return 62;t.error=0;
 code[40]=1;name[0]=0x0400003f;code[63]=1;service(&t,0xb0,0xc1,name,2,&result);if(result!=0xfffffffc||!t.error||t.stackPointer)return 50;t.error=0;code[63]=0;
 if(MLBGI_ResolveAddress(&t,0x10000007)||!t.error)return 18;t.error=0;
 if(MLBGI_ResolveAddress(&t,0x08000020)||!t.error)return 19;t.error=0;
 if(MLBGI_ReadInteger(&t,local+31,2)||!t.error)return 20;t.error=0;
 output[0]=0x0800001c;service(&t,0x81,0x0e,output,1,&result);if(result!=0xfffffffc||!t.error)return 21;t.error=0;
 if(!MLBGI_TryService(&t,0x80,0x52,&result)||!t.error||result!=0xfffffffc)return 22;t.error=0;
 memcpy(code+32,"child._bp",10);memcpy(code+44,"system.arc",11);uint32_t load[]={0x0400002c,0x04000020};
 service(&t,0x80,0x40,load,2,&result);if(result||t.error||Thread_PopStack(&t)!=64||t.codeSpaceUsed!=67||t.programCount!=1||code[65]!=9)return 68;
 service(&t,0x80,0x41,NULL,0,&result);if(result||Thread_PopStack(&t)||t.codeSpaceUsed!=64||t.programCount||t.programs||code[65])return 69;
 memcpy(code+32,"bad._bp",8);memcpy(code+44,"bad.arc",8);service(&t,0x80,0x40,load,2,&result);if(result!=0xfffffffc||!t.error||t.codeSpaceUsed!=64||t.programCount||t.programs)return 70;t.error=0;
 MLBGI_FreeDialect(&e);if(e.mlRuntime||!MLBGI_ConfigureDialect(&e,"legacy-v1",640,480))return 23;
 if(MLBGI_LocalAddress(&t,7)!=0x10000007||MLBGI_CodeAddress(&t,12)!=0x1100000c||MLBGI_ResolveAddress(&t,0x10000007)!=local+7)return 24;
 if(MLBGI_TryService(&t,0x80,0x52,&result)||!MLBGI_ShouldExecute(&e,0))return 25;
 MLBGI_FreeDialect(&e);Engine_t initial={0};if(!MLBGI_ConfigureDialect(&initial,"ethornell-1.72",1280,960)||!initial.globalMem||initial.globalBufferSize!=65536||initial.globalMem[0x400])return 29;
 Thread_t it={0};uint32_t initialStack[4]={0};it.engine=&initial;it.stack=initialStack;it.stackSize=4;uint32_t level[]={5};
 service(&it,0x80,0x70,level,1,&result);if(Thread_PopStack(&it)!=1||initial.globalBufferSize!=131072||initial.globalMem[0x400])return 51;
 uint8_t*memory=initial.globalMem;level[0]=13;service(&it,0x80,0x70,level,1,&result);if(Thread_PopStack(&it)||initial.globalMem!=memory||initial.globalBufferSize!=131072)return 52;
 MLBGI_FreeDialect(&initial);free(initial.globalMem);return 0;
}
`);
  const result = spawnSync("clang", ["-std=c11", process.platform === "darwin" ? "-D_DARWIN_C_SOURCE" : "-D_POSIX_C_SOURCE=200809L", "-fsanitize=address,undefined",
    "-I", headers, "-I", path.resolve("src/modules/bgi/native"), ...["vm-dialect.c", "vm-guards.c", "archive-reader.c", "state-files.c", "vm-strings.c", "vm-input.c"].map(name => path.resolve("src/modules/bgi/native", name)), driver, ...(process.platform === "darwin" ? ["-liconv"] : []), "-lm", "-o", executable], { encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  const run = spawnSync(executable, [stateRoot], { cwd: root, encoding: "utf8", timeout: 10000, env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" } });
  assert.equal(run.status, 0, run.stderr); assert.doesNotMatch(run.stderr, /runtime error|AddressSanitizer/);
});

test("actual adapted basic opcodes preserve signed relative addresses and modern conditional branches", { skip: !initialized }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-basic-dialect-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const headers = path.join(root, "headers"); fs.mkdirSync(path.join(headers, "SDL2"), { recursive: true });
  fs.writeFileSync(path.join(headers, "SDL2/SDL.h"), "typedef struct SDL_Window SDL_Window;\n");
  for (const name of ["engine.h", "thread.h"]) fs.writeFileSync(path.join(headers, name), Overlay.patch(`src/${name}`, fs.readFileSync(path.join(upstream, "src", name))));
  const patched = Overlay.patch("src/opcodes.c", fs.readFileSync(path.join(upstream, "src/opcodes.c"))).toString();
  assert.match(patched, /\/\* 0x63\s+99 \*\/ MLBGI_EqualMemory,/);
  assert.match(patched, /\/\* 0x48\s+72 \*\/ MLBGI_FixedSine,/);
  assert.match(patched, /\/\* 0x49\s+73 \*\/ MLBGI_FixedCosine,/);
  const actual = ["CodeOffset", "CodeAddr", "BaseOffset", "CondJump", "Leq", "Ternary", "Sprintf", "Strcpy", "Strlen", "Streq", "Memcpy", "Memclr"].map(name => {
    const start = patched.indexOf(`uint32_t Opcode_${name}(`), found = patched.indexOf("\nuint32_t ", start + 1), end = found < 0 ? patched.length : found;
    assert.ok(start >= 0 && end > start, name); return patched.slice(start, end);
  }).join("\n");
  const patchedThread = Overlay.patch("src/thread.c", fs.readFileSync(path.join(upstream, "src/thread.c"))).toString();
  const readerStart = patchedThread.indexOf("uint32_t Thread_ReadCode32("), readerEnd = patchedThread.indexOf("\nvoid Thread_PushStack(", readerStart + 1);
  assert.ok(readerStart >= 0 && readerEnd > readerStart);
  const actualReader = patchedThread.slice(readerStart, readerEnd);
  const stackStart = patchedThread.indexOf("void Thread_PushStack("), stackEnd = patchedThread.indexOf("void Thread_SchedulePush(", stackStart);
  assert.ok(stackStart >= 0 && stackEnd > stackStart);
  const actualStack = patchedThread.slice(stackStart, stackEnd);
  fs.copyFileSync(path.join(upstream, "src/golden_log.h"), path.join(headers, "golden_log.h"));
  const driver = path.join(root, "basic.c"), binary = path.join(root, "basic");
  fs.writeFileSync(driver, `#include "vm-dialect.h"
#include "vm-guards.h"
#include "vm-strings.h"
#include "golden_log.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int GoldenLogTotal=0,GoldenLogIndex=0;GLogEntry_t*GoldenLog=NULL;char*TLevel[4]={"","","",""};
${actualStack}
uint8_t Thread_ReadCode8(Thread_t*t){return MLBGI_CodeAvailable(t,1)?t->code[t->nextInstructionPointer++]:0;}
uint16_t Thread_ReadCode16(Thread_t*t){uint16_t a=Thread_ReadCode8(t);return a|((uint16_t)Thread_ReadCode8(t)<<8);}
uint32_t Thread_GetInstructionPointer(Thread_t*t){return t->instructionPointer;}
uint32_t Thread_GetBasePointer(Thread_t*t){return t->basePointer;}
void Thread_SetInstructionPointer(Thread_t*t,uint32_t v){if(v>=t->codeSpaceUsed){t->error=1;return;}t->nextInstructionPointer=v;}
${actual}
${actualReader}
int main(void){Engine_t e={0};Thread_t t={0};uint8_t code[64]={0},local[64]={0};uint32_t stack[16]={0};
t.engine=&e;e.threads=&t;t.code=code;t.codeSpaceUsed=64;t.localMem=local;t.localMemSize=64;t.stack=stack;t.stackSize=16;
if(!MLBGI_ConfigureDialect(&e,"ethornell-1.72",1920,1080))return 1;
t.instructionPointer=20;t.nextInstructionPointer=0;code[0]=0xf6;code[1]=0xff;
if(Opcode_CodeOffset(&t)||Thread_PopStack(&t)!=10)return 2;
t.nextInstructionPointer=0;if(Opcode_CodeAddr(&t)||Thread_PopStack(&t)!=0x0400000a)return 3;
t.nextInstructionPointer=0;t.basePointer=32;code[0]=4;code[1]=0;
if(Opcode_BaseOffset(&t)||Thread_PopStack(&t)!=0x0800001c)return 4;
Thread_PushStack(&t,(uint32_t)-3);Thread_PushStack(&t,(uint32_t)-2);
if(Opcode_Leq(&t)||Thread_PopStack(&t)!=1)return 5;
Thread_PushStack(&t,1920);Thread_PushStack(&t,1280);
if(Opcode_Leq(&t)||Thread_PopStack(&t)!=0)return 6;
Thread_PushStack(&t,0);Thread_PushStack(&t,1920);Thread_PushStack(&t,1280);
if(Opcode_Ternary(&t)||Thread_PopStack(&t)!=1280)return 7;
for(unsigned mode=0;mode<6;mode++){t.nextInstructionPointer=0;code[0]=mode;Thread_PushStack(&t,(uint32_t)-1);Thread_PushStack(&t,12);if(Opcode_CondJump(&t))return 8;int take=mode==0||mode==2||mode==4;if(t.nextInstructionPointer!=(take?12:1))return 9;}
t.nextInstructionPointer=0;code[0]=6;Thread_PushStack(&t,1);Thread_PushStack(&t,12);
if(Opcode_CondJump(&t)!=0xfffffffc||!t.error)return 10;t.error=0;
t.instructionPointer=0;t.nextInstructionPointer=0;code[0]=0xff;code[1]=0xff;
if(Opcode_CodeAddr(&t)!=0xfffffffc||!t.error||t.stackPointer)return 11;
t.error=0;t.inBasicOpcode=1;t.silenceBasicOpcodeLog=1;t.nextInstructionPointer=0;code[0]=0;code[1]=0x16;code[2]=0x11;code[3]=0x80;
if(Thread_ReadCode32(&t)!=0x80111600||t.nextInstructionPointer!=4||t.error)return 12;
t.nextInstructionPointer=0;for(unsigned i=0;i<4;i++)code[i]=0xff;if(Thread_ReadCode32(&t)!=0xffffffff||t.error)return 13;
t.nextInstructionPointer=61;if(Thread_ReadCode32(&t)||!t.error||t.nextInstructionPointer!=61)return 14;
t.error=0;memcpy(code+32,"%s-%d",6);memcpy(code+42,"Unit",5);Thread_PushStack(&t,(uint32_t)-7);Thread_PushStack(&t,0x0400002a);Thread_PushStack(&t,0x08000020);Thread_PushStack(&t,0x04000020);
if(Opcode_Sprintf(&t)||strcmp((char*)local+32,"Unit--7")||t.stackPointer)return 15;
Thread_PushStack(&t,0x08000010);Thread_PushStack(&t,0x08000020);if(Opcode_Strcpy(&t)||strcmp((char*)local+16,"Unit--7"))return 16;
Thread_PushStack(&t,0x08000010);if(Opcode_Strlen(&t)||Thread_PopStack(&t)!=7)return 17;
Thread_PushStack(&t,0x08000010);Thread_PushStack(&t,0x08000020);if(Opcode_Streq(&t)||Thread_PopStack(&t)!=1)return 18;
Thread_PushStack(&t,0x0800003e);Thread_PushStack(&t,0x08000020);if(Opcode_Strcpy(&t)!=0xfffffffc||!t.error||local[62])return 19;t.error=0;
Thread_PushStack(&t,0x0800003e);Thread_PushStack(&t,0x08000020);Thread_PushStack(&t,4);if(Opcode_Memcpy(&t)!=0xfffffffc||!t.error||local[62])return 20;t.error=0;
memcpy(code+32,"%n",3);Thread_PushStack(&t,0x08000030);Thread_PushStack(&t,0x04000020);if(Opcode_Sprintf(&t)!=0xfffffffc||!t.error||local[48])return 21;
t.error=0;t.running=1;t.stackPointer=16;stack[0]=0x12345678;Thread_PushStack(&t,0x87654321);
if(!t.error||t.running||t.stackPointer!=16||stack[0]!=0x12345678)return 22;
t.error=0;t.running=1;t.stackPointer=0;stack[15]=0x76543210;if(Thread_PopStack(&t)!=0x76543210||t.error||!t.running||t.stackPointer!=15)return 23;
t.error=0;t.running=1;t.stackPointer=17;if(Thread_PopStack(&t)||!t.error||t.running||t.stackPointer!=17)return 24;
t.error=0;t.running=1;t.stackPointer=0;for(unsigned i=0;i<16;i++)Thread_PushStack(&t,i);
if(t.error||t.stackPointer)return 25;for(unsigned i=16;i>0;i--)if(Thread_PopStack(&t)!=i-1)return 26;
if(t.error||t.stackPointer)return 27;
for(unsigned i=0;i<18;i++)Thread_PushStack(&t,i);
if(t.error||t.stackPointer!=2||stack[0]!=16||stack[1]!=17||stack[15]!=15)return 28;
if(Thread_PopStack(&t)!=17||Thread_PopStack(&t)!=16||Thread_PopStack(&t)!=15||t.error||t.stackPointer!=15)return 29;
t.stackPointer=0;for(unsigned i=0;i<10000;i++){Thread_PushStack(&t,i);Thread_PushStack(&t,~i);if(Thread_PopStack(&t)!=~i||Thread_PopStack(&t)!=i||t.error||t.stackPointer)return 30;}
t.stackPointer=15;Thread_PushStack(&t,0x08000010);Thread_PushStack(&t,0x0400002a);
if(Opcode_Strcpy(&t)||t.error||strcmp((char*)local+16,"Unit")||t.stackPointer!=15)return 31;
t.stackSize=0;t.stackPointer=0;Thread_PushStack(&t,7);if(!t.error||t.running||t.stackPointer)return 32;
t.stackSize=16;t.stackPointer=0;t.error=0;t.running=1;
for(unsigned i=0;i<8;i++)code[8+i]=local[8+i]=(uint8_t)(i*31);code[9]=local[9]=0;
Thread_PushStack(&t,0x08000008);Thread_PushStack(&t,0x04000008);Thread_PushStack(&t,8);
if(MLBGI_EqualMemory(&t)||t.error||Thread_PopStack(&t)!=1)return 33;
local[12]^=0x80;Thread_PushStack(&t,0x08000008);Thread_PushStack(&t,0x04000008);Thread_PushStack(&t,8);
if(MLBGI_EqualMemory(&t)||t.error||Thread_PopStack(&t))return 34;
Thread_PushStack(&t,0);Thread_PushStack(&t,0);Thread_PushStack(&t,0);
if(MLBGI_EqualMemory(&t)||t.error||Thread_PopStack(&t)!=1)return 35;
Thread_PushStack(&t,0x0800003e);Thread_PushStack(&t,0x04000008);Thread_PushStack(&t,3);
if(MLBGI_EqualMemory(&t)!=0xfffffffc||!t.error||t.stackPointer)return 36;t.error=0;t.running=1;
Thread_PushStack(&t,0);Thread_PushStack(&t,0x04000008);Thread_PushStack(&t,1);
if(MLBGI_EqualMemory(&t)!=0xfffffffc||!t.error||t.stackPointer)return 37;
t.error=0;t.running=1;
const int32_t degrees[]={0,90,180,270,-90,-180,360,-360};
const int32_t sine[]={0,65536,0,-65536,-65536,0,0,0},cosine[]={65536,0,-65536,0,0,-65536,65536,65536};
for(unsigned i=0;i<8;i++){
 Thread_PushStack(&t,(uint32_t)(degrees[i]*65536));if(MLBGI_FixedSine(&t)||t.error||(int32_t)Thread_PopStack(&t)!=sine[i])return 38;
 Thread_PushStack(&t,(uint32_t)(degrees[i]*65536));if(MLBGI_FixedCosine(&t)||t.error||(int32_t)Thread_PopStack(&t)!=cosine[i])return 39;
}
Thread_PushStack(&t,45*65536);if(MLBGI_FixedSine(&t)||(int32_t)Thread_PopStack(&t)!=46340)return 40;
Thread_PushStack(&t,(uint32_t)(-45*65536));if(MLBGI_FixedCosine(&t)||(int32_t)Thread_PopStack(&t)!=46340)return 41;
Thread_PushStack(&t,INT32_MIN);if(MLBGI_FixedSine(&t)||t.error)return 42;int32_t extreme=(int32_t)Thread_PopStack(&t);if(extreme < -65536 || extreme > 65536)return 43;
Thread_PushStack(&t,INT32_MAX);if(MLBGI_FixedCosine(&t)||t.error)return 44;extreme=(int32_t)Thread_PopStack(&t);if(extreme < -65536 || extreme > 65536)return 45;
((MLBGI_Runtime*)e.mlRuntime)->dialect=MLBGI_LEGACY;Thread_PushStack(&t,123);if(MLBGI_FixedSine(&t)!=0xfffffffc||!t.error||t.stackPointer!=1||stack[0]!=123)return 46;
((MLBGI_Runtime*)e.mlRuntime)->dialect=MLBGI_ETHORNELL_172;t.error=0;t.running=1;t.stackPointer=0;
MLBGI_FreeDialect(&e);free(e.globalMem);return 0;}
`);
  const build = spawnSync("clang", ["-std=c11", process.platform === "darwin" ? "-D_DARWIN_C_SOURCE" : "-D_POSIX_C_SOURCE=200809L", "-fsanitize=address,undefined",
    "-I", headers, "-I", path.resolve("src/modules/bgi/native"), ...["vm-dialect.c", "vm-guards.c", "archive-reader.c", "state-files.c", "vm-strings.c", "vm-input.c"].map(name => path.resolve("src/modules/bgi/native", name)), driver, ...(process.platform === "darwin" ? ["-liconv"] : []), "-lm", "-o", binary], { encoding: "utf8", timeout: 30000 });
  assert.ifError(build.error); assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10000, env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" } });
  assert.equal(run.status, 0, run.stderr); assert.doesNotMatch(run.stderr, /runtime error|AddressSanitizer/);
});
