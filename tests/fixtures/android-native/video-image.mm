#define EGL_EGLEXT_PROTOTYPES 1
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>
#include "video-image.h"
#include "video-pixels.hpp"
#include "angle-metal.hpp"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <dlfcn.h>
#include <sys/mman.h>
#include <string>

static void *eglLibrary,*glesLibrary;
extern "C" void *klj_graphics_symbol(const char*name){void*p=dlsym(eglLibrary,name);return p?p:dlsym(glesLibrary,name);}
template<class T>T function(const char*name){auto p=klj_graphics_symbol(name);assert(p);return reinterpret_cast<T>(p);}
#define GL(name,...) function<decltype(&name)>(#name)(__VA_ARGS__)
static uint32_t fourcc(const char*s){return uint8_t(s[0])|(uint32_t(uint8_t(s[1]))<<8)|(uint32_t(uint8_t(s[2]))<<16)|(uint32_t(uint8_t(s[3]))<<24);}
static void fill(KljVideoBuffer&s,unsigned y,unsigned cb,unsigned cr,bool asymmetric=false){
 auto*base=(uint8_t*)(uintptr_t)s.address;bool p010=s.fourcc==fourcc("P010"),yv12=s.fourcc==fourcc("YV12"),nv21=s.fourcc==fourcc("NV21");
 for(unsigned p=0;p<s.plane_count;p++)for(size_t row=0;row<s.planes[p].height;row++)for(size_t x=0;x<s.planes[p].width;x++){
  auto*pixel=base+s.planes[p].offset+row*s.planes[p].stride+x*(p010?2:1)*(p&&!yv12?2:1);
  if(asymmetric){
   static const unsigned colours[4][3]={{81,90,240},{235,128,128},{41,240,110},{16,128,128}};
   const auto*colour=colours[(row>=s.planes[p].height/2?2:0)+(x>=s.planes[p].width/2?1:0)];
   y=colour[0];cb=colour[1];cr=colour[2];
  }
  if(p010){auto*out=(uint16_t*)pixel;out[0]=(p?cb:y)<<8;if(p)out[1]=cr<<8;}
  else {pixel[0]=!p?y:yv12?(p==1?cr:cb):nv21?cr:cb;if(p&&!yv12)pixel[1]=nv21?cb:cr;}
 }
}
int main(int argc,char**argv){@autoreleasepool{
 assert(argc==2);std::string root=argv[1];eglLibrary=dlopen((root+"/libEGL.dylib").c_str(),RTLD_NOW|RTLD_LOCAL);glesLibrary=dlopen((root+"/libGLESv2.dylib").c_str(),RTLD_NOW|RTLD_LOCAL);assert(eglLibrary&&glesLibrary);
 const EGLint platform[]={EGL_PLATFORM_ANGLE_TYPE_ANGLE,EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE,EGL_NONE};
 auto display=function<PFNEGLGETPLATFORMDISPLAYEXTPROC>("eglGetPlatformDisplayEXT")(EGL_PLATFORM_ANGLE_ANGLE,nullptr,platform);assert(display);
 assert(GL(eglInitialize,display,nullptr,nullptr));assert(GL(eglBindAPI,EGL_OPENGL_ES_API));
 const EGLint configAttributes[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};EGLConfig config;EGLint count=0;assert(GL(eglChooseConfig,display,configAttributes,&config,1,&count)&&count);
 const EGLint contextAttributes[]={EGL_CONTEXT_CLIENT_VERSION,3,EGL_NONE};auto context=GL(eglCreateContext,display,config,EGL_NO_CONTEXT,contextAttributes);assert(context);
 const EGLint pbufferAttributes[]={EGL_WIDTH,8,EGL_HEIGHT,4,EGL_NONE};auto surface=GL(eglCreatePbufferSurface,display,config,pbufferAttributes);assert(surface);assert(GL(eglMakeCurrent,display,surface,surface,context));
 auto device=klj_angle::device(display);
 auto shader=[](GLenum kind,const char*text){auto value=GL(glCreateShader,kind);GL(glShaderSource,value,1,&text,nullptr);GL(glCompileShader,value);GLint ok=0;GL(glGetShaderiv,value,GL_COMPILE_STATUS,&ok);assert(ok);return value;};
 auto vertex=shader(GL_VERTEX_SHADER,"#version 300 es\nout vec2 uv;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.0-1.0,0,1);}");
 auto fragment=shader(GL_FRAGMENT_SHADER,"#version 300 es\nprecision highp float;in vec2 uv;uniform sampler2D pixels;out vec4 color;void main(){color=texture(pixels,uv);}");
 auto program=GL(glCreateProgram);GL(glAttachShader,program,vertex);GL(glAttachShader,program,fragment);GL(glLinkProgram,program);GLint linked=0;GL(glGetProgramiv,program,GL_LINK_STATUS,&linked);assert(linked);GL(glUseProgram,program);GL(glUniform1i,GL(glGetUniformLocation,program,"pixels"),0);
 for(const char*format:{"NV12","NV21","YV12","P010"}){
  auto*memory=mmap(nullptr,16384,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);assert(memory!=MAP_FAILED);std::memset(memory,0,16384);
  KljVideoBuffer source{};source.address=(uintptr_t)memory;source.length=16384;source.width=8;source.height=4;source.fourcc=fourcc(format);source.plane_count=source.fourcc==fourcc("YV12")?3:2;
  source.planes[0]={0,16,8,4};source.planes[1]={64,16,4,2};if(source.plane_count==3)source.planes[2]={96,16,4,2};
  void*image=nullptr;auto invalid=source;invalid.planes[1].offset=16380;assert(!klj_video_image_create(&invalid,(__bridge void*)device,display,klj_graphics_symbol,&image));
  auto owner=klj_video_image_create(&source,(__bridge void*)device,display,klj_graphics_symbol,&image);assert(owner&&image);
  GLuint texture;GL(glGenTextures,1,&texture);GL(glBindTexture,GL_TEXTURE_2D,texture);GL(glTexParameteri,GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);GL(glTexParameteri,GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);
  for(int frame=0;frame<3;frame++){
   fill(source,frame==0?81:frame==1?41:235,frame==0?90:frame==1?240:128,frame==0?240:frame==1?110:128);
   assert(klj_video_image_refresh(owner,0x102)==0);
   function<PFNGLEGLIMAGETARGETTEXTURE2DOESPROC>("glEGLImageTargetTexture2DOES")(GL_TEXTURE_2D,image);
   GL(glBindFramebuffer,GL_FRAMEBUFFER,0);GL(glViewport,0,0,8,4);GL(glDrawArrays,GL_TRIANGLES,0,3);
   uint8_t rgba[8*4*4]{};GL(glReadPixels,0,0,8,4,GL_RGBA,GL_UNSIGNED_BYTE,rgba);assert(GL(glGetError)==GL_NO_ERROR);
   std::printf("%s frame%d RGBA %u %u %u %u\n",format,frame,rgba[0],rgba[1],rgba[2],rgba[3]);
   for(size_t i=0;i<sizeof(rgba);i+=4){assert(rgba[i+3]>250);if(frame==0)assert(rgba[i]>220&&rgba[i+1]<45&&rgba[i+2]<45);else if(frame==1)assert(rgba[i]<45&&rgba[i+1]<45&&rgba[i+2]>220);else assert(rgba[i]>240&&rgba[i+1]>240&&rgba[i+2]>240);}
  }
  // Android native-buffer imports preserve the producer's row and column
  // order. Uniform frames cannot detect a conversion-induced reflection.
  fill(source,0,0,0,true);
  if(source.fourcc==fourcc("NV12")){
   void*planes[2]={(uint8_t*)memory+source.planes[0].offset,(uint8_t*)memory+source.planes[1].offset};
   size_t widths[2]={8,4},heights[2]={4,2},rows[2]={16,16};CVPixelBufferRef pixels=nullptr;
   assert(CVPixelBufferCreateWithPlanarBytes(nullptr,8,4,kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,nullptr,0,2,planes,widths,heights,rows,nullptr,nullptr,nullptr,&pixels)==kCVReturnSuccess);
   CVBufferSetAttachment(pixels,kCVImageBufferYCbCrMatrixKey,kCVImageBufferYCbCrMatrix_ITU_R_601_4,kCVAttachmentMode_ShouldPropagate);
   uint8_t bitmap[8*4*4]{};assert(klj_video_argb(pixels,bitmap,8*4));CVPixelBufferRelease(pixels);
   std::printf("ARGB byte rows: row0 BGR %u,%u,%u last BGR %u,%u,%u\n",bitmap[0],bitmap[1],bitmap[2],bitmap[3*8*4],bitmap[3*8*4+1],bitmap[3*8*4+2]);fflush(stdout);
   assert(bitmap[0]<45&&bitmap[1]<45&&bitmap[2]>220);
   assert(bitmap[3*8*4]>220&&bitmap[3*8*4+1]<45&&bitmap[3*8*4+2]<45);
  }
  assert(klj_video_image_refresh(owner,0x102)==0);
  function<PFNGLEGLIMAGETARGETTEXTURE2DOESPROC>("glEGLImageTargetTexture2DOES")(GL_TEXTURE_2D,image);
  GL(glBindFramebuffer,GL_FRAMEBUFFER,0);GL(glDrawArrays,GL_TRIANGLES,0,3);
  uint8_t corners[8*4*4]{};GL(glReadPixels,0,0,8,4,GL_RGBA,GL_UNSIGNED_BYTE,corners);assert(GL(glGetError)==GL_NO_ERROR);
  auto*rowZeroLeft=corners;auto*rowZeroRight=corners+7*4;auto*lastRowLeft=corners+3*8*4;auto*lastRowRight=lastRowLeft+7*4;
  std::printf("%s corners: row0left %u,%u,%u row0right %u,%u,%u lastleft %u,%u,%u lastright %u,%u,%u\n",format,rowZeroLeft[0],rowZeroLeft[1],rowZeroLeft[2],rowZeroRight[0],rowZeroRight[1],rowZeroRight[2],lastRowLeft[0],lastRowLeft[1],lastRowLeft[2],lastRowRight[0],lastRowRight[1],lastRowRight[2]);fflush(stdout);
  assert(rowZeroLeft[0]>220&&rowZeroLeft[1]<45&&rowZeroLeft[2]<45);
  assert(rowZeroRight[0]>240&&rowZeroRight[1]>240&&rowZeroRight[2]>240);
  assert(lastRowLeft[0]<45&&lastRowLeft[1]<45&&lastRowLeft[2]>220);
  assert(lastRowRight[0]<20&&lastRowRight[1]<20&&lastRowRight[2]<20);
  assert(klj_video_image_refresh(owner,0x102)==0);assert(GL(eglDestroyImageKHR,display,image));klj_video_image_destroy(owner);assert(!munmap(memory,16384));GL(glDeleteTextures,1,&texture);
 }
 assert(GL(eglMakeCurrent,display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));assert(GL(eglDestroySurface,display,surface));assert(GL(eglDestroyContext,display,context));assert(GL(eglTerminate,display));std::puts("PASS original EGL planar video image formats, reuse, bounds and retirement");
}}
