// White-box access is confined to this fixture. The compiled production
// marshaller and generated tables are used verbatim, with no diagnostic API
// added to the runtime and no duplicate ABI policy or C declaration parser.
#include "arm32.h"
#include "jni-value.h"
#include <jni.h>
#include <array>
#include <functional>
#include <memory>
#define private public
#include "native-imports.h"
#undef private
#include ARM32_IMPORTS_SOURCE

using namespace maclauncher::arm32;
static unsigned conversion(Imports::Impl& owner,unsigned id){
 const auto&t=types[id];
 if(t.kind==Kind::Void||t.jni!=JniValue::None)return 0;
 if(t.guestSize<=0||t.hostSize<=0||t.guestSize>1048576||t.hostSize>1048576)return 0;
 Imports::Impl::Transfer transfer(owner);
 std::vector<uint8_t> guest(size_t(t.guestSize)),host(size_t(t.hostSize)),restored(size_t(t.guestSize));
 uint32_t allocation=0;
 try{
  if(t.kind==Kind::Pointer){const auto&p=types[t.element];
   if(p.kind==Kind::Function){Imports::Impl::Signature callback(owner,t.element);return 1;}
   if(p.guestSize>0&&p.hostSize>0&&p.guestSize<=1048576&&p.hostSize<=1048576){
    allocation=owner.memory.allocate(0x60000000,unsigned(p.guestSize),Memory::Read|Memory::Write);
    std::memset(owner.memory.translate(allocation,size_t(p.guestSize),Memory::Write),0,size_t(p.guestSize));std::memcpy(guest.data(),&allocation,4);
   }
  }
  transfer.convert(id,guest.data(),host.data(),true);
  transfer.convert(id,host.data(),restored.data(),false);transfer.finish();
  if(allocation)owner.memory.unmap(allocation);
  return 1;
 }catch(...){if(allocation)owner.memory.unmap(allocation);throw;}
}
extern "C" JNIEXPORT jobjectArray JNICALL Java_maclauncher_android_Arm32ImportInspection_probe(JNIEnv*env,jclass,jobjectArray names,jstring root){
 const char*directory=env->GetStringUTFChars(root,nullptr);if(!directory)return nullptr;
 std::string file=std::string(directory)+"/native/libklepton-jvm.dylib";env->ReleaseStringUTFChars(root,directory);
 auto runtime=dlopen(file.c_str(),RTLD_NOW|RTLD_NOLOAD);
 auto lookup=runtime?reinterpret_cast<void*(*)(const char*)>(dlsym(runtime,"kl_shim_lookup")):nullptr;
 if(!lookup){auto error=env->FindClass("java/lang/IllegalStateException");env->ThrowNew(error,"Initialized shared native resolver is unavailable");return nullptr;}
 Memory memory;Imports imports(memory,lookup);
 auto string=env->FindClass("java/lang/String");auto strings=env->FindClass("[Ljava/lang/String;");auto result=env->NewObjectArray(env->GetArrayLength(names),strings,nullptr);
 for(jsize n=0;n<env->GetArrayLength(names)&&!env->ExceptionCheck();n++){
  auto text=static_cast<jstring>(env->GetObjectArrayElement(names,n));const char*chars=env->GetStringUTFChars(text,nullptr);if(!chars)break;std::string name(chars);env->ReleaseStringUTFChars(text,chars);env->DeleteLocalRef(text);
  std::array<std::string,8> row{name,"","","","owner","","",""};
  auto native=lookup(name.c_str());Dl_info supplier{};
  if(native){row[1]="shared-native-registry";if(dladdr(native,&supplier)){row[1]=supplier.dli_fname? supplier.dli_fname:row[1];row[2]=supplier.dli_sname?supplier.dli_sname:"";}}
   try{
    // The actual resolver owns specialized aliases before shared lookup. For
    // example __mmap2 uses the common mmap supplier rather than that symbol.
    auto gate=imports.resolve(name);if(!gate){if(native){row[4]="declaration";row[5]="Native owner exists, but no generated ARM32 declaration or specialized adapter resolves it";}}
    else if(!imports.impl->nativeGateTargets.contains(gate)){if(!native)row[1]="shared-native-adapter";row[4]="specialized-or-data";row[6]="Actual import resolver accepted its specialized adapter or data representation";}
    else{
     auto function=std::find_if(std::begin(functions),std::end(functions),[&](const auto&f){return name==f.name;});
     if(function==std::end(functions))throw std::runtime_error("Resolved function has no original declaration");
     row[3]=types[function->type].name;row[4]="signature";Imports::Impl::Signature signature(*imports.impl,function->type,&*function,native);row[6]="Actual FFI signature accepted";
     // Match invoke's original fixed-parameter loop. A formatted va_list is
     // lowered by the existing format planner, not generic Transfer.convert.
     row[4]="conversion";const auto&type=types[function->type];unsigned checked=conversion(*imports.impl,type.result);for(unsigned i=0;i<signature.fixed;i++)checked+=conversion(*imports.impl,type.parameters[i]);
     row[7]=std::to_string(checked)+" synthetic declared fixed values/callback signatures; no imported function called";
     if(signature.formatted)row[7]+="; dynamic format plan requires argument-dependent component evidence";row[4]="accepted";
    }
   }catch(const std::exception&error){row[5]=error.what();}
  auto values=env->NewObjectArray(row.size(),string,nullptr);if(!values)break;
  for(unsigned i=0;i<row.size();i++){auto value=env->NewStringUTF(row[i].c_str());if(!value)break;env->SetObjectArrayElement(values,i,value);env->DeleteLocalRef(value);}
  if(!env->ExceptionCheck())env->SetObjectArrayElement(result,n,values);env->DeleteLocalRef(values);
 }
 if(runtime)dlclose(runtime);env->DeleteLocalRef(string);env->DeleteLocalRef(strings);return result;
}
