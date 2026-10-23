#include "fixture-entries.h"
#include <cstring>
#include <vector>
#include "runtime.h"
#include <cassert>
#include <dlfcn.h>
#include <iostream>
#include <string>
#include <thread>
#include <fstream>
#include <iterator>
int main(int argc,char **argv){
  assert(argc==4);
  auto core=dlopen(argv[1],RTLD_NOW|RTLD_GLOBAL);if(!core){std::cerr<<dlerror()<<'\n';return 1;}
  auto lookup=reinterpret_cast<void *(*)(const char *)>(dlsym(core,"kl_shim_lookup"));assert(lookup);
  auto expected=reinterpret_cast<int (*)()>(lookup("getpid"));assert(expected);
  JavaVM *vm=nullptr;JNIEnv *env=nullptr;std::string classpath="-Djava.class.path="+std::string(argv[3]);
  JavaVMOption option{classpath.data(),nullptr};JavaVMInitArgs init{};
  init.version=JNI_VERSION_1_8;init.nOptions=1;init.options=&option;
  assert(JNI_CreateJavaVM(&vm,reinterpret_cast<void **>(&env),&init)==JNI_OK);
  const auto *api=klj_arm32_runtime();assert(api&&api->version==KLJ_ARM32_RUNTIME_VERSION);
  auto process=api->create(env,lookup,nullptr);assert(process);
  auto memory=api->process_memory(process);assert(memory);
  std::ifstream input(argv[2],std::ios::binary);std::vector<uint8_t> bytes{std::istreambuf_iterator<char>(input),{}};
  uint64_t base=0;size_t span=(bytes.size()+4095)&~size_t(4095);assert(!memory->reserve(memory->context,span,&base));assert(base==0x10000000);
  std::memcpy(memory->memory(memory->context,base,bytes.size(),3),bytes.data(),bytes.size());
  assert(!memory->protect(memory->context,base,span,7));
  auto entry=[&](unsigned index){uint32_t address;std::memcpy(&address,memory->memory(memory->context,base+4*index,4,1),4);return address;};
  auto type=env->FindClass("SyscallFixture");assert(type);
  const char *names[]={"pid"},*descriptors[]={"()I"};const uint64_t functions[]={entry(ENTRY_Java_SyscallFixture_pid)};
  assert(api->bind_addresses(env,process,type,names,descriptors,functions,1)==1);
  auto method=env->GetStaticMethodID(type,"pid","()I");assert(method);
  assert(env->CallStaticIntMethod(type,method)==expected());assert(!env->ExceptionCheck());
  klj_arm32_argument arguments[]={
    {reinterpret_cast<uintptr_t>(env),1,KLJ_ARM32_JNI_ENVIRONMENT,0,0},
    {reinterpret_cast<uintptr_t>(type),1,KLJ_ARM32_JNI_OBJECT,0,0}};
  // Ordinary C returns leave r1 unspecified for a 32-bit result. The generic
  // invocation returns both ABI words; the declared result selects its width.
  assert(static_cast<uint32_t>(api->invoke_process(env,process,entry(ENTRY_Java_SyscallFixture_pid),arguments,2,KLJ_ARM32_SCALAR))==static_cast<unsigned>(expected()));
  assert(!env->ExceptionCheck());
  uint32_t buffer=35;klj_arm32_argument borrowed{reinterpret_cast<uintptr_t>(&buffer),1,KLJ_ARM32_BUFFER,sizeof buffer,6};
  auto address=uint32_t(api->invoke_process(env,process,entry(ENTRY_borrowed_buffer),&borrowed,1,KLJ_ARM32_SCALAR));
  assert(!env->ExceptionCheck()&&buffer==42&&address);
  assert(!memory->memory(memory->context,address,sizeof buffer,1)); // The synchronous borrowed buffer has retired.
  auto finalizer=uint32_t(api->invoke_process(env,process,entry(ENTRY_buffer_finalizer),nullptr,0,KLJ_ARM32_SCALAR));
  assert(!env->ExceptionCheck()&&(finalizer&1));
  api->invoke_process(env,process,finalizer,&borrowed,1,KLJ_ARM32_SCALAR);
  assert(!env->ExceptionCheck()&&buffer==127);
  auto global=static_cast<jclass>(env->NewGlobalRef(type));
  std::thread worker([&]{
    JNIEnv *local=nullptr;assert(vm->AttachCurrentThread(reinterpret_cast<void **>(&local),nullptr)==JNI_OK);
    assert(local->CallStaticIntMethod(global,method)==expected());assert(!local->ExceptionCheck());
    assert(vm->DetachCurrentThread()==JNI_OK);
  });worker.join();
  env->DeleteGlobalRef(global);assert(vm->DestroyJavaVM()==JNI_OK);
  std::cout<<"PASS raw SVC uses the ordinary JNI process and worker thread factory\n";
}
