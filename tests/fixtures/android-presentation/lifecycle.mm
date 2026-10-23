// Compile the unchanged owned implementation first, with CPU-only Metal/EGL
// doubles. IOSurface metadata uses retained CFDictionary values because the
// sandbox denies IOSurface allocation. No device/window/GPU allocation occurs.
#import <IOSurface/IOSurface.h>
static IOSurfaceRef cpuSurfaceCreate(CFDictionaryRef values){return (IOSurfaceRef)CFRetain(values);}
static size_t cpuSurfaceValue(IOSurfaceRef value,CFStringRef key){int n=0;auto number=(CFNumberRef)CFDictionaryGetValue((CFDictionaryRef)value,key);assert(number&&CFNumberGetValue(number,kCFNumberIntType,&n));return (unsigned)n;}
static size_t cpuSurfaceWidth(IOSurfaceRef v){return cpuSurfaceValue(v,kIOSurfaceWidth);}
static size_t cpuSurfaceHeight(IOSurfaceRef v){return cpuSurfaceValue(v,kIOSurfaceHeight);}
static uint32_t cpuSurfaceFormat(IOSurfaceRef v){return (uint32_t)cpuSurfaceValue(v,kIOSurfacePixelFormat);}
#define IOSurfaceCreate cpuSurfaceCreate
#define IOSurfaceGetWidth cpuSurfaceWidth
#define IOSurfaceGetHeight cpuSurfaceHeight
#define IOSurfaceGetPixelFormat cpuSurfaceFormat
#include PRESENTATION_SOURCE
#include <unordered_set>
static unsigned checks,flushes,textureCreates,deviceQueries;
static unsigned cachedCalls,acceptedUi;
static int cachedStatus;
static uint64_t cachedUi=73;
static unsigned queueFailures,eventFailures,shaderFailures,pipelineFailures,liveQueues,liveEvents;
static std::string exception;
#define EXPECT(x) do { ++checks; if(!(x)){fprintf(stderr,"FAIL line %d: %s; pending=%s\n",__LINE__,#x,exception.c_str());return 18;} } while(0)
@interface CPUEvent:NSObject
@property uint64_t signaledValue;
@end
@implementation CPUEvent
-(instancetype)init {if((self=[super init]))++liveEvents;return self;}
-(void)dealloc {--liveEvents;}
@end
@interface CPUCommand:NSObject
@property(copy) NSString *label;
@property MTLCommandBufferStatus status;
@property(strong) NSError *error;
-(void)encodeWaitForEvent:(CPUEvent*)event value:(uint64_t)value;
-(void)encodeSignalEvent:(CPUEvent*)event value:(uint64_t)value;
-(void)commit;-(void)waitUntilCompleted;
@end
@implementation CPUCommand
-(void)encodeWaitForEvent:(CPUEvent*)event value:(uint64_t)value {assert(event.signaledValue>=value);}
-(void)encodeSignalEvent:(CPUEvent*)event value:(uint64_t)value {event.signaledValue=value;}
-(void)commit {self.status=MTLCommandBufferStatusCompleted;}
-(void)waitUntilCompleted {assert(self.status==MTLCommandBufferStatusCompleted);}
@end
@interface CPUQueue:NSObject
-(CPUCommand*)commandBuffer;
@end
@implementation CPUQueue
-(instancetype)init {if((self=[super init]))++liveQueues;return self;}
-(void)dealloc {--liveQueues;}
-(CPUCommand*)commandBuffer {return [CPUCommand new];}
@end
@interface CPULibrary:NSObject
-(id)newFunctionWithName:(NSString*)name;
@end
@interface CPUFunction:NSObject
@property MTLFunctionType functionType;
@end
@implementation CPUFunction
@end
@interface CPUTexture:NSObject
@property NSUInteger width,height;
@end
@implementation CPUTexture
@end
@implementation CPULibrary
-(id)newFunctionWithName:(NSString*)name {assert(name.length);auto function=[CPUFunction new];function.functionType=[name isEqualToString:@"hostVertex"]?MTLFunctionTypeVertex:MTLFunctionTypeFragment;return function;}
@end
@interface CPUDevice:NSObject
@property(readonly) NSString *name;
@property(readonly) uint64_t registryID;
-(CPUQueue*)newCommandQueue;-(CPUEvent*)newSharedEvent;
-(id)newTextureWithDescriptor:(MTLTextureDescriptor*)descriptor iosurface:(IOSurfaceRef)storage plane:(NSUInteger)plane;
-(CPULibrary*)newLibraryWithSource:(NSString*)source options:(id)options error:(NSError**)error;
-(id)newRenderPipelineStateWithDescriptor:(id)descriptor error:(NSError**)error;
@end
@implementation CPUDevice
-(NSString*)name{return @"CPU-only lifecycle test double";}
-(uint64_t)registryID{return 17;}
-(CPUQueue*)newCommandQueue{if(queueFailures){--queueFailures;return nil;}return [CPUQueue new];}
-(CPUEvent*)newSharedEvent{if(eventFailures){--eventFailures;return nil;}return [CPUEvent new];}
-(id)newTextureWithDescriptor:(MTLTextureDescriptor*)descriptor iosurface:(IOSurfaceRef)storage plane:(NSUInteger)plane {assert(descriptor.width==IOSurfaceGetWidth(storage)&&!plane);++textureCreates;auto texture=[CPUTexture new];texture.width=descriptor.width;texture.height=descriptor.height;return texture;}
-(CPULibrary*)newLibraryWithSource:(NSString*)source options:(id)options error:(NSError**)error {assert(source.length&&!options);if(shaderFailures){--shaderFailures;*error=[NSError errorWithDomain:@"CPU fixture" code:1 userInfo:@{NSLocalizedDescriptionKey:@"Owned shader creation rejection"}];return nil;}return [CPULibrary new];}
-(id)newRenderPipelineStateWithDescriptor:(id)descriptor error:(NSError**)error {assert(descriptor);if(pipelineFailures){--pipelineFailures;*error=[NSError errorWithDomain:@"CPU fixture" code:2 userInfo:@{NSLocalizedDescriptionKey:@"Owned pipeline creation rejection"}];return nil;}return [NSObject new];}
@end
@interface CPULayer:NSObject
@property(strong) id device;
@property MTLPixelFormat pixelFormat;
@property BOOL framebufferOnly;
@property CGSize drawableSize;
@property NSUInteger maximumDrawableCount;
@property BOOL displaySyncEnabled;
-(id)nextDrawable;
@end
@implementation CPULayer
-(id)nextDrawable {assert(false&&"Unexpected fallback presentation");return nil;}
@end
static CPUDevice *device;
static unsigned surfaceIds;
static std::unordered_set<void*> surfaces,fences;
static const char *query(void*,int){return "EGL_ANGLE_iosurface_client_buffer EGL_ANGLE_metal_shared_event_sync";}
static unsigned queryDisplay(void*,int,intptr_t*out){*out=1;return 1;}
static unsigned queryDevice(void*,int,intptr_t*out){++deviceQueries;*out=(intptr_t)(__bridge void*)device;return 1;}
static unsigned config(void*,void*,int,int*out){*out=0x3553;return 1;}
static void *pbuffer(void*,unsigned,void*,void*,const int*){auto p=new unsigned(++surfaceIds);assert(surfaces.insert(p).second);return p;}
static unsigned destroyPbuffer(void*p){assert(surfaces.erase(p));delete (unsigned*)p;return 1;}
static void *createSync(void*,unsigned,const intptr_t*a){auto event=(__bridge CPUEvent*)(void*)a[1];auto n=uint64_t(uint32_t(a[3]))|(uint64_t(uint32_t(a[5]))<<32);event.signaledValue=n;auto p=new unsigned;assert(fences.insert(p).second);return p;}
static unsigned destroySync(void*,void*p){assert(fences.erase(p));delete (unsigned*)p;return 1;}
static unsigned waitSync(void*,void*p,int){assert(fences.contains(p));return 1;}
static void flush(){++flushes;}
extern "C" void *klj_graphics_symbol(const char*n){
 struct E{const char*n;void*p;};const E entries[]={
 {"eglQueryString",(void*)query},{"eglQueryDisplayAttribEXT",(void*)queryDisplay},{"eglQueryDeviceAttribEXT",(void*)queryDevice},
 {"eglGetConfigAttrib",(void*)config},{"eglCreatePbufferFromClientBuffer",(void*)pbuffer},{"eglCreateSync",(void*)createSync},
 {"eglDestroySync",(void*)destroySync},{"eglWaitSync",(void*)waitSync},{"glFlush",(void*)flush}};
 for(auto e:entries)if(!strcmp(n,e.n))return e.p;fprintf(stderr,"Unexpected EGL call %s\n",n);abort();
}
extern "C" void* klj_overlay_create(JNIEnv*,int,int){abort();}
extern "C" int klj_overlay_validate_size(JNIEnv*,void*,int,int){abort();}
extern "C" int klj_overlay_set_surface(JNIEnv*,void*,void*,int,int){abort();}
extern "C" int klj_overlay_submit(JNIEnv*,void*,jintArray,int,int,int,int,uint64_t){abort();}
extern "C" int klj_overlay_clear(JNIEnv*,void*,uint64_t){abort();}
extern "C" int klj_overlay_encode(JNIEnv*,void*,void*,void*,int,KLJOverlayFrame*){abort();}
extern "C" int klj_overlay_encode_cached(JNIEnv*,void*,void*,KLJOverlayFrame*frame){++cachedCalls;if(cachedStatus)return cachedStatus;*frame={(void*)1,cachedUi,1};return 0;}
extern "C" void klj_overlay_frame_submitted(void*,const KLJOverlayFrame*frame){assert(frame&&frame->texture&&frame->uiFrameId==cachedUi);++acceptedUi;}
extern "C" int klj_overlay_encode_canvas(JNIEnv*,void*,void*,void**){abort();}
extern "C" void klj_overlay_destroy(void*){abort();}
static jboolean pending(JNIEnv*){return !exception.empty();}
static jclass find(JNIEnv*,const char*){return (jclass)1;}
static jint throwNew(JNIEnv*,jclass,const char*s){exception=s;return 0;}
int main(int argc,char**argv){@try{@autoreleasepool {
 EXPECT(argc==2);setenv("KLEPTON_FRAME_LIBRARY",argv[1],1);
 auto lib=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);EXPECT(lib);auto count=(unsigned(*)(unsigned))dlsym(lib,"lifecycle_count");EXPECT(count);
 auto reject=(void(*)())dlsym(lib,"lifecycle_fail_create");EXPECT(reject);
 auto present=(void(*)(uint64_t))dlsym(lib,"lifecycle_present");EXPECT(present);
 JNINativeInterface_ functions{};functions.ExceptionCheck=pending;functions.FindClass=find;functions.ThrowNew=throwNew;JNIEnv env{&functions};
 device=[CPUDevice new];auto layer=[CPULayer new];
 auto p=(Presenter*)klj_metal_create(&env,(__bridge void*)layer,64,64);EXPECT(p);klj_metal_enter(p);
 int display,configValue;void*previous=nullptr;
 for(unsigned cycle=0;cycle<4;++cycle){
  auto surface=klj_metal_surface(&env,&display,&configValue,64,64,false,nullptr);EXPECT(surface&&!pending(&env));
  EXPECT(p->device!=nil);
  if(cycle&&p->shared==nullptr){
   EXPECT(count(0)==1&&count(1)==1&&count(2)==0&&deviceQueries==cycle+1);
   EXPECT(p->displayPipeline==nil);EXPECT(klj_metal_target(p,&display,surface,42)==0x3002);
   EXPECT(destroyPbuffer(surface)==1);EXPECT(klj_metal_detach_surface(&env)==1);
   klj_metal_enter(nullptr);klj_metal_destroy(p);EXPECT(count(4)==1&&surfaces.empty()&&fences.empty());
   fprintf(stderr,"RECREATE_SHARED_MISSING: original device retained, first shared presenter destroyed, second surface bypassed initialization; nil fallback pipeline; targeted swap rejected. %u checks, CPU only.\n",checks);return 17;
  }
  EXPECT(p->shared!=nullptr);EXPECT(p->displayPipeline==nil);
  EXPECT(count(2)==1);EXPECT(klj_metal_target(p,&display,surface,123+cycle)==0);
  int64_t target=0;EXPECT(p->target.read(target)&&target==123+cycle);
  EXPECT(klj_metal_present(&env,p,1)==1);EXPECT(!pending(&env));
  EXPECT(klj_metal_finish(&env,p)==1);EXPECT(!pending(&env));
  EXPECT(count(2)==0);EXPECT(fences.empty());
  previous=surface;EXPECT(destroyPbuffer(surface)==1);EXPECT(klj_metal_detach_surface(&env)==1);
  EXPECT(!p->source&&!p->storage&&!p->surface&&!p->last);EXPECT(!p->target.read(target));
  EXPECT(p->device!=nil);EXPECT(surfaces.empty());
 }
 EXPECT(previous);EXPECT(textureCreates==4);EXPECT(deviceQueries==4);
 EXPECT(count(0)==4&&count(1)==4&&count(3)==4);
 // A rejected recreation must not allocate a new source or silently switch
 // to the direct fallback. A fresh call can retry after the caller handles it.
 reject();EXPECT(klj_metal_surface(&env,&display,&configValue,64,64,false,nullptr)==nullptr);
 EXPECT(exception=="Owned fixture create rejection");EXPECT(!p->shared&&!p->source&&!p->storage&&!p->surface);
 EXPECT(surfaces.empty()&&textureCreates==4&&count(2)==0);exception.clear();
 auto surface=klj_metal_surface(&env,&display,&configValue,64,64,false,nullptr);EXPECT(surface&&!pending(&env));
 EXPECT(p->shared&&count(0)==5&&count(5)==6&&deviceQueries==6);
 EXPECT(klj_metal_target(p,&display,surface,321)==0);EXPECT(klj_metal_present(&env,p,1)==1);
 // Ordinary resize retains the existing shared owner rather than recreating
 // it. Target identity is retired, and the newly committed extent is exact.
 EXPECT(klj_metal_resize(&env,80,72)==1);EXPECT(destroyPbuffer(surface)==1);
 int64_t target=0;EXPECT(!p->target.read(target));EXPECT(count(2)==1);
 surface=klj_metal_surface(&env,&display,&configValue,80,72,false,nullptr);EXPECT(surface&&!pending(&env));
 EXPECT(count(0)==5&&count(5)==6&&deviceQueries==7);EXPECT(!p->target.read(target));
 EXPECT(klj_metal_committed_extent(p)==((uint64_t(80)<<32)|72));
 EXPECT(klj_metal_target(p,&display,surface,456)==0);EXPECT(klj_metal_present(&env,p,1)==1);
 // A Canvas change is an independent submission to the SAME native presenter.
 // It neither flushes another producer frame nor changes committed geometry.
 p->overlay=(void*)1;p->uploadedUi=73;auto beforeFlush=flushes;
 cachedStatus=3;EXPECT(klj_metal_overlay_submit(&env,p,nullptr,0,64,64,64,73)==3);EXPECT(count(3)==6&&acceptedUi==0);
 cachedStatus=0;EXPECT(klj_metal_overlay_submit(&env,p,nullptr,0,64,64,64,73)==0);EXPECT(count(3)==7&&acceptedUi==1&&cachedCalls==2);
 EXPECT(flushes==beforeFlush&&p->width==80&&p->height==72&&p->shared);EXPECT(klj_metal_committed_extent(p)==((uint64_t(80)<<32)|72));
 // Physical frame status remains independent of Android transaction latching.
 // A hidden/dropped presenter reports no displayed frame after accepting UI.
 present(0);
 for(uint64_t frame:{73,73,74,75}){p->uploadedUi=cachedUi=frame;EXPECT(klj_metal_overlay_submit(&env,p,nullptr,0,64,64,64,frame)==0);}
 RSPresenterStatus physical{};physical.size=sizeof(physical);physical.version=RS_PRESENTER_ABI_VERSION;
 EXPECT(p->sharedStatus(p->shared,&physical)==RS_FRAME_OK&&physical.lastPresentedFrame==0&&physical.presentedReal==0);
 present(p->serial);EXPECT(p->sharedStatus(p->shared,&physical)==RS_FRAME_OK&&physical.lastPresentedFrame==p->serial);
 p->overlay=nullptr;
 EXPECT(klj_metal_finish(&env,p)==1);EXPECT(destroyPbuffer(surface)==1);EXPECT(klj_metal_detach_surface(&env)==1);
 EXPECT(count(0)==5&&count(1)==5&&count(3)==11&&fences.empty()&&surfaces.empty());
 klj_metal_enter(nullptr);klj_metal_destroy(p);EXPECT(count(2)==0&&count(4)==1);EXPECT(fences.empty());
 device=nil;dlclose(lib);printf("PASS %u actual presentation lifecycle checks; four destroy/recreate cycles, failed creation/retry, retained-owner resize, target retirement, final owner release; zero GPU devices/windows.\n",checks);return 0;
}}@catch(NSException*error){fprintf(stderr,"FIXTURE_EXCEPTION: %s\n",error.reason.UTF8String);return 20;}}
