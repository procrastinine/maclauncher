#include "runtime.h"
#include <cassert>
#include <cstring>
#include <iostream>
#include <unistd.h>
#include <sys/wait.h>

int main() {
  JavaVM *vm=nullptr;JNIEnv *env=nullptr;
  char headless[]="-Djava.awt.headless=true";
  JavaVMOption option{headless,nullptr};JavaVMInitArgs init{};
  init.version=JNI_VERSION_1_8;init.nOptions=1;init.options=&option;
  assert(JNI_CreateJavaVM(&vm,reinterpret_cast<void **>(&env),&init)==JNI_OK);
  const auto *api=klj_arm32_runtime();assert(api&&api->version==KLJ_ARM32_RUNTIME_VERSION);
  const auto lookup=[](const char *)->void *{return nullptr;};
  auto process=api->create(env,lookup,nullptr);assert(process);
  const auto *memory=api->process_memory(process);assert(memory&&memory->word_size==4&&memory->page_size==4096);
  uint64_t code=0,data=0;
  assert(!memory->reserve(memory->context,4096,&code));
  assert(!memory->reserve(memory->context,4096,&data));
  assert(code!=data);
  constexpr uint64_t fixed=0x01000000;
  assert(!memory->reserve_fixed(memory->context,fixed,4096));
  auto fixedBytes=static_cast<unsigned char *>(memory->memory(memory->context,fixed,4096,3));assert(fixedBytes);
  fixedBytes[0]=73;
  assert(memory->reserve_fixed(memory->context,fixed,4096)==EEXIST&&fixedBytes[0]==73);
  memory->release(memory->context,fixed,4096);
  const uint32_t instructions[]={0xe2800007,0xe12fff1e}; // add r0,r0,#7; bx lr
  auto bytes=memory->memory(memory->context,code,sizeof instructions,3);assert(bytes);
  std::memcpy(bytes,instructions,sizeof instructions);
  auto zero=static_cast<const unsigned char *>(memory->memory(memory->context,data,4096,1));assert(zero);
  for(unsigned i=0;i<4096;i++)assert(zero[i]==0);
  assert(!memory->protect(memory->context,code,4096,5));
  assert(!memory->memory(memory->context,code,4,2));
  uint64_t result=0;assert(!memory->invoke(memory->context,code,35,&result)&&result==42);
  assert(!memory->protect(memory->context,code,4096,3));
  // Five original ABI words: the fifth is on the guest stack, not a host
  // pointer or the C entry shim's own stack. Exercise this through real ARM.
  const uint32_t sum[]={0xe0800001,0xe0800002,0xe0800003,0xe59d1000,0xe0800001,0xe12fff1e};
  std::memcpy(memory->memory(memory->context,code+64,sizeof sum,2),sum,sizeof sum);
  assert(!memory->protect(memory->context,code,4096,5));
  const uint64_t arguments[]={3,5,7,11,16};
  assert(!memory->call(memory->context,code+64,arguments,5,&result)&&result==42);
  // No inherited JNI frame, GetEnv or Java callback may be required between
  // native fork and exec. Exercise the actual translated process owner there.
  pid_t child=fork();assert(child>=0);
  if(!child){
    alarm(5);
    uint64_t result=0,temporary=0;
    assert(!memory->reserve(memory->context,4096,&temporary));
    assert(!memory->call_native(memory->context,code+64,arguments,5,&result)&&result==42);
    memory->release(memory->context,temporary,4096);_exit(23);
  }
  int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==23);
  const uint64_t wide[]={UINT64_C(0x100000000)};
  assert(memory->call(memory->context,code,wide,1,&result)==EOVERFLOW);
  assert(!env->ExceptionCheck());
  assert(!memory->protect(memory->context,data,4096,0));
  assert(!memory->memory(memory->context,data,4,1));
  memory->release(memory->context,code,4096);
  memory->release(memory->context,data,4096);
  assert(!memory->memory(memory->context,code,4,0));
  assert(!memory->memory(memory->context,data,4,0));
  assert(vm->DestroyJavaVM()==JNI_OK);
  std::cout<<"PASS process memory executes through the existing ARM32 owner\n";
}
