#include <cassert>
#include <cerrno>
#include <cmath>
#include <limits>
#include "native-surface.mm"
extern "C" {
#include "graphics-host.h"
int kl_errno_to_linux(int value){return value;}
int kl_errno_from_linux(int value){return value;}
}
#include "indices.h"
static int retained=0,retired=0;
static int retainConsumer(void *p){assert(p==(void*)7);retained++;return 1;}
static void releaseConsumer(void *p){assert(p==(void*)7);retired++;}
static JNIEnv *outer=(JNIEnv*)(uintptr_t)0x123400;
static JNIEnv *environment(void*,JNIEnv *actual,JNIEnv *guest){return guest==outer?actual:nullptr;}
template<class A> static int64_t call(JNIEnv *env,unsigned index,A &args){
    auto b=klj_bionic_graphics_bindings();assert(b&&b->count==42&&index<b->count);
    assert(b->targets[index].argument_size==sizeof args);
    KljBionicNdkPacket p={sizeof p,KLJ_BIONIC_NDK_ABI,b->targets[index].target,(uintptr_t)&args,sizeof args,0,0,-1};
    return klj_bionic_graphics_dispatch(env,&p);
}
struct Get {void *window;int result;};
struct One {void *window;};
struct Pair {void *window;int value,result;};
struct Geometry {void *window;int width,height,format,result;};
struct From {JNIEnv *env;jobject surface;void *result;};
struct To {JNIEnv *env;void *window;jobject result;};
struct Frame {void *window;float rate;int8_t compatibility;int result;};
struct Strategy {void *window;float rate;int8_t compatibility,strategy;int result;};
struct Read {const void *parcel;void **output;int result;};
struct Write {void *window,*parcel;int result;};
struct Lock {void *window,*buffer,*dirty;int result;};
extern "C" JNIEXPORT void JNICALL Java_NativeWindowControl_run(JNIEnv *env,jclass,jobject surface){
    KljBionicGraphicsOwner owner={lookup,environment,nullptr,nullptr};assert(!klj_bionic_graphics_prepare(&owner));
    auto cls=env->FindClass("maclauncher/android/framework/HostSurface");assert(cls);
    jlong lease=Java_maclauncher_android_bridge_NativeSurface_createComposition(env,nullptr,320,240,1,surface);assert(lease);
    env->SetStaticLongField(cls,env->GetStaticFieldID(cls,"lease","J"),lease);
    {WindowLock guard;auto w=find(lease);assert(w);w->consumer=7;w->consumerRetain=retainConsumer;w->consumerRelease=releaseConsumer;}
    From from={outer,surface,nullptr};assert(!call(env,IDX_ANativeWindow_fromSurface,from));assert(from.result&&retained==1&&retired==0);
    void *w=from.result;assert(known(w)&&known(w)->references==2);
    From bad={nullptr,surface,nullptr};assert(call(env,IDX_ANativeWindow_fromSurface,bad)==-22&&bad.result==nullptr);
    From empty={outer,nullptr,(void*)1};assert(!call(env,IDX_ANativeWindow_fromSurface,empty)&&empty.result==nullptr);
    One one={w};assert(!call(env,IDX_ANativeWindow_acquire,one));assert(known(w)->references==3&&retained==1);
    To to={outer,w,nullptr};assert(!call(env,IDX_ANativeWindow_toSurface,to));assert(to.result&&env->IsSameObject(surface,to.result));env->DeleteLocalRef(to.result);assert(known(w)->references==3);
    Get width={w,0},height={w,0},format={w,0};
    assert(!call(env,IDX_ANativeWindow_getWidth,width)&&width.result==320);
    assert(!call(env,IDX_ANativeWindow_getHeight,height)&&height.result==240);
    assert(!call(env,IDX_ANativeWindow_getFormat,format)&&format.result==1);
    Geometry geometry={w,160,120,1,0};assert(!call(env,IDX_ANativeWindow_setBuffersGeometry,geometry)&&!geometry.result);assert(known(w)->width==160&&known(w)->height==120);
    assert(!call(env,IDX_ANativeWindow_getWidth,width)&&width.result==320);
    geometry.width=0;assert(!call(env,IDX_ANativeWindow_setBuffersGeometry,geometry)&&geometry.result==-22&&known(w)->width==160);
    Pair transform={w,0,7};assert(!call(env,IDX_ANativeWindow_setBuffersTransform,transform)&&!transform.result);transform.value=8;assert(!call(env,IDX_ANativeWindow_setBuffersTransform,transform)&&transform.result==-22);transform.value=1;assert(!call(env,IDX_ANativeWindow_setBuffersTransform,transform)&&transform.result==-38);
    Pair space={w,0,7};assert(!call(env,IDX_ANativeWindow_setBuffersDataSpace,space)&&!space.result);space.value=1;assert(!call(env,IDX_ANativeWindow_setBuffersDataSpace,space)&&space.result==-22);
    Get data={w,7};assert(!call(env,IDX_ANativeWindow_getBuffersDataSpace,data)&&!data.result);assert(!call(env,IDX_ANativeWindow_getBuffersDefaultDataSpace,data)&&!data.result);data.window=nullptr;assert(!call(env,IDX_ANativeWindow_getBuffersDataSpace,data)&&data.result==-22);
    Frame frame={w,60,0,7};assert(!call(env,IDX_ANativeWindow_setFrameRate,frame)&&frame.result==-38);frame.rate=std::numeric_limits<float>::quiet_NaN();assert(!call(env,IDX_ANativeWindow_setFrameRate,frame)&&frame.result==-22);
    Strategy strategy={w,0,127,127,7};assert(!call(env,IDX_ANativeWindow_setFrameRateWithChangeStrategy,strategy)&&!strategy.result);strategy.rate=60;assert(!call(env,IDX_ANativeWindow_setFrameRateWithChangeStrategy,strategy)&&strategy.result==-22);
    Get clear={w,7};assert(!call(env,IDX_ANativeWindow_clearFrameRate,clear)&&!clear.result);
    assert(!call(env,IDX_ANativeWindow_tryAllocateBuffers,one));assert(known(w)->storage==nullptr);
    void *out=(void*)1;Read read={(void*)2,&out,7};assert(!call(env,IDX_ANativeWindow_readFromParcel,read)&&read.result==-38&&out==nullptr);read.parcel=nullptr;out=(void*)1;assert(!call(env,IDX_ANativeWindow_readFromParcel,read)&&read.result==-22&&out==nullptr);
    Write write={w,(void*)2,7};assert(!call(env,IDX_ANativeWindow_writeToParcel,write)&&write.result==-38);write.parcel=nullptr;assert(!call(env,IDX_ANativeWindow_writeToParcel,write)&&write.result==-22);
    Lock buffer={w,nullptr,nullptr,0};assert(!call(env,IDX_ANativeWindow_lock,buffer)&&buffer.result==-38);Get post={w,0};assert(!call(env,IDX_ANativeWindow_unlockAndPost,post)&&post.result==-38);
    auto exceptionType=env->FindClass("java/lang/IllegalStateException");env->ThrowNew(exceptionType,"preserved");auto original=env->ExceptionOccurred();from.env=outer;from.result=(void*)1;assert(!call(env,IDX_ANativeWindow_fromSurface,from)&&from.result==nullptr);auto after=env->ExceptionOccurred();env->ExceptionClear();assert(env->IsSameObject(original,after));env->DeleteLocalRef(original);env->DeleteLocalRef(after);env->DeleteLocalRef(exceptionType);
    assert(!call(env,IDX_ANativeWindow_release,one));assert(known(w)->references==2&&retired==0);assert(!call(env,IDX_ANativeWindow_release,one));assert(known(w)->references==1&&retired==1);
    Java_maclauncher_android_bridge_NativeSurface_release(env,nullptr,lease);assert(windows.empty()&&retained==retired);
    from.env=outer;from.result=(void*)1;assert(!call(env,IDX_ANativeWindow_fromSurface,from)&&from.result==nullptr);env->DeleteLocalRef(cls);assert(!env->ExceptionCheck());
}
