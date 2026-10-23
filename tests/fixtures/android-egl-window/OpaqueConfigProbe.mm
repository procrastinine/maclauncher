#define main ownershipProbeMain
#include "WindowSurfaceProbe.mm"
#undef main
#include "framebuffer-initialize.hpp"
#include <thread>
namespace driver {
void *egl,*gl;void *(*proc)(const char*);
void *resolve(const char*name){void*result=dlsym(egl,name);if(!result)result=dlsym(gl,name);return result?result:proc(name);}
void *surface(JNIEnv*,void*d,void*c,int w,int h,bool opaque,const int*extra){
 int target=0;assert(fn<unsigned(*)(void*,void*,int,int*)>("eglGetConfigAttrib")(d,c,0x348D,&target));
 std::vector<int> attributes={EGL_WIDTH,w,EGL_HEIGHT,h,EGL_IOSURFACE_PLANE_ANGLE,0,EGL_TEXTURE_TARGET,target,EGL_TEXTURE_FORMAT,EGL_TEXTURE_RGBA,EGL_TEXTURE_TYPE_ANGLE,0x1401,EGL_TEXTURE_INTERNAL_FORMAT_ANGLE,opaque?0x1907:0x1908};
 if(extra)for(size_t i=0;extra[i]!=EGL_NONE;i+=2){attributes.push_back(extra[i]);attributes.push_back(extra[i+1]);}attributes.push_back(EGL_NONE);
 return fn<void*(*)(void*,unsigned,void*,void*,const int*)>("eglCreatePbufferFromClientBuffer")(d,EGL_IOSURFACE_ANGLE,probe::activeStorage,c,attributes.data());
}
}
int main(int argc,char**argv){
 assert(argc==2);driver::egl=dlopen((std::string(argv[1])+"/libEGL.dylib").c_str(),RTLD_NOW|RTLD_LOCAL);assert(driver::egl);driver::gl=dlopen((std::string(argv[1])+"/libGLESv2.dylib").c_str(),RTLD_NOW|RTLD_LOCAL);assert(driver::gl);driver::proc=(decltype(driver::proc))dlsym(driver::egl,"eglGetProcAddress");assert(driver::proc);
 symbol=driver::resolve;
 probe::calls.ExceptionOccurred=[](JNIEnv*)->jthrowable{return nullptr;};probe::calls.ExceptionCheck=[](JNIEnv*)->jboolean{return false;};probe::env.functions=&probe::calls;
 probe::invokes.GetEnv=[](JavaVM*,void**out,jint)->jint{*out=&probe::env;return JNI_OK;};probe::jvm.functions=&probe::invokes;vm=&probe::jvm;
 enter=probe::enter;supply=probe::supply;makeSurface=driver::surface;current=probe::initialized;present=probe::present;finish=probe::finish;detach=probe::detach;resizePresenter=probe::resize;
 void*d=display(nullptr);assert(d&&initialize(d,nullptr,nullptr));
 int looseRgb[]={EGL_RED_SIZE,4,EGL_GREEN_SIZE,4,EGL_BLUE_SIZE,4,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_NONE};int looseCount=0;
 assert(choose(d,looseRgb,nullptr,0,&looseCount));std::vector<void*> loose(looseCount);assert(choose(d,looseRgb,loose.data(),looseCount,&looseCount));
 bool raw565=false,visible565=false;int rawCount=0;assert(fn<unsigned(*)(void*,void**,int,int*)>("eglGetConfigs")(d,nullptr,0,&rawCount));std::vector<void*> rawConfigs(rawCount);assert(fn<unsigned(*)(void*,void**,int,int*)>("eglGetConfigs")(d,rawConfigs.data(),rawCount,&rawCount));
 for(auto candidate:rawConfigs){int red=0;assert(attribute(d,candidate,EGL_RED_SIZE,&red));if(red==5)raw565=true;}
 for(auto candidate:loose){int red=0;assert(attribute(d,candidate,EGL_RED_SIZE,&red));if(red==5)visible565=true;}
 assert(raw565==visible565); // An omitted surface attribute retains EGL's window default.
 auto selected=[&](const int*attributes){int n=0;assert(choose(d,attributes,nullptr,0,&n));std::vector<void*> result(n);assert(choose(d,attributes,result.data(),n,&n));return result;};
 int empty[]={EGL_NONE};assert(selected(nullptr)==selected(empty));
 for(int surfaceType:{EGL_WINDOW_BIT,EGL_PBUFFER_BIT,EGL_DONT_CARE}){
  int request[]={EGL_RED_SIZE,4,EGL_GREEN_SIZE,4,EGL_BLUE_SIZE,4,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_SURFACE_TYPE,surfaceType,EGL_NONE};
  auto result=selected(request);bool found565=false;
  for(auto candidate:result){int red=0,type=0;assert(attribute(d,candidate,EGL_RED_SIZE,&red));assert(attribute(d,candidate,EGL_SURFACE_TYPE,&type));if(red==5)found565=true;if(surfaceType!=EGL_DONT_CARE)assert(type&surfaceType);}
  assert(found565==raw565);if(surfaceType==EGL_WINDOW_BIT)assert(result==loose);
 }
 int requested[]={EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_DEPTH_SIZE,16,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_NONE};
 int count=0;assert(choose(d,requested,nullptr,0,&count)&&count>0);std::vector<void*> configs(count);assert(choose(d,requested,configs.data(),count,&count));
 void*rgb=nullptr,*rgba=nullptr;for(auto config:configs){int alpha=-1,visual=0;assert(attribute(d,config,EGL_ALPHA_SIZE,&alpha));assert(attribute(d,config,EGL_NATIVE_VISUAL_ID,&visual));if(alpha==0){assert(visual==2);rgb=config;}else if(alpha==8){assert(visual==1);rgba=config;}}assert(rgb&&rgba);
 int originalCount=0;assert(fn<unsigned(*)(void*,void**,int,int*)>("eglGetConfigs")(d,nullptr,0,&originalCount));int visibleCount=0;assert(::configs(d,nullptr,0,&visibleCount));int rgbxCount=0;bool okay=false;for(auto candidate:configList(d,okay))if(opaqueConfig(candidate))rgbxCount++;assert(okay&&rgbxCount>0&&visibleCount==originalCount+rgbxCount);
 int id=0;assert(attribute(d,rgb,EGL_CONFIG_ID,&id));int byId[]={EGL_CONFIG_ID,id,EGL_NONE};void*exact=nullptr;assert(choose(d,byId,&exact,1,&count)&&count==1&&exact==rgb);
 for(int version:{1,2,3}){
 const int contextAttributes[]={EGL_CONTEXT_CLIENT_VERSION,version,EGL_NONE};void*ctx=createContext(d,rgb,nullptr,contextAttributes);assert(ctx);int contextId=0;assert(queryContext(d,ctx,EGL_CONFIG_ID,&contextId)&&contextId==id);
 probe::next=probe::storage(64,32);auto window=create(d,rgb,(void*)3,nullptr);if(!window)std::cerr<<"window error "<<std::hex<<getError()<<"\n";assert(window);assert(makeCurrent(d,window,window,ctx));
 fn<void(*)(float,float,float,float)>("glClearColor")(.25f,.5f,.75f,1.f);
 fn<void(*)(unsigned char,unsigned char,unsigned char,unsigned char)>("glColorMask")(0,1,0,1);fn<void(*)(unsigned)>("glEnable")(0x0C11);
 klj_framebuffer::initialize(driver::resolve);
 float retainedColor[4]={};unsigned char retainedMask[4]={};
 fn<void(*)(unsigned,float*)>("glGetFloatv")(0x0C22,retainedColor);fn<void(*)(unsigned,unsigned char*)>("glGetBooleanv")(0x0C23,retainedMask);
 assert(retainedColor[0]==.25f&&retainedColor[1]==.5f&&retainedColor[2]==.75f&&retainedColor[3]==1.f);
 assert(!retainedMask[0]&&retainedMask[1]&&!retainedMask[2]&&retainedMask[3]&&fn<unsigned char(*)(unsigned)>("glIsEnabled")(0x0C11));
 assert(fn<unsigned(*)()>("glGetError")()==0);
 fn<void(*)(unsigned char,unsigned char,unsigned char,unsigned char)>("glColorMask")(1,1,1,1);fn<void(*)(unsigned)>("glDisable")(0x0C11);
 fn<void(*)(int,int,int,int)>("glViewport")(0,0,64,32);fn<void(*)(float,float,float,float)>("glClearColor")(.2f,.4f,.6f,0.f);fn<void(*)(unsigned)>("glClear")(0x4000);
 if(version==3){
  // Android's process display has independent EGL clients. An SDK releasing
  // its own initialization must not invalidate the game's surface or fences.
  void *fence=fn<void*(*)(void*,unsigned,const intptr_t*)>("eglCreateSync")(d,EGL_SYNC_FENCE,nullptr);assert(fence);
  fn<void(*)()>("glFlush")();
  std::vector<std::thread> clients;
  for(int n=0;n<4;n++)clients.emplace_back([&]{for(int i=0;i<8;i++){int major=0,minor=0;assert(initialize(d,&major,&minor)&&major==1&&minor>=4);assert(terminate(d));}});
  for(auto &client:clients)client.join();
  intptr_t state=0;assert(fn<unsigned(*)(void*,void*,int,intptr_t*)>("eglGetSyncAttrib")(d,fence,EGL_SYNC_STATUS,&state));
  assert(fn<unsigned(*)(void*,void*)>("eglDestroySync")(d,fence));
  int width=0;assert(querySurface(d,window,EGL_WIDTH,&width)&&width==64);
 }
 unsigned char pixel[4]={};fn<void(*)(int,int,int,int,unsigned,unsigned,void*)>("glReadPixels")(0,0,1,1,0x1908,0x1401,pixel);
 int alphaBits=-1;fn<void(*)(unsigned,int*)>("glGetIntegerv")(0x0D55,&alphaBits);
 std::cout<<"RGB pixel "<<int(pixel[0])<<","<<int(pixel[1])<<","<<int(pixel[2])<<","<<int(pixel[3])<<" alphaBits="<<alphaBits<<"\n";
 assert(pixel[0]>=50&&pixel[0]<=52&&pixel[1]>=101&&pixel[1]<=103&&pixel[2]>=152&&pixel[2]<=154&&pixel[3]==255&&alphaBits==0);
 assert(makeCurrent(d,nullptr,nullptr,nullptr));assert(destroy(d,window));assert(destroyContext(d,ctx));CFRelease(probe::next);
 }
 assert(terminate(d));assert(surfaces.empty()&&contextConfigs.empty()&&initializeCounts.empty());
 std::cout<<"PASS RGB config selection, stable identity and actual ANGLE opaque rendering\n";
}
