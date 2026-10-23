#include "host.hpp"
#include "view-presentation.hpp"
#include "frame.h"
#include "opengl-interop.hpp"
#import <Cocoa/Cocoa.h>
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>
#include <cstdlib>
#include <cstdio>
#include <cmath>
#include <stdexcept>
#include <string>
extern "C" CGLError rsFlushDrawable(CGLContextObj);
// Nonzero bindings on every supported unit catch a transfer helper changing a
// unit it does not own, including during CoreVideo texture-cache creation.
struct TextureBindings {
    GLuint textures[16]={},samplers[16]={};bool core;
    explicit TextureBindings(bool c):core(c) {
        glGenTextures(16,textures);if(core)glGenSamplers(16,samplers);
        for(unsigned i=0;i<16;++i){glActiveTexture(GL_TEXTURE0+i);glBindTexture(GL_TEXTURE_2D,textures[i]);if(core)glBindSampler(i,samplers[i]);}
        glActiveTexture(GL_TEXTURE3);
    }
    bool preserved() const {
        GLint active=0;glGetIntegerv(GL_ACTIVE_TEXTURE,&active);bool okay=true;
        for(unsigned i=0;i<16;++i){GLint texture=0,sampler=0;glActiveTexture(GL_TEXTURE0+i);glGetIntegerv(GL_TEXTURE_BINDING_2D,&texture);
            if(core)glGetIntegerv(GL_SAMPLER_BINDING,&sampler);
            okay=okay&&GLuint(texture)==textures[i]&&(!core||GLuint(sampler)==samplers[i]);}
        glActiveTexture(active);return okay;
    }
    ~TextureBindings(){glDeleteTextures(16,textures);if(core)glDeleteSamplers(16,samplers);}
};
@interface MissingDepthOpenGLPanel:NSPanel
@end
@implementation MissingDepthOpenGLPanel
- (BOOL)canBecomeKeyWindow{return NO;}
- (BOOL)canBecomeMainWindow{return NO;}
@end
bool missingDepthCase(CGLContextObj context,unsigned width,unsigned height,bool legacy,const char *effect) {
    if(!context)return false;
    CGLLockContext(context);
    struct UnlockContext {CGLContextObj context;~UnlockContext(){CGLUnlockContext(context);}} unlock{context};
    // This pixel format has no window depth attachment. An Advanced row that
    // requests depth must not prevent an independent color row or final scaler
    // from running. Exercise the actual interop path, including frames inside
    // its retry interval, rather than relying only on processor row mocks.
    NSString *identity=[@"" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0];
    glBindFramebuffer(GL_FRAMEBUFFER,0);
    GLint depthBits=0;
    if(legacy)glGetIntegerv(0x0D56/*GL_DEPTH_BITS*/,&depthBits);
    else glGetFramebufferAttachmentParameteriv(GL_FRAMEBUFFER,GL_DEPTH,GL_FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE,&depthBits);
    bool missingDepthFallback=depthBits==0;
    NSString *fallbackPlan=[NSTemporaryDirectory() stringByAppendingPathComponent:[@"opengl-depth-fallback-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    NSString *fallbackIdentity=[@"" stringByPaddingToLength:64 withString:@"b" startingAtIndex:0];
    auto colorRow=@{@"id":@"color",@"kind":@"shader",@"enabled":@YES,@"format":@"fx",@"file":[NSURL fileURLWithPath:[NSString stringWithUTF8String:effect]].path,@"key":identity,@"revision":identity};
    NSMutableDictionary *depthRow=[colorRow mutableCopy];depthRow[@"id"]=@"missing-depth";depthRow[@"requirements"]=@{@"depth":@YES};
    NSDictionary *fallbackDocument=@{@"schema":@1,@"mode":@"advanced",@"revision":fallbackIdentity,@"nodes":@[depthRow,colorRow,@{@"id":@"fit",@"kind":@"spatial",@"enabled":@YES,@"method":@"nearest",@"settings":@{}}]};
    if(![[NSJSONSerialization dataWithJSONObject:fallbackDocument options:0 error:nil]writeToFile:fallbackPlan atomically:YES])throw std::runtime_error("Cannot create OpenGL depth fallback plan");
    rsReleaseFrameOwner(context);
    setenv("RESHADE_EFFECT_PLAN",fallbackPlan.fileSystemRepresentation,1);
    try {
        macfx::OpenGLInterop interop(context);
        missingDepthFallback=missingDepthFallback&&macfx::frameRequiresDepth(context,MTLCreateSystemDefaultDevice(),width,height);
        for(unsigned frame=0;frame<3;++frame) {
            glBindFramebuffer(GL_FRAMEBUFFER,0);glDrawBuffer(GL_BACK);
            glDisable(GL_SCISSOR_TEST);glColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE);
            glClearColor(.2,.4,.6,1);glClear(GL_COLOR_BUFFER_BIT);
            unsigned char input[4]={};glReadBuffer(GL_BACK);
            glReadPixels(width/2,height/2,1,1,GL_RGBA,GL_UNSIGNED_BYTE,input);
            const bool originalColor=std::abs(int(input[0])-51)<=2&&std::abs(int(input[1])-102)<=2&&std::abs(int(input[2])-153)<=2&&input[3]==255;
            missingDepthFallback=missingDepthFallback&&originalColor;
            interop.render(width,height);glFinish();
            unsigned char fallback[4]={};glBindFramebuffer(GL_READ_FRAMEBUFFER,0);glReadBuffer(GL_BACK);
            glReadPixels(width/2,height/2,1,1,GL_RGBA,GL_UNSIGNED_BYTE,fallback);
            const bool independentColor=std::abs(int(fallback[0])-102)<=2&&std::abs(int(fallback[1])-77)<=2&&std::abs(int(fallback[2])-51)<=2&&fallback[3]==255;
            missingDepthFallback=missingDepthFallback&&independentColor;
            printf("OpenGL missing depth frame=%u input=%u,%u,%u,%u original=%d independent color/scaler=%d output=%u,%u,%u,%u\n",frame,input[0],input[1],input[2],input[3],originalColor,independentColor,fallback[0],fallback[1],fallback[2],fallback[3]);
        }
    }catch(const std::exception &error){missingDepthFallback=false;printf("OpenGL missing-depth fallback failed: %s\n",error.what());}
    unsetenv("RESHADE_EFFECT_PLAN");rsReleaseFrameOwner(context);[NSFileManager.defaultManager removeItemAtPath:fallbackPlan error:nil];
    return missingDepthFallback;
}
int main(int argc,char **argv) { @autoreleasepool {
    if(argc!=3 && argc!=4) return 2;
    const bool legacy=argc==4 && std::string(argv[3])=="legacy";
    const bool focused=argc==4 && std::string(argv[3])=="missing-depth";
    if(focused)setenv("RESHADE_EXPLICIT_HOST","1",1);
    setenv("RESHADE_EFFECT",argv[1],1);setenv("RESHADE_INCLUDE_PATH",argv[2],1);
    [NSApplication sharedApplication];
    // Pixel assertions read GL_BACK after presentation. Ordinary double buffers
    // are volatile after a swap; retained backing makes that read well-defined.
    NSOpenGLPixelFormatAttribute attrs[]={NSOpenGLPFAAccelerated,NSOpenGLPFAOpenGLProfile,legacy?NSOpenGLProfileVersionLegacy:NSOpenGLProfileVersion4_1Core,NSOpenGLPFADoubleBuffer,NSOpenGLPFABackingStore,NSOpenGLPFAColorSize,32,NSOpenGLPFAAlphaSize,8,0};
    auto *format=[[NSOpenGLPixelFormat alloc]initWithAttributes:attrs];
    if(!format) {puts("No hardware-accelerated OpenGL context; check requires a physical Mac.");return 77;}
    if(focused) {
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        auto *window=[[MissingDepthOpenGLPanel alloc]initWithContentRect:NSMakeRect(24,24,128,128) styleMask:NSWindowStyleMaskBorderless|NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed=NO;window.title=@"OpenGL missing depth";
        auto *view=[[NSOpenGLView alloc]initWithFrame:NSMakeRect(0,0,128,128)pixelFormat:format];window.contentView=view;
        [window orderBack:nil];[window display];
        CFRunLoopRunInMode(kCFRunLoopDefaultMode,0.05,false);
        [view.openGLContext update];[view.openGLContext makeCurrentContext];
        const auto context=view.openGLContext.CGLContextObj;
        const NSRect backing=[view convertRectToBacking:view.bounds];
        printf("OpenGL focused renderer=%s version=%s window=%ld key=%d main=%d extent=%ux%u\n",glGetString(GL_RENDERER),glGetString(GL_VERSION),(long)window.windowNumber,window.keyWindow,window.mainWindow,unsigned(backing.size.width),unsigned(backing.size.height));
        const bool valid=context&&!window.keyWindow&&!window.mainWindow&&missingDepthCase(context,backing.size.width,backing.size.height,false,argv[1])&&glGetError()==GL_NO_ERROR;
        [NSOpenGLContext clearCurrentContext];[window orderOut:nil];[window close];
        return valid?0:3;
    }
    auto makeWindow=[&](NSString *title) {
        auto *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,128,128) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        window.title=title;
        window.contentView=[[NSOpenGLView alloc]initWithFrame:NSMakeRect(0,0,128,128)pixelFormat:format];
        [window orderFront:nil];[window display];
        return window;
    };
    auto *other=makeWindow(@"Unfiltered");
    auto *window=makeWindow(@"Filtered");
    auto *view=(NSOpenGLView *)window.contentView;
    // A real CGL owner must never cross an Objective-C retaining parameter in
    // the generic depth-demand path, even when it has no presentation yet.
    const auto probeContext=view.openGLContext.CGLContextObj;
    if(!probeContext)throw std::runtime_error("Missing OpenGL probe context");
    const auto probePresentation=macfx::viewPresentationForOwner(probeContext);
    NSString *probePlan=[NSTemporaryDirectory() stringByAppendingPathComponent:[@"opengl-depth-owner-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    NSString *identity=[@"" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0];
    NSDictionary *probeDocument=@{@"schema":@1,@"mode":@"advanced",@"revision":identity,@"nodes":@[@{@"id":@"depth-owner",@"kind":@"shader",@"enabled":@YES,@"format":@"fx",@"file":[NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]].path,@"key":identity,@"revision":identity,@"requirements":@{@"depth":@YES}}]};
    if(![[NSJSONSerialization dataWithJSONObject:probeDocument options:0 error:nil]writeToFile:probePlan atomically:YES])throw std::runtime_error("Cannot create OpenGL depth-owner plan");
    setenv("RESHADE_EFFECT_PLAN",probePlan.fileSystemRepresentation,1);
    const bool depthOwnerSafe=macfx::frameRequiresDepth(probeContext,MTLCreateSystemDefaultDevice(),128,128);
    unsetenv("RESHADE_EFFECT_PLAN");[NSFileManager.defaultManager removeItemAtPath:probePlan error:nil];rsReleaseFrameOwner(probeContext);
    if(!depthOwnerSafe||macfx::viewPresentationForOwner(probeContext)!=probePresentation)throw std::runtime_error("OpenGL depth-owner demand or presentation changed");
    CFRunLoopRunInMode(kCFRunLoopDefaultMode,0.1,false);
    auto *otherContext=[(NSOpenGLView *)other.contentView openGLContext];
    [otherContext update];[otherContext makeCurrentContext];
    glDrawBuffer(GL_BACK);glClearColor(.2,.4,.6,1);glClear(GL_COLOR_BUFFER_BIT);
    [otherContext flushBuffer];glFinish();
    unsigned char original[4]={};glReadBuffer(GL_BACK);glReadPixels(64,64,1,1,GL_RGBA,GL_UNSIGNED_BYTE,original);
    const bool isolated=std::abs(int(original[0])-51)<=2&&std::abs(int(original[1])-102)<=2&&std::abs(int(original[2])-153)<=2&&original[3]==255;
    [view.openGLContext update];[view.openGLContext makeCurrentContext];
    TextureBindings bindings(!legacy);
    printf("OpenGL renderer=%s version=%s\n",glGetString(GL_RENDERER),glGetString(GL_VERSION));
    glDrawBuffer(GL_BACK);glClearColor(.2,.4,.6,1);glClear(GL_COLOR_BUFFER_BIT);
    glViewport(3,4,117,109);glActiveTexture(GL_TEXTURE3);glColorMask(GL_FALSE,GL_TRUE,GL_FALSE,GL_TRUE);
    glEnable(GL_SCISSOR_TEST);glScissor(8,8,16,16);
    if(legacy){glPolygonMode(GL_FRONT,GL_LINE);glPolygonMode(GL_BACK,GL_POINT);}
    else glPolygonMode(GL_FRONT_AND_BACK,GL_LINE);
    const auto result=rsFlushDrawable(view.openGLContext.CGLContextObj);glFinish();
    unsigned char rgba[4]={};glReadBuffer(GL_BACK);glReadPixels(64,64,1,1,GL_RGBA,GL_UNSIGNED_BYTE,rgba);
    unsigned char edge[4]={};glReadPixels(126,126,1,1,GL_RGBA,GL_UNSIGNED_BYTE,edge);
    GLint viewport[4]={},active=0,polygon[2]={};GLboolean mask[4]={};glGetIntegerv(GL_VIEWPORT,viewport);glGetIntegerv(GL_ACTIVE_TEXTURE,&active);glGetBooleanv(GL_COLOR_WRITEMASK,mask);glGetIntegerv(GL_POLYGON_MODE,polygon);
    const bool pixels=std::abs(int(rgba[0])-102)<=2&&std::abs(int(rgba[1])-77)<=2&&std::abs(int(rgba[2])-51)<=2&&rgba[3]==255;
    const bool fullSurface=std::abs(int(edge[0])-102)<=2&&std::abs(int(edge[1])-77)<=2&&std::abs(int(edge[2])-51)<=2&&edge[3]==255;
    const bool polygonPreserved=polygon[0]==GL_LINE&&polygon[1]==(legacy?GL_POINT:GL_LINE);
    const bool state=viewport[0]==3&&viewport[1]==4&&viewport[2]==117&&viewport[3]==109&&active==GL_TEXTURE3&&mask[0]==GL_FALSE&&mask[1]==GL_TRUE&&mask[2]==GL_FALSE&&mask[3]==GL_TRUE&&glIsEnabled(GL_SCISSOR_TEST)&&polygonPreserved;
    printf("OpenGL pixels=%u,%u,%u,%u, state restored=%d, flush=%d\n",rgba[0],rgba[1],rgba[2],rgba[3],state,result);
    printf("OpenGL edge=%u,%u,%u,%u, entire drawable filtered=%d\n",edge[0],edge[1],edge[2],edge[3],fullSurface);
    printf("OpenGL polygon front=%x back=%x preserved=%d\n",polygon[0],polygon[1],polygonPreserved);
    glPolygonMode(GL_FRONT_AND_BACK,GL_FILL);
    glDisable(GL_SCISSOR_TEST);glColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE);
    [window setContentSize:NSMakeSize(256,96)];[view.openGLContext update];
    glViewport(0,0,256,96);glDrawBuffer(GL_BACK);glClearColor(.2,.4,.6,1);glClear(GL_COLOR_BUFFER_BIT);
    [view.openGLContext flushBuffer];glFinish();
    unsigned char resized[4]={};glReadBuffer(GL_BACK);glReadPixels(128,48,1,1,GL_RGBA,GL_UNSIGNED_BYTE,resized);
    const bool cocoa=std::abs(int(resized[0])-102)<=2&&std::abs(int(resized[1])-77)<=2&&std::abs(int(resized[2])-51)<=2&&resized[3]==255;
    printf("OpenGL window isolated=%d, Cocoa resize pixels=%u,%u,%u,%u\n",isolated,resized[0],resized[1],resized[2],resized[3]);
    // CGLFlushDrawable may flush a context that is not current on this thread.
    // Effect resources and pixels must belong to that argument, and the caller's
    // previous context and its unrelated back buffer must remain unchanged.
    glDrawBuffer(GL_BACK);glClearColor(.2,.4,.6,1);glClear(GL_COLOR_BUFFER_BIT);
    [otherContext makeCurrentContext];glDrawBuffer(GL_BACK);glClearColor(.2,.4,.6,1);glClear(GL_COLOR_BUFFER_BIT);
    CGLLockContext(view.openGLContext.CGLContextObj); // Legal nested caller lock.
    const auto noncurrentResult=rsFlushDrawable(view.openGLContext.CGLContextObj);
    CGLUnlockContext(view.openGLContext.CGLContextObj);
    const bool currentRestored=CGLGetCurrentContext()==otherContext.CGLContextObj;
    glFinish();unsigned char untouched[4]={};glReadBuffer(GL_BACK);glReadPixels(64,64,1,1,GL_RGBA,GL_UNSIGNED_BYTE,untouched);
    const bool otherUntouched=std::abs(int(untouched[0])-51)<=2&&std::abs(int(untouched[1])-102)<=2&&std::abs(int(untouched[2])-153)<=2&&untouched[3]==255;
    [view.openGLContext makeCurrentContext];glFinish();unsigned char switched[4]={};glReadBuffer(GL_BACK);glReadPixels(128,48,1,1,GL_RGBA,GL_UNSIGNED_BYTE,switched);
    const bool noncurrentFiltered=std::abs(int(switched[0])-102)<=2&&std::abs(int(switched[1])-77)<=2&&std::abs(int(switched[2])-51)<=2&&switched[3]==255;
    printf("OpenGL noncurrent target filtered=%d current restored=%d unrelated untouched=%d pixels=%u,%u,%u,%u\n",noncurrentFiltered,currentRestored,otherUntouched,switched[0],switched[1],switched[2],switched[3]);
    bool repeated=bindings.preserved();
    GLuint rectangle=0;if(legacy){glGenTextures(1,&rectangle);glActiveTexture(GL_TEXTURE0);glBindTexture(GL_TEXTURE_RECTANGLE,rectangle);}
    // A vertical gradient with nonopaque alpha distinguishes texture orientation
    // errors from correct constant-color output and checks reuse across frames.
    GLint size[2]={};CGLGetParameter(view.openGLContext.CGLContextObj,kCGLCPSurfaceBackingSize,size);
    if(size[0]<=0 || size[1]<=0){const NSRect backing=[view convertRectToBacking:view.bounds];size[0]=backing.size.width;size[1]=backing.size.height;}
    for(unsigned frame=0;frame<6;++frame) {
        glDisable(GL_SCISSOR_TEST);glDrawBuffer(GL_BACK);glColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE);
        glClearColor(.2,.4,.6,.4);glClear(GL_COLOR_BUFFER_BIT);
        glEnable(GL_SCISSOR_TEST);glScissor(0,size[1]/2,size[0],size[1]-size[1]/2);
        glClearColor(.8,.6,.4,.4);glClear(GL_COLOR_BUFFER_BIT);glDisable(GL_SCISSOR_TEST);
        glActiveTexture(GL_TEXTURE3);[view.openGLContext flushBuffer];glFinish();
        unsigned char lower[4]={},upper[4]={};glReadBuffer(GL_BACK);
        glReadPixels(size[0]/2,size[1]/4,1,1,GL_RGBA,GL_UNSIGNED_BYTE,lower);
        glReadPixels(size[0]/2,3*size[1]/4,1,1,GL_RGBA,GL_UNSIGNED_BYTE,upper);
        const bool orientationPreserved=std::abs(int(lower[0])-102)<=2&&std::abs(int(upper[0])-26)<=2&&std::abs(int(lower[2])-51)<=2&&std::abs(int(upper[2])-77)<=2;
        // two-pass.fx explicitly returns alpha=1; verify output is not inverted
        // or accidentally sourced from a previously displayed frame.
        GLint currentActive=0,rectAfter=0;glGetIntegerv(GL_ACTIVE_TEXTURE,&currentActive);
        if(legacy){glActiveTexture(GL_TEXTURE0);glGetIntegerv(GL_TEXTURE_BINDING_RECTANGLE,&rectAfter);glActiveTexture(GL_TEXTURE3);}
        repeated=repeated&&bindings.preserved()&&orientationPreserved&&lower[3]==255&&upper[3]==255&&currentActive==GL_TEXTURE3&&(!legacy||GLuint(rectAfter)==rectangle);
        printf("OpenGL reused frame=%u orientation=%d rectangle restored=%d lower=%u,%u,%u,%u upper=%u,%u,%u,%u\n",frame,orientationPreserved,!legacy||GLuint(rectAfter)==rectangle,lower[0],lower[1],lower[2],lower[3],upper[0],upper[1],upper[2],upper[3]);
    }
    if(rectangle)glDeleteTextures(1,&rectangle);
    const bool missingDepthFallback=missingDepthCase(probeContext,size[0],size[1],legacy,argv[1]);
    return pixels&&fullSurface&&state&&isolated&&cocoa&&noncurrentFiltered&&currentRestored&&otherUntouched&&repeated&&missingDepthFallback&&noncurrentResult==kCGLNoError&&result==kCGLNoError&&glGetError()==GL_NO_ERROR?0:3;
}}
