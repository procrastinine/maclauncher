#include <jni.h>
#include <android/binder_ibinder_jni.h>
#include <android/binder_libbinder.h>
#include <binder/IBinder.h>
#include <binder/Parcel.h>
#include <utils/String16.h>
#include <pthread.h>
#include <cstdio>

namespace {
struct Request {android::sp<android::IBinder> endpoint;JavaVM* vm;int value;bool passed=false;};
void* transact(void* value){
 auto& request=*static_cast<Request*>(value);JNIEnv* env=nullptr;
 if(request.vm->GetEnv(reinterpret_cast<void**>(&env),JNI_VERSION_1_6)!=JNI_EDETACHED)return nullptr;
 android::Parcel input,reply;input.writeInterfaceToken(android::String16("maclauncher.android.fixture.LocalThread"));input.writeInt32(request.value);
 if(request.endpoint->transact(android::IBinder::FIRST_CALL_TRANSACTION,input,&reply,0)!=android::OK)return nullptr;
 if(request.vm->GetEnv(reinterpret_cast<void**>(&env),JNI_VERSION_1_6)!=JNI_OK||!env)return nullptr;
 if(reply.readExceptionCode()!=0||reply.readInt32()!=request.value*2)return nullptr;
 auto returned=reply.readStrongBinder();
 if(returned.get()!=request.endpoint.get()||returned->getInterfaceDescriptor()!=android::String16("maclauncher.android.fixture.LocalThread"))return nullptr;
 request.passed=true;return nullptr;
}
void fail(JNIEnv* env,const char* message){jclass type=env->FindClass("java/lang/AssertionError");if(type)env->ThrowNew(type,message);}
}
extern "C" JNIEXPORT void JNICALL Java_maclauncher_android_LocalBinderThreadProbe_exercise(JNIEnv* env,jclass,jobject endpoint){
 JavaVM* vm=nullptr;if(env->GetJavaVM(&vm)!=JNI_OK||!vm){fail(env,"Original VM unavailable");return;}
 AIBinder* handle=AIBinder_fromJavaBinder(env,endpoint);if(!handle){fail(env,"Original Java Binder unavailable");return;}
 auto binder=AIBinder_toPlatformBinder(handle);AIBinder_decStrong(handle);
 AIBinder* back=AIBinder_fromPlatformBinder(binder);jobject original=env->NewLocalRef(AIBinder_toJavaBinder(env,back));AIBinder_decStrong(back);
 bool same=env->IsSameObject(endpoint,original);env->DeleteLocalRef(original);
 if(!same){fail(env,"Native Binder conversion changed original Java identity");return;}
 for(int index=0;index<16;++index){
  Request request{binder,vm,index+1};pthread_t worker;
  if(pthread_create(&worker,nullptr,transact,&request)||pthread_join(worker,nullptr)||!request.passed){fail(env,"Original Binder native-thread transaction failed");return;}
 }
}
