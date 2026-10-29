// CPU-only ownership regression. Include the real retirement implementation;
// replace driver calls and the interop object, never create a graphics context.
#import <Cocoa/Cocoa.h>
#include <OpenGL/OpenGL.h>
#include <OpenGL/CGLRenderers.h>
#include <OpenGL/gl3.h>
#include <OpenGL/CGLIOSurface.h>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <vector>

namespace retirement {
enum class Failure { None, Lock, Bind };
struct State {
    Failure failure=Failure::None;
    CGLContextObj current=nullptr,target=nullptr;
    unsigned gets=0,locks=0,unlocks=0,sets=0,deletes=0,finishes=0;
    unsigned created=0,destroyed=0,abandoned=0;
    std::vector<CGLContextObj> bindings;
} state;
void require(bool value,const char *reason){if(!value)throw std::runtime_error(reason);}
void deletion(GLsizei count,const GLuint *names){
    for(GLsizei i=0;i<count;++i)if(names[i]){
        require(state.current==state.target,"GL deletion ran on a different context");++state.deletes;
    }
}
}
static CGLContextObj retirementCurrent(){++retirement::state.gets;return retirement::state.current;}
static CGLError retirementLock(CGLContextObj context){
    retirement::require(context==retirement::state.target,"Unexpected context lock");
    ++retirement::state.locks;return retirement::state.failure==retirement::Failure::Lock?kCGLBadContext:kCGLNoError;
}
static CGLError retirementSet(CGLContextObj context){
    auto &state=retirement::state;++state.sets;state.bindings.push_back(context);
    if(state.failure==retirement::Failure::Bind&&context==state.target)return kCGLBadContext;
    state.current=context;return kCGLNoError;
}
static CGLError retirementUnlock(CGLContextObj context){
    retirement::require(context==retirement::state.target,"Unexpected context unlock");
    ++retirement::state.unlocks;return kCGLNoError;
}
extern "C" void retirementDeleteProgram(GLuint name){retirement::deletion(1,&name);}
extern "C" void retirementDeleteTextures(GLsizei count,const GLuint *names){retirement::deletion(count,names);}
extern "C" void retirementDeleteFramebuffers(GLsizei count,const GLuint *names){retirement::deletion(count,names);}
extern "C" void retirementDeleteBuffers(GLsizei count,const GLuint *names){retirement::deletion(count,names);}
extern "C" void retirementDeleteVertexArrays(GLsizei count,const GLuint *names){retirement::deletion(count,names);}
extern "C" void retirementDeleteVertexArraysAPPLE(GLsizei count,const GLuint *names){retirement::deletion(count,names);}
extern "C" void retirementDeleteQueries(GLsizei count,const GLuint *names){retirement::deletion(count,names);}
extern "C" void retirementFinish(){++retirement::state.finishes;}

#define CGLGetCurrentContext retirementCurrent
#define CGLLockContext retirementLock
#define CGLSetCurrentContext retirementSet
#define CGLUnlockContext retirementUnlock
#define glDeleteProgram retirementDeleteProgram
#define glDeleteTextures retirementDeleteTextures
#define glDeleteFramebuffers retirementDeleteFramebuffers
#define glDeleteBuffers retirementDeleteBuffers
#define glDeleteVertexArrays retirementDeleteVertexArrays
#define glDeleteVertexArraysAPPLE retirementDeleteVertexArraysAPPLE
#define glDeleteQueries retirementDeleteQueries
#define glFinish retirementFinish
#ifndef MACFX_OPENGL_RETIREMENT_SOURCE
#define MACFX_OPENGL_RETIREMENT_SOURCE <opengl.mm>
#endif
#include MACFX_OPENGL_RETIREMENT_SOURCE
#undef CGLGetCurrentContext
#undef CGLLockContext
#undef CGLSetCurrentContext
#undef CGLUnlockContext
#undef glDeleteProgram
#undef glDeleteTextures
#undef glDeleteFramebuffers
#undef glDeleteBuffers
#undef glDeleteVertexArrays
#undef glDeleteVertexArraysAPPLE
#undef glDeleteQueries
#undef glFinish

static unsigned retiredReceivers=0;
@interface MacFXRetirementReceiver:NSObject
- (CGLContextObj)CGLContextObj NS_RETURNS_INNER_POINTER;
@end
@implementation MacFXRetirementReceiver
- (CGLContextObj)CGLContextObj{return nullptr;}
- (void)dealloc{++retiredReceivers;}
@end

static void checkDeallocReceiver(){
    Method method=class_getInstanceMethod(MacFXRetirementReceiver.class,sel_registerName("dealloc"));
    const auto previous=originalDealloc;
    originalDealloc=method_setImplementation(method,reinterpret_cast<IMP>(deallocContext));
    @autoreleasepool{MacFXRetirementReceiver *receiver=[MacFXRetirementReceiver new];receiver=nil;}
    assert(retiredReceivers==1);
    method_setImplementation(method,originalDealloc);originalDealloc=previous;
}

