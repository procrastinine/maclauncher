#import <AppKit/AppKit.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#import <QuartzCore/CATransaction.h>
#include <dlfcn.h>
#include <cmath>
#include <stdexcept>
#include <cstdio>
#include <cstring>
static void require(bool ok,const char *what){if(!ok)throw std::runtime_error(what);}
int main(int argc,char **argv){@autoreleasepool{try{
 require(argc==3,"Expected shared library and grayscale effect");setenv("RESHADE_EFFECT",argv[2],1);
 [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];[NSApp finishLaunching];
 require(dlopen(argv[1],RTLD_NOW|RTLD_LOCAL),"Cannot load shared library");
 auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];require(queue!=nil,"No GPU");
 auto window=[[NSWindow alloc]initWithContentRect:NSMakeRect(100,100,64,48)styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;window.title=@"Metal presentation order";
 auto layer=[CAMetalLayer layer];layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.framebufferOnly=NO;layer.drawableSize=CGSizeMake(64,48);layer.frame=window.contentView.bounds;window.contentView.wantsLayer=YES;window.contentView.layer=layer;[window orderFront:nil];[window display];[CATransaction flush];
 for(unsigned mode=0;mode<3;++mode){@autoreleasepool{
  CFRunLoopRunInMode(kCFRunLoopDefaultMode,.03,false);auto drawable=[layer nextDrawable];require(drawable!=nil,"No drawable");auto commands=[queue commandBuffer];
  auto pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=drawable.texture;pass.colorAttachments[0].loadAction=MTLLoadActionClear;pass.colorAttachments[0].storeAction=MTLStoreActionStore;pass.colorAttachments[0].clearColor=MTLClearColorMake(.1,.2,.3,1);
  auto encoder=[commands renderCommandEncoderWithDescriptor:pass];require(encoder!=nil,"No encoder");
  if(mode==0)[commands presentDrawable:drawable];else if(mode==1)[commands presentDrawable:drawable atTime:CACurrentMediaTime()+.01];else [commands presentDrawable:drawable afterMinimumDuration:.01];
  require(commands.status<MTLCommandBufferStatusCommitted,"Presentation submitted the app buffer");[encoder endEncoding];
  // A legal later write must precede the effect as well as the actual present.
  auto input=[device newBufferWithLength:64*48*4 options:MTLResourceStorageModeShared];for(unsigned y=0;y<48;++y)for(unsigned x=0;x<64;++x){const unsigned char color[4]={77,(unsigned char)(y<24?26:204),(unsigned char)(y<24?204:26),255};std::memcpy((char*)input.contents+(y*64+x)*4,color,4);}auto upload=[commands blitCommandEncoder];[upload copyFromBuffer:input sourceOffset:0 sourceBytesPerRow:256 sourceBytesPerImage:64*48*4 sourceSize:MTLSizeMake(64,48,1) toTexture:drawable.texture destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[upload endEncoding];
  [commands commit];[commands waitUntilCompleted];require(commands.status==MTLCommandBufferStatusCompleted,"Producer failed");
  auto bytes=[device newBufferWithLength:512 options:MTLResourceStorageModeShared];auto read=[queue commandBuffer];auto copy=[read blitCommandEncoder];[copy copyFromTexture:drawable.texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(1,1,1) toBuffer:bytes destinationOffset:0 destinationBytesPerRow:256 destinationBytesPerImage:256];[copy copyFromTexture:drawable.texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,47,0) sourceSize:MTLSizeMake(1,1,1) toBuffer:bytes destinationOffset:256 destinationBytesPerRow:256 destinationBytesPerImage:256];[copy endEncoding];[read commit];[read waitUntilCompleted];require(read.status==MTLCommandBufferStatusCompleted,"Readback failed");auto pixel=(unsigned char*)bytes.contents;const int expected=std::lround((.2126*.8+.7152*.1+.0722*.3)*255);for(unsigned c=0;c<3;++c)require(std::abs(int(pixel[c])-expected)<=2,"Effect missed final app write");require(pixel[3]==255,"Alpha changed");const int bottom=std::lround(.2126*26+.7152*204+.0722*77);for(unsigned c=0;c<3;++c)require(std::abs(int(pixel[256+c])-bottom)<=2,"Effect inverted the source");require(pixel[259]==255,"Bottom alpha changed");printf("PASS present mode=%u before endEncoding, final write filtered rgba=%u,%u,%u,%u\n",mode,pixel[0],pixel[1],pixel[2],pixel[3]);
 }}[window close];CFRunLoopRunInMode(kCFRunLoopDefaultMode,.02,false);return 0;
}catch(const std::exception&e){fprintf(stderr,"FAIL %s\n",e.what());return 1;}}}
