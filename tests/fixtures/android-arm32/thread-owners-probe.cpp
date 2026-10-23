#include "jni-bridge.h"
#include <cassert>
#include <cstdio>
#include <mach-o/dyld.h>
#include <thread>
using namespace maclauncher::arm32;
static Jni *firstPool,*secondPool;
static std::weak_ptr<Thread> original,createdDuringRetirement,createdAfterRetirement;
static unsigned callbacks,lateCallbacks;
static thread_local bool retired;
static void physicalEnd(){
  if(retired)return;
  retired=true;
  auto retained=original.lock();
  assert(retained&&"physical callbacks must precede translated-thread lease retirement");
  assert(firstPool->thread()==retained);
  // A callback can enter another library/pool while physical cleanup runs.
  // Its new lease must be retained and retired by the same live container.
  createdDuringRetirement=secondPool->thread();
  ++callbacks;
}
static void fallback(void*){physicalEnd();}
static void lateCallback(void*){
  assert(retired&&original.expired()&&createdDuringRetirement.expired());
  // A native library's earlier registered TLS destructor can legitimately
  // call JNI after the first translated-thread container has retired.
  createdAfterRetirement=firstPool->thread();++lateCallbacks;
}
int main(){
  JavaVM *vm=nullptr;JNIEnv *env=nullptr;JavaVMInitArgs args{};
  JavaVMOption option{const_cast<char*>("-Xmx64m"),nullptr};
  args.options=&option;args.nOptions=1;args.version=JNI_VERSION_1_8;
  assert(JNI_CreateJavaVM(&vm,reinterpret_cast<void**>(&env),&args)==JNI_OK);
  {
    Memory memory;KljJniInvocationApi api{};api.physicalEnd=physicalEnd;
    Jni first(memory,vm,nullptr,&api),second(memory,vm,nullptr,&api);
    firstPool=&first;secondPool=&second;
    for(unsigned i=0;i<32;++i){
      std::thread worker([&]{_tlv_atexit(fallback,nullptr);auto thread=firstPool->thread();original=thread;});
      worker.join();
      assert(original.expired()&&createdDuringRetirement.expired());
    }
    assert(callbacks==32);
    for(unsigned i=0;i<32;++i){
      std::thread worker([&]{_tlv_atexit(lateCallback,nullptr);auto thread=firstPool->thread();original=thread;});
      worker.join();
      assert(original.expired()&&createdDuringRetirement.expired()&&createdAfterRetirement.expired());
    }
    assert(callbacks==64&&lateCallbacks==32);
  }
  std::puts("PASS physical callbacks retain original ARM32 threads and pool leases until retirement, including later native TLS reentry");
  assert(vm->DestroyJavaVM()==JNI_OK);
}
