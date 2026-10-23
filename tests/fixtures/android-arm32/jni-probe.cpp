#include "flat-binary.h"
#include "jni-bridge.h"
#include "native-imports.h"
#include <array>
#include <cassert>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <thread>
using namespace maclauncher::arm32;
static char nativeWindow;
static jobject windowObject;
static void *fromSurface(JNIEnv*env,jobject value){assert(env->GetVersion()>=JNI_VERSION_1_6);assert(value);windowObject=env->NewGlobalRef(value);return &nativeWindow;}
static jobject toSurface(JNIEnv*env,void*window){assert(window==&nativeWindow);assert(env->GetVersion()>=JNI_VERSION_1_6);return env->NewLocalRef(windowObject);}
static void *lookup(const char*name){if(!std::strcmp(name,"ANativeWindow_fromSurface"))return reinterpret_cast<void*>(fromSurface);if(!std::strcmp(name,"ANativeWindow_toSurface"))return reinterpret_cast<void*>(toSurface);return nullptr;}
int main(int argc, char **argv) {
  assert(argc == 3);
  JavaVM *vm = nullptr;
  JNIEnv *env = nullptr;
  std::string classpath = "-Djava.class.path=" + std::string(argv[2]);
  JavaVMOption option{classpath.data(), nullptr};
  JavaVMInitArgs init{};
  init.version = JNI_VERSION_1_8;
  init.nOptions = 1;
  init.options = &option;
  assert(JNI_CreateJavaVM(&vm, reinterpret_cast<void **>(&env), &init) ==
         JNI_OK);
  {
    Memory memory;
    Thread thread(memory);
    Jni bridge(memory, vm);
    Imports imports(memory,lookup);
    imports.setJniAdapter([&](JniValue kind,uint64_t value,bool toHost){return bridge.nativeValue(kind,value,toHost);});
    FlatBinary image(memory,argv[1]);image.gate(0,imports.resolve("ANativeWindow_fromSurface"));image.gate(1,imports.resolve("ANativeWindow_toSurface"));
    assert(bridge.initialize(thread, env, image.entry(ENTRY_JNI_OnLoad)) ==
           JNI_VERSION_1_6);
    auto type = env->FindClass("Arm32JniFixture");
    assert(type);
    auto original=env->NewStringUTF("ordinary C JNI argument order");
    std::array<Jni::Argument,5> plain{{{Value::word(73)},
      {{reinterpret_cast<uintptr_t>(env),1},JniValue::Environment},
      {{reinterpret_cast<uintptr_t>(original),1},JniValue::Object},
      {Value::wide(0xfedcba9876543210ULL)},
      {{reinterpret_cast<uintptr_t>(vm),1},JniValue::VM}}};
    auto returned=reinterpret_cast<jobject>(bridge.invoke(thread,env,image.entry(ENTRY_guest_c_entry),plain,JniValue::Object));
    assert(returned&&env->IsSameObject(original,returned)&&!env->ExceptionCheck());
    env->DeleteLocalRef(returned);env->DeleteLocalRef(original);
    auto value =
        bridge.call(thread, env, image.entry(ENTRY_guest_probe), type, "()I", {});
    if (env->ExceptionCheck())
      env->ExceptionDescribe();
    if (value.i)
      std::cerr << "Guest JNI assertion line " << value.i << '\n';
    assert(value.i == 0);
    env->DeleteGlobalRef(windowObject);windowObject=nullptr;
    memory.map(0x30000000, 4096, Memory::Read | Memory::Write);
    jvalue destination{};
    destination.i = 0x30000ffe;
    bridge.call(thread, env, image.entry(ENTRY_guest_utf_region), type, "(I)V",
                std::span<const jvalue>(&destination, 1));
    assert(!env->ExceptionCheck());
    assert(std::memcmp(memory.translate(0x30000ffe, 2, Memory::Read), "a", 2) == 0);
    auto string = static_cast<jstring>(
        bridge
            .call(thread, env, image.entry(ENTRY_guest_string), type,
                  "()Ljava/lang/String;", {})
            .l);
    const char *text = env->GetStringUTFChars(string, nullptr);
    assert(std::strcmp(text, "ARM32 through original JVM") == 0);
    env->ReleaseStringUTFChars(string, text);
    env->DeleteLocalRef(string);
    std::thread other([&] {
      JNIEnv *worker = nullptr;
      assert(vm->AttachCurrentThread(reinterpret_cast<void **>(&worker),
                                     nullptr) == JNI_OK);
      auto type = worker->FindClass("Arm32JniFixture");
      auto invoke = worker->GetStaticMethodID(type, "invokeNative", "()J");
      assert(invoke);
      assert(worker->CallStaticLongMethod(type, invoke) ==
             0x123456789abcdf02LL);
      assert(!worker->ExceptionCheck());
      assert(vm->DetachCurrentThread() == JNI_OK);
    });
    other.join();
    std::thread nativeWorker([&] {
      auto translated=bridge.thread();
      auto result=bridge.callback(*translated,image.entry(ENTRY_guest_native_thread),{});
      if(result)std::cerr<<"Guest native thread assertion line "<<result<<'\n';
      assert(result==0);
      JNIEnv *detached=nullptr;assert(vm->GetEnv(reinterpret_cast<void **>(&detached),JNI_VERSION_1_6)==JNI_EDETACHED);
    });
    nativeWorker.join();
  }
  assert(vm->DestroyJavaVM() == JNI_OK);
  std::cout << "PASS original JNI table, JavaVM, reference frames, AAPCS32 "
               "variadic/A/V calls, arrays, critical buffers, native "
               "registration, nested and cross-thread callbacks\n";
}
