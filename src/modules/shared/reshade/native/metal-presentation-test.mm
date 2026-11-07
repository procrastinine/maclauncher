#include "host.hpp"
#include "window.hpp"
#include "view-presentation.hpp"
#import <objc/runtime.h>
#import <QuartzCore/CATransaction.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <cstdio>
#include <stdexcept>
static IMP originalNext;
static id<CAMetalDrawable> lastDrawable;
static CAMetalLayer *lastLayer;
static id<CAMetalDrawable> observeNext(id object,SEL selector){auto value=reinterpret_cast<id<CAMetalDrawable>(*)(id,SEL)>(originalNext)(object,selector);lastDrawable=value;lastLayer=object;return value;}
static void present(id<MTLCommandBuffer>commands,id<CAMetalDrawable>drawable){if(std::getenv("RESHADE_TEST_SCHEDULED"))[commands addScheduledHandler:^(id<MTLCommandBuffer>){[drawable present];}];else [commands presentDrawable:drawable];}
static void require(bool value,const char*reason){if(!value)throw std::runtime_error(reason);}
static void progress(unsigned phase,unsigned frame,const char *step){if(std::getenv("RESHADE_TEST_STOPPED_OWNER")){fprintf(stderr,"Metal replacement phase=%u frame=%u step=%s\n",phase,frame,step);fflush(stderr);}}
static NSView *layerView(NSView *view,CALayer *layer){if(view.layer==layer)return view;for(NSView *child in view.subviews)if(auto match=layerView(child,layer))return match;return nil;}
static double fixtureDeadline=0;
static void idle(double seconds){const double until=CACurrentMediaTime()+seconds;
 while(CACurrentMediaTime()<until){require(CACurrentMediaTime()<fixtureDeadline,"Automatic Metal fixture exceeded its 20 second deadline");
  CFRunLoopRunInMode(kCFRunLoopDefaultMode,.005,false);
  if(NSApp){for(unsigned i=0;i<32;++i){auto event=[NSApp nextEventMatchingMask:NSEventMaskAny untilDate:NSDate.distantPast inMode:NSDefaultRunLoopMode dequeue:YES];if(!event)break;[NSApp sendEvent:event];}[NSApp updateWindows];}
 }}
