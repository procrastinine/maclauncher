// Owned output drawables: a controlled layer whose nextDrawable waits one
// second when its drawables are all in use, as Core Animation does. No Metal
// device, queue, GPU or display.
#include "overlay-drawables.hpp"
#import <Foundation/Foundation.h>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <vector>
static unsigned checks;
static void check(bool value,const char *what){++checks;if(!value){std::fprintf(stderr,"Overlay drawable check %u failed: %s\n",checks,what);std::exit(1);}}
@class ControlledDrawable;
@interface ControlledLayer:NSObject
@property NSUInteger maximumDrawableCount;
@property(weak)ControlledDrawable *displayed;
@property std::atomic<unsigned> *calls,*blocked,*inUse;
@property BOOL failNext;
- (id<CAMetalDrawable>)nextDrawable;
- (void)returnDrawable;
@end
@interface ControlledDrawable:NSObject
@property(weak)ControlledLayer *layer;
@property double presentedTime;
@property BOOL returned;
@property(strong)NSMutableArray *handlers;
- (void)addPresentedHandler:(MTLDrawablePresentedHandler)handler;
- (void)display:(double)time;
@end
@implementation ControlledLayer {std::atomic<unsigned> callCount,blockedCount,useCount;ControlledDrawable *screen;}
- (instancetype)init{if((self=[super init])){_calls=&callCount;_blocked=&blockedCount;_inUse=&useCount;}return self;}
- (id<CAMetalDrawable>)nextDrawable{
    ++callCount;
    if(useCount.load()>=_maximumDrawableCount){++blockedCount;std::this_thread::sleep_for(std::chrono::seconds(1));return nil;}
    if(_failNext){_failNext=NO;return nil;}
    ++useCount;auto drawable=[ControlledDrawable new];drawable.layer=self;drawable.handlers=[NSMutableArray new];return (id<CAMetalDrawable>)drawable;
}
- (void)returnDrawable{--useCount;}
// The displayed drawable stays in use until a later one replaces it.
- (void)show:(ControlledDrawable *)drawable{ControlledDrawable *previous=screen;screen=drawable;if(previous&&!previous.returned){previous.returned=YES;[self returnDrawable];}}
@end
@implementation ControlledDrawable
- (void)addPresentedHandler:(MTLDrawablePresentedHandler)handler{[self.handlers addObject:[handler copy]];}
- (void)display:(double)time{
    self.presentedTime=time;
    if(time>0)[self.layer show:self];else if(!self.returned){self.returned=YES;[self.layer returnDrawable];}
    NSArray *saved=[self.handlers copy];[self.handlers removeAllObjects];for(MTLDrawablePresentedHandler handler in saved)handler((id<MTLDrawable>)self);
}
- (void)dealloc{if(!_returned&&!_presentedTime)[_layer returnDrawable];}
@end
static double elapsed(std::chrono::steady_clock::time_point begun){return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-begun).count();}
int main(){@autoreleasepool{
    double slowest=0;
    auto timed=[&](macfx::OverlayDrawables &gate,ControlledLayer *layer){
        const auto begun=std::chrono::steady_clock::now();id<CAMetalDrawable> value=gate.acquire((CAMetalLayer*)(id)layer);
        const double spent=elapsed(begun);if(spent>slowest)slowest=spent;return (ControlledDrawable*)(id)value;};
    ControlledLayer *layer=[ControlledLayer new];layer.maximumDrawableCount=3;
    macfx::OverlayDrawables gate;
    ControlledDrawable *a=timed(gate,layer),*b=timed(gate,layer),*c=timed(gate,layer);
    check(a&&b&&c&&gate.held()==3&&layer.calls->load()==3,"three drawables are admitted");
    // A display that consumes nothing holds every drawable. The submitting
    // thread then returns at once and never enters the waiting call.
    for(unsigned i=0;i<100;++i)check(!timed(gate,layer),"a held output refuses");
    check(layer.calls->load()==3&&layer.blocked->load()==0&&gate.refusingSeconds()>0,"refusal never calls nextDrawable");
    [a display:1.0];
    check(!timed(gate,layer)&&gate.held()==3,"the displayed drawable remains in use");
    [b display:2.0];
    check(gate.held()==2&&layer.inUse->load()==2,"a replacement returns the earlier displayed drawable");
    ControlledDrawable *d=timed(gate,layer);check(d&&gate.held()==3&&gate.refusingSeconds()==0,"a returned drawable is admitted again");
    [c display:0];
    check(gate.held()==2,"a dropped presentation returns its drawable");
    @autoreleasepool {ControlledDrawable *e=timed(gate,layer);check(e&&gate.held()==3,"admission after a drop");e=nil;}
    check(gate.held()==2&&layer.inUse->load()==2,"an unpresented drawable returns with its release");
    layer.failNext=YES;
    check(!timed(gate,layer)&&gate.held()==2,"a nil drawable returns its reservation");
    check(layer.blocked->load()==0,"no acquisition waited");
    // Concurrent producers reserve before the call and never overcommit.
    ControlledLayer *shared=[ControlledLayer new];shared.maximumDrawableCount=3;
    std::atomic<unsigned> admitted{0};NSMutableArray *kept=[NSMutableArray new];
    {
        macfx::OverlayDrawables concurrent;NSLock *keeping=[NSLock new];
        std::vector<std::thread> threads;
        for(unsigned i=0;i<8;++i)threads.emplace_back([&]{@autoreleasepool{for(unsigned j=0;j<20;++j)if(id value=concurrent.acquire((CAMetalLayer*)(id)shared)){++admitted;[keeping lock];[kept addObject:value];[keeping unlock];}}});
        for(auto &thread:threads)thread.join();
        check(admitted.load()==3&&concurrent.held()==3&&shared.blocked->load()==0,"concurrent acquisition stays within capacity");
    }
    // Drawables may outlive their presenter; their handlers then refer to no count.
    [kept[0] display:3.0];[kept[1] display:0];[kept removeAllObjects];
    check(shared.inUse->load()==1,"drawables outliving their presenter retire normally");
    std::printf("Owned output drawables: %u checks; refusals and admissions took at most %.2f ms; nextDrawable was never entered while every drawable was in use.\n",checks,slowest);
}}
