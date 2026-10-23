const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const moduleUrl=require('node:url').pathToFileURL(path.join(root,'src/modules/android/native/platform-syscalls.mjs'));

// Exercise actual generated C calls, signed returns and fallback ownership.
// A newly declared ordinary entry needs no change to the generator.
test('raw syscalls derive ordinary adapters and preserve distinct kernel ownership',async t=>{
  const {emitPlatformSyscalls}=await import(moduleUrl);
  const types={int:{kind:'Int',size:4},uint:{kind:'UInt',size:4},long:{kind:'Long',size:8},ptr:{kind:'Pointer',size:8},void:{kind:'Void',size:0}};
  const functions={};
  function declare(name,result,parameters){const type='fn_'+name;functions[name]={type};types[type]={result,parameters};}
  declare('new_upstream_call','int',['int','ptr']);
  declare('readlinkat','long',['int','ptr','ptr','long']);
  declare('faccessat','int',['int','ptr','int','int']);
  declare('getpriority','int',['int','uint']);
  declare('getcwd','ptr',['ptr','long']);
  declare('clock_nanosleep','int',['int','int','ptr','ptr']);
  declare('waitid','int',['int','uint','ptr','int']);
  declare('brk','int',['ptr']);
  declare('sync','void',[]);
  declare('unbound','int',[]);
  declare('sigtimedwait64','int',['ptr','ptr','ptr']);
  declare('ppoll','int',['ptr','long','ptr','ptr']);
  declare('epoll_pwait','int',['int','ptr','int','int','ptr']);
  declare('epoll_pwait2','int',['int','ptr','int','ptr','ptr']);
  const names=['new_upstream_call','readlinkat','faccessat','getpriority','getcwd','clock_nanosleep','waitid','brk','sync','unbound','futex','rt_tgsigqueueinfo','rt_sigqueueinfo','rt_sigtimedwait','ppoll','epoll_pwait','epoll_pwait2'];
  const kernel=names.map((name,number)=>({name,number:1000+number,macro:'__NR_'+name}));
  const {dispatch,entries}=emitPlatformSyscalls({rows:[],kernel,declarations:{types,functions}});
  assert.equal(entries.length,kernel.length);
  assert.equal(entries.find(r=>r.name==='brk').mode,'kernel');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'android-syscall-owner-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const c=path.join(dir,'probe.c'),binary=path.join(dir,'probe');
  fs.writeFileSync(c,`
#include <assert.h>
#include <stdint.h>
#include <string.h>
#include <errno.h>
#include <stdio.h>
static int absent, syncs;
static int32_t fresh(int32_t n,void *p){assert(n==-7&&p==(void*)0x1234);return -22;}
static int64_t read_link(int32_t n,void *p,void *out,int64_t size){assert(n==-100&&p&&out&&size==8);memcpy(out,"link",4);return 4;}
static int32_t access_at(int32_t n,void *p,int32_t mode,int32_t flags){assert(n==-100&&p&&mode==4&&flags==0);return -9;}
static int32_t priority(int32_t which,uint32_t who){(void)which;(void)who;return -1;}
static void *cwd(void *p,int64_t size){assert(size>=5);memcpy(p,"/tmp",5);return p;}
static int32_t sleep_call(int32_t c,int32_t flags,void *a,void *b){(void)c;(void)flags;(void)a;(void)b;return 4;}
static int32_t wait_call(int32_t t,uint32_t id,void *p,int32_t f){(void)t;(void)id;(void)p;(void)f;return 17;}
static void sync_call(void){syncs++;}
static int32_t thread_signal(int32_t p,int32_t t,int32_t s,void *info){assert(p==17&&t==23&&s==35&&info==(void*)0x1234);return 0;}
static int32_t process_signal(int32_t p,int32_t s,void *info){assert(p==17&&s==35&&info==(void*)0x1234);return -1;}
static int32_t signal_wait(void *set,void *info,void *timeout){assert(set==(void*)0x1000&&info==(void*)0x1234&&timeout==(void*)0x2000);return 35;}
static int32_t poll_wait(void *fds,uint64_t count,void *timeout,void *mask){assert(fds==(void*)0x1000&&count==2&&timeout==(void*)0x2000);assert(!mask||mask==(void*)0x3000);return 3;}
static int32_t epoll_wait(int32_t fd,void *events,int32_t count,int32_t timeout,void *mask){assert(fd==17&&events==(void*)0x1000&&count==2&&timeout==0);assert(!mask||mask==(void*)0x3000);return 4;}
static int32_t epoll_wait2(int32_t fd,void *events,int32_t count,void *timeout,void *mask){assert(fd==17&&events==(void*)0x1000&&count==2&&timeout==(void*)0x2000);assert(!mask||mask==(void*)0x3000);return 5;}
static int kl_errno_from_linux(int value){return value+100;}
static void *kl_shim_lookup(const char *name){
 if(absent)return NULL;
 if(!strcmp(name,"new_upstream_call"))return fresh;
 if(!strcmp(name,"readlinkat"))return read_link;
 if(!strcmp(name,"faccessat"))return access_at;
 if(!strcmp(name,"getpriority"))return priority;
 if(!strcmp(name,"getcwd"))return cwd;
 if(!strcmp(name,"clock_nanosleep"))return sleep_call;
 if(!strcmp(name,"waitid"))return wait_call;
 if(!strcmp(name,"sync"))return sync_call;
 if(!strcmp(name,"rt_tgsigqueueinfo"))return thread_signal;
 if(!strcmp(name,"rt_sigqueueinfo"))return process_signal;
 if(!strcmp(name,"sigtimedwait64"))return signal_wait;
 if(!strcmp(name,"ppoll"))return poll_wait;
 if(!strcmp(name,"epoll_pwait"))return epoll_wait;
 if(!strcmp(name,"epoll_pwait2"))return epoll_wait2;
 return NULL;
}
static long call(long n,long a1,long a2,long a3,long a4,long a5,long a6){(void)a6;${dispatch}return -9000-n;}
int main(void){char out[8];
 assert(call(1000,-7,0x1234,0,0,0,0)==-22);
 assert(call(1001,-100,(long)"name",(long)out,8,0,0)==4&&!memcmp(out,"link",4));
 assert(call(1002,-100,(long)"name",4,999,0,0)==-9);
 errno=123;assert(call(1003,0,0,0,0,0,0)==21);
 assert(call(1004,(long)out,8,0,0,0,0)==5&&!strcmp(out,"/tmp"));
 assert(call(1005,0,0,0,0,0,0)==-1&&errno==104);
 assert(call(1006,0,0,0,0,0,0)==17);
 assert(call(1006,0,0,0,0,1,0)==-10006);
 assert(call(1007,0,0,0,0,0,0)==-10007);
 assert(call(1008,0,0,0,0,0,0)==0&&syncs==1);
 assert(call(1009,0,0,0,0,0,0)==-10009);
 assert(call(1010,0,0,0,0,0,0)==-10010);
 assert(call(1011,17,23,35,0x1234,0,0)==0);
 assert(call(1012,17,35,0x1234,0,0,0)==-1);
 assert(call(1013,0x1000,0x1234,0x2000,8,0,0)==35);
 assert(call(1013,0x1000,0x1234,0x2000,4,0,0)==-1&&errno==EINVAL);
 // Original Linux set_user_sigmask accepts any size for a NULL mask, and
 // rejects a bad size when the caller actually supplies a temporary mask.
 for(long size=0;size<=16;size+=8){
  assert(call(1014,0x1000,2,0x2000,0,size,0)==3);
  assert(call(1015,17,0x1000,2,0,0,size)==4);
  assert(call(1016,17,0x1000,2,0x2000,0,size)==5);
 }
 assert(call(1014,0x1000,2,0x2000,0x3000,8,0)==3);
 assert(call(1015,17,0x1000,2,0,0x3000,8)==4);
 assert(call(1016,17,0x1000,2,0x2000,0x3000,8)==5);
 assert(call(1014,0x1000,2,0x2000,0x3000,0,0)==-1&&errno==EINVAL);
 assert(call(1015,17,0x1000,2,0,0x3000,0)==-1&&errno==EINVAL);
 assert(call(1016,17,0x1000,2,0x2000,0x3000,0)==-1&&errno==EINVAL);
 absent=1;assert(call(1000,0,0,0,0,0,0)==-10000);
 puts("PASS generated syscall routing and physical fallback");
}
`);
  execFileSync('clang',['-std=c11','-Wall','-Wextra','-Werror',c,'-o',binary],{stdio:'pipe'});
  assert.match(execFileSync(binary,{encoding:'utf8'}),/PASS generated syscall/);
});

