// Forwarded CPU-filled surfaces, real core and fixture-owned windows only.
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#include <cassert>
#include <atomic>
#include <map>
#define main windowGraphicsHelperMain
#include <graphics-window.mm>
#undef main
static macfx::wcap::ClientCallbacks callbacks;
static std::map<uint32_t,NSDictionary*> opens,options;
static std::atomic<unsigned>releases{0};static unsigned pointerStarts=0,pointerStops=0;
namespace macfx::wcap {
struct Client::Impl {};
std::shared_ptr<Client>Client::connect(NSString*,NSString*,ClientCallbacks c,NSString**){callbacks=c;auto client=std::shared_ptr<Client>(new Client);dispatch_async(dispatch_get_main_queue(),^{callbacks.connected();});return client;}
void Client::setOverlays(NSArray<NSNumber*>*){}
void Client::open(uint32_t f,NSDictionary*r){opens[f]=r;}
void Client::options(uint32_t f,NSDictionary*r){::options[f]=r;}
void Client::close(uint32_t f){opens.erase(f);}
void Client::release(uint32_t,uint64_t){++releases;}
void Client::catalog(NSDictionary*){}
void Client::stop(){}
pid_t Client::servicePid()const{return getpid();}
Client::~Client(){}
}
namespace macfx {
struct PointerConstraint::Impl {};
PointerPosition PointerConstraint::update(WindowRect r,int,bool active){if(active)++pointerStarts;else ++pointerStops;return {active,r.x+10,r.y+10};}
void PointerConstraint::stop(){++pointerStops;}
PointerConstraint::~PointerConstraint(){stop();}
}
int runCaptureService(NSArray<NSString*>*){return 0;}
int runCatalogRelay(NSArray<NSString*>*){return 0;}
@interface FixtureSession:MacFXWindowGraphicsSession
@property(nonatomic,strong) NSMutableArray *events;
@property BOOL ended;
@property int endStatus;
@property BOOL forceScaled;
- (Output)output:(NSUInteger)i;
@end
@implementation FixtureSession {std::vector<Output> observed;}
- (void)watchLifecycle{}
- (RSWindowSourceOptions)optionsFor:(Output)o {auto options=[super optionsFor:o];if(self.forceScaled)options.flags|=RS_WINDOW_SOURCE_SCALED;return options;}
- (void)emit:(NSDictionary*)event output:(Output)o {if(!self.events)self.events=[NSMutableArray array];NSMutableDictionary*r=[event mutableCopy];r[@"target"]=o->identifier;[self.events addObject:r];if([event[@"event"] isEqual:@"targetAdded"])observed.push_back(o);}
- (Output)output:(NSUInteger)i{return observed.at(i);}
- (void)finishedWithStatus:(int)s event:(NSString*)e reason:(NSString*)r {self.ended=YES;self.endStatus=s;}
@end
static void spin(double seconds){const double end=CACurrentMediaTime()+seconds;while(CACurrentMediaTime()<end)CFRunLoopRunInMode(kCFRunLoopDefaultMode,.01,true);}
static RSWindowSourceStatus poll(Output o){RSWindowSourceStatus s{sizeof(s),2};assert(rsWindowSourcePoll(o->handle,&s));return s;}
static void input(FixtureSession*s,NSDictionary*d){NSMutableData*b=[[NSJSONSerialization dataWithJSONObject:d options:0 error:nil] mutableCopy];[b appendBytes:"\n" length:1];[s receive:(const char*)b.bytes length:b.length];}
static NSDictionary*geometry(NSWindow*w,uint64_t generation,unsigned width=160){
 return @{@"event":@"geometry",@"exists":@1,@"onScreen":@1,@"pid":@(getpid()),@"layer":@0,@"x":@200,@"y":@200,@"width":@160,@"height":@100,@"scale":@1,@"displayID":@(CGMainDisplayID()),@"pixelsWidth":@(width),@"pixelsHeight":@100,@"generation":@(generation)};
}
static void frame(Output o,uint64_t generation,unsigned width=160){
 IOSurfaceRef s=IOSurfaceCreate((__bridge CFDictionaryRef)@{(id)kIOSurfaceWidth:@(width),(id)kIOSurfaceHeight:@100,(id)kIOSurfaceBytesPerElement:@4,(id)kIOSurfacePixelFormat:@(uint32_t('BGRA'))});assert(s);
 IOSurfaceLock(s,0,nullptr);for(unsigned y=0;y<100;++y){auto*p=(uint32_t*)((char*)IOSurfaceGetBaseAddress(s)+y*IOSurfaceGetBytesPerRow(s));for(unsigned x=0;x<width;++x)p[x]=0xff337799;}IOSurfaceUnlock(s,0,nullptr);
 static uint64_t sequence=0;macfx::wcap::FrameInfo f{++sequence,generation,CACurrentMediaTime(),width,100};callbacks.frame(callbacks.frameContext,o->feed,s,f);CFRelease(s);
}
static BOOL inactiveSpace(id,SEL){return NO;}
int main(){@autoreleasepool{
 setenv("RESHADE_SPATIAL_METHOD","bilinear",1);setenv("RESHADE_EXPLICIT_HOST","1",1);unsetenv("RESHADE_EFFECT_PLAN");
 [NSApplication sharedApplication];NSApp.activationPolicy=NSApplicationActivationPolicyAccessory;
 Dl_info lib{};assert(dladdr((void*)&rsWindowSourceAPI,&lib));
 NSWindow*w=[[NSWindow alloc]initWithContentRect:NSMakeRect(200,200,160,100) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];w.releasedWhenClosed=NO;[w orderFrontRegardless];
 FixtureSession*s=[[FixtureSession alloc]initWithArguments:@[@"--window",[@(w.windowNumber) stringValue],@"--library",@(lib.dli_fname),@"--capture-rate",@"30"]];[s start];auto o=[s output:0];assert(o->hold);assert(opens.empty());spin(.05);assert(opens.size()==1);
 callbacks.feedEvent(o->feed,geometry(w,1));assert(poll(o).outputVisible==0);
 frame(o,1);spin(.2);assert(poll(o).outputVisible==0);
 callbacks.feedEvent(0,@{@"event":@"excluded",@"overlays":@[@(rsWindowSourceOutputWindow(o->handle))]});
 bool revealed=false;for(int i=0;i<80&&!revealed;++i){frame(o,1);spin(.05);[s poll];revealed=poll(o).revealed;}
 auto status=poll(o);fprintf(stderr,"initial state=%u revealed=%u real=%llu reason=%s\n",status.state,status.revealed,status.presentedReal,status.reason);assert(revealed&&status.displayID==CGMainDisplayID()&&status.outputVisible);
 // A new extent keeps the shown image: frames of the old generation or
 // extent are released without being taken, and one at the new extent is.
 callbacks.feedEvent(o->feed,geometry(w,2,200));assert(poll(o).revealed);unsigned before=releases.load();const auto taken=poll(o).captured;frame(o,1);frame(o,2,160);spin(.1);assert(releases==before+2&&poll(o).revealed&&poll(o).captured==taken);
 for(int i=0;i<80&&poll(o).captured==taken;++i){frame(o,2,200);spin(.05);[s poll];}assert(poll(o).revealed&&poll(o).captured>taken&&poll(o).pixelsWidth==200);
 // Pausing keeps feed state and stops presentation; options use the shared cap.
 input(s,@{@"scaled":@NO});assert(std::abs([options[o->feed][@"interval"] doubleValue]-1./30)<1e-6);
 [s suspend:true];[s poll];assert([options[o->feed][@"paused"] boolValue]&&!poll(o).outputVisible);[s suspend:false];[s poll];assert(![options[o->feed][@"paused"] boolValue]);
 // A scaled overlay remains click-through; the fake pointer records activation.
 s.forceScaled=YES;input(s,@{@"scaled":@YES,@"scale":@1.5});callbacks.feedEvent(o->feed,geometry(w,3));
 for(int i=0;i<80&&!poll(o).revealed;++i){frame(o,3);spin(.05);[s poll];}
 assert(pointerStarts>0);NSWindow*overlay=[NSApp windowWithWindowNumber:rsWindowSourceOutputWindow(o->handle)];assert(overlay.ignoresMouseEvents);
 [s suspend:true];[s poll];assert(pointerStops>0);[s suspend:false];[s poll];
 // Active Space failure is scoped to the fixture's overlay class.
 Class cls=NSClassFromString(@"MacFXWindowSourceOutputWindow");class_addMethod(cls,@selector(isOnActiveSpace),(IMP)inactiveSpace,"c@:");
 for(int i=0;i<4;++i)status=poll(o);assert(status.state==RS_WINDOW_SOURCE_HIDDEN&&strstr(status.reason,"full-screen Space"));
 // A frame arriving after the source has stopped releases its transport lease.
 [s suspend:true];before=releases.load();frame(o,3);spin(.1);assert(releases==before+1);[s suspend:false];
 // Two independent feeds and event shapes, including failed closure.
 auto second=[s addOutput:@{@"target":@"window",@"windowID":@(w.windowNumber+1000)}];assert(second&&opens.size()==2);
 callbacks.feedEvent(second->feed,@{@"event":@"closed",@"failed":@YES,@"reason":@"fixture"});assert(!s.ended&&opens.size()==1);
 bool failure=false,removed=false,state=false;for(NSDictionary*e in s.events){if([e[@"event"] isEqual:@"failed"])failure=true;if([e[@"event"] isEqual:@"targetRemoved"])removed=failure;if([e[@"event"] isEqual:@"state"]&&e[@"revealed"])state=true;}assert(failure&&removed&&state);
 input(s,@{@"pointer":@"toggle"});input(s,@{@"remove":o->identifier});assert(s.ended&&s.endStatus==0);spin(.2);assert(rsWindowSourcePendingStops()==0);
 macfx::PointerMotion motion;motion.moved(1,2,0,0);motion.moved(1,2,3,4);assert(motion.held);motion.moved(2,2,0,0);assert(!motion.held);
 assert(pointerStops>0);[w close];puts("window-source-fixture: forwarded frames, HOLD, geometry gates, release, events, pause, display, Space and lifecycle passed");
}}
