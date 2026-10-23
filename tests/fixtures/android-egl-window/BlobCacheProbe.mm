#include "native-egl-cache.hpp"
#include <GLES3/gl3.h>
#include <cassert>
#include <cstdio>
#include <filesystem>
static void *library;static EGLSetBlobFuncANDROID setter;static EGLGetBlobFuncANDROID getter;static unsigned stores=0,hits=0;
static void EGLAPIENTRY set(const void*k,EGLsizeiANDROID ks,const void*v,EGLsizeiANDROID vs){++stores;setter(k,ks,v,vs);}
static EGLsizeiANDROID EGLAPIENTRY get(const void*k,EGLsizeiANDROID ks,void*v,EGLsizeiANDROID vs){auto n=getter(k,ks,v,vs);if(n&&v&&vs>=n)++hits;return n;}
static void install(EGLDisplay d,EGLSetBlobFuncANDROID s,EGLGetBlobFuncANDROID g){setter=s;getter=g;auto call=(PFNEGLSETBLOBCACHEFUNCSANDROIDPROC)dlsym(library,"eglSetBlobCacheFuncsANDROID");assert(call);call(d,set,get);}
static void *symbol(const char*n){return !strcmp(n,"eglSetBlobCacheFuncsANDROID")?(void*)install:dlsym(library,n);}
#ifdef ART_CACHE_ADAPTER
extern "C" void kl_android_egl_cache_install(uintptr_t,void *(*)(const char*));
#endif
#define EGL(name) auto name=(decltype(&::name))dlsym(library,#name);assert(name)
#define GL(name) auto name=(decltype(&::name))dlsym(gles,#name);assert(name)
int main(int argc,char**argv){assert(argc==4);library=dlopen((std::string(argv[1])+"/libEGL.dylib").c_str(),RTLD_NOW|RTLD_LOCAL);assert(library);auto gles=dlopen((std::string(argv[1])+"/libGLESv2.dylib").c_str(),RTLD_NOW|RTLD_LOCAL);assert(gles);
 EGL(eglInitialize);EGL(eglChooseConfig);EGL(eglCreateContext);EGL(eglCreatePbufferSurface);EGL(eglMakeCurrent);EGL(eglDestroyContext);EGL(eglDestroySurface);EGL(eglTerminate);EGL(eglGetError);
 auto platform=(PFNEGLGETPLATFORMDISPLAYEXTPROC)dlsym(library,"eglGetPlatformDisplayEXT");assert(platform);EGLint displayAttributes[]={EGL_PLATFORM_ANGLE_TYPE_ANGLE,EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE,EGL_NONE};auto display=platform(EGL_PLATFORM_ANGLE_ANGLE,nullptr,displayAttributes);assert(display);assert(eglInitialize(display,nullptr,nullptr));
#ifdef ART_CACHE_ADAPTER
 setenv("MACLAUNCHER_ANDROID_EGL_CACHE",argv[2],1);kl_android_egl_cache_install((uintptr_t)display,symbol);
#else
 klj_egl_cache::configure(argv[2],(void*)eglInitialize);assert(klj_egl_cache::install(display,symbol));
#endif
 assert(eglGetError()==EGL_SUCCESS);
 const char arbitrary[]="binary\0key";char small[4]={'x','x','x','x'};if(strcmp(argv[3],"warm"))assert(!getter(arbitrary,sizeof arbitrary,small,sizeof small));setter(arbitrary,sizeof arbitrary,"hello",5);assert(getter(arbitrary,sizeof arbitrary,nullptr,0)==5);assert(getter(arbitrary,sizeof arbitrary,small,sizeof small)==5&&small[0]=='x');klj_egl_cache::owner->drain();stores=hits=0;
 EGLint attributes[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_NONE};EGLConfig config;EGLint count=0;assert(eglChooseConfig(display,attributes,&config,1,&count)&&count);EGLint contextAttributes[]={EGL_CONTEXT_CLIENT_VERSION,3,EGL_NONE};auto context=eglCreateContext(display,config,EGL_NO_CONTEXT,contextAttributes);assert(context);EGLint size[]={EGL_WIDTH,2,EGL_HEIGHT,2,EGL_NONE};auto surface=eglCreatePbufferSurface(display,config,size);assert(surface);assert(eglMakeCurrent(display,surface,surface,context));
 GL(glCreateShader);GL(glShaderSource);GL(glCompileShader);GL(glCreateProgram);GL(glAttachShader);GL(glLinkProgram);GL(glGetProgramiv);GL(glUseProgram);GL(glDeleteProgram);GL(glDeleteShader);GL(glGetProgramBinary);GL(glFinish);
 const char *vertex="#version 300 es\nvoid main(){gl_Position=vec4(float(gl_VertexID)*0.25,0.,0.,1.);}";const char *fragment="#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(0.25,0.5,0.75,1.);}";
 auto vs=glCreateShader(GL_VERTEX_SHADER),fs=glCreateShader(GL_FRAGMENT_SHADER);glShaderSource(vs,1,&vertex,nullptr);glShaderSource(fs,1,&fragment,nullptr);glCompileShader(vs);glCompileShader(fs);auto program=glCreateProgram();glAttachShader(program,vs);glAttachShader(program,fs);glLinkProgram(program);GLint okay=0;glGetProgramiv(program,GL_LINK_STATUS,&okay);assert(okay);glUseProgram(program);glFinish();GLint length=0;glGetProgramiv(program,GL_PROGRAM_BINARY_LENGTH,&length);assert(length>0);std::vector<unsigned char> binary(length);GLenum format;glGetProgramBinary(program,length,nullptr,&format,binary.data());glUseProgram(0);glDeleteProgram(program);glDeleteShader(vs);glDeleteShader(fs);klj_egl_cache::owner->drain();
 bool warm=!strcmp(argv[3],"warm");fprintf(stderr,"stores=%u hits=%u binary=%d\n",stores,hits,length);assert(warm?hits>0:stores>0);eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);eglDestroySurface(display,surface);eglDestroyContext(display,context);eglTerminate(display);puts(warm?"PASS warm actual ANGLE blob callbacks":"PASS cold actual ANGLE blob callbacks");
}
