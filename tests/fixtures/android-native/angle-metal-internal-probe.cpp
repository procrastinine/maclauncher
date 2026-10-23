#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <dlfcn.h>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>

template<class T>T symbol(void* library,const char* name){
 auto value=reinterpret_cast<T>(dlsym(library,name));
 if(!value){std::fprintf(stderr,"Missing original entry %s: %s\n",name,dlerror());std::exit(1);}return value;
}
int main(int argc,char**argv){
 if(argc!=2)return 2;
 auto library=dlopen((std::string(argv[1])+"/libEGL.dylib").c_str(),RTLD_NOW|RTLD_LOCAL);
 auto gles=dlopen((std::string(argv[1])+"/libGLESv2.dylib").c_str(),RTLD_NOW|RTLD_LOCAL);
 if(!library||!gles){std::fprintf(stderr,"%s\n",dlerror());return 1;}
 auto getProc=symbol<PFNEGLGETPROCADDRESSPROC>(library,"eglGetProcAddress");
 auto platform=reinterpret_cast<PFNEGLGETPLATFORMDISPLAYEXTPROC>(getProc("eglGetPlatformDisplayEXT"));
 auto initialize=symbol<PFNEGLINITIALIZEPROC>(library,"eglInitialize");
 const EGLint attributes[]={EGL_PLATFORM_ANGLE_TYPE_ANGLE,EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE,EGL_NONE};
 EGLDisplay display=platform(EGL_PLATFORM_ANGLE_ANGLE,nullptr,attributes);EGLint major=0,minor=0;
 const auto began=std::chrono::steady_clock::now();
 if(!initialize(display,&major,&minor)){std::fprintf(stderr,"Original Metal EGL initialization failed\n");return 1;}
 const double elapsed=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-began).count();
 auto choose=symbol<PFNEGLCHOOSECONFIGPROC>(library,"eglChooseConfig");
 const EGLint requested[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
 EGLConfig config{};EGLint count=0;if(!choose(display,requested,&config,1,&count)||count!=1)return 1;
 const EGLint extent[]={EGL_WIDTH,16,EGL_HEIGHT,16,EGL_NONE},version[]={EGL_CONTEXT_CLIENT_VERSION,2,EGL_NONE};
 auto surface=symbol<PFNEGLCREATEPBUFFERSURFACEPROC>(library,"eglCreatePbufferSurface")(display,config,extent);
 auto context=symbol<PFNEGLCREATECONTEXTPROC>(library,"eglCreateContext")(display,config,EGL_NO_CONTEXT,version);
 auto current=symbol<PFNEGLMAKECURRENTPROC>(library,"eglMakeCurrent");
 if(surface==EGL_NO_SURFACE||context==EGL_NO_CONTEXT||!current(display,surface,surface,context))return 1;
 symbol<decltype(&glClearColor)>(gles,"glClearColor")(0.25f,0.5f,0.75f,1.f);
 symbol<decltype(&glClear)>(gles,"glClear")(GL_COLOR_BUFFER_BIT);
 unsigned char pixel[4]{};symbol<decltype(&glReadPixels)>(gles,"glReadPixels")(0,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel);
 const bool correct=std::abs(int(pixel[0])-64)<=1&&std::abs(int(pixel[1])-128)<=1&&std::abs(int(pixel[2])-191)<=1&&pixel[3]==255;
 std::printf("{\"eglInitializeMs\":%.3f,\"pixel\":[%u,%u,%u,%u],\"pixelCorrect\":%s}\n",elapsed,pixel[0],pixel[1],pixel[2],pixel[3],correct?"true":"false");
 current(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);
 symbol<PFNEGLDESTROYCONTEXTPROC>(library,"eglDestroyContext")(display,context);
 symbol<PFNEGLDESTROYSURFACEPROC>(library,"eglDestroySurface")(display,surface);
 symbol<PFNEGLTERMINATEPROC>(library,"eglTerminate")(display);
 dlclose(library);dlclose(gles);return correct?0:1;
}
