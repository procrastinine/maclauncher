// The production presenter executes against the existing CPU-only device and
// EGL doubles. Only the private JNI observation table is supplied by this file.
#import <IOSurface/IOSurface.h>
static IOSurfaceID cpuSurfaceIdentity(IOSurfaceRef value){return static_cast<IOSurfaceID>(reinterpret_cast<uintptr_t>(value)>>4);}
#define IOSurfaceGetID cpuSurfaceIdentity
#define main previousLifecycleMain
#include "lifecycle.mm"
#undef main
extern "C" int klj_android_log_write(int,const char*,const char*){return 0;}

static unsigned jniChecks,jniFinds,jniThrows,jniClears;
[[maybe_unused]] static unsigned releasedLeases;
static jboolean checkedPending(JNIEnv *env){++jniChecks;return pending(env);}
static jclass checkedFind(JNIEnv *env,const char *name){++jniFinds;return find(env,name);}
static jint checkedThrow(JNIEnv *env,jclass type,const char *message){++jniThrows;return throwNew(env,type,message);}
static void forbiddenClear(JNIEnv*){++jniClears;abort();}

// This exact helper is copied from the production native-egl translation unit
// by the test runner. Its surrounding carriers supply no Java or GPU behavior.
namespace native_egl_control {
[[maybe_unused]] static unsigned error;
[[maybe_unused]] static constexpr unsigned EGL_BAD_ALLOC=0x3003;
struct WindowSurface {
    bool texture=false,composition=false;
    void *presenter=nullptr,*display=nullptr,*config=nullptr;
    std::vector<int> attributes;
};
static void *configRaw(void *value){return value;}
static int opaqueConfig(void*){return 0;}
static void *rawBuffer(WindowSurface&,void*,int,int){abort();}
static auto enter=klj_metal_enter;
static auto supply=klj_metal_supply_storage;
#ifdef KL_METAL_C_ERROR_ABI
static auto makeSurface=klj_metal_surface_c;
#else
static auto makeSurface=klj_metal_surface;
#endif
/* NATIVE_EGL_BUFFER_SURFACE */
}

@interface CPUFaultDevice:CPUDevice
@property unsigned rejectedStage,eventCalls;
@end
@implementation CPUFaultDevice
-(CPUQueue*)newCommandQueue{return self.rejectedStage==1?nil:[super newCommandQueue];}
-(CPUEvent*)newSharedEvent{++_eventCalls;return (_rejectedStage==2&&_eventCalls==1)||(_rejectedStage==3&&_eventCalls==2)?nil:[super newSharedEvent];}
@end
@interface CPUTerminalCommand:CPUCommand
@end
@implementation CPUTerminalCommand
-(void)waitUntilCompleted{assert(self.status==MTLCommandBufferStatusCompleted||self.status==MTLCommandBufferStatusError);}
@end

