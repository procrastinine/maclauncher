// Exercise the real owned submission adapter and installed common presenter.
// The lifecycle fixture's unused EGL/device doubles do not enter this path.
#define main previousLifecycleMain
#include "lifecycle.mm"
#undef main
#import <AppKit/AppKit.h>

int main(int argc,char **argv){@try{@autoreleasepool{
 EXPECT(argc==2);setenv("KLEPTON_FRAME_LIBRARY",argv[1],1);setenv("RESHADE_EXPLICIT_HOST","1",1);
 [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
 NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(30,30,64,64) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
 window.releasedWhenClosed=NO; // ARC owns this hidden fixture window.
 auto layer=[CAMetalLayer layer];window.contentView.wantsLayer=YES;window.contentView.layer=layer;layer.frame=window.contentView.bounds;EXPECT(!window.visible);
 JNINativeInterface_ functions{};functions.ExceptionCheck=pending;functions.FindClass=find;functions.ThrowNew=throwNew;JNIEnv env{&functions};
 auto p=(Presenter*)klj_metal_create(&env,(__bridge void*)layer,64,64);EXPECT(p);
 initializeDevice(p,MTLCreateSystemDefaultDevice(),true);EXPECT(p->shared&&p->sharedStatus);
 auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:64 height:64 mipmapped:NO];descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead;
 auto source=[p->device newTextureWithDescriptor:descriptor];std::vector<uint32_t> pixels(64*64,0xff20c040);[source replaceRegion:MTLRegionMake2D(0,0,64,64) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:64*4];
 auto commands=[p->queue commandBuffer];RSPresenterSubmission submission{};submission.size=sizeof(submission);submission.version=RS_PRESENTER_ABI_VERSION;submission.commandBuffer=(__bridge void*)commands;submission.sourceTexture=(__bridge void*)source;submission.frameId=1;submission.sourceTime=CACurrentMediaTime();
 RSFrameResult result{};result.size=sizeof(result);result.version=RS_FRAME_ABI_VERSION;
 EXPECT(submitFrame(p,&submission,nullptr,&result)==RS_FRAME_OK&&result.encoded);[commands commit];
 // The original shared presenter may complete or drop this hidden frame,
 // but it must not manufacture physical display for Android transaction state.
 [commands waitUntilCompleted];
 RSPresenterStatus status{};status.size=sizeof(status);status.version=RS_PRESENTER_ABI_VERSION;EXPECT(p->sharedStatus(p->shared,&status)==RS_FRAME_OK);
 fprintf(stderr,"[hidden-output] encoded=%llu completed=%llu presented=%llu dropped=%llu command-status=%lu\n",(unsigned long long)status.encoded,(unsigned long long)status.completedReal,(unsigned long long)status.presentedReal,(unsigned long long)status.dropped,(unsigned long)commands.status);
 EXPECT(status.encoded>0&&status.presentedReal==0&&!window.visible);
 klj_metal_destroy(p);[window orderOut:nil];[window close];
 printf("PASS actual hidden Metal output: encoded pixels retain independent zero physical presentation\n");return 0;
}}@catch(NSException *error){fprintf(stderr,"FIXTURE_EXCEPTION: %s\n",error.reason.UTF8String);return 20;}}
