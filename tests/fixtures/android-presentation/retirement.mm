// Execute the real owned presenter and EGL cleanup with CPU-only Metal/EGL
// doubles. No physical window, GPU device, command queue or event is created.
#import <IOSurface/IOSurface.h>
static IOSurfaceID cpuSurfaceIdentity(IOSurfaceRef value){return static_cast<IOSurfaceID>(reinterpret_cast<uintptr_t>(value)>>4);}
#define IOSurfaceGetID cpuSurfaceIdentity
#define main previousLifecycleMain
#include "lifecycle.mm"
#undef main
#include "egl-cleanup.hpp"
#include <cstdarg>
extern "C" int klj_android_log_write(int,const char*,const char*){return 0;}

static std::vector<std::unique_ptr<std::string>> localFailures;
static std::vector<std::string> suppressed;
static jthrowable occurred(JNIEnv*){
 if(exception.empty())return nullptr;
 localFailures.push_back(std::make_unique<std::string>(exception));return reinterpret_cast<jthrowable>(localFailures.back().get());
}
static void clearFailure(JNIEnv*){exception.clear();}
static jint throwFailure(JNIEnv*,jthrowable value){exception=*reinterpret_cast<std::string*>(value);return 0;}
static jboolean sameFailure(JNIEnv*,jobject a,jobject b){return a==b;}
static void deleteLocal(JNIEnv*,jobject){}
static jmethodID method(JNIEnv*,jclass,const char*,const char*){return reinterpret_cast<jmethodID>(1);}
static void suppress(JNIEnv*,jobject,jmethodID,va_list args){auto next=va_arg(args,jthrowable);suppressed.push_back(*reinterpret_cast<std::string*>(next));}
@interface CPURetirementCommand:CPUCommand
@end
@implementation CPURetirementCommand
-(void)waitUntilCompleted {assert(self.status==MTLCommandBufferStatusCompleted||self.status==MTLCommandBufferStatusError);}
@end
@interface CPUAllocationDevice:CPUDevice
@property unsigned rejectedStage,eventCalls;
@end
@implementation CPUAllocationDevice
-(CPUQueue*)newCommandQueue {return self.rejectedStage==1?nil:[super newCommandQueue];}
-(CPUEvent*)newSharedEvent {++_eventCalls;return (_rejectedStage==2&&_eventCalls==1)||(_rejectedStage==3&&_eventCalls==2)?nil:[super newSharedEvent];}
@end

