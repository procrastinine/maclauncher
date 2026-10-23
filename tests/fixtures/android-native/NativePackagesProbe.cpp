#include <jni.h>
#include <binder/Parcel.h>
#include <binder/RpcSession.h>
#include <binder/unique_fd.h>
#include <android/os/IServiceManager.h>
#include <android/content/pm/IPackageManagerNative.h>
#include <android/content/pm/BnStagedApexObserver.h>
#include <stdexcept>
#include <unistd.h>

using namespace android;
using namespace android::content::pm;
namespace {
void check(bool value,const char* message){if(!value)throw std::runtime_error(message);}
class Observer final:public BnStagedApexObserver {
    binder::Status onApexStaged(const ApexStagedEvent&)override{return binder::Status::ok();}
};
}
extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM*,void*){return JNI_VERSION_1_6;}
extern "C" JNIEXPORT void JNICALL Java_maclauncher_android_fixture_NativePackagesProbe_probe(JNIEnv* env,jclass,jint socket,jint expectedSdk,jlong expectedVersion,jboolean expectedCapture,jboolean expectedDebug){
    sp<RpcSession> session;
    try{
        binder::unique_fd bootstrap(dup(socket));check(bootstrap.ok(),"Native service-directory bootstrap");
        session=RpcSession::make();session->setMaxIncomingThreads(4);session->setFileDescriptorTransportMode(RpcSession::FileDescriptorTransportMode::UNIX);
        check(session->setupUnixDomainSocketBootstrapClient(std::move(bootstrap))==OK,"Original Binder RPC connection");
        auto directory=interface_cast<android::os::IServiceManager>(session->getRootObject());sp<IBinder> endpoint;
        check(directory&&directory->getService("package_native",&endpoint).isOk()&&endpoint,"Published original package_native contract");
        auto packages=interface_cast<IPackageManagerNative>(endpoint);check(packages!=nullptr,"Original native AIDL client");
        std::vector<std::string> names;check(packages->getNamesForUids({1000,99999},&names).isOk()&&names.size()==2&&names[0]=="android"&&names[1].empty(),"Native UID names and unknown sentinel");
        int32_t uid=-1;check(packages->getPackageUid("android",0,0,&uid).isOk()&&uid==1000,"Native UID uses original package catalog");
        check(packages->getPackageUid("missing.package",0,0,&uid).isOk()&&uid==-1,"Missing native package UID");
        std::string installer;check(packages->getInstallerForPackage(String16("android"),&installer).isOk()&&installer=="preload","Original system installer label");
        check(packages->getInstallerForPackage(String16("missing.package"),&installer).isOk()&&installer.empty(),"Missing installer is empty");
        int64_t version=0;check(packages->getVersionCodeForPackage(String16("android"),&version).isOk()&&version==expectedVersion,"Native version code");
        check(packages->getVersionCodeForPackage(String16("missing.package"),&version).isOk()&&version==0,"Missing version is zero");
        std::vector<bool> capture;check(packages->isAudioPlaybackCaptureAllowed({"android","missing.package"},&capture).isOk()&&capture.size()==2&&capture[0]==bool(expectedCapture)&&!capture[1],"Native audio-capture manifest policy");
        int32_t location=0;check(packages->getLocationFlags("android",&location).isOk()&&(location&IPackageManagerNative::LOCATION_SYSTEM),"Original system location flag");
        int32_t sdk=0;check(packages->getTargetSdkVersionForPackage(String16("android"),&sdk).isOk()&&sdk==expectedSdk,"AudioRecord native target SDK query");
        check(!packages->getTargetSdkVersionForPackage(String16("missing.package"),&sdk).isOk(),"Unknown target SDK retains original failure contract");
        std::string metadata;check(packages->getModuleMetadataPackageName(&metadata).isOk(),"Original module metadata resource query");
        bool matches=true;check(packages->hasSha256SigningCertificate("missing.package",std::vector<uint8_t>(32),&matches).isOk()&&!matches,"Native certificate query uses package identity");
        bool debug=false;check(packages->isPackageDebuggable(String16("android"),&debug).isOk()&&debug==bool(expectedDebug),"Native debuggable manifest flag");
        bool feature=true;check(packages->hasSystemFeature(String16("fixture.missing.feature"),0,&feature).isOk()&&!feature,"MediaCodec original feature query completes");
        auto observer=sp<Observer>::make();check(packages->registerStagedApexObserver(observer).isOk(),"Original native staged observer registration");
        std::vector<StagedApexInfo> staged;check(packages->getStagedApexInfos(&staged).isOk()&&staged.empty(),"Actual empty staged APEX state");
        check(packages->unregisterStagedApexObserver(observer).isOk(),"Original native staged observer retirement");
        observer.clear();packages.clear();endpoint.clear();directory.clear();check(session->shutdownAndWait(true),"Native package client shutdown");
    }catch(const std::exception& error){if(session)(void)session->shutdownAndWait(true);env->ThrowNew(env->FindClass("java/lang/AssertionError"),error.what());}
}
