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
    JNIEnv_ env{&callbacks};
    void *presenter=(void*)0x1234;
    klj_surface_host(presenter);
    auto lease=Java_maclauncher_android_bridge_NativeSurface_create(&env,nullptr,16,16,1);
    void *borrowedPresenter=nullptr;int width=0,height=0;
    auto window=klj_surface_acquire_lease(lease,&borrowedPresenter,&width,&height);
    assert(window&&borrowedPresenter==presenter&&width==16&&height==16);
    assert(!lookup("ANativeWindow_acquire"));assert(klj_surface_retain_window(window));
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

    // IOSurface lifetime follows all copies of the original handle's FD.
    uint64_t identity=0,other=0;int capability=-1,otherCapability=-1;uint32_t row=0,otherRow=0;
    assert(klj_graphics_storage_supports(KLJ_SURFACE_RGBA8));
    assert(!klj_graphics_storage_supports(KLJ_SURFACE_P010));
    assert(klj_graphics_storage_create(4,3,KLJ_SURFACE_RGBA8,&identity,&capability,&row)==0);
    assert(klj_graphics_storage_create(4,3,KLJ_SURFACE_RGBA8,&other,&otherCapability,&otherRow)==0);
    std::vector<uint8_t> source(row*3,0x79),copy(row*3,0);
    assert(klj_graphics_storage_write(capability,identity,source.data(),source.size(),row)==0);
    int cloned=dup(capability);assert(cloned>=0);close(capability);
    uint64_t resolved=0;assert(klj_graphics_storage_identity(cloned,&resolved)==0&&resolved==identity);
    assert(klj_graphics_storage_read(cloned,other,copy.data(),copy.size(),row)==-EACCES);
    assert(klj_graphics_storage_read(cloned,identity,copy.data(),copy.size(),row)==0);
    for(size_t y=0;y<3;y++)assert(!memcmp(copy.data()+y*row,source.data()+y*row,16));
    close(cloned);close(otherCapability);
    bool alive=true;for(int attempt=0;attempt<100&&alive;attempt++){
        auto value=IOSurfaceLookup(static_cast<IOSurfaceID>(identity));alive=value!=nullptr;if(value)CFRelease(value);
        if(alive)usleep(10000);
    }
    assert(!alive);
    std::puts("PASS shared FD storage lifetime, duplicate handles and identity-bound copies");
    std::puts("PASS native display detaches independently of retained buffer storage and protects active submissions");
}}
