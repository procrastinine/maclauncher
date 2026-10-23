#include <jni.h>
#include <dlfcn.h>
#include <cassert>
#include <cstdio>
#include <string>

int main(int count,char** arguments){
    assert(count==5);
    std::string classPath="-Djava.class.path="+std::string(arguments[1]);
    JavaVMOption options[]={{classPath.data(),nullptr},{const_cast<char*>("-Xcheck:jni"),nullptr}};
    JavaVMInitArgs init{};init.version=JNI_VERSION_1_6;init.nOptions=2;init.options=options;
    JavaVM* vm=nullptr;JNIEnv* env=nullptr;
    assert(JNI_CreateJavaVM(&vm,reinterpret_cast<void**>(&env),&init)==JNI_OK);
    jclass type=env->FindClass("maclauncher/android/fixture/BinderNativeDirectoryProbe");assert(type);
    jmethodID main=env->GetStaticMethodID(type,"main","([Ljava/lang/String;)V");assert(main);
    jclass string=env->FindClass("java/lang/String");assert(string);
    jobjectArray args=env->NewObjectArray(3,string,nullptr);assert(args);
    for(int index=0;index<3;index++){jstring value=env->NewStringUTF(arguments[index+2]);assert(value);env->SetObjectArrayElement(args,index,value);env->DeleteLocalRef(value);}
    env->CallStaticVoidMethod(type,main,args);
    if(env->ExceptionCheck()){env->ExceptionDescribe();return 1;}
    env->DeleteLocalRef(args);env->DeleteLocalRef(string);env->DeleteLocalRef(type);
    std::string library=std::string(arguments[2])+"/native/libnativebinding.dylib";
    void* owner=dlopen(library.c_str(),RTLD_LAZY|RTLD_NOLOAD);assert(owner);
    auto environment=reinterpret_cast<JNIEnv*(*)(JavaVM*)>(dlsym(owner,"klj_jni_vm_environment"));
    auto guestVm=reinterpret_cast<JavaVM*(*)(JavaVM*)>(dlsym(owner,"klj_guest_vm"));
    assert(environment&&guestVm&&environment(vm)==env);
    JavaVM* guest=guestVm(vm);assert(guest);
    assert(vm->DestroyJavaVM()==JNI_OK);
    // Both late shared consumers must reject the dead VM before touching its
    // JNI invocation table. Original native cache destructors still run on exit.
    assert(environment(vm)==nullptr&&guestVm(vm)==nullptr);
    void* late=reinterpret_cast<void*>(1);
    assert(guest->AttachCurrentThreadAsDaemon(&late,nullptr)==JNI_ERR&&late==nullptr);
    late=reinterpret_cast<void*>(1);
    assert(guest->GetEnv(&late,JNI_VERSION_1_6)==JNI_ERR&&late==nullptr);
    dlclose(owner);
    std::puts("PASS real JVM destruction: Java permission controller retirement and dead-VM attachment rejection");
}
