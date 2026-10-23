#import <Cocoa/Cocoa.h>
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <dlfcn.h>
#include <vector>
#include <sys/sysctl.h>

// Owned-window end-to-end capture test. Readback belongs only to this test.
int main(int argc,char **argv){@autoreleasepool{
 if(argc<3)return 64;const bool legacy=argc>3;
 int translated=0;size_t translatedSize=sizeof(translated);sysctlbyname("sysctl.proc_translated",&translated,&translatedSize,nullptr,0);
#if defined(__x86_64__)
 printf("ARCH x86_64 translated=%d\n",translated);
#else
 printf("ARCH arm64 translated=%d\n",translated);
#endif
 setenv("RESHADE_EFFECT",argv[2],1);
 void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library){puts(dlerror());return 1;}
 auto flush=reinterpret_cast<CGLError(*)(CGLContextObj)>(dlsym(library,"rsFlushDrawable"));if(!flush)return 2;
 [NSApplication sharedApplication];
 NSOpenGLPixelFormatAttribute attributes[]={NSOpenGLPFAAccelerated,NSOpenGLPFAOpenGLProfile,legacy?NSOpenGLProfileVersionLegacy:NSOpenGLProfileVersion4_1Core,NSOpenGLPFADoubleBuffer,NSOpenGLPFABackingStore,NSOpenGLPFAColorSize,32,NSOpenGLPFAAlphaSize,8,NSOpenGLPFADepthSize,24,NSOpenGLPFAStencilSize,8,0};
 auto format=[[NSOpenGLPixelFormat alloc]initWithAttributes:attributes];if(!format)return 77;
 auto window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,128,96) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];window.title=@"Depth";
 auto view=[[NSOpenGLView alloc]initWithFrame:window.contentView.bounds pixelFormat:format];window.contentView=view;[window orderFront:nil];[window display];
 unsigned checks=0;
 for(auto size:{NSMakeSize(128,96),NSMakeSize(193,127)}){
  [window setContentSize:size];[view.openGLContext update];[view.openGLContext makeCurrentContext];CFRunLoopRunInMode(kCFRunLoopDefaultMode,.02,false);
  GLint backing[2]={};CGLGetParameter(view.openGLContext.CGLContextObj,kCGLCPSurfaceBackingSize,backing);NSRect actual=[view convertRectToBacking:view.bounds];
  unsigned w=backing[0]>0?backing[0]:actual.size.width,h=backing[1]>0?backing[1]:actual.size.height;
  for(unsigned frame=0;frame<3;++frame){
   glBindFramebuffer(GL_FRAMEBUFFER,0);glDrawBuffer(GL_BACK);glReadBuffer(GL_BACK);glDisable(GL_SCISSOR_TEST);glColorMask(1,1,1,1);glDepthMask(GL_TRUE);glStencilMask(~0u);
   glClearColor(.1f,.2f,.3f,197.f/255);glClearDepth(.9);glClearStencil(31);glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT|GL_STENCIL_BUFFER_BIT);
   glEnable(GL_SCISSOR_TEST);
   for(unsigned y=0;y<2;++y)for(unsigned x=0;x<2;++x){glScissor(x?w/2:0,y?h/2:0,x?w-w/2:w/2,y?h-h/2:h/2);glClearDepth((1+x+2*y+frame)*.125);glClear(GL_DEPTH_BUFFER_BIT);}
   glDisable(GL_SCISSOR_TEST);std::vector<float> original(w*h),retained(w*h);std::vector<unsigned char> output(w*h*4),stencil(w*h);
   glReadPixels(0,0,w,h,GL_DEPTH_COMPONENT,GL_FLOAT,original.data());
   glViewport(3,4,117,89);glActiveTexture(GL_TEXTURE3);glColorMask(0,1,0,1);glDepthMask(GL_FALSE);glEnable(GL_DEPTH_TEST);glEnable(GL_SCISSOR_TEST);glScissor(8,8,16,16);
   if(flush(view.openGLContext.CGLContextObj)!=kCGLNoError)return 3;glFinish();
   GLint active=0,viewport[4]={};GLboolean mask[4]={},depthMask=1;glGetIntegerv(GL_ACTIVE_TEXTURE,&active);glGetIntegerv(GL_VIEWPORT,viewport);glGetBooleanv(GL_COLOR_WRITEMASK,mask);glGetBooleanv(GL_DEPTH_WRITEMASK,&depthMask);
   if(active!=GL_TEXTURE3||viewport[0]!=3||viewport[1]!=4||viewport[2]!=117||viewport[3]!=89||mask[0]||!mask[1]||mask[2]||!mask[3]||depthMask||!glIsEnabled(GL_DEPTH_TEST)||!glIsEnabled(GL_SCISSOR_TEST)){puts("Depth capture changed caller state");return 4;}
   glReadBuffer(GL_BACK);glReadPixels(0,0,w,h,GL_RGBA,GL_UNSIGNED_BYTE,output.data());glReadPixels(0,0,w,h,GL_DEPTH_COMPONENT,GL_FLOAT,retained.data());
   GLint pack=0;glGetIntegerv(GL_PACK_ALIGNMENT,&pack);glPixelStorei(GL_PACK_ALIGNMENT,1);glReadPixels(0,0,w,h,GL_STENCIL_INDEX,GL_UNSIGNED_BYTE,stencil.data());glPixelStorei(GL_PACK_ALIGNMENT,pack);
   for(unsigned i=0;i<w*h;++i){int expected=std::lround(original[i]*255);
    if(original[i]!=retained[i]||stencil[i]!=31||std::abs(int(output[i*4+3])-197)>1){printf("Depth, stencil or alpha changed at %u\n",i);return 5;}
    for(unsigned c=0;c<3;++c){if(std::abs(int(output[i*4+c])-expected)>1){printf("Depth pixel mismatch %s %ux%u frame%u x%u y%u expected%d actual%u GLerror=0x%x\n",legacy?"legacy":"core",w,h,frame,i%w,i/w,expected,output[i*4+c],glGetError());return 6;}++checks;}
   }
   if(glGetError()!=GL_NO_ERROR){puts("OpenGL depth error");return 7;}
   printf("%s depth %ux%u frame%u: exact depth/stencil, alpha, orientation, state pass\n",legacy?"legacy":"core",w,h,frame);
  }
 }
 [window orderOut:nil];[view.openGLContext clearDrawable];printf("PASS %u depth color checks\n",checks);return 0;
}}
