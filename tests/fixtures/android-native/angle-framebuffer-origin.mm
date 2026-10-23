#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>
#include <cassert>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <dlfcn.h>
#include <string>
#include <sys/mman.h>
template<class T>T symbol(void *library,const char *name){auto value=reinterpret_cast<T>(dlsym(library,name));if(!value){std::fprintf(stderr,"Missing %s\n",name);std::abort();}return value;}
int main(int argc,char **argv){@autoreleasepool{
 assert(argc==2);auto egl=dlopen((std::string(argv[1])+"/libEGL.dylib").c_str(),RTLD_NOW|RTLD_LOCAL);auto gl=dlopen((std::string(argv[1])+"/libGLESv2.dylib").c_str(),RTLD_NOW|RTLD_LOCAL);assert(egl&&gl);
 auto platform=symbol<PFNEGLGETPLATFORMDISPLAYEXTPROC>(egl,"eglGetPlatformDisplayEXT");const EGLint displayAttrs[]={EGL_PLATFORM_ANGLE_TYPE_ANGLE,EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE,EGL_NONE};
 EGLDisplay display=platform(EGL_PLATFORM_ANGLE_ANGLE,nullptr,displayAttrs);int major=0,minor=0;assert(symbol<PFNEGLINITIALIZEPROC>(egl,"eglInitialize")(display,&major,&minor));
 const EGLint attrs[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT|EGL_OPENGL_ES3_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};EGLConfig config=nullptr;int count=0;assert(symbol<PFNEGLCHOOSECONFIGPROC>(egl,"eglChooseConfig")(display,attrs,&config,1,&count)&&count);
#define GL(name) auto name=symbol<decltype(&::name)>(gl,#name)
 GL(glGetString);GL(glGetError);GL(glClearColor);GL(glClear);GL(glEnable);GL(glDisable);GL(glScissor);GL(glGenTextures);GL(glBindTexture);GL(glGenFramebuffers);GL(glBindFramebuffer);GL(glFramebufferTexture2D);GL(glBlitFramebuffer);GL(glFinish);GL(glCheckFramebufferStatus);GL(glDeleteTextures);GL(glDeleteFramebuffers);
 auto parameter=symbol<PFNGLFRAMEBUFFERPARAMETERIMESAPROC>(gl,"glFramebufferParameteriMESA");auto imageTarget=symbol<PFNGLEGLIMAGETARGETTEXTURE2DOESPROC>(gl,"glEGLImageTargetTexture2DOES");
 auto blitAngle=symbol<PFNGLBLITFRAMEBUFFERANGLEPROC>(gl,"glBlitFramebufferANGLE");
 constexpr unsigned width=64,height=64,stride=256,length=16384;void *memory=mmap(nullptr,length,PROT_READ|PROT_WRITE,MAP_ANON|MAP_SHARED,-1,0);assert(memory!=MAP_FAILED);
 id<MTLDevice> device=MTLCreateSystemDefaultDevice();assert(device);id<MTLBuffer> buffer=[device newBufferWithBytesNoCopy:memory length:length options:MTLResourceStorageModeShared deallocator:nil];assert(buffer);
 MTLTextureDescriptor *textureDescriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:width height:height mipmapped:NO];textureDescriptor.usage=MTLTextureUsageRenderTarget|MTLTextureUsageShaderRead;textureDescriptor.storageMode=MTLStorageModeShared;
 id<MTLTexture> texture=[buffer newTextureWithDescriptor:textureDescriptor offset:0 bytesPerRow:stride];assert(texture);
 for(int version:{2,3}){
  const EGLint contextAttrs[]={EGL_CONTEXT_CLIENT_VERSION,version,EGL_NONE},surfaceAttrs[]={EGL_WIDTH,width,EGL_HEIGHT,height,EGL_NONE};
  auto context=symbol<PFNEGLCREATECONTEXTPROC>(egl,"eglCreateContext")(display,config,EGL_NO_CONTEXT,contextAttrs);auto surface=symbol<PFNEGLCREATEPBUFFERSURFACEPROC>(egl,"eglCreatePbufferSurface")(display,config,surfaceAttrs);auto makeCurrent=symbol<PFNEGLMAKECURRENTPROC>(egl,"eglMakeCurrent");assert(context&&surface&&makeCurrent(display,surface,surface,context));
  assert(std::strstr(reinterpret_cast<const char*>(glGetString(GL_EXTENSIONS)),"GL_MESA_framebuffer_flip_y"));
  // CPU Canvas-style top-row-first storage must retain its exact row order.
  auto *pixels=static_cast<uint32_t*>(memory);for(unsigned y=0;y<height;y++)for(unsigned x=0;x<width;x++)pixels[y*width+x]=y<height/2?0xff00ff00:0xffff0000;
  const EGLint imageAttrs[]={EGL_NONE};auto image=symbol<PFNEGLCREATEIMAGEKHRPROC>(egl,"eglCreateImageKHR")(display,EGL_NO_CONTEXT,EGL_METAL_TEXTURE_ANGLE,(__bridge EGLClientBuffer)texture,imageAttrs);assert(image);
  unsigned name=0,fbo=0;glGenTextures(1,&name);glBindTexture(GL_TEXTURE_2D,name);imageTarget(GL_TEXTURE_2D,image);glGenFramebuffers(1,&fbo);glBindFramebuffer(GL_FRAMEBUFFER,fbo);glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,name,0);assert(glCheckFramebufferStatus(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE);glFinish();assert(pixels[0]==0xff00ff00&&pixels[(height-1)*width]==0xffff0000);
  glBindFramebuffer(GL_FRAMEBUFFER,0);glClearColor(0,1,0,1);glClear(GL_COLOR_BUFFER_BIT);glEnable(GL_SCISSOR_TEST);glScissor(0,0,width,height/4);glClearColor(0,0,1,1);glClear(GL_COLOR_BUFFER_BIT);glDisable(GL_SCISSOR_TEST);
  for(int flip:{1,0,1}){
   glBindFramebuffer(GL_DRAW_FRAMEBUFFER,fbo);parameter(GL_DRAW_FRAMEBUFFER,GL_FRAMEBUFFER_FLIP_Y_MESA,flip);assert(glGetError()==GL_NO_ERROR);glBindFramebuffer(GL_READ_FRAMEBUFFER,0);
   if(version>=3)glBlitFramebuffer(0,0,width,height,0,0,width,height,GL_COLOR_BUFFER_BIT,GL_NEAREST);else blitAngle(0,0,width,height,0,0,width,height,GL_COLOR_BUFFER_BIT,GL_NEAREST);
   glFinish();assert(glGetError()==GL_NO_ERROR);assert(pixels[0]==(flip?0xff00ff00:0xffff0000));assert(pixels[(height-1)*width]==(flip?0xffff0000:0xff00ff00));
  }
  glBindFramebuffer(GL_FRAMEBUFFER,0);glDeleteFramebuffers(1,&fbo);glDeleteTextures(1,&name);symbol<PFNEGLDESTROYIMAGEKHRPROC>(egl,"eglDestroyImageKHR")(display,image);makeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);symbol<PFNEGLDESTROYSURFACEPROC>(egl,"eglDestroySurface")(display,surface);symbol<PFNEGLDESTROYCONTEXTPROC>(egl,"eglDestroyContext")(display,context);
  std::printf("PASS GLES%d explicit framebuffer origin, repeated state changes, native shared texture and unchanged CPU Canvas row order\n",version);
 }
 symbol<PFNEGLTERMINATEPROC>(egl,"eglTerminate")(display);texture=nil;buffer=nil;munmap(memory,length);std::puts("PASS Metal Android buffer orientation");
}}
