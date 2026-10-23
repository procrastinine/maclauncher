#include "application-sleep.h"
#import <AppKit/AppKit.h>
#include <cstdio>
#include <cstdlib>
static void check(bool value,const char*text){if(!value){fprintf(stderr,"FAIL %s\n",text);exit(1);}}
static int drain(SDL_WindowID window,int expected){SDL_Event event;int count=0,value=-1;while(SDL_PeepEvents(&event,1,SDL_GETEVENT,SDL_EVENT_FIRST,SDL_EVENT_LAST)>0)if(kl_application_sleep_event(&event,window,&value)){check(value==expected,"notification payload");count++;}return count;}
int main(){@autoreleasepool{
 check(SDL_Init(SDL_INIT_EVENTS),"SDL events initialization");
 auto observer=kl_application_sleep_observe(17);check(observer,"workspace subscription");
 auto center=NSWorkspace.sharedWorkspace.notificationCenter;
 [center postNotificationName:NSWorkspaceWillSleepNotification object:nil];
 SDL_Event event;check(SDL_PeepEvents(&event,1,SDL_GETEVENT,SDL_EVENT_FIRST,SDL_EVENT_LAST)==1,"queued sleep");int value=-1;
 check(!kl_application_sleep_event(&event,18,&value),"another window cannot consume sleep");
 check(kl_application_sleep_event(&event,17,&value)&&value==1,"sleep uses the existing SDL queue");
 [center postNotificationName:NSWorkspaceDidWakeNotification object:nil];check(drain(17,0)==1,"queued wake");
 kl_application_sleep_retire(observer);
 [center postNotificationName:NSWorkspaceWillSleepNotification object:nil];check(drain(17,1)==0,"retired subscription emits no event");
 observer=kl_application_sleep_observe(19);check(observer,"replacement subscription");
 [center postNotificationName:NSWorkspaceDidWakeNotification object:nil];check(drain(19,0)==1,"new window receives wake once");
 kl_application_sleep_retire(observer);kl_application_sleep_retire(nullptr);SDL_Quit();
 puts("PASS workspace sleep/wake SDL delivery, window ownership and subscription retirement");return 0;
}}
