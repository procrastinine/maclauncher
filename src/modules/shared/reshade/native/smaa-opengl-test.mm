#import <Cocoa/Cocoa.h>
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>
#include <cmath>
#include <cstdio>
#include <vector>
extern "C" CGLError rsFlushDrawable(CGLContextObj);
int main(int argc,char**){@autoreleasepool{
 const bool legacy=argc>1;[NSApplication sharedApplication];
 NSOpenGLPixelFormatAttribute attrs[]={NSOpenGLPFAAccelerated,NSOpenGLPFAOpenGLProfile,legacy?NSOpenGLProfileVersionLegacy:NSOpenGLProfileVersion4_1Core,NSOpenGLPFADoubleBuffer,NSOpenGLPFABackingStore,NSOpenGLPFAColorSize,32,NSOpenGLPFAAlphaSize,8,0};
 auto format=[[NSOpenGLPixelFormat alloc]initWithAttributes:attrs];if(!format)return 77;
 auto window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,128,96) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];window.title=@"Filtered";
 auto view=[[NSOpenGLView alloc]initWithFrame:window.contentView.bounds pixelFormat:format];window.contentView=view;[window orderFront:nil];[window display];
 for(auto size:{NSMakeSize(128,96),NSMakeSize(193,127)}){
  [window setContentSize:size];[view.openGLContext update];[view.openGLContext makeCurrentContext];CFRunLoopRunInMode(kCFRunLoopDefaultMode,.02,false);
  GLint dimensions[2]={};CGLGetParameter(view.openGLContext.CGLContextObj,kCGLCPSurfaceBackingSize,dimensions);const NSRect backing=[view convertRectToBacking:view.bounds];const unsigned w=dimensions[0]>0?dimensions[0]:backing.size.width,h=dimensions[1]>0?dimensions[1]:backing.size.height;
  for(unsigned frame=0;frame<3;++frame){
   glDisable(GL_SCISSOR_TEST);glColorMask(1,1,1,1);glDrawBuffer(GL_BACK);glClearColor(48.f/255,80.f/255,112.f/255,197.f/255);glClear(GL_COLOR_BUFFER_BIT);
   glEnable(GL_SCISSOR_TEST);glClearColor(230.f/255,225.f/255,210.f/255,197.f/255);
   for(unsigned y=0;y<h;++y){const int end=std::min(int(w),std::max(0,int(std::ceil((double(y)-15)/.37))));if(end){glScissor(0,y,end,1);glClear(GL_COLOR_BUFFER_BIT);}}
   glDisable(GL_SCISSOR_TEST);glReadBuffer(GL_BACK);std::vector<unsigned char> original(w*h*4),output(w*h*4);glReadPixels(0,0,w,h,GL_RGBA,GL_UNSIGNED_BYTE,original.data());
   glViewport(3,4,117,89);glActiveTexture(GL_TEXTURE3);glColorMask(0,1,0,1);glEnable(GL_SCISSOR_TEST);glScissor(8,8,16,16);
   if(rsFlushDrawable(view.openGLContext.CGLContextObj)!=kCGLNoError)return 2;glFinish();glReadBuffer(GL_BACK);glReadPixels(0,0,w,h,GL_RGBA,GL_UNSIGNED_BYTE,output.data());
   GLint active=0,viewport[4]={};GLboolean mask[4]={};glGetIntegerv(GL_ACTIVE_TEXTURE,&active);glGetIntegerv(GL_VIEWPORT,viewport);glGetBooleanv(GL_COLOR_WRITEMASK,mask);
   if(active!=GL_TEXTURE3||viewport[0]!=3||viewport[1]!=4||viewport[2]!=117||viewport[3]!=89||mask[0]||!mask[1]||mask[2]||!mask[3]||!glIsEnabled(GL_SCISSOR_TEST)){puts("SMAA changed caller state");return 3;}
   unsigned changed=0;for(unsigned y=0;y<h;++y)for(unsigned x=0;x<w;++x){size_t offset=(y*w+x)*4;if(std::abs(int(output[offset+3])-int(original[offset+3]))>1)return 4;
    for(unsigned c=0;c<3;++c)if(std::abs(int(output[offset+c])-int(original[offset+c]))>2){changed++;if(std::abs(double(y)-(x*.37+15))>5){printf("SMAA flat mismatch x=%u y=%u c=%u original=%u output=%u dimensions=%ux%u\n",x,y,c,original[offset+c],output[offset+c],w,h);return 5;}}}
   if(changed<20||changed>w*h/3||glGetError()!=GL_NO_ERROR){printf("Unexpected edge coverage %u\n",changed);return 6;}
   printf("OpenGL %s SMAA %ux%u frame%u changed%u; state, flat colors and alpha retained\n",legacy?"legacy":"core",w,h,frame,changed);
  }
 }
 return 0;
}}