int main(int argc,char **argv){@try{@autoreleasepool{
    EXPECT(argc==2);setenv("KLEPTON_FRAME_LIBRARY",argv[1],1);
    auto lib=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);EXPECT(lib);
    auto count=(unsigned(*)(unsigned))dlsym(lib,"lifecycle_count");EXPECT(count);
    JNINativeInterface_ functions{};functions.ExceptionCheck=checkedPending;functions.FindClass=checkedFind;
    functions.ThrowNew=checkedThrow;functions.ExceptionClear=forbiddenClear;JNIEnv env{&functions};
    auto layer=[CPULayer new];auto p=(Presenter*)klj_metal_create(&env,(__bridge void*)layer,64,64);EXPECT(p);klj_metal_enter(p);
    int display,config;native_egl_control::WindowSurface window;window.presenter=p;window.display=&display;window.config=&config;
    // This is the original C/EGL call boundary. The baseline attaches env and
    // leaves IllegalStateException pending; the typed path owns an EGL error.
    EXPECT(native_egl_control::bufferSurface(&env,window,nullptr,0,64)==nullptr);
    EXPECT(exception.empty());
#ifdef KL_METAL_C_ERROR_ABI
    EXPECT(native_egl_control::error==KL_METAL_BAD_PARAMETER);
    EXPECT(jniChecks==0&&jniFinds==0&&jniThrows==0&&jniClears==0);
    EXPECT(native_egl_control::bufferSurface(nullptr,window,nullptr,0,64)==nullptr);
    EXPECT(native_egl_control::error==KL_METAL_BAD_PARAMETER&&exception.empty());
    EXPECT(klj_metal_surface(nullptr,&display,&config,0,64,false,nullptr)==nullptr);
    EXPECT(exception.empty()&&jniChecks==0);
    // JNI clients still receive the original exception, and an existing one
    // keeps its identity/message. C calls neither observe nor clear that state.
    EXPECT(klj_metal_surface(&env,&display,&config,0,64,false,nullptr)==nullptr);
    EXPECT(exception=="Metal host requires one valid Android window surface"&&jniThrows==1&&jniFinds==1&&jniChecks==1);
    exception="Original caller exception";
    EXPECT(klj_metal_surface(&env,&display,&config,0,64,false,nullptr)==nullptr);
    EXPECT(exception=="Original caller exception"&&jniThrows==1&&jniFinds==1&&jniChecks==2);
    KLMetalError error=KL_METAL_OK;
    EXPECT(klj_metal_surface_c(&display,&config,0,64,false,nullptr,&error)==nullptr);
    EXPECT(error==KL_METAL_BAD_PARAMETER&&exception=="Original caller exception"&&jniChecks==2);
    exception.clear();
    // An outer C operation can reenter a real JNI boundary on the same thread.
    // Its explicit env keeps JNI authority; it must not be swallowed by TLS.
    {
        KLMetalError outer=KL_METAL_CONTEXT_LOST;CMetalErrors scope(&outer);
        EXPECT(klj_metal_surface(&env,&display,&config,0,64,false,nullptr)==nullptr);
        EXPECT(exception=="Metal host requires one valid Android window surface"&&outer==KL_METAL_OK);
        EXPECT(jniThrows==2&&jniFinds==2&&jniChecks==3);
        EXPECT(klj_metal_surface_c(&display,&config,0,64,false,nullptr,&error)==nullptr);
        EXPECT(error==KL_METAL_BAD_PARAMETER&&outer==KL_METAL_OK&&jniChecks==3&&jniThrows==2);
    }
    exception.clear();
    EXPECT(klj_metal_finish_c(nullptr,&error)==1&&error==KL_METAL_OK);
    EXPECT(klj_metal_present_c(nullptr,1,&error)==0&&error==KL_METAL_BAD_SURFACE);
    EXPECT(klj_metal_present_retained_c(nullptr,1,&releasedLeases,[](void *v){++*static_cast<unsigned*>(v);},nullptr,&error)==0);
    EXPECT(error==KL_METAL_BAD_SURFACE&&releasedLeases==1&&exception.empty());
    EXPECT(klj_metal_resize_c(0,64,&error)==0&&error==KL_METAL_BAD_ACCESS);
    EXPECT(klj_metal_replace_surface_c(nullptr,nullptr,nullptr,64,64,&error)==0&&error==KL_METAL_BAD_PARAMETER);
    klj_metal_enter(nullptr);EXPECT(klj_metal_current_c(nullptr,&error)==1&&error==KL_METAL_OK);
    EXPECT(klj_metal_detach_surface_c(&error)==0&&error==KL_METAL_BAD_SURFACE);
    klj_metal_destroy(p);
    // Device, queue and both shared-event allocation failures are atomic and
    // return typed allocation errors without allocating a physical GPU object.
    for(unsigned stage=0;stage<4;++stage){@autoreleasepool{
        auto fault=[CPUFaultDevice new];fault.rejectedStage=stage;device=stage?fault:nil;
        auto localLayer=[CPULayer new];auto owner=(Presenter*)klj_metal_create(nullptr,(__bridge void*)localLayer,64,64);EXPECT(owner);klj_metal_enter(owner);
        EXPECT(klj_metal_surface_c(&display,&config,64,64,false,nullptr,&error)==nullptr&&error==KL_METAL_BAD_ALLOC);
        EXPECT(!owner->device&&!owner->queue&&!owner->produced&&!owner->consumed&&!owner->deviceReady);
        EXPECT(liveQueues==0&&liveEvents==0&&surfaces.empty()&&fences.empty()&&exception.empty());
        klj_metal_enter(nullptr);klj_metal_destroy(owner);
    }}
    // Successful calls use the same shared presenter and original resource
    // graph. Terminal errors release safely; genuinely inflight work stays live.
    device=[CPUDevice new];layer=[CPULayer new];p=(Presenter*)klj_metal_create(nullptr,(__bridge void*)layer,64,64);EXPECT(p);klj_metal_enter(p);
    auto surface=klj_metal_surface_c(&display,&config,64,64,false,nullptr,&error);EXPECT(surface&&error==KL_METAL_OK&&p->shared);
    EXPECT(klj_metal_present_c(p,1,&error)==1&&error==KL_METAL_OK&&!fences.empty());
    EXPECT(klj_metal_finish_c(p,&error)==1&&error==KL_METAL_OK&&!p->shared&&fences.empty());
    EXPECT(destroyPbuffer(surface)==1);EXPECT(klj_metal_detach_surface_c(&error)==1&&error==KL_METAL_OK);
    EXPECT(!p->surface&&!p->source&&!p->storage&&!p->last);klj_metal_enter(nullptr);klj_metal_destroy(p);p=nullptr;layer=nil;
    for(bool inflight:{false,true}){@autoreleasepool{
        auto terminalLayer=[CPULayer new];auto owner=(Presenter*)klj_metal_create(nullptr,(__bridge void*)terminalLayer,64,64);EXPECT(owner);klj_metal_enter(owner);
        surface=klj_metal_surface_c(&display,&config,64,64,false,nullptr,&error);EXPECT(surface&&error==KL_METAL_OK);
        EXPECT(klj_metal_present_c(owner,1,&error)==1&&error==KL_METAL_OK);
        auto command=[CPUTerminalCommand new];command.status=inflight?MTLCommandBufferStatusScheduled:MTLCommandBufferStatusError;
        command.error=[NSError errorWithDomain:@"CPU fixture" code:1 userInfo:@{NSLocalizedDescriptionKey:@"CPU terminal GPU failure"}];owner->last=(id<MTLCommandBuffer>)command;
        auto produced=owner->produced.signaledValue,consumed=owner->consumed.signaledValue;
        if(inflight){
            const auto began=std::chrono::steady_clock::now();EXPECT(klj_metal_finish_c(owner,&error)==0&&error==KL_METAL_BAD_ACCESS);
            EXPECT(std::chrono::steady_clock::now()-began<std::chrono::seconds(3));
            EXPECT(owner->shared&&owner->surface==surface&&!fences.empty()&&surfaces.contains(surface));
            EXPECT(owner->produced.signaledValue==produced&&owner->consumed.signaledValue==consumed);
            command.status=MTLCommandBufferStatusError;
        }
        EXPECT(klj_metal_finish_c(owner,&error)==1&&error==KL_METAL_CONTEXT_LOST);
        EXPECT(exception.empty()&&!owner->shared&&fences.empty());
        EXPECT(destroyPbuffer(surface)==1);EXPECT(klj_metal_detach_surface_c(&error)==1&&error==KL_METAL_OK);
        EXPECT(!owner->surface&&!owner->source&&!owner->storage&&!owner->last);klj_metal_enter(nullptr);klj_metal_destroy(owner);
    }}
    EXPECT(count(2)==0&&surfaces.empty()&&fences.empty()&&jniClears==0&&jniThrows==2&&jniChecks==3);
    device=nil;dlclose(lib);
    printf("PASS %u actual C/EGL error-boundary checks; JNI exception preservation, typed allocation failures, original success and terminal/inflight retirement; zero GPU devices/windows.\n",checks);
    return 0;
#else
    // The baseline must fail the pending-exception assertion above.
    return 19;
#endif
}}@catch(NSException *error){fprintf(stderr,"FIXTURE_EXCEPTION: %s\n",error.reason.UTF8String);return 20;}}
