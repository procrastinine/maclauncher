// Copyright (c) MacLauncher contributors. MIT license.
// OpenGL interop, the processor behind the flush hook, over a default
// framebuffer that has depth. A depth-only ReShadeFX row receives that depth.
// A projection-bound native depth row asks for no image depth, names the
// absent projection and leaves an independent color row running. The interop
// writes its completed image back to GL_BACK, which the hooked flush's view
// presentation does not. One non-activating window, run once.
#include "frame.h"
#include "effects-plan.hpp"
#include "frame-depth.hpp"
#include "fixture-files.hpp"
#include "opengl-interop.hpp"
#include "process-phase.hpp"
#import <Cocoa/Cocoa.h>
#import <Metal/Metal.h>
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <stdexcept>
#include <string>
#include <thread>
@interface DepthEffectPanel:NSPanel
@end
@implementation DepthEffectPanel
- (BOOL)canBecomeKeyWindow{return NO;}
- (BOOL)canBecomeMainWindow{return NO;}
@end
namespace {
struct Pixel {unsigned char r,g,b,a;};
void require(bool value,const char *message){if(!value)throw std::runtime_error(message);}
NSString *hex(NSString *digit){return [@"" stringByPaddingToLength:64 withString:digit startingAtIndex:0];}
void publish(NSString *path,NSString *revision,NSArray *nodes){
    NSData *bytes=[NSJSONSerialization dataWithJSONObject:@{@"schema":@1,@"mode":@"advanced",@"revision":hex(revision),@"nodes":nodes} options:0 error:nil];
    require(replaceFile(bytes,path),"Cannot publish the effect plan");
}
NSDictionary *row(NSString *id,NSString *format,NSString *file,NSString *key,NSDictionary *requirements){
    NSMutableDictionary *value=[@{@"id":id,@"kind":@"shader",@"enabled":@YES,@"format":format,@"file":file,@"key":hex(key),@"revision":hex(key),@"parameters":@{}} mutableCopy];
    if(requirements)value[@"requirements"]=requirements;return value;
}
// One game frame: color .8/.4/.2 over depth .5 in the default framebuffer.
Pixel frame(macfx::OpenGLInterop &interop,unsigned width,unsigned height){
    glBindFramebuffer(GL_FRAMEBUFFER,0);glDrawBuffer(GL_BACK);glDisable(GL_SCISSOR_TEST);glColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE);glDepthMask(GL_TRUE);
    glClearColor(.8f,.4f,.2f,1);glClearDepth(.5);glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT);
    interop.render(width,height);glFinish();
    Pixel value{};glBindFramebuffer(GL_READ_FRAMEBUFFER,0);glReadBuffer(GL_BACK);glReadPixels(width/2,height/2,1,1,GL_RGBA,GL_UNSIGNED_BYTE,&value);
    require(glGetError()==GL_NO_ERROR,"OpenGL state failed");return value;
}
// Preparation and completion are asynchronous; earlier frames replay the
// previous completed output.
Pixel until(macfx::OpenGLInterop &interop,unsigned width,unsigned height,const std::function<bool(const Pixel&)>&done,const char *what){
    Pixel last{};
    for(unsigned attempt=0;attempt<200;++attempt){last=frame(interop,width,height);if(done(last))return last;std::this_thread::sleep_for(std::chrono::milliseconds(25));}
    std::fprintf(stderr,"%s; last output %u,%u,%u,%u\n",what,last.r,last.g,last.b,last.a);throw std::runtime_error(what);
}
bool near(int value,int expected){return std::abs(value-expected)<=3;}
bool logged(NSString *log,NSString *text){
    for(unsigned attempt=0;attempt<40;++attempt){NSString *contents=[NSString stringWithContentsOfFile:log encoding:NSUTF8StringEncoding error:nil];if([contents containsString:text])return true;std::this_thread::sleep_for(std::chrono::milliseconds(25));}
    return false;
}
void depthChecks(CGLContextObj context,id<MTLDevice> device,unsigned width,unsigned height,GLint depthBits,NSString *directory){
    NSString *plan=[directory stringByAppendingPathComponent:@"plan.json"],*log=[NSString stringWithUTF8String:std::getenv("RESHADE_LOG")];
    NSString *grayEffect=[directory stringByAppendingPathComponent:@"gray.fx"],*fog=[directory stringByAppendingPathComponent:@"fog.mclfilter"];
    macfx::OpenGLInterop interop(context);

    // The launch plan's depth-only row reads the default framebuffer's depth:
    // color times depth .5.
    const auto shaded=until(interop,width,height,[](const Pixel&p){return near(p.r,102)&&near(p.g,51)&&near(p.b,26);},"Default-framebuffer depth did not reach the depth effect");
    require(shaded.a==255&&macfx::effectPlanDemands(macfx::PlanDemandDepth)&&macfx::frameRequiresDepth(context,device,width,height),"The depth-only row did not request image depth");
    std::printf("OpenGL default-framebuffer depth %ux%u (%d bits) -> depth effect output=%u,%u,%u,%u\n",width,height,depthBits,shaded.r,shaded.g,shaded.b,shaded.a);

    // Projection-bound depth comes only with a renderer scene. The frame copies
    // no depth for it, the row names the projection and the color row runs.
    publish(plan,@"2",@[row(@"fog",@"native",fog,@"b",@{@"depth":@YES,@"projectionMatrix":@YES}),row(@"gray",@"fx",grayEffect,@"c",nil)]);
    const auto gray=until(interop,width,height,[](const Pixel&p){return near(p.r,120)&&near(p.g,120)&&near(p.b,120);},"The independent color row did not run beside the projection-bound row");
    require(!macfx::effectPlanDemands(macfx::PlanDemandDepth)&&!macfx::frameRequiresDepth(context,device,width,height),"A projection-bound row requested image depth");
    require(logged(log,@"The frame source supplies no camera projection"),"The projection-bound row did not name the absent projection");
    std::printf("Projection-bound native depth row: no image depth requested, projection reason reported, independent color output=%u,%u,%u,%u\n",gray.r,gray.g,gray.b,gray.a);
}
int checks(NSString *directory){
    NSString *fog=[directory stringByAppendingPathComponent:@"fog.mclfilter"];
    require([[NSJSONSerialization dataWithJSONObject:@{@"schema":@1,@"method":@"depth-fog",@"parameters":@{}} options:0 error:nil] writeToFile:fog atomically:NO],"Cannot write the native depth descriptor");
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSOpenGLPixelFormatAttribute attributes[]={NSOpenGLPFAAccelerated,NSOpenGLPFAOpenGLProfile,NSOpenGLProfileVersion4_1Core,NSOpenGLPFADoubleBuffer,NSOpenGLPFABackingStore,NSOpenGLPFAColorSize,32,NSOpenGLPFAAlphaSize,8,NSOpenGLPFADepthSize,24,0};
    auto format=[[NSOpenGLPixelFormat alloc]initWithAttributes:attributes];if(!format){std::puts("skipped: no hardware-accelerated OpenGL context");return 0;}
    auto window=[[DepthEffectPanel alloc]initWithContentRect:NSMakeRect(24,24,96,64) styleMask:NSWindowStyleMaskBorderless|NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;window.title=@"OpenGL depth effect";
    auto view=[[NSOpenGLView alloc]initWithFrame:NSMakeRect(0,0,96,64) pixelFormat:format];window.contentView=view;[window orderBack:nil];[window display];
    struct Close {DepthEffectPanel *window;~Close(){[NSOpenGLContext clearCurrentContext];[window orderOut:nil];[window close];}} close{window};
    CFRunLoopRunInMode(kCFRunLoopDefaultMode,.05,false);[view.openGLContext update];[view.openGLContext makeCurrentContext];
    const auto context=view.openGLContext.CGLContextObj;const NSRect backing=[view convertRectToBacking:view.bounds];const unsigned width=backing.size.width,height=backing.size.height;
    GLint depthBits=0;glBindFramebuffer(GL_FRAMEBUFFER,0);glGetFramebufferAttachmentParameteriv(GL_FRAMEBUFFER,GL_DEPTH,GL_FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE,&depthBits);
    require(context&&!window.keyWindow&&!window.mainWindow&&depthBits>0,"The default framebuffer has no depth attachment");
    auto device=MTLCreateSystemDefaultDevice();require(device!=nil,"Metal is unavailable");
    CGLLockContext(context);struct Unlock {CGLContextObj context;~Unlock(){rsReleaseFrameOwner(context);CGLUnlockContext(context);}} unlock{context};
    depthChecks(context,device,width,height,depthBits,directory);return 0;
}
}
int main(int argc,char **argv){@autoreleasepool{
    const auto phase=fixture::phase(argc,argv);
    if(phase.name.empty()){
        if(argc!=2){std::fputs("Usage: opengl-depth-effect DIRECTORY\n",stderr);return 64;}
        NSString *directory=[NSString stringWithUTF8String:argv[1]];
        try{publish([directory stringByAppendingPathComponent:@"plan.json"],@"1",@[row(@"depth",@"fx",[directory stringByAppendingPathComponent:@"depth.fx"],@"a",@{@"depth":@YES})]);}
        catch(const std::exception &error){std::fprintf(stderr,"%s\n",error.what());return 1;}
        // An explicit host keeps the window and flush hooks out; this process
        // drives the interop itself.
        return fixture::runPhase("checks",{{"RESHADE_LOG",[directory stringByAppendingPathComponent:@"native.log"].fileSystemRepresentation},
            {"RESHADE_EFFECT_PLAN",[directory stringByAppendingPathComponent:@"plan.json"].fileSystemRepresentation},{"RESHADE_EXPLICIT_HOST","1"},{"RESHADE_EFFECT",nullptr}},{argv[1]});
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,30*NSEC_PER_SEC),dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{std::fputs("OpenGL depth-effect check timed out\n",stderr);std::_Exit(2);});
    try{return checks([NSString stringWithUTF8String:phase.argv[1]]);}
    catch(const std::exception &error){std::fprintf(stderr,"%s\n",error.what());return 1;}
}}
