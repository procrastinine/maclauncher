#import <Metal/Metal.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <dlfcn.h>
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <string>
#include <thread>

static void *eglLibrary, *glesLibrary;
template<class F> F api(const char *name) {
    void *address = dlsym(eglLibrary, name);
    if (!address) address = dlsym(glesLibrary, name);
    if (!address) address = reinterpret_cast<void *>(
        reinterpret_cast<PFNEGLGETPROCADDRESSPROC>(dlsym(eglLibrary, "eglGetProcAddress"))(name));
    if (!address) std::fprintf(stderr,"Missing provider entrypoint: %s\n",name);
    assert(address); return reinterpret_cast<F>(address);
}

int main(int argc, char **argv) { @autoreleasepool {
    assert(argc == 2);
    eglLibrary = dlopen((std::string(argv[1])+"/libEGL.dylib").c_str(), RTLD_NOW|RTLD_LOCAL);
    glesLibrary = dlopen((std::string(argv[1])+"/libGLESv2.dylib").c_str(), RTLD_NOW|RTLD_LOCAL);
    assert(eglLibrary && glesLibrary);
    const EGLint platform[] = {0x3203, 0x3489, EGL_NONE};
    auto display = api<PFNEGLGETPLATFORMDISPLAYEXTPROC>("eglGetPlatformDisplayEXT")(0x3202, nullptr, platform);
    assert(api<PFNEGLINITIALIZEPROC>("eglInitialize")(display, nullptr, nullptr));
    const EGLint choose[] = {EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_NONE};
    EGLConfig config; EGLint count;
    assert(api<PFNEGLCHOOSECONFIGPROC>("eglChooseConfig")(display,choose,&config,1,&count) && count);
    const EGLint contextAttrs[] = {EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
    const EGLint surfaceAttrs[] = {EGL_WIDTH,8,EGL_HEIGHT,8,EGL_NONE};
    auto context = api<PFNEGLCREATECONTEXTPROC>("eglCreateContext")(display,config,EGL_NO_CONTEXT,contextAttrs);
    auto surface = api<PFNEGLCREATEPBUFFERSURFACEPROC>("eglCreatePbufferSurface")(display,config,surfaceAttrs);
    assert(context && surface);
    assert(api<PFNEGLMAKECURRENTPROC>("eglMakeCurrent")(display,surface,surface,context));

    // Both EGL entrypoint families support waiting on a native worker that has
    // never bound a context. The flush flag must not require one either.
    for (bool core : {false,true}) for (EGLint flags : {0,EGL_SYNC_FLUSH_COMMANDS_BIT}) {
        api<void(*)(GLbitfield)>("glClear")(GL_COLOR_BUFFER_BIT);
        auto sync = core ? api<PFNEGLCREATESYNCPROC>("eglCreateSync")(display,EGL_SYNC_FENCE,nullptr)
                         : api<PFNEGLCREATESYNCKHRPROC>("eglCreateSyncKHR")(display,EGL_SYNC_FENCE_KHR,nullptr);
        assert(sync);
        // Cross-context EGL fences submit at creation, as on ANGLE Vulkan.
        // The producer may pace or wait before its next swap/explicit flush.
        std::thread worker([&] {
            assert(api<PFNEGLGETCURRENTCONTEXTPROC>("eglGetCurrentContext")() == EGL_NO_CONTEXT);
            EGLint status = core ? api<PFNEGLCLIENTWAITSYNCPROC>("eglClientWaitSync")(display,sync,flags,2000000000)
                                 : api<PFNEGLCLIENTWAITSYNCKHRPROC>("eglClientWaitSyncKHR")(display,sync,flags,2000000000);
            assert(status == EGL_CONDITION_SATISFIED);
            assert(api<PFNEGLGETERRORPROC>("eglGetError")() == EGL_SUCCESS);
            api<PFNEGLRELEASETHREADPROC>("eglReleaseThread")();
        }); worker.join();
        assert(api<PFNEGLDESTROYSYNCPROC>("eglDestroySync")(display,sync));
    }

    // The Metal shared-event implementation has a separate client-wait path.
    // Exercise an unsignaled event, then two actual waiters and notification.
    id<MTLSharedEvent> event = [MTLCreateSystemDefaultDevice() newSharedEvent];
    assert(event);
    const EGLAttrib attrs[] = {0x34D9,reinterpret_cast<EGLAttrib>((__bridge void *)event),
        0x34DA,1,0x34DB,0,EGL_SYNC_CONDITION,0x34DC,EGL_NONE};
    auto shared = api<PFNEGLCREATESYNCPROC>("eglCreateSync")(display,0x34D8,attrs);
    assert(shared);
    std::thread poll([&] {
        assert(api<PFNEGLCLIENTWAITSYNCKHRPROC>("eglClientWaitSyncKHR")(display,shared,0,0) == EGL_TIMEOUT_EXPIRED_KHR);
        api<PFNEGLRELEASETHREADPROC>("eglReleaseThread")();
    }); poll.join();
    auto wait = [&] {
        assert(api<PFNEGLCLIENTWAITSYNCKHRPROC>("eglClientWaitSyncKHR")(display,shared,EGL_SYNC_FLUSH_COMMANDS_BIT_KHR,2000000000) == EGL_CONDITION_SATISFIED_KHR);
        api<PFNEGLRELEASETHREADPROC>("eglReleaseThread")();
    };
    std::thread first(wait), second(wait);
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    event.signaledValue = 1;
    first.join(); second.join();
    assert(api<PFNEGLDESTROYSYNCKHRPROC>("eglDestroySyncKHR")(display,shared));

    // A client fence wait must not hold the global EGL lock: the producer
    // needs that lock to manage fences and submit the frame being waited for.
    // Destroying the waited-on handle must also retain the in-flight wait.
    for (bool core : {false, true}) {
        id<MTLSharedEvent> waitingEvent = [MTLCreateSystemDefaultDevice() newSharedEvent];
        const EGLAttrib waitingAttrs[] = {0x34D9,reinterpret_cast<EGLAttrib>((__bridge void *)waitingEvent),
            0x34DA,1,0x34DB,0,EGL_SYNC_CONDITION,0x34DC,EGL_NONE};
        auto retained = api<PFNEGLCREATESYNCPROC>("eglCreateSync")(display,0x34D8,waitingAttrs);
        assert(retained);
        std::atomic<bool> entered{false}, destroyed{false}, concurrent{false};
        std::thread waiter([&] {
            entered.store(true);
            const auto status = core
                ? api<PFNEGLCLIENTWAITSYNCPROC>("eglClientWaitSync")(display,retained,0,2000000000)
                : api<PFNEGLCLIENTWAITSYNCKHRPROC>("eglClientWaitSyncKHR")(display,retained,0,2000000000);
            assert(status == EGL_CONDITION_SATISFIED);
            api<PFNEGLRELEASETHREADPROC>("eglReleaseThread")();
        });
        while (!entered.load()) std::this_thread::yield();
        std::this_thread::sleep_for(std::chrono::milliseconds(30));
        std::thread signaler([&] {
            const auto deadline = std::chrono::steady_clock::now()+std::chrono::milliseconds(400);
            while (!destroyed.load() && std::chrono::steady_clock::now() < deadline)
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            concurrent.store(destroyed.load());
            waitingEvent.signaledValue = 1;
        });
        auto independent = api<PFNEGLCREATESYNCPROC>("eglCreateSync")(display,EGL_SYNC_FENCE,nullptr);
        assert(independent);
        assert(api<PFNEGLDESTROYSYNCPROC>("eglDestroySync")(display,independent));
        assert(api<PFNEGLDESTROYSYNCPROC>("eglDestroySync")(display,retained));
        destroyed.store(true);
        signaler.join(); waiter.join();
        assert(concurrent.load() && "EGL fence management blocked behind a client wait");
    }
    // Display termination resets its queue/listener, while the pending wait
    // still owns the event and listener it needs to complete safely.
    id<MTLSharedEvent> finalEvent = [MTLCreateSystemDefaultDevice() newSharedEvent];
    const EGLAttrib finalAttrs[] = {0x34D9,reinterpret_cast<EGLAttrib>((__bridge void *)finalEvent),
        0x34DA,1,0x34DB,0,EGL_SYNC_CONDITION,0x34DC,EGL_NONE};
    auto finalSync = api<PFNEGLCREATESYNCPROC>("eglCreateSync")(display,0x34D8,finalAttrs);
    assert(finalSync);
    std::atomic<bool> finalEntered{false}, terminated{false};
    std::thread finalWaiter([&] {
        finalEntered.store(true);
        assert(api<PFNEGLCLIENTWAITSYNCPROC>("eglClientWaitSync")(display,finalSync,0,2000000000) == EGL_CONDITION_SATISFIED);
        api<PFNEGLRELEASETHREADPROC>("eglReleaseThread")();
    });
    while (!finalEntered.load()) std::this_thread::yield();
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    std::thread finalSignaler([&] {
        const auto deadline = std::chrono::steady_clock::now()+std::chrono::milliseconds(400);
        while (!terminated.load() && std::chrono::steady_clock::now() < deadline)
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        finalEvent.signaledValue = 1;
    });
    assert(api<PFNEGLMAKECURRENTPROC>("eglMakeCurrent")(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    assert(api<PFNEGLDESTROYSURFACEPROC>("eglDestroySurface")(display,surface));
    assert(api<PFNEGLDESTROYCONTEXTPROC>("eglDestroyContext")(display,context));
    assert(api<PFNEGLTERMINATEPROC>("eglTerminate")(display));
    terminated.store(true);
    finalSignaler.join(); finalWaiter.join();
    std::puts("PASS context-free EGL fence and shared-event workers");
} }
