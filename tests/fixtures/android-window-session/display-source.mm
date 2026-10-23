#import <AppKit/AppKit.h>
#include "clock/display-clock.h"
#include <atomic>
#include <cassert>
#include <cstdio>
#include <unistd.h>

static std::atomic<unsigned> wakes;
static void wake(void*){++wakes;}
int main(){@autoreleasepool{
 [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
 NSWindow *window=[[NSWindow alloc] initWithContentRect:NSMakeRect(20,20,64,64) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO screen:NSScreen.mainScreen];
 window.releasedWhenClosed=NO;
 [window orderBack:nil];
 char error[256]={0};KLDisplayClock *clock=kl_display_clock_create((__bridge void*)window,error,sizeof error);if(!clock){std::fprintf(stderr,"%s\n",error);return 1;}
 assert(kl_display_clock_set_wake(clock,wake,nullptr,error,sizeof error));
 assert(kl_display_clock_set_demand(clock,1,error,sizeof error));
 uint64_t cursor=0,began=kl_display_clock_monotonic_now();unsigned frames=0;
 while(kl_display_clock_monotonic_now()-began<1000000000){
  KLDisplayTick tick{};if(kl_display_clock_sample(clock,&cursor,&tick)){
   assert(tick.callbackTimeNanos>=began&&tick.callbackTimeNanos<=kl_display_clock_monotonic_now());
   assert(tick.intervalNanos>0&&tick.predictedOutputTimeNanos>=tick.callbackTimeNanos);frames++;
  }usleep(1000);
 }
 std::printf("physicalClock wakes=%u frames=%u detail=%s\n",wakes.load(),frames,error);
 assert(frames>=2&&wakes>=frames);assert(kl_display_clock_set_demand(clock,0,error,sizeof error));assert(kl_display_clock_destroy(clock,error,sizeof error));
 [window close];std::puts("PASS actual background Mac display clock publishes current uptime ticks and retires demand");
}}
