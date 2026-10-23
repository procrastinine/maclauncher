#include ARM32_IMPORTS_SOURCE
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <array>
#include <cassert>
#include <cstdio>
#include <cstring>
using namespace maclauncher::arm32;
static EGLDisplay display;
static EGLSurface surface;
static EGLDisplay receivedDisplay;
static EGLSurface receivedSurface;
static EGLObjectKHR receivedObject;
static EGLLabelKHR receivedLabel;
static unsigned calls;
static EGLDisplay EGLAPIENTRY currentDisplay(){return display;}
static EGLSurface EGLAPIENTRY currentSurface(EGLint which){assert(which==EGL_DRAW);return surface;}
static EGLBoolean EGLAPIENTRY swap(EGLDisplay d,EGLSurface s){receivedDisplay=d;receivedSurface=s;++calls;return d==display&&s==surface?EGL_TRUE:EGL_FALSE;}
static EGLint EGLAPIENTRY label(EGLDisplay d,EGLenum,EGLObjectKHR object,EGLLabelKHR value){assert(d==display);receivedObject=object;receivedLabel=value;return EGL_SUCCESS;}
static void buffer(unsigned,ptrdiff_t,const void*,unsigned){assert(false&&"invalid storage reached native API");}
static void *lookup(const char *name){
 if(!std::strcmp(name,"eglGetCurrentDisplay"))return reinterpret_cast<void *>(currentDisplay);
 if(!std::strcmp(name,"eglGetCurrentSurface"))return reinterpret_cast<void *>(currentSurface);
 if(!std::strcmp(name,"eglSwapBuffers"))return reinterpret_cast<void *>(swap);
 if(!std::strcmp(name,"eglLabelObjectKHR"))return reinterpret_cast<void *>(label);
 if(!std::strcmp(name,"glBufferData"))return reinterpret_cast<void *>(buffer);
 return nullptr;
}
int main(){
 Memory memory;Thread thread(memory);Imports imports(memory,lookup);
 auto invoke=[&](const char *name,std::initializer_list<Value> args){return thread.call(imports.resolve(name),std::span(args.begin(),args.size()));};
 auto current=[&](){return std::array{Value::word(invoke("eglGetCurrentDisplay",{})),Value::word(invoke("eglGetCurrentSurface",{Value::word(EGL_DRAW)}))};};
 display=reinterpret_cast<EGLDisplay>(uintptr_t(0x64700000));surface=reinterpret_cast<EGLSurface>(uintptr_t(0x1234));
 auto args=current();assert(thread.call(imports.resolve("eglSwapBuffers"),args)==EGL_TRUE);
 assert(receivedDisplay==display&&receivedSurface==surface&&calls==1);
 // Opaque values may also be application-defined labels, not allocations.
 assert(invoke("eglLabelObjectKHR",{args[0],Value::word(EGL_OBJECT_SURFACE_KHR),args[1],Value::word(0x87654321)})==EGL_SUCCESS);
 assert(receivedObject==surface&&uintptr_t(receivedLabel)==0x87654321);
 // A wide native identity uses the existing alias owner, without readable
 // backing bytes. These deliberately inaccessible values must never be read.
 display=reinterpret_cast<EGLDisplay>(UINT64_C(0x100012345));surface=reinterpret_cast<EGLSurface>(UINT64_C(0x100023456));
 args=current();assert(args[0].bits!=uintptr_t(display)&&args[1].bits!=uintptr_t(surface));
 assert(thread.call(imports.resolve("eglSwapBuffers"),args)==EGL_TRUE);
 assert(receivedDisplay==display&&receivedSurface==surface&&calls==2);
 bool rejected=false;try{memory.translate(uint32_t(args[1].bits),1,Memory::Read);}catch(const Memory::Fault&){rejected=true;}assert(rejected);
 // Retirement must not resurrect the released native identity. Invalid EGL
 // values reach the original validator as values, never as freed resources.
 memory.retireNative(surface,1);
 assert(thread.call(imports.resolve("eglSwapBuffers"),args)==EGL_FALSE);
 assert(receivedSurface!=surface&&uintptr_t(receivedSurface)==args[1].bits);
 rejected=false;try{invoke("glBufferData",{Value::word(0x8892),Value::word(4),Value::word(0x1234),Value::word(0x88e4)});}catch(const Memory::Fault&){rejected=true;}assert(rejected);
 display=nullptr;surface=nullptr;args=current();assert(thread.call(imports.resolve("eglSwapBuffers"),args)==EGL_TRUE);
 std::puts("PASS original EGL opaque tokens, mapped identities, labels, retirement and ordinary buffer bounds");
}
