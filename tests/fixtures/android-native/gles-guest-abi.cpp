#define GL_GLES_PROTOTYPES 1
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl32.h>
#include <dlfcn.h>
#include <cassert>
#include <cstdio>
#include <string>
#include "../../../src/modules/android/native/gles-guest-abi.hpp"
extern "C" void *klj_gles_guest_abi(const char*,void*);
extern "C" void guest_blit(void*);
extern "C" void guest_upload3d(void*,const void*);
extern "C" uint64_t guest_mixed(void*,const void*);
static uint64_t mixed(unsigned a,unsigned b,unsigned c,unsigned d,unsigned e,unsigned f,unsigned g,unsigned h,float x,double y,uint8_t small,int16_t negative,const void *pointer,uint64_t large){
 assert(a==1&&b==2&&c==3&&d==4&&e==5&&f==6&&g==7&&h==8&&x==1.5f&&y==2.5&&small==251&&negative==-1234&&pointer==(void*)0x123456789&&large==0x56781234abcdef90);
 return UINT64_C(0xfedcba9876543210);
}
static constexpr char mixedName[]="mixed";
static void floatStack(float,float,float,float,float,float,float,float,float){}
static constexpr char floatName[]="single-float-stack";
static void *gles,*egl;
template<class F>F api(const char *name){void *p=dlsym(gles,name);if(!p)p=dlsym(egl,name);assert(p);return reinterpret_cast<F>(p);}
#define GL(name) api<decltype(&name)>(#name)
static void pixel(unsigned char r,unsigned char g,unsigned char b,unsigned char a){unsigned char p[4]={};GL(glReadPixels)(0,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,p);assert(p[0]==r&&p[1]==g&&p[2]==b&&p[3]==a);}
int main(int argc,char **argv){
 assert(argc==2);std::string root=argv[1];
 gles=dlopen((root+"/libGLESv2.dylib").c_str(),RTLD_NOW|RTLD_LOCAL);egl=dlopen((root+"/libEGL.dylib").c_str(),RTLD_NOW|RTLD_LOCAL);assert(gles&&egl);
 EGLint displayAttrs[]={EGL_PLATFORM_ANGLE_TYPE_ANGLE,EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE,EGL_NONE};
 auto display=api<PFNEGLGETPLATFORMDISPLAYEXTPROC>("eglGetPlatformDisplayEXT")(EGL_PLATFORM_ANGLE_ANGLE,nullptr,displayAttrs);assert(display);assert(GL(eglInitialize)(display,nullptr,nullptr));
 EGLint choose[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};EGLConfig config;EGLint count=0;assert(GL(eglChooseConfig)(display,choose,&config,1,&count)&&count);
 EGLint contextAttrs[]={EGL_CONTEXT_CLIENT_VERSION,3,EGL_NONE},surfaceAttrs[]={EGL_WIDTH,2,EGL_HEIGHT,2,EGL_NONE};
 auto context=GL(eglCreateContext)(display,config,EGL_NO_CONTEXT,contextAttrs);auto surface=GL(eglCreatePbufferSurface)(display,config,surfaceAttrs);assert(context&&surface);assert(GL(eglMakeCurrent)(display,surface,surface,context));
 GLuint textures[2],fbos[2];GL(glGenTextures)(2,textures);GL(glGenFramebuffers)(2,fbos);
 for(int n=0;n<2;++n){GL(glBindTexture)(GL_TEXTURE_2D,textures[n]);GL(glTexStorage2D)(GL_TEXTURE_2D,1,GL_RGBA8,2,2);GL(glBindFramebuffer)(GL_FRAMEBUFFER,fbos[n]);GL(glFramebufferTexture2D)(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,textures[n],0);assert(GL(glCheckFramebufferStatus)(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE);GL(glClearColor)(n?0:1,n?0:.25f,n?0:.5f,1);GL(glClear)(GL_COLOR_BUFFER_BIT);}
 GL(glBindFramebuffer)(GL_READ_FRAMEBUFFER,fbos[0]);GL(glBindFramebuffer)(GL_DRAW_FRAMEBUFFER,fbos[1]);assert(GL(glGetError)()==GL_NO_ERROR);
 void *raw=(void*)GL(glBlitFramebuffer);guest_blit(raw);assert(GL(glGetError)()==GL_INVALID_ENUM);
 auto adapted=klj_gles_guest_abi("glBlitFramebuffer",raw);assert(adapted&&adapted!=raw);guest_blit(adapted);assert(GL(glGetError)()==GL_NO_ERROR);GL(glBindFramebuffer)(GL_READ_FRAMEBUFFER,fbos[1]);pixel(255,64,128,255);
 std::puts("PASS original AAPCS64 blit rejects on raw Darwin entry; adapted framebuffer copy preserves RGBA pixels");
 GLuint array;GL(glGenTextures)(1,&array);GL(glBindTexture)(GL_TEXTURE_2D_ARRAY,array);GL(glTexStorage3D)(GL_TEXTURE_2D_ARRAY,1,GL_RGBA8,2,2,1);const unsigned char pixels[]={32,64,128,255,32,64,128,255,32,64,128,255,32,64,128,255};
 raw=(void*)GL(glTexSubImage3D);guest_upload3d(raw,pixels);assert(GL(glGetError)()==GL_INVALID_ENUM);
 adapted=klj_gles_guest_abi("glTexSubImage3D",raw);assert(adapted&&adapted!=raw);guest_upload3d(adapted,pixels);assert(GL(glGetError)()==GL_NO_ERROR);
 GL(glBindFramebuffer)(GL_FRAMEBUFFER,fbos[1]);GL(glFramebufferTextureLayer)(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,array,0,0);assert(GL(glCheckFramebufferStatus)(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE);pixel(32,64,128,255);assert(GL(glGetError)()==GL_NO_ERROR);
 std::puts("PASS original AAPCS64 array upload rejects on raw Darwin entry; adapted upload preserves format, type and source pointer");
 raw=(void*)GL(glTexImage2D);assert(klj_gles_guest_abi("glTexImage2D",raw)==raw);raw=(void*)GL(glDrawArrays);assert(klj_gles_guest_abi("glDrawArrays",raw)==raw);assert(!klj_gles_guest_abi("glBlitFramebuffer",nullptr));
 GL(glBindFramebuffer)(GL_READ_FRAMEBUFFER,fbos[0]);GL(glBindFramebuffer)(GL_DRAW_FRAMEBUFFER,0);GL(glBlitFramebuffer)(0,0,2,2,0,0,2,2,GL_COLOR_BUFFER_BIT,GL_NEAREST);assert(GL(glGetError)()==GL_NO_ERROR);
 assert(guest_mixed(klj_gles_abi::Entry<decltype(&mixed),mixedName>::bind((void*)mixed),(void*)0x123456789)==UINT64_C(0xfedcba9876543210));
 assert((klj_gles_abi::Entry<decltype(&floatStack),floatName>::bind((void*)floatStack)==(void*)floatStack));
 std::puts("PASS mixed floating registers, signed short/byte stack values, pointer alignment, 64-bit argument and return");
 GL(glDeleteFramebuffers)(2,fbos);GL(glDeleteTextures)(2,textures);GL(glDeleteTextures)(1,&array);GL(eglMakeCurrent)(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);GL(eglDestroySurface)(display,surface);GL(eglDestroyContext)(display,context);GL(eglTerminate)(display);
 std::puts("PASS matching signatures retain direct provider pointers and Darwin callers retain original entry points");
}
