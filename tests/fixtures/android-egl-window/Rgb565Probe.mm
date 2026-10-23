#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <dlfcn.h>
#include <cassert>
#include <cstdio>
#include <string>
#include <vector>
#include <array>
#include <set>

void *eglLibrary,*glLibrary;PFNEGLGETPROCADDRESSPROC proc;
template<class T>T function(const char*name){void *address=dlsym(eglLibrary,name);if(!address)address=dlsym(glLibrary,name);if(!address)address=(void*)proc(name);assert(address);return reinterpret_cast<T>(address);}
#define CALL(name) function<decltype(&name)>(#name)
static GLuint shader(GLenum type,const char*source){auto result=CALL(glCreateShader)(type);CALL(glShaderSource)(result,1,&source,nullptr);CALL(glCompileShader)(result);GLint success=0;CALL(glGetShaderiv)(result,GL_COMPILE_STATUS,&success);if(!success){char log[4096]={};CALL(glGetShaderInfoLog)(result,sizeof(log),nullptr,log);std::fprintf(stderr,"%s\n",log);}assert(success);return result;}
static void dithering(){
 assert(CALL(glIsEnabled)(GL_DITHER));
 for(int version:{100,300}){
  const char *vertex=version==100?"attribute vec2 position;void main(){gl_Position=vec4(position,0.0,1.0);}":"#version 300 es\nin vec2 position;void main(){gl_Position=vec4(position,0.0,1.0);}";
  const char *fragment=version==100?"precision mediump float;uniform vec4 sourceColor;void main(){gl_FragColor=sourceColor;}":"#version 300 es\nprecision mediump float;uniform vec4 sourceColor;out vec4 color;void main(){color=sourceColor;}";
  GLuint vs=shader(GL_VERTEX_SHADER,vertex),fs=shader(GL_FRAGMENT_SHADER,fragment),program=CALL(glCreateProgram)();CALL(glAttachShader)(program,vs);CALL(glAttachShader)(program,fs);CALL(glBindAttribLocation)(program,0,"position");CALL(glLinkProgram)(program);GLint linked=0;CALL(glGetProgramiv)(program,GL_LINK_STATUS,&linked);assert(linked);CALL(glUseProgram)(program);GLint sourceColor=CALL(glGetUniformLocation)(program,"sourceColor");assert(sourceColor>=0);CALL(glUniform4f)(sourceColor,.5,.5,.5,1);
  GLuint buffer=0;CALL(glGenBuffers)(1,&buffer);CALL(glBindBuffer)(GL_ARRAY_BUFFER,buffer);const GLfloat positions[]={-1,-1,3,-1,-1,3};CALL(glBufferData)(GL_ARRAY_BUFFER,sizeof(positions),positions,GL_STATIC_DRAW);CALL(glVertexAttribPointer)(0,2,GL_FLOAT,GL_FALSE,0,nullptr);CALL(glEnableVertexAttribArray)(0);CALL(glViewport)(0,0,8,4);
  auto draw=[&](bool enabled){if(enabled)CALL(glEnable)(GL_DITHER);else CALL(glDisable)(GL_DITHER);CALL(glClearColor)(0,0,0,0);CALL(glClear)(GL_COLOR_BUFFER_BIT);CALL(glDrawArrays)(GL_TRIANGLES,0,3);std::array<uint32_t,32> pixels{};CALL(glReadPixels)(0,0,8,4,GL_RGBA,GL_UNSIGNED_BYTE,pixels.data());assert(CALL(glGetError)()==GL_NO_ERROR);return pixels;};
  auto off=draw(false),on=draw(true);std::set<uint32_t> offValues(off.begin(),off.end()),onValues(on.begin(),on.end());std::fprintf(stderr,"GLSL%d 565 dither off=%zu on=%zu\n",version,offValues.size(),onValues.size());assert(offValues.size()==1);assert(onValues.size()>1);assert(draw(false)==off);
  // Changing attachments must update the control without changing the shader.
  GLuint framebuffer=0,texture=0;CALL(glGenFramebuffers)(1,&framebuffer);CALL(glBindFramebuffer)(GL_FRAMEBUFFER,framebuffer);CALL(glGenTextures)(1,&texture);CALL(glBindTexture)(GL_TEXTURE_2D,texture);CALL(glTexImage2D)(GL_TEXTURE_2D,0,GL_RGBA8,8,4,0,GL_RGBA,GL_UNSIGNED_BYTE,nullptr);CALL(glFramebufferTexture2D)(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,texture,0);assert(CALL(glCheckFramebufferStatus)(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE);assert(draw(false)==draw(true));CALL(glBindFramebuffer)(GL_FRAMEBUFFER,0);assert(draw(true)==on);
  // Match native games which use the standard source-alpha blend on the imported
  // IOSurface. Pick a half-step after blending, rather than a quantized endpoint.
  CALL(glEnable)(GL_BLEND);CALL(glBlendFunc)(GL_SRC_ALPHA,GL_ONE_MINUS_SRC_ALPHA);
  for(float alpha:{.5f,.75f}){
   CALL(glUniform4f)(sourceColor,(8.5f/31.f)/alpha,(16.5f/63.f)/alpha,(8.5f/31.f)/alpha,alpha);
   auto blendOff=draw(false),blendOn=draw(true);std::set<uint32_t> plain(blendOff.begin(),blendOff.end()),dithered(blendOn.begin(),blendOn.end());
   std::fprintf(stderr,"GLSL%d 565 source-alpha=%g dither off=%zu on=%zu\n",version,alpha,plain.size(),dithered.size());assert(plain.size()==1);assert(dithered.size()>1);assert(draw(false)==blendOff);
   CALL(glBlendFunc)(GL_ONE,GL_ONE_MINUS_SRC_ALPHA);
   CALL(glUniform4f)(sourceColor,8.5f/31.f,16.5f/63.f,8.5f/31.f,alpha);
   assert(draw(true)==blendOn);
   CALL(glBlendFunc)(GL_SRC_ALPHA,GL_ONE_MINUS_SRC_ALPHA);
  }
  CALL(glBlendFunc)(GL_ONE,GL_ONE_MINUS_SRC_ALPHA);CALL(glUniform4f)(sourceColor,0,0,0,0);assert(draw(false)==draw(true));
  CALL(glUniform4f)(sourceColor,.5,.5,.5,1);auto premultiplied=draw(true);assert(premultiplied==on);
  CALL(glBindFramebuffer)(GL_FRAMEBUFFER,framebuffer);assert(draw(false)==draw(true));CALL(glBindFramebuffer)(GL_FRAMEBUFFER,0);assert(draw(true)==premultiplied);
  CALL(glDisable)(GL_BLEND);CALL(glEnable)(GL_DITHER);
  CALL(glDeleteFramebuffers)(1,&framebuffer);CALL(glDeleteTextures)(1,&texture);CALL(glDeleteBuffers)(1,&buffer);CALL(glDeleteShader)(vs);CALL(glDeleteShader)(fs);CALL(glDeleteProgram)(program);
 }
}
int main(int argc,char**argv){@autoreleasepool{
 assert(argc==2);std::string directory=argv[1];
 glLibrary=dlopen((directory+"/libGLESv2.dylib").c_str(),RTLD_NOW|RTLD_LOCAL);assert(glLibrary);
 eglLibrary=dlopen((directory+"/libEGL.dylib").c_str(),RTLD_NOW|RTLD_LOCAL);assert(eglLibrary);
 proc=(PFNEGLGETPROCADDRESSPROC)dlsym(eglLibrary,"eglGetProcAddress");assert(proc);
 EGLint displayAttributes[]={EGL_PLATFORM_ANGLE_TYPE_ANGLE,EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE,EGL_NONE};
 auto display=function<PFNEGLGETPLATFORMDISPLAYEXTPROC>("eglGetPlatformDisplayEXT")(EGL_PLATFORM_ANGLE_ANGLE,nullptr,displayAttributes);assert(display&&CALL(eglInitialize)(display,nullptr,nullptr));
 EGLint count=0;assert(CALL(eglGetConfigs)(display,nullptr,0,&count));std::vector<EGLConfig> configs(count);assert(CALL(eglGetConfigs)(display,configs.data(),count,&count));
 int checked=0;
 for(int samples:{0,4}){
  EGLConfig config=nullptr;
  for(auto candidate:configs){EGLint red=0,green=0,blue=0,alpha=0,sampleCount=0;CALL(eglGetConfigAttrib)(display,candidate,EGL_RED_SIZE,&red);CALL(eglGetConfigAttrib)(display,candidate,EGL_GREEN_SIZE,&green);CALL(eglGetConfigAttrib)(display,candidate,EGL_BLUE_SIZE,&blue);CALL(eglGetConfigAttrib)(display,candidate,EGL_ALPHA_SIZE,&alpha);CALL(eglGetConfigAttrib)(display,candidate,EGL_SAMPLES,&sampleCount);if(red==5&&green==6&&blue==5&&!alpha&&sampleCount==samples){config=candidate;break;}}
  assert(config);EGLint contextAttributes[]={EGL_CONTEXT_CLIENT_VERSION,3,EGL_NONE};auto context=CALL(eglCreateContext)(display,config,EGL_NO_CONTEXT,contextAttributes);assert(context);
  const size_t row=IOSurfaceAlignProperty(kIOSurfaceBytesPerRow,16);
  auto storage=IOSurfaceCreate((__bridge CFDictionaryRef)@{(__bridge NSString*)kIOSurfaceWidth:@8,(__bridge NSString*)kIOSurfaceHeight:@4,(__bridge NSString*)kIOSurfaceBytesPerElement:@2,(__bridge NSString*)kIOSurfaceBytesPerRow:@(row),(__bridge NSString*)kIOSurfacePixelFormat:@((uint32_t)'L565')});assert(storage);
  EGLint target=0;assert(CALL(eglGetConfigAttrib)(display,config,0x348D,&target));
  EGLint attributes[]={EGL_WIDTH,8,EGL_HEIGHT,4,EGL_IOSURFACE_PLANE_ANGLE,0,EGL_TEXTURE_TARGET,target,EGL_TEXTURE_FORMAT,EGL_TEXTURE_RGBA,EGL_TEXTURE_TYPE_ANGLE,GL_UNSIGNED_SHORT_5_6_5,EGL_TEXTURE_INTERNAL_FORMAT_ANGLE,GL_RGB,EGL_NONE};
  auto surface=CALL(eglCreatePbufferFromClientBuffer)(display,EGL_IOSURFACE_ANGLE,storage,config,attributes);if(!surface)std::fprintf(stderr,"565 surface error0x%x\n",CALL(eglGetError)());assert(surface);
  assert(CALL(eglMakeCurrent)(display,surface,surface,context));
  EGLint width=0;assert(CALL(eglQuerySurface)(display,surface,EGL_WIDTH,&width)&&width==8);
  for(auto bits:std::initializer_list<std::pair<GLenum,int>>{{0x0D52,5},{0x0D53,6},{0x0D54,5},{0x0D55,0}}){GLint value=-1;CALL(glGetIntegerv)(bits.first,&value);assert(value==bits.second);}
  CALL(glClearColor)(1,0,0,0);CALL(glClear)(GL_COLOR_BUFFER_BIT);unsigned char pixel[4]={};CALL(glReadPixels)(0,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel);assert(pixel[0]==255&&pixel[1]==0&&pixel[2]==0&&pixel[3]==255);
  CALL(glFinish)();assert(CALL(glGetError)()==GL_NO_ERROR);
  assert(IOSurfaceLock(storage,kIOSurfaceLockReadOnly,nullptr)==kIOReturnSuccess);assert(*static_cast<uint16_t*>(IOSurfaceGetBaseAddress(storage))==0xf800);IOSurfaceUnlock(storage,kIOSurfaceLockReadOnly,nullptr);
  dithering();
  assert(CALL(eglMakeCurrent)(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));assert(CALL(eglDestroySurface)(display,surface));assert(CALL(eglDestroyContext)(display,context));CFRelease(storage);checked++;
 }
 assert(CALL(eglTerminate)(display));std::printf("PASS actual ANGLE RGB565 default framebuffer, packed IOSurface, alpha and MSAA (%d configs)\n",checked);
}}