int main(int argc,char**argv){@try{@autoreleasepool{
 EXPECT(argc==2);setenv("KLEPTON_FRAME_LIBRARY",argv[1],1);
 auto lib=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);EXPECT(lib);
 auto count=(unsigned(*)(unsigned))dlsym(lib,"lifecycle_count");EXPECT(count);
 JNINativeInterface_ functions{};functions.ExceptionCheck=pending;functions.FindClass=find;functions.ThrowNew=throwNew;
 functions.ExceptionOccurred=occurred;functions.ExceptionClear=clearFailure;functions.Throw=throwFailure;functions.IsSameObject=sameFailure;
 functions.DeleteLocalRef=deleteLocal;functions.GetMethodID=method;functions.CallVoidMethodV=suppress;JNIEnv env{&functions};
 device=[CPUDevice new];unsigned retired=0,destroyed=0;
 for(const auto mode:{"complete","gpu-error","timeout","empty","gpu-error-only"}){
  exception.clear();suppressed.clear();
  auto layer=[CPULayer new];auto p=(Presenter*)klj_metal_create(&env,(__bridge void*)layer,64,64);EXPECT(p);klj_metal_enter(p);
  int display,configValue;auto surface=klj_metal_surface(&env,&display,&configValue,64,64,false,nullptr);EXPECT(surface&&p->shared&&!pending(&env));
  if(strcmp(mode,"empty")){EXPECT(klj_metal_present(&env,p,1)==1);EXPECT(!fences.empty());}
  if(!strcmp(mode,"gpu-error")||!strcmp(mode,"timeout")||!strcmp(mode,"gpu-error-only")){
   auto command=[CPURetirementCommand new];p->last=(id<MTLCommandBuffer>)command;
   command.status=!strcmp(mode,"timeout")?MTLCommandBufferStatusScheduled:MTLCommandBufferStatusError;
   command.error=[NSError errorWithDomain:@"CPU fixture" code:2 userInfo:@{NSLocalizedDescriptionKey:@"CPU terminal GPU failure"}];
   if(strcmp(mode,"gpu-error-only"))exception="Original caller exception";
  }
  const auto produced=p->produced.signaledValue,consumed=p->consumed.signaledValue;
  const auto release=[&]{return egl_cleanup::surface(&env,[&]{return klj_metal_finish(&env,p)!=0;},[&]{return klj_metal_detach_surface(&env);},[&]{++destroyed;return destroyPbuffer(surface);},[&]{++retired;});};
  if(!strcmp(mode,"timeout")){
   const auto began=std::chrono::steady_clock::now();EXPECT(release()==0);
   EXPECT(std::chrono::steady_clock::now()-began<std::chrono::seconds(3));
   EXPECT(exception=="Original caller exception");EXPECT(suppressed.size()==1&&suppressed.back().find("teardown deadline")!=std::string::npos);
   EXPECT(p->shared&&p->surface==surface&&!fences.empty()&&surfaces.contains(surface));EXPECT(retired==2&&destroyed==2);
   EXPECT(p->produced.signaledValue==produced&&p->consumed.signaledValue==consumed);
   // A later genuine terminal status permits retry. Cleanup never changes
   // that status or signals a GPU event to pretend the work completed.
   auto command=(__bridge CPUCommand*)(__bridge void*)p->last;EXPECT(command.status==MTLCommandBufferStatusScheduled);command.status=MTLCommandBufferStatusError;
  }
  EXPECT(release()==1);EXPECT(!p->shared&&!p->surface&&!p->source&&!p->storage&&!p->last&&fences.empty()&&surfaces.empty());
  if(!strcmp(mode,"gpu-error")||!strcmp(mode,"timeout")){
   EXPECT(exception=="Original caller exception");EXPECT(suppressed.back()=="CPU terminal GPU failure");
  }else if(!strcmp(mode,"gpu-error-only")){EXPECT(exception=="CPU terminal GPU failure"&&suppressed.empty());}
  else EXPECT(!pending(&env));
  klj_metal_enter(nullptr);klj_metal_destroy(p);EXPECT(count(2)==0&&liveQueues==0&&liveEvents==0);
 }
 EXPECT(retired==5&&destroyed==5&&count(0)==5&&count(1)==5&&count(4)==5);
 const char *allocationErrors[]={"Metal device is unavailable","Metal command queue is unavailable","Metal producer shared event is unavailable","Metal consumer shared event is unavailable"};
 for(unsigned stage=0;stage<4;++stage){
  exception.clear();auto allocation=[CPUAllocationDevice new];allocation.rejectedStage=stage;
  auto layer=[CPULayer new];auto p=(Presenter*)klj_metal_create(&env,(__bridge void*)layer,64,64);EXPECT(p);
  std::string rejected;
  try{initializeDevice(p,stage?(id<MTLDevice>)allocation:nil);}catch(const std::exception &error){rejected=error.what();}
  EXPECT(rejected==allocationErrors[stage]);EXPECT(!p->device&&!p->queue&&!p->produced&&!p->consumed&&!p->deviceReady);
  EXPECT(liveQueues==0&&liveEvents==0);klj_metal_destroy(p);
 }
 device=nil;dlclose(lib);
 printf("PASS %u actual EGL/Metal retirement checks; completed/error/empty release, bounded inflight retention/retry, first exception preserved, four atomic allocation failures, zero GPU devices/windows.\n",checks);return 0;
}}@catch(NSException*error){fprintf(stderr,"FIXTURE_EXCEPTION: %s\n",error.reason.UTF8String);return 20;}}
