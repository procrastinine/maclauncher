#include "jni-bridge.h"
#if defined(__ANDROID__)
#include <nativebridge/native_bridge.h>
#endif
#include <cstring>
#include <memory>
#include <vector>
using namespace maclauncher::arm32;
#if defined(__ANDROID__)
static const android::NativeBridgeRuntimeCallbacks *callbacks;
static bool initialize(const android::NativeBridgeRuntimeCallbacks *value,const char *,const char *){callbacks=value;return true;}
static void *bridgeTrampoline(const void*,const char*,uint32_t,android::JNICallType);
static bool bridgePointer(const void*);
// This fixture obtains ART's actual metadata callbacks; it does not claim a
// production native-library namespace. The original runtime loads its JNI ELF.
extern "C" __attribute__((visibility("default"))) android::NativeBridgeCallbacks NativeBridgeItf={
 .version=8,.initialize=initialize,.loadLibrary=nullptr,.getTrampoline=nullptr,
 .isSupported=+[](const char*){return false;},.getAppEnv=+[](const char*)->const android::NativeBridgeRuntimeValues*{return nullptr;},
 .isCompatibleWith=+[](uint32_t version){return version<=8;},
 .getSignalHandler=+[](int)->android::NativeBridgeSignalHandlerFn{return nullptr;},
 .isPathSupported=+[](const char*){return false;},
 .getTrampolineForFunctionPointer=bridgeTrampoline,
 .isNativeBridgeFunctionPointer=bridgePointer
};
#endif
struct State {
 Memory memory;
 std::unique_ptr<Image> image;
 std::unique_ptr<Jni> jni;
};
static std::unique_ptr<State> state;
#if defined(__ANDROID__)
static State *preparing;
static unsigned bridgeCalls;
static void *bridgeTrampoline(const void *function,const char *shorty,uint32_t length,android::JNICallType type){
 auto &owner=preparing?*preparing:*state;++bridgeCalls;
 return owner.jni->trampoline(uint32_t(reinterpret_cast<uintptr_t>(function)),std::string_view(shorty,length),
  type==android::kJNICallTypeCriticalNative?Jni::NativeCall::Critical:Jni::NativeCall::Regular);
}
static bool bridgePointer(const void *function){
 auto *owner=preparing?preparing:state.get();const auto address=reinterpret_cast<uintptr_t>(function);
 if(!owner||!address||address>UINT32_MAX)return false;
 try{return owner->memory.translate(uint32_t(address)&~1u,2,Memory::Execute)!=nullptr;}
 catch(const Memory::Fault&){return false;}
}
struct Preparing{explicit Preparing(State &value){preparing=&value;}~Preparing(){preparing=nullptr;}};
#endif
static void memoryLease(Memory &memory){
 unsigned released=0,protectedCount=0;
 auto *bytes=new uint8_t[8192]{};
 auto storage=std::shared_ptr<void>(bytes,[&](void *value){++released;delete[] static_cast<uint8_t*>(value);});
 auto address=memory.mapNative(bytes,8192,Memory::Read|Memory::Write,storage,0,false,false,[&](unsigned){++protectedCount;});
 storage.reset();memory.unmap(address,4096);
 if(released)throw std::runtime_error("Native memory owner retired before its final page");
 memory.protect(address+4096,4096,Memory::Read);
 if(protectedCount!=1||memory.translate(address+4096,4096,Memory::Read)!=bytes+4096)
  throw std::runtime_error("Native memory protection lost its original owner");
 memory.invalidate(address+4096,4096);
 if(memory.mappingDescription(address+4096)=="unmapped")throw std::runtime_error("Missing native memory mapping");
 memory.retireNative(bytes,8192);
 if(released!=1||memory.mappingDescription(address+4096)!="unmapped")throw std::runtime_error("Native memory owner retirement was not exact");
}
static void error(JNIEnv *env,const char *text){if(!env->ExceptionCheck()){auto type=env->FindClass("java/lang/IllegalStateException");if(type)env->ThrowNew(type,text);}}
extern "C" JNIEXPORT void JNICALL Java_ArtSharedJniProbe_open(JNIEnv *env,jclass,jbyteArray bytes){
 try{
#if defined(__ANDROID__)
  if(!callbacks||!callbacks->getMethodShorty)throw std::runtime_error("Original NativeBridge metadata was not initialized");
#endif
  std::vector<uint8_t> image(env->GetArrayLength(bytes));env->GetByteArrayRegion(bytes,0,image.size(),reinterpret_cast<jbyte*>(image.data()));if(env->ExceptionCheck())return;
  auto next=std::make_unique<State>();memoryLease(next->memory);JavaVM *vm=nullptr;env->GetJavaVM(&vm);
#if defined(__ANDROID__)
  next->jni=std::make_unique<Jni>(next->memory,vm,Jni::Metadata{callbacks->getMethodShorty,true});
#else
  next->jni=std::make_unique<Jni>(next->memory,vm);
#endif
  next->image=std::make_unique<Image>(next->memory,image,0x10000000,[](std::string_view name)->uint32_t{throw std::runtime_error("Unexpected fixture import: "+std::string(name));});
#if defined(__ANDROID__)
  Preparing registration(*next);
#endif
  auto thread=next->jni->thread();next->jni->construct(*thread,env,*next->image);
  using OnLoad=jint(*)(JavaVM *,void *);
  auto onLoad=reinterpret_cast<OnLoad>(next->jni->trampoline(next->image->symbol("JNI_OnLoad"),"I",Jni::NativeCall::Invocation));
  if(onLoad(vm,nullptr)!=JNI_VERSION_1_6)throw std::runtime_error("Original ARM32 JNI_OnLoad failed");
#if defined(__ANDROID__)
  if(bridgeCalls!=2)throw std::runtime_error("Original ART did not select the JNI registration trampoline");
#endif
  const auto function=next->image->symbol("critical");
  auto code=next->jni->trampoline(function,"JBSJFD",Jni::NativeCall::Critical);
  if(code!=next->jni->trampoline(function,"JBSJFD",Jni::NativeCall::Critical))throw std::runtime_error("JNI trampoline identity changed");
  using Critical=jlong(*)(jbyte,jshort,jlong,jfloat,jdouble);
  if(reinterpret_cast<Critical>(code)(-91,-12345,INT64_C(0x123456789abcdef0),1.25f,3.5)!=INT64_C(0x123456789abcdef7))throw std::runtime_error("Critical JNI argument representation changed");
  bool rejected=false;try{next->jni->trampoline(function,"JL",Jni::NativeCall::Critical);}catch(const std::runtime_error&){rejected=true;}
  if(!rejected)throw std::runtime_error("Critical JNI accepted a reference argument");
  state=std::move(next);
 }catch(const std::exception &failure){error(env,failure.what());}
}
extern "C" JNIEXPORT void JNICALL Java_ArtSharedJniProbe_close(JNIEnv *,jclass){state.reset();}
