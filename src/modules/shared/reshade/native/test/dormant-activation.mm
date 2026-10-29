#import <Cocoa/Cocoa.h>
#include "fixture-files.hpp"
#import <QuartzCore/QuartzCore.h>
#import <Metal/Metal.h>
#import <objc/runtime.h>
#include "live-controls.hpp"
#include "native-layer.h"
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <fstream>
#include <thread>
#include <unistd.h>

namespace {
std::atomic<unsigned> deviceQueries{0},queues{0},drawables{0},framebufferWrites{0};
std::atomic<unsigned> completedHandlers{0},scheduledHandlers{0},handlerCalls{0},nativePresents{0};
bool installedHooks=false;
bool fetchSupported=false;
bool expectUnwrapped=false;
id fakeQueue,fakeBuffer,expectedDrawable;
SEL expectedPresent=nullptr;double expectedTime=0;
MTLCommandBufferHandler expectedHandler=nil;
void write(const std::string &file,const void *bytes,size_t size){
    const auto temporary=file+".next";std::ofstream output(temporary,std::ios::binary);output.write(static_cast<const char*>(bytes),size);output.close();assert(output);
    assert(rename(temporary.c_str(),file.c_str())==0);
}
void plan(const std::string &file,const char *mode){
    const auto body=std::string("{\"schema\":1,\"mode\":\"")+mode+"\",\"revision\":\""+std::string(64,mode[0]=='a'?'a':'b')+"\",\"nodes\":[]}";
    write(file,body.data(),body.size());
}
IMP originalFramebuffer=nullptr;
id originalDrawable(id,SEL){++drawables;return nil;}
void setFramebuffer(id object,SEL selector,BOOL value){++framebufferWrites;reinterpret_cast<void(*)(id,SEL,BOOL)>(originalFramebuffer)(object,selector,value);}
}
@interface DormantFakeBuffer:NSObject
@end
@implementation DormantFakeBuffer
- (void)addCompletedHandler:(MTLCommandBufferHandler)handler{assert(handler);++completedHandlers;}
- (void)addScheduledHandler:(MTLCommandBufferHandler)handler{assert(handler&&(!expectUnwrapped||handler==expectedHandler));++scheduledHandlers;handler((id<MTLCommandBuffer>)self);}
- (void)presentDrawable:(id<MTLDrawable>)drawable{assert(drawable==expectedDrawable&&expectedPresent==_cmd);++nativePresents;}
- (void)presentDrawable:(id<MTLDrawable>)drawable atTime:(CFTimeInterval)time{assert(drawable==expectedDrawable&&expectedPresent==_cmd&&time==expectedTime);++nativePresents;}
- (void)presentDrawable:(id<MTLDrawable>)drawable afterMinimumDuration:(CFTimeInterval)time{assert(drawable==expectedDrawable&&expectedPresent==_cmd&&time==expectedTime);++nativePresents;}
- (void)commit{}
@end
@interface DormantFakeQueue:NSObject
@end
@implementation DormantFakeQueue
- (id)commandBuffer{return fakeBuffer;}
@end
@interface DormantFakeDevice:NSObject
@end
@implementation DormantFakeDevice
-(id)newCommandQueue{++queues;return installedHooks?fakeQueue:nil;} // Never returns a real Metal object.
-(NSString*)name{return @"CPU dormant fixture";}
-(id)newMTL4CommandQueue{return nil;}
-(BOOL)supportsFamily:(MTLGPUFamily)family{return fetchSupported&&family==MTLGPUFamilyApple2;}
@end
namespace {
id fake;
id device(id,SEL){++deviceQueries;return fake;}
int nativeFrame(void*,void*,void*){return 0;}
}
int main(int argc,char **argv){@autoreleasepool {
    assert(argc==2||(argc==3&&(!std::strcmp(argv[2],"--installed-hooks")||!std::strcmp(argv[2],"--readability-formats"))));
    const bool readabilityFormats=argc==3&&!std::strcmp(argv[2],"--readability-formats");installedHooks=argc==3;
    char directory[1024];temporaryPath(directory,"macfx-dormant-activation-XXXXXX");assert(mkdtemp(directory));
    const auto controls=std::string(directory)+"/controls",selected=std::string(directory)+"/plan.json",state=std::string(directory)+"/window-state";
    const auto log=std::string(directory)+"/native.log",missing=std::string(directory)+"/must-not-read-prepared.fx";
    macfx::LivePacket packet{};std::memcpy(packet.magic,"MLFXCTL2",8);packet.targetHz=60;packet.multiplier=4;packet.sharpness=.5f;packet.flowScale=1;
    std::memset(packet.effectKey,'0',64);std::memset(packet.revision,'0',64);write(controls,&packet,sizeof(packet));plan(selected,"advanced");
    const char zero[4096]{};write(state,zero,sizeof(zero));
    setenv("RESHADE_CONTROL_FILE",controls.c_str(),1);setenv("RESHADE_LIVE_EFFECTS",directory,1);setenv("RESHADE_EFFECT_KEY",std::string(64,'0').c_str(),1);
    setenv("RESHADE_EFFECT_PLAN",selected.c_str(),1);setenv("RESHADE_WINDOW_STATE",state.c_str(),1);setenv("RESHADE_LAYER_SURFACE","1",1);setenv("RESHADE_LOG",log.c_str(),1);
    setenv("RESHADE_EFFECT","/stale-launch-selection.fx",1);setenv("RESHADE_PREPARED_EFFECT",missing.c_str(),1);
    for(const char *name:{"RESHADE_EXPLICIT_HOST","RESHADE_TRACE","RESHADE_DIAGNOSTICS","RESHADE_GPU_TIMING","RESHADE_RENDER_SOURCE_CONTROL","RESHADE_RENDER_HEIGHT","RESHADE_RENDER_MAX_HEIGHT","RESHADE_RENDER_MULTIPLIER","RESHADE_RENDER_AUTO"})unsetenv(name);
    const auto source=std::string(directory)+"/source-control-dormant-test.json",status=std::string(directory)+"/source-status-dormant-test.json";
    const char command[]="{\"schema\":1,\"launchId\":\"dormant-test\",\"epoch\":1,\"revision\":\"d769e0da94ae6d2614d5b6e22e9740c0f1180c467dd18a5bf3643e0d6a1c9a52\",\"control\":\"virtual\",\"source\":null}";
    write(source,command,sizeof(command)-1);
    setenv("RESHADE_RENDER_SOURCE_CONTROL","virtual",1);setenv("RESHADE_RENDER_SOURCE_ACTIVATION_API","1",1);
    setenv("RESHADE_RENDER_SOURCE_CONTROL_FILE",source.c_str(),1);setenv("RESHADE_RENDER_SOURCE_STATUS_FILE",status.c_str(),1);setenv("RESHADE_RENDER_SOURCE_LAUNCH_ID","dormant-test",1);
    // Construct the legal publisher image before loading the core. Its global
    // Quartz interposition must not be mistaken for one of its own class probes.
    CGColorSpaceRef space=CGColorSpaceCreateDeviceRGB();CGContextRef bitmap=CGBitmapContextCreate(nullptr,2,2,8,8,space,kCGImageAlphaPremultipliedLast);
    assert(bitmap);CGImageRef image=CGBitmapContextCreateImage(bitmap);assert(image);CGContextRelease(bitmap);CGColorSpaceRelease(space);
    fake=[DormantFakeDevice new];fakeQueue=[DormantFakeQueue new];fakeBuffer=[DormantFakeBuffer new];
    method_setImplementation(class_getInstanceMethod(CAMetalLayer.class,@selector(device)),reinterpret_cast<IMP>(device));
    method_setImplementation(class_getInstanceMethod(CAMetalLayer.class,@selector(nextDrawable)),reinterpret_cast<IMP>(originalDrawable));
    originalFramebuffer=method_setImplementation(class_getInstanceMethod(CAMetalLayer.class,@selector(setFramebufferOnly:)),reinterpret_cast<IMP>(setFramebuffer));
    void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library){std::fprintf(stderr,"dlopen: %s\n",dlerror());return 1;}
    assert(access(log.c_str(),F_OK)!=0); // Old core attempts the stale prepared path and fails here.
    CALayer *contents=[CALayer layer];contents.opaque=NO;contents.bounds=CGRectMake(0,0,73,41);contents.contents=(__bridge id)image;
    CAMetalLayer *layer=[CAMetalLayer layer];layer.drawableSize=CGSizeMake(73,41);layer.framebufferOnly=YES;
    deviceQueries=0;queues=0;drawables=0;framebufferWrites=0;
    assert([layer nextDrawable]==nil&&drawables==1&&deviceQueries==0&&queues==0&&framebufferWrites==0);
    assert(layer.framebufferOnly&&CGSizeEqualToSize(layer.drawableSize,CGSizeMake(73,41)));
    assert(contents.contents==(__bridge id)image&&!contents.opaque&&CGRectEqualToRect(contents.bounds,CGRectMake(0,0,73,41)));
    assert(access(log.c_str(),F_OK)!=0);
    std::puts("dormant live Off: actual packet/empty plan/state/null source bindings; zero fake-device queries/queues/framebuffer writes; exact original drawable and contents forwarding");
    // Real readers consume a new Simple spatial packet, not a fixture-only gate.
    packet.spatial=1;write(controls,&packet,sizeof(packet));plan(selected,"simple");std::this_thread::sleep_for(std::chrono::milliseconds(110));
    contents.contents=(__bridge id)image;
    assert([layer nextDrawable]==nil&&drawables==2&&deviceQueries>0&&queues==1);
    std::puts("live On: real control/plan readers permit the fake queue request; no real Metal device or command buffer");
    if(installedHooks){
        expectedHandler=^(id<MTLCommandBuffer>buffer){assert(buffer==fakeBuffer);++handlerCalls;};
        [(id<MTLCommandBuffer>)fakeBuffer addScheduledHandler:expectedHandler];
        assert(scheduledHandlers==1&&handlerCalls==1&&completedHandlers==1);
        std::puts("installed On hooks: one extra retirement handler, exact original scheduled callback executes");
    }
    if(readabilityFormats){
        // Actual nextDrawable hook, real CAMetalLayer properties and an Apple2
        // device double. No real drawable/device/queue or GPU work is created.
        for(const bool fetch:{false,true}){
            fetchSupported=fetch;
            for(const auto format:{MTLPixelFormatBGRA8Unorm,MTLPixelFormatBGRA8Unorm_sRGB,MTLPixelFormatRGB10A2Unorm,
                                   MTLPixelFormatBGR10A2Unorm,MTLPixelFormatRGBA16Float,MTLPixelFormatBGRA10_XR}){
                layer.pixelFormat=format;layer.framebufferOnly=YES;
                const auto writes=framebufferWrites.load(),before=drawables.load();
                assert([layer nextDrawable]==nil&&drawables==before+1);
                assert(layer.framebufferOnly==fetch&&framebufferWrites==writes+(fetch?0:1));
            }
        }
        std::puts("actual nextDrawable readability: Apple2 attachment fetch retains framebufferOnly for 8-bit, packed 10-bit, float and XR layers; without fetch each requests a readable drawable");
    }
    packet.spatial=0;write(controls,&packet,sizeof(packet));plan(selected,"advanced");std::this_thread::sleep_for(std::chrono::milliseconds(110));
    const auto queries=deviceQueries.load(),writes=framebufferWrites.load(),before=drawables.load();const auto size=layer.drawableSize;const auto framebuffer=layer.framebufferOnly;
    contents.contents=(__bridge id)image;
    assert([layer nextDrawable]==nil&&drawables==before+1&&deviceQueries==queries&&queues==1&&framebufferWrites==writes);
    assert(contents.contents==(__bridge id)image&&layer.framebufferOnly==framebuffer&&CGSizeEqualToSize(layer.drawableSize,size));
    std::puts("Off again: unchanged original publisher state, no additional fake-device/queue/framebuffer work; no owned output was created");
    if(installedHooks){
        completedHandlers=0;scheduledHandlers=0;handlerCalls=0;
        expectUnwrapped=true;
        [(id<MTLCommandBuffer>)fakeBuffer addScheduledHandler:expectedHandler];
        assert(scheduledHandlers==1&&handlerCalls==1&&completedHandlers==0);
        // An explicit producer registration remains functional even while
        // shared effects are Off. Its removal restores the inert hook path.
        auto add=reinterpret_cast<decltype(&rsRegisterNativeMetalLayer)>(dlsym(library,"rsRegisterNativeMetalLayer"));
        auto remove=reinterpret_cast<decltype(&rsUnregisterNativeMetalLayer)>(dlsym(library,"rsUnregisterNativeMetalLayer"));assert(add&&remove);
        assert(add((__bridge void*)layer,nativeFrame,nullptr)==1);
        expectUnwrapped=false;
        [(id<MTLCommandBuffer>)fakeBuffer addScheduledHandler:expectedHandler];assert(completedHandlers==1);
        remove((__bridge void*)layer);completedHandlers=0;expectUnwrapped=true;
        [(id<MTLCommandBuffer>)fakeBuffer addScheduledHandler:expectedHandler];assert(completedHandlers==0);
        std::puts("installed Off hooks: no extra retirement handler; explicit registration stays active and unregister restores inert forwarding");
    }
    CGImageRelease(image);unlink(controls.c_str());unlink(selected.c_str());unlink(state.c_str());unlink(log.c_str());unlink(source.c_str());unlink(status.c_str());rmdir(directory);
    // The library installs process-lifetime hooks; keep it loaded until exit.
}}
