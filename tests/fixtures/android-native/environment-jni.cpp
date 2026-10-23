#include <jni.h>
#include <cassert>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <unistd.h>
extern "C" {
jstring Java_libcore_io_Linux_getenv(JNIEnv*,jobject,jstring);
void Java_libcore_io_Linux_setenv(JNIEnv*,jobject,jstring,jstring,jboolean);
void Java_libcore_io_Linux_unsetenv(JNIEnv*,jobject,jstring);
jobjectArray Java_libcore_io_Linux_environ(JNIEnv*,jobject);
}
int main(){
    JavaVM* vm=nullptr;JNIEnv* env=nullptr;JavaVMInitArgs args{};args.version=JNI_VERSION_1_6;
    JavaVMOption option{};option.optionString=const_cast<char*>("-Xcheck:jni");args.nOptions=1;args.options=&option;
    assert(JNI_CreateJavaVM(&vm,reinterpret_cast<void**>(&env),&args)==JNI_OK);
    const std::string name="MACLAUNCHER_ENVIRONMENT_"+std::to_string(getpid());
    jstring key=env->NewStringUTF(name.c_str());
    const jchar unicode[]={'h',0xe9,'l','l','o',0xd83d,0xde00};
    jstring value=env->NewString(unicode,7);
    Java_libcore_io_Linux_unsetenv(env,nullptr,key);assert(!env->ExceptionCheck());
    assert(!Java_libcore_io_Linux_getenv(env,nullptr,key)&&!env->ExceptionCheck());
    Java_libcore_io_Linux_setenv(env,nullptr,key,value,JNI_FALSE);assert(!env->ExceptionCheck());
    const char* utf8="h\xc3\xa9llo\xf0\x9f\x98\x80";
    assert(std::strcmp(getenv(name.c_str()),utf8)==0);
    jstring read=Java_libcore_io_Linux_getenv(env,nullptr,key);assert(read&&!env->ExceptionCheck());
    const jchar* chars=env->GetStringChars(read,nullptr);
    assert(env->GetStringLength(read)==7&&!std::memcmp(chars,unicode,sizeof(unicode)));
    env->ReleaseStringChars(read,chars);env->DeleteLocalRef(read);
    jobjectArray entries=Java_libcore_io_Linux_environ(env,nullptr);assert(entries&&!env->ExceptionCheck());
    bool found=false;
    for(jsize i=0;i<env->GetArrayLength(entries);++i){
        auto entry=static_cast<jstring>(env->GetObjectArrayElement(entries,i));
        const jchar* text=env->GetStringChars(entry,nullptr);
        if(env->GetStringLength(entry)==static_cast<jsize>(name.size()+1+7)){
            bool prefix=true;for(size_t j=0;j<name.size();++j)prefix&=text[j]==static_cast<jchar>(name[j]);
            found|=prefix&&text[name.size()]=='='&&!std::memcmp(text+name.size()+1,unicode,sizeof(unicode));
        }
        env->ReleaseStringChars(entry,text);env->DeleteLocalRef(entry);
    }
    assert(found);env->DeleteLocalRef(entries);
    jstring empty=env->NewStringUTF("");
    Java_libcore_io_Linux_setenv(env,nullptr,key,empty,JNI_FALSE);assert(!env->ExceptionCheck());
    assert(std::strcmp(getenv(name.c_str()),utf8)==0);
    Java_libcore_io_Linux_setenv(env,nullptr,key,empty,JNI_TRUE);assert(!env->ExceptionCheck());
    assert(getenv(name.c_str())&&*getenv(name.c_str())==0);
    const jchar withNul[]={'x',0,'y'};jstring invalid=env->NewString(withNul,3);
    Java_libcore_io_Linux_setenv(env,nullptr,key,invalid,JNI_TRUE);
    jthrowable failure=env->ExceptionOccurred();assert(failure);env->ExceptionClear();
    jclass type=env->FindClass("java/lang/IllegalArgumentException");assert(type&&env->IsInstanceOf(failure,type));
    assert(getenv(name.c_str())&&*getenv(name.c_str())==0);
    env->DeleteLocalRef(type);env->DeleteLocalRef(failure);env->DeleteLocalRef(invalid);
    Java_libcore_io_Linux_unsetenv(env,nullptr,key);assert(!env->ExceptionCheck()&&!getenv(name.c_str()));
    env->DeleteLocalRef(empty);env->DeleteLocalRef(value);env->DeleteLocalRef(key);
    assert(vm->DestroyJavaVM()==JNI_OK);
    std::cout<<"PASS original libcore JNI environment UTF-8, enumeration, overwrite, NUL rejection and removal\n";
}
