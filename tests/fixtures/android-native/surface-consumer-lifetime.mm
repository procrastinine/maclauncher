#include "native-surface.mm"
#include <cassert>
#include <cstdio>
#include <vector>

int main(){@autoreleasepool{
    // This fixture calls native buffer owners without a JVM. Report an actual
    // allocation failure explicitly instead of dereferencing a null JNIEnv.
    JNINativeInterface_ callbacks{};
    callbacks.ExceptionCheck=[](JNIEnv*)->jboolean{return JNI_FALSE;};
    callbacks.FindClass=[](JNIEnv*,const char*)->jclass{return reinterpret_cast<jclass>(1);};
    callbacks.ThrowNew=[](JNIEnv*,jclass,const char*message)->jint{std::fprintf(stderr,"%s\n",message);std::abort();};
    // Windows record their owning VM; no Java callback is made in this fixture.
    callbacks.GetJavaVM=[](JNIEnv*,JavaVM**vm)->jint{*vm=nullptr;return JNI_OK;};
    JNIEnv_ env{&callbacks};
    void *presenter=(void*)0x1234;
    klj_surface_host(presenter);
    auto lease=Java_maclauncher_android_bridge_NativeSurface_create(&env,nullptr,16,16,1);
    void *borrowedPresenter=nullptr;int width=0,height=0;
    auto window=klj_surface_acquire_lease(lease,&borrowedPresenter,&width,&height);
    assert(window&&borrowedPresenter==presenter&&width==16&&height==16);
    assert(lookup("ANativeWindow_acquire"));assert(klj_surface_retain_window(window));
    auto storage=Java_maclauncher_android_bridge_NativeSurface_storageId(nullptr,nullptr,(jlong)(uintptr_t)window);
    assert(!klj_surface_detach_presenter(presenter)); // Actual enqueue is active.
    klj_surface_release_lease(window);
    void *eglPresenter=nullptr;int ew=0,eh=0;
    auto eglStorage=(IOSurfaceRef)klj_surface_begin_egl(window,&eglPresenter,&ew,&eh,1);
    assert(eglStorage&&eglPresenter==presenter);
    assert(!klj_surface_detach_presenter(presenter)); // Also covers EGL creation before registration.
    klj_surface_record_egl(window,(void*)0x4321);
    assert(!klj_surface_detach_presenter(presenter));
    klj_surface_end_egl(window);CFRelease(eglStorage);
    Java_maclauncher_android_bridge_NativeSurface_release(nullptr,nullptr,lease);
    assert(klj_surface_detach_presenter(presenter)); // Borrowed ANativeWindow is storage only.
    assert(Java_maclauncher_android_bridge_NativeSurface_storageAlive(nullptr,nullptr,storage));
    assert(!klj_surface_begin_egl(window,&eglPresenter,&ew,&eh,1));
    klj_surface_release_window(window);
    assert(!Java_maclauncher_android_bridge_NativeSurface_storageAlive(nullptr,nullptr,storage));

    klj_surface_host(presenter);
    lease=Java_maclauncher_android_bridge_NativeSurface_create(&env,nullptr,16,16,1);
    assert(klj_surface_detach_presenter(presenter)); // An original Surface may remain bound.
    window=klj_surface_acquire_lease(lease,&borrowedPresenter,&width,&height);
    assert(window&&!borrowedPresenter); // It cannot recover the retired display.
    assert(!klj_surface_begin_egl(window,&eglPresenter,&ew,&eh,1));
    klj_surface_release_lease(window);
    Java_maclauncher_android_bridge_NativeSurface_release(nullptr,nullptr,lease);
    assert(windows.empty());

    std::puts("PASS native display detaches independently of retained buffer storage and protects active submissions");
}}
