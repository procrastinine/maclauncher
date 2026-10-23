#include "frame.h"
#include "live-controls.hpp"
#import <Cocoa/Cocoa.h>
#import <Metal/Metal.h>
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>
#include <fstream>
#include <thread>
#include <cstdio>
#include <stdexcept>
extern "C" CGLError rsFlushDrawable(CGLContextObj);
static void require(bool b,const char*m){if(!b)throw std::runtime_error(m);}
// PLAN lists immutable revisions: grayscale, sharpen, grayscale+sharpen.
int main(int argc,char**argv){@autoreleasepool{try{
 require(argc==4,"Usage: live-effects metal|gl PLAN CONTROL_FILE");const bool gl=std::string(argv[1])=="gl";
 std::ifstream plan(argv[2]);std::array<std::string,3> revisions;for(auto&s:revisions){std::getline(plan,s);require(s.size()==64,"Invalid effect revision");}
 auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];require(device&&queue,"Metal unavailable");
 auto desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:32 height:24 mipmapped:NO];
 desc.storageMode=MTLStorageModeShared;desc.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
 auto source=[device newTextureWithDescriptor:desc],target=[device newTextureWithDescriptor:desc];
 std::array<unsigned char,32*24*4> pixels;for(size_t i=0;i<pixels.size();i+=4){pixels[i]=204;pixels[i+1]=51;pixels[i+2]=102;pixels[i+3]=255;}
 [source replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:128];
 NSWindow*window=nil;NSOpenGLView*view=nil;
 if(gl){[NSApplication sharedApplication];NSOpenGLPixelFormatAttribute attrs[]={NSOpenGLPFAAccelerated,NSOpenGLPFAOpenGLProfile,NSOpenGLProfileVersion4_1Core,NSOpenGLPFADoubleBuffer,NSOpenGLPFABackingStore,NSOpenGLPFAColorSize,32,NSOpenGLPFAAlphaSize,8,0};
  auto format=[[NSOpenGLPixelFormat alloc]initWithAttributes:attrs];require(format!=nil,"Hardware OpenGL unavailable");
  window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,128,128) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];window.title=@"Filtered";
  view=[[NSOpenGLView alloc]initWithFrame:NSMakeRect(0,0,128,128) pixelFormat:format];window.contentView=view;[window orderFront:nil];[window display];
  CFRunLoopRunInMode(kCFRunLoopDefaultMode,.1,false);[view.openGLContext update];[view.openGLContext makeCurrentContext];}
 int owner=0;
 // Initial off, enable grayscale, switch preset, disable, enable chain, disable.
 for(unsigned frame=0;frame<6;++frame){
  const bool gray=frame==1||frame==4,enabled=frame==1||frame==2||frame==4;const unsigned choice=frame==4?2:frame==2?1:0;
  macfx::LivePacket p{};std::memcpy(p.magic,"MLFXCTL2",8);p.targetHz=60;p.multiplier=2;p.flags=enabled?8:0;if(frame==4)p.flags|=16;
  std::memset(p.effectKey,'a',64);std::memcpy(p.revision,revisions[choice].data(),64);
  const std::string tmp=std::string(argv[3])+".tmp";{std::ofstream out(tmp,std::ios::binary);out.write(reinterpret_cast<const char*>(&p),sizeof(p));}require(rename(tmp.c_str(),argv[3])==0,"Publish failed");
  std::this_thread::sleep_for(std::chrono::milliseconds(120));unsigned char rgba[4]{};
  if(gl){glDisable(GL_SCISSOR_TEST);glColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE);glDrawBuffer(GL_BACK);glClearColor(.8,.2,.4,1);glClear(GL_COLOR_BUFFER_BIT);
   require(rsFlushDrawable(view.openGLContext.CGLContextObj)==kCGLNoError,"OpenGL flush failed");glFinish();glReadBuffer(GL_BACK);glReadPixels(64,64,1,1,GL_RGBA,GL_UNSIGNED_BYTE,rgba);require(glGetError()==GL_NO_ERROR,"OpenGL state failed");
  }else{auto cb=[queue commandBuffer];RSFrameRequest request{sizeof(RSFrameRequest),1,&owner,(__bridge void*)cb,(__bridge void*)source,(__bridge void*)target,frame+1,RS_FRAME_BILINEAR,RS_FRAME_PERCEPTUAL,RS_FRAME_TOP_LEFT};RSFrameResult result{};result.size=sizeof(result);result.version=1;
   require(rsProcessFrame(&request,&result)==RS_FRAME_OK,result.reason);require(result.encoded,"Frame missing");[cb commit];[cb waitUntilCompleted];require(cb.status==MTLCommandBufferStatusCompleted,"GPU failure");
   [target getBytes:rgba bytesPerRow:4 fromRegion:MTLRegionMake2D(16,12,1,1) mipmapLevel:0];}
  printf("%s frame=%u enabled=%d chain=%d rgba=%u,%u,%u,%u\n",gl?"OpenGL":"Metal",frame,enabled,frame==4,rgba[0],rgba[1],rgba[2],rgba[3]);
  require(rgba[3]==255,"Alpha changed");if(gray)require(abs(int(rgba[0])-int(rgba[1]))<=2&&abs(int(rgba[1])-int(rgba[2]))<=2,"New grayscale effect did not apply");
  else require(abs(int(rgba[0])-204)<=2&&abs(int(rgba[1])-51)<=2&&abs(int(rgba[2])-102)<=2,"Original color or sharpen replacement failed");
 }
 rsReleaseFrameOwner(&owner);if(window)[window orderOut:nil];puts("Live off, enable, preset replacement, disable, chain and source restoration passed");return 0;
}catch(const std::exception&e){fprintf(stderr,"%s\n",e.what());return 1;}}}
