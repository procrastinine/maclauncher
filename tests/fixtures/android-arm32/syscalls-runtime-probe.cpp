#include "runtime.h"
#include <cassert>
#include <dlfcn.h>
#include <iostream>
#include <string>
#include <thread>
int main(int argc,char **argv){
  assert(argc==5);
  auto core=dlopen(argv[1],RTLD_NOW|RTLD_GLOBAL);if(!core){std::cerr<<dlerror()<<'\n';return 1;}
  auto lookup=reinterpret_cast<void *(*)(const char *)>(dlsym(core,"kl_shim_lookup"));assert(lookup);
  auto configureIds=reinterpret_cast<int (*)(const char *)>(dlsym(core,"klj_process_ids_configure"));assert(configureIds);
  assert(configureIds(argv[4])>0);
  auto expected=reinterpret_cast<int (*)()>(lookup("getpid"));assert(expected);
  const auto expectedPid=expected();assert(expectedPid>0);
  JavaVM *vm=nullptr;JNIEnv *env=nullptr;std::string classpath="-Djava.class.path="+std::string(argv[3]);
  JavaVMOption option{classpath.data(),nullptr};JavaVMInitArgs init{};
  init.version=JNI_VERSION_1_8;init.nOptions=1;init.options=&option;
  assert(JNI_CreateJavaVM(&vm,reinterpret_cast<void **>(&env),&init)==JNI_OK);
  const auto *api=klj_arm32_runtime();assert(api&&api->version==4);
  auto process=api->create(env,lookup,nullptr);assert(process);
  auto format=api->format(process);assert(format&&format->elf_class==1);
  uintptr_t base=0;size_t span=0;char error[512]{};
  auto image=format->map(format->context,argv[2],&base,&span,error,sizeof error);
  if(!image)std::cerr<<error<<'\n';assert(image&&base==0x10000000&&span);
  assert(format->initialize(image));api->initialize(env,image);assert(!env->ExceptionCheck());
  auto type=env->FindClass("SyscallFixture");assert(type);
  const char *names[]={"pid","borrowedBuffer","readRetired","bufferFinalizer"};
  const char *descriptors[]={"()I","([I)I","(I)I","()I"};
  const char *exports[]={"Java_SyscallFixture_pid","Java_SyscallFixture_borrowedBuffer","Java_SyscallFixture_readRetired","Java_SyscallFixture_bufferFinalizer"};
  assert(api->bind(env,image,type,names,descriptors,exports,exports,4)==4);
  auto method=env->GetStaticMethodID(type,"pid","()I");assert(method);
  assert(env->CallStaticIntMethod(type,method)==expectedPid);assert(!env->ExceptionCheck());
  // Ordinary C returns leave r1 unspecified for a 32-bit result. The generic
  // trampoline selects the declared JNI result width rather than reading r1.
  auto pidAddress=uintptr_t(format->symbol(image,exports[0]));assert(pidAddress&&api->executable(process,pidAddress));
  auto pid=reinterpret_cast<jint (*)(JNIEnv *,jclass)>(api->trampoline(process,uint32_t(pidAddress),"I",1,0));assert(pid);
  assert(pid(env,type)==expectedPid);
  assert(!env->ExceptionCheck());
  auto buffer=env->NewIntArray(1);assert(buffer);jint value=35;env->SetIntArrayRegion(buffer,0,1,&value);
  auto borrowMethod=env->GetStaticMethodID(type,"borrowedBuffer","([I)I");assert(borrowMethod);
  auto address=env->CallStaticIntMethod(type,borrowMethod,buffer);
  env->GetIntArrayRegion(buffer,0,1,&value);assert(!env->ExceptionCheck()&&value==42&&address);
  auto retiredMethod=env->GetStaticMethodID(type,"readRetired","(I)I");assert(retiredMethod);
  env->CallStaticIntMethod(type,retiredMethod,address);
  auto retired=env->ExceptionOccurred();assert(retired);env->ExceptionClear();
  auto faultType=env->FindClass("java/lang/UnsatisfiedLinkError");assert(faultType&&env->IsInstanceOf(retired,faultType));
  env->DeleteLocalRef(retired);env->DeleteLocalRef(faultType); // ReleaseIntArrayElements retired the borrowed alias.
  auto finalizerMethod=env->GetStaticMethodID(type,"bufferFinalizer","()I");assert(finalizerMethod);
  auto finalizer=uint32_t(env->CallStaticIntMethod(type,finalizerMethod));
  assert(!env->ExceptionCheck()&&(finalizer&1));
  assert(api->executable(process,finalizer));
  auto finish=reinterpret_cast<void (*)(JNIEnv *,jclass,jintArray)>(api->trampoline(process,finalizer,"VL",2,0));assert(finish);
  finish(env,type,buffer);env->GetIntArrayRegion(buffer,0,1,&value);
  assert(!env->ExceptionCheck()&&value==127);
  auto global=static_cast<jclass>(env->NewGlobalRef(type));
  std::thread worker([&]{
    JNIEnv *local=nullptr;assert(vm->AttachCurrentThread(reinterpret_cast<void **>(&local),nullptr)==JNI_OK);
    assert(local->CallStaticIntMethod(global,method)==expectedPid);assert(!local->ExceptionCheck());
    assert(vm->DetachCurrentThread()==JNI_OK);
  });worker.join();
  env->DeleteGlobalRef(global);env->DeleteLocalRef(buffer);format->unmap(image);assert(vm->DestroyJavaVM()==JNI_OK);
  std::cout<<"PASS raw SVC uses the ordinary JNI process and worker thread factory\n";
}
