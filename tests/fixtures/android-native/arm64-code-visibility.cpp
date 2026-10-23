#include "cpu.h"
#include <sys/mman.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
struct Memory {unsigned char *bytes;size_t size,reads=0;};
static int read(void *owner,uint64_t a,void *out,size_t size,int code){auto &m=*static_cast<Memory*>(owner);if(a<uintptr_t(m.bytes)||a-uintptr_t(m.bytes)>m.size||size>m.size-(a-uintptr_t(m.bytes)))return -14;memcpy(out,(void*)a,size);if(!code)m.reads++;return 0;}
static int write(void *owner,uint64_t a,const void *in,size_t size){auto &m=*static_cast<Memory*>(owner);if(a<uintptr_t(m.bytes)||a-uintptr_t(m.bytes)>m.size||size>m.size-(a-uintptr_t(m.bytes)))return -14;memcpy((void*)a,in,size);return 0;}
static void require(bool value,const char *text){if(!value){fprintf(stderr,"FAIL %s\n",text);exit(1);}}
int main(){
 const uint32_t original[]={0xd53bd040,0x10ffffe1,0xb9400022,0x3dc00020,0x94000004,0xd4000001,0x91000c00,0xd4000021,0x91001400,0xd65f03c0};
 auto *bytes=(unsigned char*)mmap(nullptr,16384,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);require(bytes!=MAP_FAILED,"mapping");
 for(int direct=0;direct<2;direct++){
  memcpy(bytes,original,sizeof original);Memory memory{bytes,16384};KlA64Config config{};config.memory={&memory,read,write,nullptr,nullptr};config.direct_memory=direct;config.ctr_el0=0x8444c004;config.cntfrq_el0=1000000000;config.dczid_el0=4;
  KlA64Cpu *cpu=kl_a64_create(config);require(cpu,"CPU");
  for(unsigned turn=0;turn<2;turn++){
   if(turn){uint32_t add=0x91002400;memcpy(bytes+32,&add,4);kl_a64_invalidate(cpu,uintptr_t(bytes)+32,4);}
   KlA64State state{};state.pc=uintptr_t(bytes);state.tpidr_el0=0x123456789abULL;state.sp=uintptr_t(bytes)+16384;state.pstate=0x20000000;state.fpcr=0x800000;state.fpsr=0x10;for(unsigned i=3;i<30;i++)state.x[i]=0xdead0000+i;for(unsigned i=1;i<32;i++){state.v[i][0]=0x1230000+i;state.v[i][1]=0x4560000+i;}
   KlA64Exit out=kl_a64_run(cpu,&state,10000);
   require(out.kind==KL_A64_SVC&&out.detail==0,"SVC0 reaches original dispatcher boundary");require(state.pc==uintptr_t(bytes)+24,"SVC retains next original PC");state.x[0]+=7;
   out=kl_a64_run(cpu,&state,10000);require(out.kind==KL_A64_SVC&&out.detail==1,"SVC1 exit");
   require(state.x[0]==state.tpidr_el0+(turn?9:5)+7+3,"TLS and dispatcher result");require(state.x[1]==uintptr_t(bytes)&&state.x[2]==0xd53bd040,"source PC and original scalar data");require(memcmp(state.v[0],original,16)==0,"original SIMD data");require(state.sp==uintptr_t(bytes)+16384&&state.pstate==0x20000000&&state.fpcr==0x800000&&state.fpsr==0x10,"SP and architectural status");for(unsigned i=3;i<30;i++)require(state.x[i]==0xdead0000+i,"all general registers");for(unsigned i=1;i<32;i++)require(state.v[i][0]==0x1230000+i&&state.v[i][1]==0x4560000+i,"all SIMD registers");
  }
  require(direct?memory.reads==0:memory.reads>0,"direct or callback memory contract");require(memcmp(bytes,original,32)==0,"original source stays unchanged");
  for(const uint32_t instruction:{0xf9400080u,0xf9000080u}){
   memcpy(bytes,&instruction,4);kl_a64_invalidate(cpu,uintptr_t(bytes),sizeof original);KlA64State state{};state.pc=uintptr_t(bytes);state.x[4]=1;auto out=kl_a64_run(cpu,&state,1000);require(out.kind==KL_A64_MEMORY&&out.address==1&&out.owner_error==-14,"original owner reports invalid access");if(state.pc!=uintptr_t(bytes))fprintf(stderr,"direct=%d insn=%x actualpc=%llx expected=%llx\n",direct,instruction,(unsigned long long)state.pc,(unsigned long long)uintptr_t(bytes));require(state.pc==uintptr_t(bytes),"fault retains original instruction PC");
  }
  uint32_t loop=0x14000000;memcpy(bytes,&loop,4);kl_a64_invalidate(cpu,uintptr_t(bytes),4);KlA64State state{};state.pc=uintptr_t(bytes);require(kl_a64_run(cpu,&state,10).kind==KL_A64_BUDGET,"bounded execution");kl_a64_stop(cpu);require(kl_a64_run(cpu,&state,10).kind==KL_A64_STOP,"owned stop persists");
  kl_a64_destroy(cpu);
 }
 munmap(bytes,16384);puts("PASS shared A64 binding retains original text, CPU state, SVC continuation, owner faults, bounded execution and direct memory");
}