// Presentation reveal and native window publication run on the main thread.
// Observe actual GPU retirement while allowing that lifecycle to advance.
static void waitForCompletion(id<MTLCommandBuffer>commands){while(commands.status<MTLCommandBufferStatusCompleted)idle(.005);}
static id<MTLRenderPipelineState> patternPipeline,framebufferReadPipeline;
static void prepareFramebufferProducer(id<MTLDevice>device){
 require([device supportsFamily:MTLGPUFamilyApple2],"Framebuffer-only fixture requires programmable blending");
 NSError *error=nil;auto options=[MTLCompileOptions new];options.languageVersion=MTLLanguageVersion2_3;
 auto code=@"#include <metal_stdlib>\nusing namespace metal;\n"
  "vertex float4 fullscreen(uint i [[vertex_id]]){float2 p=float2((i<<1)&2,i&2);return float4(p*2-1,0,1);}\n"
  "fragment float4 pattern(float4 p [[position]],constant uint2 &v [[buffer(0)]]){return (p.y<v.y?float4(v.x,102,153,255):float4(204,179,51,255))/255.0;}\n"
  "struct Copy{float4 value [[color(1)]];};\n"
  "fragment Copy fetch(float4 value [[color(0)]]){Copy o;o.value=value;return o;}\n";
 auto library=[device newLibraryWithSource:code options:options error:&error];require(library!=nil,error.localizedDescription.UTF8String?:"Cannot compile fixture render pass");
 auto descriptor=[MTLRenderPipelineDescriptor new];descriptor.vertexFunction=[library newFunctionWithName:@"fullscreen"];
 descriptor.fragmentFunction=[library newFunctionWithName:@"pattern"];descriptor.colorAttachments[0].pixelFormat=MTLPixelFormatBGRA8Unorm;
 patternPipeline=[device newRenderPipelineStateWithDescriptor:descriptor error:&error];require(patternPipeline!=nil,error.localizedDescription.UTF8String?:"Cannot prepare fixture producer");
 // Match framebuffer-access.hpp: read color(0) through programmable blending,
 // write only color(1), and preserve the framebuffer-only source attachment.
 descriptor.fragmentFunction=[library newFunctionWithName:@"fetch"];descriptor.colorAttachments[0].writeMask=MTLColorWriteMaskNone;
 descriptor.colorAttachments[1].pixelFormat=MTLPixelFormatBGRA8Unorm;
 framebufferReadPipeline=[device newRenderPipelineStateWithDescriptor:descriptor error:&error];require(framebufferReadPipeline!=nil,error.localizedDescription.UTF8String?:"Cannot prepare fixture framebuffer readback");
}
static void renderPattern(id<MTLCommandBuffer>commands,id<MTLTexture>texture,unsigned red){
 auto pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=texture;
 pass.colorAttachments[0].loadAction=MTLLoadActionDontCare;pass.colorAttachments[0].storeAction=MTLStoreActionStore;
 auto encoder=[commands renderCommandEncoderWithDescriptor:pass];require(encoder!=nil,"Cannot encode framebuffer-only producer");
 const unsigned values[]={red,unsigned(texture.height/2)};[encoder setRenderPipelineState:patternPipeline];[encoder setFragmentBytes:values length:sizeof(values) atIndex:0];
 [encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];[encoder endEncoding];
}
static id<MTLTexture> readableFramebuffer(id<MTLCommandBuffer>commands,id<MTLTexture>texture){
 auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:texture.pixelFormat width:texture.width height:texture.height mipmapped:NO];
 descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageRenderTarget;
 auto readable=[commands.device newTextureWithDescriptor:descriptor];require(readable!=nil,"Cannot allocate fixture framebuffer snapshot");
 auto pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=texture;
 pass.colorAttachments[0].loadAction=MTLLoadActionLoad;pass.colorAttachments[0].storeAction=MTLStoreActionStore;
 pass.colorAttachments[1].texture=readable;pass.colorAttachments[1].loadAction=MTLLoadActionDontCare;pass.colorAttachments[1].storeAction=MTLStoreActionStore;
 auto encoder=[commands renderCommandEncoderWithDescriptor:pass];require(encoder!=nil,"Cannot encode fixture framebuffer snapshot");
 [encoder setRenderPipelineState:framebufferReadPipeline];[encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];[encoder endEncoding];return readable;
}
static void fullscreen(NSWindow *window,bool enabled){
 __block bool complete=false;NSString *name=enabled?NSWindowDidEnterFullScreenNotification:NSWindowDidExitFullScreenNotification;
 auto observer=[NSNotificationCenter.defaultCenter addObserverForName:name object:window queue:nil usingBlock:^(NSNotification*){complete=true;}];
 [window toggleFullScreen:nil];for(unsigned i=0;i<500&&!complete;++i)idle(.01);
 [NSNotificationCenter.defaultCenter removeObserver:observer];require(complete,"Native fullscreen transition did not complete");
 require(bool(window.styleMask&NSWindowStyleMaskFullScreen)==enabled,"Window fullscreen state differs");
}
static void checkPixels(id<MTLTexture>texture,id<MTLCommandQueue>queue,unsigned red,bool effects){
 auto bytes=[queue.device newBufferWithLength:512 options:MTLResourceStorageModeShared];auto commands=[queue commandBuffer];
 auto readable=texture.framebufferOnly?readableFramebuffer(commands,texture):texture;auto copy=[commands blitCommandEncoder];
 for(unsigned y=0;y<2;++y)[copy copyFromTexture:readable sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(texture.width/2,texture.height*(y?3:1)/4,0) sourceSize:MTLSizeMake(1,1,1) toBuffer:bytes destinationOffset:y*256 destinationBytesPerRow:256 destinationBytesPerImage:256];
 [copy endEncoding];[commands commit];waitForCompletion(commands);require(commands.status==MTLCommandBufferStatusCompleted,"Readback failed");const unsigned colors[2][4]={{153,102,red,255},{51,179,204,255}};
 for(unsigned y=0;y<2;++y)for(unsigned c=0;c<4;++c){const int expected=effects&&c<3?lround((255-colors[y][c])*.5):colors[y][c];const int actual=static_cast<unsigned char*>(bytes.contents)[y*256+c];if(abs(actual-expected)>3)throw std::runtime_error("Automatic Metal pixels/orientation differ");}
}
int main(){@autoreleasepool{try{
 fixtureDeadline=CACurrentMediaTime()+20;
 [NSApplication sharedApplication];require([NSApp setActivationPolicy:NSApplicationActivationPolicyRegular],"Cannot activate automatic Metal fixture");[NSApp finishLaunching];auto method=class_getInstanceMethod(CAMetalLayer.class,@selector(nextDrawable));originalNext=method_setImplementation(method,reinterpret_cast<IMP>(observeNext));auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];const bool effects=std::getenv("RESHADE_EFFECT")!=nullptr;
 const bool framebufferOnly=std::getenv("RESHADE_TEST_FRAMEBUFFER_ONLY")!=nullptr;if(framebufferOnly)prepareFramebufferProducer(device);
 auto make=[&](NSString*title,int x){auto window=[[NSWindow alloc]initWithContentRect:NSMakeRect(x,140,256,160)styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];window.collectionBehavior|=NSWindowCollectionBehaviorFullScreenPrimary;window.releasedWhenClosed=NO;window.title=title;auto source=[[NSView alloc]initWithFrame:window.contentView.bounds];source.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;auto layer=[CAMetalLayer layer];layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.framebufferOnly=framebufferOnly;source.wantsLayer=YES;source.layer=layer;[window.contentView addSubview:source];[window orderFront:nil];[window display];return window;};
 auto window=make(@"Filtered",40),other=make(@"Unfiltered",450);auto source=window.contentView.subviews.firstObject;auto layer=(CAMetalLayer*)source.layer;unsigned checks=0;
 [window makeKeyAndOrderFront:nil];[NSApp activateIgnoringOtherApps:YES];[NSRunningApplication.currentApplication activateWithOptions:NSApplicationActivateAllWindows|NSApplicationActivateIgnoringOtherApps];
 const double readyDeadline=std::min(fixtureDeadline,CACurrentMediaTime()+3);
 while(CACurrentMediaTime()<readyDeadline&&!(NSApp.active&&window.keyWindow&&(window.occlusionState&NSWindowOcclusionStateVisible)))idle(.005);
 fprintf(stderr,"Automatic window ready: active=%d key=%d occlusion=%llu window=%ld\n",bool(NSApp.active),bool(window.keyWindow),(unsigned long long)window.occlusionState,(long)window.windowNumber);
 require(NSApp.active&&window.keyWindow&&(window.occlusionState&NSWindowOcclusionStateVisible),"Automatic Metal window is not active, key and visible");
 const bool transitions=std::getenv("RESHADE_TEST_TRANSITIONS")!=nullptr,full=std::getenv("RESHADE_TEST_FULLSCREEN")!=nullptr;std::shared_ptr<macfx::ViewPresentation> previous;
 for(unsigned phase=0;phase<(full?6u:transitions?4u:2u);++phase){if(phase>=4)fullscreen(window,phase==4);else [window setContentSize:phase?NSMakeSize(320,196):NSMakeSize(256,160)];[window display];const NSRect actual=[source convertRectToBacking:source.bounds];const unsigned outputW=actual.size.width,outputH=actual.size.height,inputW=transitions&&phase<4&&phase%2==0?outputW:outputW/2,inputH=transitions&&phase<4&&phase%2==0?outputH:outputH/2;const bool passthrough=!effects&&inputW==outputW&&inputH==outputH;layer.drawableSize=CGSizeMake(inputW,inputH);const NSRect originalFrame=source.frame;
  fprintf(stderr,"Metal presentation phase=%u source=%ux%u output=%ux%u backing=%.1f fullscreen=%d\n",phase,inputW,inputH,outputW,outputH,window.backingScaleFactor,bool(window.styleMask&NSWindowStyleMaskFullScreen));
  for(unsigned frame=0;frame<4;++frame){const unsigned red=32+frame*24;
   // Source acquisition also updates the observation. Keep the actual previous
   // processed layer before that overwrites lastLayer with the source layer.
   CAMetalLayer *previousProcessedLayer=lastLayer!=layer?lastLayer:nil;
   progress(phase,frame,"nextDrawable-begin");auto drawable=[layer nextDrawable];progress(phase,frame,"nextDrawable-end");require(drawable!=nil,"No game drawable");if(framebufferOnly)require(drawable.texture.framebufferOnly,"Framebuffer-only publisher contract was changed");else require(!drawable.texture.framebufferOnly,"Fixture drawable must allow blit upload/readback");require(drawable.texture.width==inputW&&drawable.texture.height==inputH,"Engine drawable resolution was changed");
   progress(phase,frame,"upload-begin");auto commands=[queue commandBuffer];
   if(framebufferOnly)renderPattern(commands,drawable.texture,red);
   else {const size_t stride=(inputW*4+255)&~size_t(255);auto upload=[device newBufferWithLength:stride*inputH options:MTLResourceStorageModeShared];
    const unsigned char upper[]={153,102,(unsigned char)red,255},lower[]={51,179,204,255};for(unsigned y=0;y<inputH;++y)for(unsigned x=0;x<inputW;++x)std::memcpy(static_cast<unsigned char*>(upload.contents)+y*stride+x*4,y<inputH/2?upper:lower,4);
    auto copy=[commands blitCommandEncoder];[copy copyFromBuffer:upload sourceOffset:0 sourceBytesPerRow:stride sourceBytesPerImage:stride*inputH sourceSize:MTLSizeMake(inputW,inputH,1) toTexture:drawable.texture destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];}
   progress(phase,frame,"upload-end");
   progress(phase,frame,"owner-lookup-begin");auto presentation=macfx::metalPresentation(layer);progress(phase,frame,"owner-lookup-end");if(passthrough){require(!presentation,"Equal-resolution scaling created Metal output");if(previous)require(previous->snapshot().stopped,"Equal-resolution transition retained prior Metal output");present(commands,drawable);[commands commit];waitForCompletion(commands);require(commands.status==MTLCommandBufferStatusCompleted,"Passthrough publisher failed");idle(.02);require(lastLayer==layer,"Passthrough acquired another output drawable");checkPixels(drawable.texture,queue,red,false);for(NSView*view in source.superview.subviews)if(view!=source&&[view.layer isKindOfClass:CAMetalLayer.class])require(view.hidden,"Passthrough obscures publisher output");++checks;continue;}require(bool(presentation),"Accepted Metal view has no presentation owner");
   if(phase==0&&frame<2&&std::getenv("RESHADE_TEST_STOPPED_OWNER")){
    auto retired=presentation;
    progress(phase,frame,frame==0?"replace-stop-begin":"replace-detach-begin");
    if(frame==0)retired->stop();
    else {require(previousProcessedLayer&&previousProcessedLayer!=layer,"No previous processed layer to detach");auto detached=layerView(window.contentView,previousProcessedLayer);require(detached&&detached!=source,"No processed attachment to detach");[detached removeFromSuperview];}
    progress(phase,frame,"replace-mutation-end");progress(phase,frame,"resolve-begin");require(macfx::acceptsLayer(layer),"Original Metal publisher lost ownership during replacement");progress(phase,frame,"resolve-end");
    presentation=macfx::metalPresentation(layer);
    require(retired->snapshot().stopped&&presentation&&presentation!=retired&&!presentation->snapshot().stopped,
      frame==0?"Stopped map entry was not replaced in the same resolver pass":"Update-triggered detachment was not replaced in the same resolver pass");++checks;
    if(std::getenv("RESHADE_TEST_FLUSH_REPLACEMENT")){progress(phase,frame,"replacement-flush-begin");[CATransaction flush];progress(phase,frame,"replacement-flush-end");}
   }
   previous=presentation;const auto completed=presentation->snapshot().completedReal;
   if(phase==0&&frame==0&&std::getenv("RESHADE_TEST_BACKPRESSURE")) {
    const auto dropped=presentation->snapshot().dropped;
    @autoreleasepool {
     NSMutableArray *held=[NSMutableArray array];
     for(unsigned slot=0;slot<3;++slot){auto unsubmitted=[queue commandBuffer];auto result=presentation->submit(unsubmitted,drawable.texture,0,CACurrentMediaTime());require(result.encoded,"Cannot saturate automatic presentation");[held addObject:unsubmitted];}
     present(commands,drawable);
     [commands commit];require(!presentation->snapshot().stopped&&presentation->snapshot().dropped>dropped,"Temporary pressure permanently disabled automatic presentation");waitForCompletion(commands);require(commands.status==MTLCommandBufferStatusCompleted,"Busy frame blocked the original publisher");[held removeAllObjects];
    }
    idle(.02);fprintf(stderr,"Automatic pressure status stopped=%d pending=%llu dropped=%llu reason=%s\n",presentation->snapshot().stopped,(unsigned long long)presentation->snapshot().pending,(unsigned long long)presentation->snapshot().dropped,presentation->snapshot().reason.c_str());require(!presentation->snapshot().stopped&&presentation->snapshot().pending==0,"Abandoned automatic frames retained capacity");++checks;continue;
   }
   progress(phase,frame,"submit-begin");present(commands,drawable);progress(phase,frame,"submit-end");require(commands.status<MTLCommandBufferStatusCommitted,"Hook submitted the publisher buffer");progress(phase,frame,"commit-begin");[commands commit];progress(phase,frame,"commit-end");waitForCompletion(commands);progress(phase,frame,"gpu-wait-end");require(commands.status==MTLCommandBufferStatusCompleted,"Publisher GPU work failed");
   progress(phase,frame,"presentation-completion-begin");for(unsigned i=0;i<100&&presentation->snapshot().completedReal<=completed;++i)idle(.01);idle(.02);progress(phase,frame,"presentation-completion-end");auto status=presentation->snapshot();require(status.completedReal>completed&&status.reason.empty(),"Automatic presentation did not complete");require(lastLayer!=layer&&lastDrawable,"Missing distinct final output layer");require(lastDrawable.texture.width==outputW&&lastDrawable.texture.height==outputH,"Output is not the view's actual physical size");progress(phase,frame,"read-output-begin");checkPixels(lastDrawable.texture,queue,red,effects);progress(phase,frame,"read-source-begin");checkPixels(drawable.texture,queue,red,false);progress(phase,frame,"read-end");
   require(NSEqualRects(source.frame,originalFrame)&&layer.drawableSize.width==inputW,"Game geometry or resolution changed");NSView*overlay=layerView(window.contentView,lastLayer);require(overlay&&overlay!=source&&overlay.window==window&&!overlay.hiddenOrHasHiddenAncestor,"Valid automatic output remained hidden");require([overlay hitTest:NSMakePoint(10,10)]==nil&&!overlay.acceptsFirstResponder,"Output steals input");++checks;
  }
 }
 auto otherLayer=(CAMetalLayer*)other.contentView.subviews.firstObject.layer;[otherLayer nextDrawable];require(!macfx::metalPresentation(otherLayer),"Unselected window gained processing");++checks;auto owner=macfx::metalPresentation(layer);for(unsigned i=0;i<200&&!owner->snapshot().presentedReal;++i)idle(.01);require(owner->snapshot().presentedReal>0,"No automatic frame reached actual presentation");[window orderOut:nil];idle(.03);require(!macfx::metalPresentation(layer)&&owner->snapshot().stopped,"Closed window retained active presentation");++checks;lastDrawable=nil;lastLayer=nil;[window close];[other close];printf("Automatic Metal presentation checks=%u actual-half-resolution-source native-output effects=%d input/resize/isolation/teardown pass\n",checks,effects);return 0;
 }catch(const std::exception&e){fprintf(stderr,"%s\n",e.what());return 1;}}}
