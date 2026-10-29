// Driver/presenter doubles isolate window ownership and ABI forwarding. Actual
// ANGLE/Metal rendering is covered by NativeGlesProbe and game integration.
#include "native-egl.mm"
#include <cassert>
#include <iostream>
namespace probe {
int width=64,height=32;IOSurfaceRef next=nullptr,activeStorage=nullptr;void *tracked=nullptr;
void *draw=nullptr,*read=nullptr,*context=nullptr,*display=(void*)1;
uintptr_t rawId=100;int submitted=0,replaced=0,destroyed=0,driverDamage=0,driverRegions=0;
JNIEnv env;JavaVM jvm;JNINativeInterface_ calls{};JNIInvokeInterface_ invokes{};
IOSurfaceRef storage(int w,int h){int32_t width=w,height=h,bpe=4;auto values=CFDictionaryCreateMutable(nullptr,0,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);for(auto item:std::initializer_list<std::pair<CFStringRef,int32_t>>{{kIOSurfaceWidth,width},{kIOSurfaceHeight,height},{kIOSurfaceBytesPerElement,bpe},{kIOSurfaceBytesPerRow,width*4},{kIOSurfacePixelFormat,int32_t('RGBA')}}){auto number=CFNumberCreate(nullptr,kCFNumberSInt32Type,&item.second);CFDictionarySetValue(values,item.first,number);CFRelease(number);}auto result=IOSurfaceCreate(values);CFRelease(values);assert(result);return result;}
unsigned bind(void*,void*d,void*r,void*c){draw=d;read=r;context=c;return 1;}
void *current(int kind){return kind==EGL_DRAW?draw:read;}
void *currentDisplay(){return display;}void *currentContext(){return context;}
unsigned destroy(void*,void*){destroyed++;return 1;}
unsigned query(void*,void*s,int,int*value){assert(s==(void*)rawId);*value=73;return 1;}
unsigned configAttribute(void*,void*,int name,int*value){*value=name==EGL_NATIVE_VISUAL_ID?1:0;return 1;}
unsigned damage(void*,void*s,int*r,int n){assert(s==(void*)77&&r&&n==1);driverDamage++;return 1;}
unsigned region(void*,void*s,int n,const int*r){assert(s==(void*)77&&r&&n==1);driverRegions++;return 1;}
unsigned plain(void*,void*){return 1;}
unsigned release(){draw=read=context=nullptr;return 1;}
void blit(int,int,int,int,int,int,int,int,unsigned,unsigned){}
void *symbol(const char*n){
 if(!strcmp(n,"glBlitFramebuffer"))return (void*)blit;
 if(!strcmp(n,"eglMakeCurrent"))return (void*)bind;
 if(!strcmp(n,"eglGetCurrentSurface"))return (void*)current;
 if(!strcmp(n,"eglGetCurrentDisplay"))return (void*)currentDisplay;
 if(!strcmp(n,"eglGetCurrentContext"))return (void*)currentContext;
 if(!strcmp(n,"eglDestroySurface"))return (void*)destroy;
 if(!strcmp(n,"eglSwapBuffers"))return (void*)plain;
 if(!strcmp(n,"eglQuerySurface"))return (void*)query;
 if(!strcmp(n,"eglGetConfigAttrib"))return (void*)configAttribute;
 if(!strcmp(n,"eglSwapBuffersWithDamageKHR")||!strcmp(n,"eglSwapBuffersWithDamageEXT"))return (void*)damage;
 if(!strcmp(n,"eglSwapBuffersRegionNOK")||!strcmp(n,"eglSwapBuffersRegion2NOK"))return (void*)region;
 if(!strcmp(n,"eglReleaseThread"))return (void*)release;
 return nullptr;
}
void enter(void*){}void supply(void*){}
void *surface(void*,void*,int w,int h,bool,const int*,KLMetalError*){assert(w==width&&h==height);return (void*)++rawId;}
int initialized(void*,KLMetalError*){return 1;}
int present(void*,int,KLMetalError*){submitted++;return 1;}
int resize(int w,int h,KLMetalError*){assert(w==width&&h==height);replaced++;return 1;}
int finish(void*,KLMetalError*){return 1;}int detach(KLMetalError*){return 1;}
}
extern "C" void *klj_surface_begin_egl(void*,void**p,int*w,int*h,int){*p=(void*)2;*w=probe::width;*h=probe::height;probe::activeStorage=(IOSurfaceRef)CFRetain(probe::next);return (void*)CFRetain(probe::next);}
extern "C" void klj_surface_record_egl(void*,void*s){probe::tracked=s;}
extern "C" void *klj_surface_find_egl(void*s,void**p){if(s!=probe::tracked)return nullptr;*p=(void*)2;return (void*)3;}
extern "C" void klj_surface_end_egl(void*){probe::tracked=nullptr;CFRelease(probe::activeStorage);probe::activeStorage=nullptr;}
extern "C" void *klj_surface_next_egl(void*,int*w,int*h){*w=probe::width;*h=probe::height;return probe::next==probe::activeStorage?nullptr:(void*)CFRetain(probe::next);}
extern "C" void klj_surface_commit_egl(void*,void*s){CFRelease(probe::activeStorage);probe::activeStorage=(IOSurfaceRef)CFRetain(s);}
extern "C" void klj_surface_rotate_egl(void*,void*s){CFRelease(probe::activeStorage);probe::activeStorage=(IOSurfaceRef)CFRetain(s);}
extern "C" void klj_surface_account_egl_buffer(void*,bool){}
extern "C" int klj_surface_acquire_native_layer(void*,void**,void**){assert(false&&"Metal IOSurface probe cannot acquire a Vulkan carrier");return 0;}
extern "C" void klj_surface_release_native_layer(void*){assert(false&&"Metal IOSurface probe cannot release a Vulkan carrier");}
extern "C" bool klj_surface_is_texture(void*){return false;}
extern "C" jobject klj_surface_composition(JNIEnv*,void*){return nullptr;}
extern "C" void *klj_surface_copy_storage(void*){return nullptr;}
extern "C" void *klj_composition_create(JNIEnv*,jobject){assert(false);return nullptr;}
extern "C" void klj_composition_release(void*){assert(false);}
extern "C" int klj_composition_present(JNIEnv*,void*,void*,void*,uint64_t){assert(false);return 0;}
extern "C" unsigned klj_texture_publish(JNIEnv*,void*,void*){return 0;}
extern "C" void klj_glfb_current(void*,void*){}
extern "C" void klj_glfb_context_created(void*,void*,void*){}
extern "C" void klj_glfb_context_destroyed(void*){}
extern "C" int klj_glfb_configure(void*(*)(const char*)){return 1;}
extern "C" void klj_xr_provider_install(){}
int main(){
 probe::calls.ExceptionOccurred=[](JNIEnv*)->jthrowable{return nullptr;};probe::calls.ExceptionCheck=[](JNIEnv*)->jboolean{return false;};probe::env.functions=&probe::calls;
 probe::invokes.GetEnv=[](JavaVM*,void**out,jint)->jint{*out=&probe::env;return JNI_OK;};probe::jvm.functions=&probe::invokes;
 vm=&probe::jvm;symbol=probe::symbol;enter=probe::enter;supply=probe::supply;makeSurface=probe::surface;current=probe::initialized;present=probe::present;finish=probe::finish;detach=probe::detach;resizePresenter=probe::resize;
 const char *configuredAbi=getenv("MACLAUNCHER_ANDROID_NATIVE_ABI");std::string previousAbi=configuredAbi?configuredAbi:"";
 setenv("MACLAUNCHER_ANDROID_NATIVE_ABI","arm64-v8a",1);
 auto raw=klj_native_egl_lookup("glBlitFramebuffer"),guest=klj_native_egl_guest_lookup("glBlitFramebuffer");assert(raw==(void*)probe::blit&&guest&&guest!=raw);
 auto guestProc=(void*(*)(const char*))klj_native_egl_guest_lookup("eglGetProcAddress");assert(guestProc("glBlitFramebuffer")==guest);assert(getProc("glBlitFramebuffer")==raw);
 platformHandle=[](const void *value)->int{return value==(void*)123;};assert(findPlatformSymbol((void*)123,"glBlitFramebuffer")==guest);
 setenv("MACLAUNCHER_ANDROID_NATIVE_ABI","armeabi-v7a",1);assert(klj_native_egl_guest_lookup("glBlitFramebuffer")==raw);assert(klj_native_egl_guest_lookup("eglGetProcAddress")==klj_native_egl_lookup("eglGetProcAddress"));
 if(configuredAbi)setenv("MACLAUNCHER_ANDROID_NATIVE_ABI",previousAbi.c_str(),1);else unsetenv("MACLAUNCHER_ANDROID_NATIVE_ABI");
 probe::next=probe::storage(64,32);auto window=create(probe::display,(void*)4,(void*)3,nullptr);assert(window&&window==probe::tracked);assert(window!=surfaceRaw(window));
 assert(makeCurrent(probe::display,window,window,(void*)5));assert(currentSurface(EGL_DRAW)==window);
 int rects[]={0,0,20,20};auto damage=(unsigned(*)(void*,void*,int*,int))klj_native_egl_lookup("eglSwapBuffersWithDamageKHR");
 assert(damage(probe::display,window,rects,1));assert(probe::submitted==1&&probe::driverDamage==0);
 CFRelease(probe::next);probe::width=96;probe::height=48;probe::next=probe::storage(96,48);void*old=surfaceRaw(window);
 assert(damage(probe::display,window,rects,1));assert(probe::replaced==1&&probe::destroyed==1);assert(surfaceRaw(window)!=old&&probe::draw==surfaceRaw(window)&&probe::read==surfaceRaw(window));assert(currentSurface(EGL_DRAW)==window);
 auto query=(unsigned(*)(void*,void*,int,int*))klj_native_egl_lookup("eglQuerySurface");int value=0;assert(query(probe::display,window,EGL_WIDTH,&value)&&value==73);
 assert(damage(probe::display,(void*)77,rects,1)&&probe::driverDamage==1);
 auto region=(unsigned(*)(void*,void*,int,const int*))klj_native_egl_lookup("eglSwapBuffersRegionNOK");assert(region(probe::display,(void*)77,1,rects)&&probe::driverRegions==1);assert(region(probe::display,window,1,rects));
 assert(!swap((void*)99,window));assert(getError()==EGL_BAD_DISPLAY);
 FILE *diagnostic=tmpfile();assert(diagnostic);klj_native_egl_report(diagnostic);rewind(diagnostic);char lines[1024]={0};assert(fread(lines,1,sizeof(lines)-1,diagnostic)>0);fclose(diagnostic);
 assert(strstr(lines,"live-surfaces=1"));assert(strstr(lines,"binds=1 swaps=4 submitted=3 failed=1 resizes=1 last-error=0x3008"));
 assert(makeCurrent(probe::display,nullptr,nullptr,nullptr));assert(destroy(probe::display,window));assert(probe::tracked==nullptr&&surfaces.empty());CFRelease(probe::next);
 std::cout<<"PASS persistent EGL identity, damage/region presentation, generated surface forwarding and buffer replacement\n";return 0;
}
