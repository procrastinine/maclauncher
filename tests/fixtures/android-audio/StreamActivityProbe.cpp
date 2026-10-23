#include <jni.h>
#if defined(__APPLE__)
#include "audio-volume.h"
extern "C" JNIEXPORT void JNICALL Java_maclauncher_android_media_StreamActivityProbe_install(JNIEnv*,jclass) {}
extern "C" JNIEXPORT void JNICALL Java_maclauncher_android_media_StreamActivityProbe_playing(JNIEnv*,jclass,jint stream,jboolean active) {
    klj_audio_activity_transition(stream,!active,active);
}
#else
#include <media/AudioSystem.h>
#include <android/media/IAudioPolicyService.h>
static int selected=3;
static bool playing=false,recent=false;
class Policy final : public android::media::IAudioPolicyServiceDefault {
    android::binder::Status isStreamActive(android::media::audio::common::AudioStreamType stream,int32_t past,bool* active) override {
        *active=int(stream)==selected&&(playing||(recent&&past==1234));
        return android::binder::Status::ok();
    }
};
extern "C" JNIEXPORT void JNICALL Java_maclauncher_android_media_StreamActivityProbe_install(JNIEnv* env,jclass) {
    android::AudioSystem::disableThreadPool();
    auto policy=android::sp<Policy>::make();
    if(android::AudioSystem::setLocalAudioPolicyService(policy)!=android::OK)
        env->ThrowNew(env->FindClass("java/lang/AssertionError"),"Original AudioSystem local policy installation failed");
}
extern "C" JNIEXPORT void JNICALL Java_maclauncher_android_media_StreamActivityProbe_playing(JNIEnv*,jclass,jint stream,jboolean active) {
    selected=stream;playing=active;recent=!active;
}
#endif
