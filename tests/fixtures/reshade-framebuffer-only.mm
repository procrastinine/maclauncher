#import <AppKit/AppKit.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#include <dlfcn.h>
#include <cmath>
#include <cstdio>
#include <stdexcept>
static void check(bool value,const char *message){if(!value)throw std::runtime_error(message);}
static double srgb(double x){return x<=.0031308?12.92*x:1.055*std::pow(x,1/2.4)-.055;}
int main(int argc,char **argv){@autoreleasepool{try{
 check(argc==3,"Expected shared library and grayscale effect");setenv("RESHADE_EFFECT",argv[2],1);
 [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];[NSApp finishLaunching];
 check(dlopen(argv[1],RTLD_NOW|RTLD_LOCAL),"Cannot load shared library");
 auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];
 NSError *error=nil;auto options=[MTLCompileOptions new];options.languageVersion=MTLLanguageVersion2_3;
 auto library=[device newLibraryWithSource:@"#include <metal_stdlib>\nusing namespace metal;vertex float4 vertexMain(uint i[[vertex_id]]){return float4(float2((i<<1)&2,i&2)*2-1,0,1);}fragment float4 paint(float4 p[[position]]){return p.y<24?float4(.8,.1,.3,.6):float4(.1,.8,.3,.6);}struct Out{float4 value[[color(1)]];};fragment Out inspect(float4 v[[color(0)]]){Out o;o.value=v;return o;}" options:options error:&error];
 check(library!=nil,error.localizedDescription.UTF8String?:"Cannot compile scene");
 auto window=[[NSWindow alloc]initWithContentRect:NSMakeRect(90,90,64,48)styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;window.title=@"Framebuffer preservation";
 auto layer=[CAMetalLayer layer];layer.device=device;layer.framebufferOnly=YES;layer.drawableSize=CGSizeMake(64,48);layer.frame=window.contentView.bounds;window.contentView.wantsLayer=YES;window.contentView.layer=layer;[window orderFront:nil];
 for(unsigned color=0;color<2;++color){
  const auto format=color?MTLPixelFormatBGRA8Unorm_sRGB:MTLPixelFormatBGRA8Unorm;layer.pixelFormat=format;
  auto descriptor=[MTLRenderPipelineDescriptor new];descriptor.vertexFunction=[library newFunctionWithName:@"vertexMain"];descriptor.fragmentFunction=[library newFunctionWithName:@"paint"];descriptor.colorAttachments[0].pixelFormat=format;
  auto paint=[device newRenderPipelineStateWithDescriptor:descriptor error:&error];check(paint!=nil,"Cannot create scene");
  descriptor.fragmentFunction=[library newFunctionWithName:@"inspect"];descriptor.colorAttachments[0].writeMask=MTLColorWriteMaskNone;descriptor.colorAttachments[1].pixelFormat=format;
  auto inspect=[device newRenderPipelineStateWithDescriptor:descriptor error:&error];check(inspect!=nil,"Cannot create independent readback");
  auto imageDescriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:64 height:48 mipmapped:NO];imageDescriptor.usage=MTLTextureUsageRenderTarget;imageDescriptor.storageMode=MTLStorageModePrivate;auto readable=[device newTextureWithDescriptor:imageDescriptor];
  for(unsigned mode=0;mode<3;++mode){@autoreleasepool{
   CFRunLoopRunInMode(kCFRunLoopDefaultMode,.025,false);auto drawable=[layer nextDrawable];check(drawable&&drawable.texture.framebufferOnly&&layer.framebufferOnly,"Producer framebuffer-only property changed");
   auto commands=[queue commandBuffer];auto pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=drawable.texture;pass.colorAttachments[0].loadAction=MTLLoadActionClear;pass.colorAttachments[0].storeAction=MTLStoreActionStore;
   auto encoder=[commands renderCommandEncoderWithDescriptor:pass];
   if(mode==0)[commands presentDrawable:drawable];else if(mode==1)[commands presentDrawable:drawable atTime:CACurrentMediaTime()+.01];else [commands presentDrawable:drawable afterMinimumDuration:.01];
   [encoder endEncoding];encoder=[commands renderCommandEncoderWithDescriptor:pass];[encoder setRenderPipelineState:paint];[encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];[encoder endEncoding];
   [commands commit];[commands waitUntilCompleted];check(commands.status==MTLCommandBufferStatusCompleted,"Processing failed");
   // Fixture-only readback. The protected drawable is used solely as a render
   // attachment; only the separate test texture is copied to CPU memory.
   auto read=[queue commandBuffer];pass.colorAttachments[0].loadAction=MTLLoadActionLoad;pass.colorAttachments[1].texture=readable;pass.colorAttachments[1].loadAction=MTLLoadActionDontCare;pass.colorAttachments[1].storeAction=MTLStoreActionStore;
   encoder=[read renderCommandEncoderWithDescriptor:pass];[encoder setRenderPipelineState:inspect];[encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];[encoder endEncoding];
   auto bytes=[device newBufferWithLength:64*48*4 options:MTLResourceStorageModeShared];auto copy=[read blitCommandEncoder];[copy copyFromTexture:readable sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(64,48,1) toBuffer:bytes destinationOffset:0 destinationBytesPerRow:256 destinationBytesPerImage:64*48*4];[copy endEncoding];[read commit];[read waitUntilCompleted];check(read.status==MTLCommandBufferStatusCompleted,"Readback failed");
   auto pixels=(unsigned char*)bytes.contents;
   for(unsigned y=0;y<48;++y){double r=y<24?.8:.1,g=y<24?.1:.8,b=.3;if(color){r=srgb(r);g=srgb(g);b=srgb(b);}const int gray=std::lround((.2126*r+.7152*g+.0722*b)*255);for(unsigned x=0;x<64;++x){const auto p=pixels+(y*64+x)*4;for(unsigned c=0;c<3;++c)check(std::abs(int(p[c])-gray)<=2,"Final color or source orientation changed");check(std::abs(int(p[3])-153)<=1,"Source alpha changed");}}
   printf("PASS framebufferOnly=YES srgb=%u mode=%u full asymmetric pixels and alpha\n",color,mode);
  }}
 }
 [window close];CFRunLoopRunInMode(kCFRunLoopDefaultMode,.02,false);return 0;
}catch(const std::exception&e){fprintf(stderr,"FAIL %s\n",e.what());return 1;}}}
