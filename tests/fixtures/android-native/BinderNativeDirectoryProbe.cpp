#include <jni.h>
#include <binder/Binder.h>
#include <binder/IPCThreadState.h>
#include <binder/PermissionCache.h>
#include <binder/IPermissionController.h>
#include <android/binder_ibinder.h>
#include <binder/Parcel.h>
#include <binder/RpcSession.h>
#include <binder/unique_fd.h>
#include <android/os/IServiceManager.h>
#include <android_util_Binder.h>
#include <binder/IServiceManager.h>
#include <binder/IServiceManagerUnitTestHelper.h>
#include <unistd.h>
#include <atomic>
#include <stdexcept>
#include <string>

using namespace android;
extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM*,void*){return JNI_VERSION_1_6;}
namespace {
void check(bool value,const char* message){if(!value)throw std::runtime_error(message);}
class Callback final:public BBinder {
public:
    std::atomic<bool> called=false;
    status_t onTransact(uint32_t code,const Parcel& data,Parcel* reply,uint32_t)override{
        if(code!=1||data.readInt32()!=41)return BAD_VALUE;
        called=true;return reply->writeInt32(43);
    }
};
class DeniedPermission final:public BnPermissionController {
public:
    bool checkPermission(const String16&,int32_t,int32_t)override{return false;}
    int32_t noteOp(const String16&,int32_t,const String16&)override{return 0;}
    void getPackagesForUid(uid_t,Vector<String16>&)override{}
    bool isRuntimePermission(const String16&)override{return false;}
    int getPackageUid(const String16&,int)override{return -1;}
};
}
extern "C" JNIEXPORT void JNICALL Java_maclauncher_android_fixture_BinderNativeDirectoryProbe_probe(JNIEnv* env,jclass,jobject directory,jint ownPid,jint ownUid,jint physicalPid){
    try{
        // Use the same original native service-manager shim as the platform
        // bootstrap, retaining the actual Java AIDL directory endpoint.
        auto service=interface_cast<android::os::IServiceManager>(ibinderForJavaObject(env,directory));
        setDefaultServiceManager(getServiceManagerShimFromAidlServiceManagerForTests(service));
        check(IPCThreadState::self()->getCallingPid()==ownPid&&IPCThreadState::self()->getCallingUid()==static_cast<uid_t>(ownUid),"Native Binder Android principal");
        check(AIBinder_getCallingPid()==ownPid&&AIBinder_getCallingUid()==static_cast<uid_t>(ownUid),"NDK Binder Android principal");
        auto local=sp<Callback>::make();sp<IBinder> localBinder=local;pid_t debugPid=-1;
        check(local->getDebugPid()==ownPid&&localBinder->getDebugPid(&debugPid)==OK&&debugPid==ownPid,"Original local Binder debug PID");
        const String16 denied("fixture.permission.denied");
        PermissionCache::purgeCache();
        check(PermissionCache::checkPermission(denied,ownPid,ownUid),"Original native permission cache recognizes its Android process");
        check(physicalPid!=ownPid,"Permission domain collision requires distinct physical and Android process IDs");
        // Exercise original policy arguments directly. This does not enroll a
        // synthetic peer or alter authenticated RPC transport credentials.
        check(!PermissionCache::checkPermission(denied,physicalPid,ownUid),"A physical PID must not trigger Android's self permission shortcut");
        auto manager=defaultServiceManager();
        sp<IBinder> target=manager->getService(String16("fixture.native.transport"));
        check(target!=nullptr,"Original native service-manager query");
        check(target->getDebugPid(&debugPid)==OK&&debugPid==ownPid,"Original remote Binder debug PID");
        auto callback=sp<Callback>::make();
        int descriptors[2];check(pipe(descriptors)==0,"Descriptor source");
        binder::unique_fd reader(descriptors[0]),writer(descriptors[1]);
        check(write(writer.get(),"native-rpc",10)==10,"Descriptor payload");writer.reset();
        Parcel request,response;request.markForBinder(target);
        request.writeInt32(19);request.writeStrongBinder(callback);request.writeDupFileDescriptor(reader.get());
        request.writeInt64(INT64_C(0x1122334455667788));
        check(target->transact(1,request,&response,0)==OK,"Native request across original RPC sessions");
        check(callback->called,"Native callback completed");
        check(response.readInt32()==23,"Native response payload");
        check(response.readStrongBinder()==target,"Original Binder identity after relay");
        check(response.readInt64()==INT64_C(0x1122334455667788),"Payload offsets retained");
        target.clear();manager.clear();callback.clear();
    }catch(const std::exception& error){
        env->ThrowNew(env->FindClass("java/lang/AssertionError"),error.what());
    }
}
