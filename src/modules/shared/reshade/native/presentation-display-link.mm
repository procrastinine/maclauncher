#include "presentation-display-link.hpp"
#include "presentation-refresh.hpp"
#import <AppKit/AppKit.h>
#import <QuartzCore/CAMetalDisplayLink.h>
#include <atomic>
#include <mutex>
#include <stdexcept>
namespace {
struct DisplayLinkState {
    std::atomic<bool> paused{true},invalidated{false};std::atomic<uint32_t>display{0};
    macfx::PresentationDisplayLink::Update update;
    explicit DisplayLinkState(macfx::PresentationDisplayLink::Update value):update(std::move(value)){}
};
}
API_AVAILABLE(macos(14.0))
@interface MacFXPresentationDisplayLink : NSObject<CAMetalDisplayLinkDelegate>
- (instancetype)initWithLayer:(CAMetalLayer*)layer state:(std::shared_ptr<DisplayLinkState>)state;
- (void)applyState;
- (void)applyDisplay;
- (void)invalidate;
@end
@implementation MacFXPresentationDisplayLink {
    CAMetalDisplayLink *_link;std::shared_ptr<DisplayLinkState> _state;
    macfx::PresentationRefreshClock _clock;std::atomic<unsigned>_nominal,_maximum;
    std::atomic<uint64_t>_displayRevision;uint64_t _appliedRevision;
    id _screenChanges;NSThread *_thread;
    std::mutex _loopMutex;CFRunLoopRef _loop;
}
- (instancetype)initWithLayer:(CAMetalLayer*)layer state:(std::shared_ptr<DisplayLinkState>)state {
    if((self=[super init])){
        _state=std::move(state);_link=[[CAMetalDisplayLink alloc]initWithMetalLayer:layer];
        if(!_link)return nil;
        _link.delegate=self;_link.preferredFrameLatency=1;_link.paused=YES;
    }return self;
}
- (void)postState {
    __weak MacFXPresentationDisplayLink *weak=self;
    std::lock_guard lock(_loopMutex);if(!_loop)return;
    CFRunLoopPerformBlock(_loop,kCFRunLoopCommonModes,^{[weak applyLoopState];});CFRunLoopWakeUp(_loop);
}
- (void)applyDisplay { // Main thread; screen discovery is never per frame.
    if(_state->invalidated)return;
    NSScreen *selected=nil;const auto display=_state->display.load();
    for(NSScreen *screen in NSScreen.screens)if([screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue]==display){selected=screen;break;}
    selected=selected?:NSScreen.mainScreen;
    const auto nominal=unsigned(std::clamp<NSInteger>(selected.maximumFramesPerSecond?:60,20,1000));unsigned maximum=nominal;
    // The link follows its layer between screens. Permit the fastest connected
    // screen so moving a window cannot leave it capped by the old screen.
    for(NSScreen *screen in NSScreen.screens)maximum=std::max(maximum,unsigned(std::clamp<NSInteger>(screen.maximumFramesPerSecond,20,1000)));
    _nominal=nominal;_maximum=maximum;++_displayRevision;[self postState];
}
- (void)applyLoopState { // Display thread only.
    if(_state->invalidated)return;
    const auto revision=_displayRevision.load();
    if(_appliedRevision!=revision){
        _appliedRevision=revision;_clock.reset();const float maximum=float(_maximum.load());
        _link.preferredFrameRateRange=CAFrameRateRangeMake(20,maximum,maximum);
    }
    const bool paused=_state->paused.load();if(_link.paused&&!paused)_clock.reset();_link.paused=paused;
}
- (void)runDisplayLoop {
    @autoreleasepool{
        CFRunLoopRef loop=CFRunLoopGetCurrent();
        CFRunLoopSourceContext context{};context.perform=[](void*){};
        CFRunLoopSourceRef idle=CFRunLoopSourceCreate(kCFAllocatorDefault,0,&context);
        CFRunLoopAddSource(loop,idle,kCFRunLoopCommonModes);
        {std::lock_guard lock(_loopMutex);_loop=(CFRunLoopRef)CFRetain(loop);}
        @try{try{
            [self applyLoopState];[_link addToRunLoop:NSRunLoop.currentRunLoop forMode:NSRunLoopCommonModes];
            while(!_state->invalidated){@autoreleasepool{CFRunLoopRunInMode(kCFRunLoopDefaultMode,1,true);}}
        }catch(const std::exception&){if(!_state->invalidated)_state->update(nil,0,0);}}
        @catch(NSException*){if(!_state->invalidated)_state->update(nil,0,0);}
        [_link invalidate];_link.delegate=nil;
        {std::lock_guard lock(_loopMutex);CFRelease(_loop);_loop=nullptr;}
        CFRunLoopSourceInvalidate(idle);CFRelease(idle);
    }
}
- (void)applyState { // Main thread; does not wait for rendering or a run loop.
    if(_state->invalidated){[self invalidate];return;}
    if(!_thread){
        [self applyDisplay];__weak MacFXPresentationDisplayLink *weak=self;
        _screenChanges=[NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidChangeScreenParametersNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification*){[weak applyDisplay];}];
        _thread=[[NSThread alloc]initWithBlock:^{MacFXPresentationDisplayLink *driver=weak;if(driver)[driver runDisplayLoop];}];
        _thread.name=@"MacLauncher presentation timing";_thread.qualityOfService=NSQualityOfServiceUserInteractive;[_thread start];
    }else [self postState];
}
- (void)invalidate {
    _state->invalidated=true;if(_screenChanges){[NSNotificationCenter.defaultCenter removeObserver:_screenChanges];_screenChanges=nil;}
    [self postState];
    // Before first resume there is no display thread or registration to retire.
    if(!_thread){[_link invalidate];_link.delegate=nil;}
}
- (void)metalDisplayLink:(CAMetalDisplayLink*)link needsUpdate:(CAMetalDisplayLinkUpdate*)update {
    if(_state->invalidated||_state->paused)return;
    const auto rate=_clock.observe(update.targetPresentationTimestamp);
    _state->update(update.drawable,update.targetPresentationTimestamp,rate?rate:_nominal.load());
}
@end
struct macfx::PresentationDisplayLink::Impl {
    std::shared_ptr<DisplayLinkState> state;id driver;
    Impl(CAMetalLayer *layer,Update update):state(std::make_shared<DisplayLinkState>(std::move(update))){
        if(@available(macOS 14.0,*))driver=[[MacFXPresentationDisplayLink alloc]initWithLayer:layer state:state];
        if(!driver)throw std::runtime_error("Metal display timing is unavailable");
    }
    void apply(){id retained=driver;dispatch_async(dispatch_get_main_queue(),^{if(@available(macOS 14.0,*))[(MacFXPresentationDisplayLink*)retained applyState];});}
};
macfx::PresentationDisplayLink::PresentationDisplayLink(CAMetalLayer *layer,Update update):impl(std::make_unique<Impl>(layer,std::move(update))){}
macfx::PresentationDisplayLink::~PresentationDisplayLink(){invalidate();}
void macfx::PresentationDisplayLink::resume(){if(!impl->state->invalidated&&impl->state->paused.exchange(false))impl->apply();}
void macfx::PresentationDisplayLink::pause(){if(!impl->state->paused.exchange(true))impl->apply();}
void macfx::PresentationDisplayLink::invalidate(){if(!impl||impl->state->invalidated.exchange(true))return;id retained=impl->driver;
    dispatch_async(dispatch_get_main_queue(),^{if(@available(macOS 14.0,*))[(MacFXPresentationDisplayLink*)retained invalidate];});}
void macfx::PresentationDisplayLink::setDisplay(uint32_t display){if(impl->state->display.exchange(display)==display)return;id retained=impl->driver;
    dispatch_async(dispatch_get_main_queue(),^{if(@available(macOS 14.0,*))[(MacFXPresentationDisplayLink*)retained applyDisplay];});}