test('complete original target UAPI supplies raw ARM64 syscall membership',async t=>{
  const bionicSource=process.env.BIONIC_SOURCE,include=process.env.ANDROID_NDK_HEADERS,importsDirectory=process.env.ANDROID_IMPORT_DECLARATIONS,python=process.env.PYTHON;
  if(!bionicSource||!include||!importsDirectory||!python)return t.skip('Requires pinned Bionic, NDK declarations and build Python');
  const {preparePlatformSyscalls}=await import(moduleUrl);
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-syscall-original-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const c=path.join(output,'calls.c');
  fs.writeFileSync(c,'#include <errno.h>\nlong klb_syscall(long n, long a1, long a2, long a3, long a4, long a5, long a6) { errno=ENOSYS;return -1; }');
  const {entries}=preparePlatformSyscalls(c,{bionicSource,include,importsDirectory,python,output});
  for(const name of ['newfstatat','readlinkat','faccessat','accept','gettid'])assert.equal(entries.find(x=>x.name===name)?.mode,'adapter',name);
  assert.equal(entries.find(x=>x.name==='futex')?.mode,'kernel');
  assert.equal(new Set(entries.map(x=>x.macro)).size,entries.length);
  execFileSync('clang',['-std=c11','-Wall','-Wextra','-Werror','-fsyntax-only',c],{stdio:'pipe'});
});
