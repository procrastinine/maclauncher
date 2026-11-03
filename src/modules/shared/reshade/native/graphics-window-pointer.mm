#include "graphics-window-pointer.hpp"
#import <AppKit/AppKit.h>
#include <dlfcn.h>
#include <mutex>
#include <thread>
namespace macfx {
struct PointerConstraint::Impl {
 std::mutex mutex;WindowRect rect;bool active=false;PointerMotion motion;unsigned hides=0;
 CFMachPortRef tap=nullptr;CFRunLoopRef loop=nullptr;std::thread thread;double hiddenAt=0;
 static CGEventRef event(CGEventTapProxy,CGEventType type,CGEventRef e,void*c){auto&s=*static_cast<Impl*>(c);std::lock_guard<std::mutex>lock(s.mutex);
  if(type==kCGEventTapDisabledByTimeout||type==kCGEventTapDisabledByUserInput){if(s.tap)CGEventTapEnable(s.tap,true);return e;}
  if(!s.active)return e;
  auto p=CGEventGetLocation(e);
  if(type==kCGEventMouseMoved){s.motion.moved(p.x,p.y,CGEventGetIntegerValueField(e,kCGMouseEventDeltaX),CGEventGetIntegerValueField(e,kCGMouseEventDeltaY));}
  auto q=CGPointMake(std::clamp(p.x,s.rect.x+.5,s.rect.x+s.rect.width-.5),std::clamp(p.y,s.rect.y+.5,s.rect.y+s.rect.height-.5));
  if(q.x!=p.x||q.y!=p.y){CGEventSetLocation(e,q);CGWarpMouseCursorPosition(q);}return e;
 }
 void cursor(bool enabled){
  const double now=NSProcessInfo.processInfo.systemUptime;
  if(enabled&&(!hides||now-hiddenAt>=.5)){CGDisplayHideCursor(kCGDirectMainDisplay);++hides;hiddenAt=now;}
  if(!enabled)while(hides){CGDisplayShowCursor(kCGDirectMainDisplay);--hides;}
 }
 Impl(){
  using Connection=int(*)();using Property=int(*)(int,int,CFStringRef,CFTypeRef);
  auto connection=reinterpret_cast<Connection>(dlsym(RTLD_DEFAULT,"CGSMainConnectionID"));auto property=reinterpret_cast<Property>(dlsym(RTLD_DEFAULT,"CGSSetConnectionProperty"));
  if(connection&&property)property(connection(),connection(),CFSTR("SetsCursorInBackground"),kCFBooleanTrue);
  dispatch_semaphore_t started=dispatch_semaphore_create(0);
  thread=std::thread([this,started]{@autoreleasepool{auto mask=CGEventMaskBit(kCGEventMouseMoved)|CGEventMaskBit(kCGEventLeftMouseDragged)|CGEventMaskBit(kCGEventRightMouseDragged)|CGEventMaskBit(kCGEventOtherMouseDragged)|CGEventMaskBit(kCGEventLeftMouseDown)|CGEventMaskBit(kCGEventLeftMouseUp)|CGEventMaskBit(kCGEventRightMouseDown)|CGEventMaskBit(kCGEventRightMouseUp)|CGEventMaskBit(kCGEventOtherMouseDown)|CGEventMaskBit(kCGEventOtherMouseUp);
   auto port=CGEventTapCreate(kCGSessionEventTap,kCGHeadInsertEventTap,kCGEventTapOptionDefault,mask,event,this);
   {std::lock_guard<std::mutex>lock(mutex);tap=port;loop=CFRunLoopGetCurrent();CFRetain(loop);dispatch_semaphore_signal(started);}
   if(port){auto source=CFMachPortCreateRunLoopSource(nullptr,port,0);CFRunLoopAddSource(CFRunLoopGetCurrent(),source,kCFRunLoopCommonModes);CFRunLoopRun();CFRunLoopRemoveSource(CFRunLoopGetCurrent(),source,kCFRunLoopCommonModes);CFRelease(source);CFRelease(port);}
  }});dispatch_semaphore_wait(started,DISPATCH_TIME_FOREVER);
 }
 ~Impl(){CFRunLoopRef run=nullptr;{std::lock_guard<std::mutex>lock(mutex);active=false;cursor(false);run=loop;if(run){CFRunLoopPerformBlock(run,kCFRunLoopCommonModes,^{CFRunLoopStop(run);});CFRunLoopWakeUp(run);}}if(thread.joinable())thread.join();if(loop)CFRelease(loop);}
};
PointerPosition PointerConstraint::update(WindowRect rect,int pid,bool shown){
 const bool active=shown&&windowRectValid(rect)&&NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==pid;
 if(!impl&&!active)return {};if(!impl)impl=std::make_shared<Impl>();
 std::lock_guard<std::mutex>lock(impl->mutex);impl->rect=rect;impl->active=active&&impl->tap;
 if(!active){impl->motion={};}impl->cursor(impl->active);
 auto event=CGEventCreate(nullptr);auto p=event?CGEventGetLocation(event):CGPointZero;if(event)CFRelease(event);
 return {impl->active&&!impl->motion.held,p.x,p.y};
}
void PointerConstraint::stop(){impl.reset();}
PointerConstraint::~PointerConstraint(){stop();}
}