// The queue-owning interop boundary is represented by a counted C++ owner.
// No Metal device, queue, CoreVideo cache or GL object is created by this fake.
namespace macfx {
struct OpenGLInterop::Impl {bool abandoned=false;};
OpenGLInterop::OpenGLInterop(CGLContextObj,bool):impl(std::make_unique<Impl>()){++retirement::state.created;}
OpenGLInterop::~OpenGLInterop(){++retirement::state.destroyed;}
void OpenGLInterop::render(unsigned,unsigned){throw std::runtime_error("Unexpected render in CPU retirement test");}
void OpenGLInterop::clear(){}
void OpenGLInterop::resetHistory(){}
void OpenGLInterop::abandon() noexcept {if(!impl->abandoned){impl->abandoned=true;++retirement::state.abandoned;}}
}

static void check(retirement::Failure failure,bool sameContext=false,bool withRuntime=true){
    using retirement::require;
    auto target=reinterpret_cast<CGLContextObj>(uintptr_t(0x1010));
    auto previous=sameContext?target:reinterpret_cast<CGLContextObj>(uintptr_t(0x2020));
    auto other=reinterpret_cast<CGLContextObj>(uintptr_t(0x3030));
    retirement::state={};auto &state=retirement::state;state.failure=failure;state.current=previous;state.target=target;
    require(runtimes().empty()&&legacySurfaces().empty(),"The prior case left owners behind");
    runtimes()[other].w=123;legacySurfaces()[other].w=456;
    if(withRuntime){
        auto &runtime=runtimes()[target];runtime.interop=std::make_unique<macfx::OpenGLInterop>(target);
        runtime.programs={11};runtime.colors[0]={12,13,8,8};runtime.colors[1]={14,15,8,8};
        runtime.textures["retained"]={16,17,8,8};runtime.vao=18;runtime.vbo=19;
    }
    auto data=CFDataCreateMutable(kCFAllocatorDefault,0);
    const UInt8 bytes[]={1,2,3};CFDataAppendBytes(data,bytes,sizeof(bytes));
    const auto retained=CFGetRetainCount(data);CFRetain(data);
    auto &surface=legacySurfaces()[target];surface.input=reinterpret_cast<IOSurfaceRef>(data);
    surface.inputTexture=21;surface.outputTexture=22;surface.inputFbo=23;surface.outputFbo=24;
    releaseContextResources(target);
    require(!runtimes().count(target),"Retired Runtime remains in the map");
    require(!legacySurfaces().count(target),"Retired legacy surface remains in the map");
    require(runtimes().count(other)&&legacySurfaces().count(other),"Retirement erased another context");
    require(CFGetRetainCount(data)==retained,"Legacy retained host backing was not released exactly once");
    require(state.created==unsigned(withRuntime)&&state.destroyed==unsigned(withRuntime),"Interop owner did not retire exactly once");
    require(state.current==previous,"Previous current context was not preserved");
    require(state.locks==1&&state.gets==1,"Retirement did not make exactly one context attempt");
    if(failure==retirement::Failure::Lock){
        require(!state.sets&&!state.unlocks,"Failed lock attempted binding or unlock");
    }else if(failure==retirement::Failure::Bind){
        require(state.sets==1&&state.unlocks==1&&state.bindings[0]==target,"Failed binding did not release its successful lock");
    }else {
        require(state.unlocks==1&&state.sets==(sameContext?0u:2u),"Successful retirement did not restore and unlock the context");
        if(!sameContext)require(state.bindings==std::vector<CGLContextObj>{target,previous},"Context restore order changed");
    }
    require(state.abandoned==(failure==retirement::Failure::None?0u:unsigned(withRuntime)),"Only an unbindable interop owner must be abandoned");
    require(state.deletes==(failure==retirement::Failure::None?(withRuntime?13u:4u):0u),"GL names were deleted on a failed context or not cleared on success");
    require(!state.finishes,"CPU retirement unexpectedly waited for GL work");
    const auto gets=state.gets,locks=state.locks,destroyed=state.destroyed,abandoned=state.abandoned,deletes=state.deletes;
    releaseContextResources(target);
    require(state.gets==gets&&state.locks==locks&&state.destroyed==destroyed&&state.abandoned==abandoned&&state.deletes==deletes,
        "Duplicate retirement performed driver or resource work");
    require(CFGetRetainCount(data)==retained,"Duplicate retirement released host backing twice");
    CFRelease(data);runtimes().erase(other);legacySurfaces().erase(other);
}

int main(){@autoreleasepool{
    if(!std::getenv("RESHADE_EXPLICIT_HOST")){std::fprintf(stderr,"Run with RESHADE_EXPLICIT_HOST=1; this fixture never creates a renderer.\n");return 2;}
    try {
        checkDeallocReceiver();
        check(retirement::Failure::Lock);
        check(retirement::Failure::Bind);
        check(retirement::Failure::None);
        check(retirement::Failure::None,true);
        check(retirement::Failure::Lock,false,false);
        check(retirement::Failure::None,false,false);
        std::puts("CPU OpenGL retirement: lock/bind failures, success, host backing, exact owner and duplicate cleanup passed");return 0;
    }catch(const std::exception &error){std::fprintf(stderr,"CPU OpenGL retirement failed: %s\n",error.what());return 1;}
}}
