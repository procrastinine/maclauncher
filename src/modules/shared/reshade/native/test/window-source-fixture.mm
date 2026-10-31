// The picked-window source end to end, except the picker: this fixture
// captures its own test-pattern window through the current-process
// shareable content and the same rsWindowSource* calls the session helper
// uses. Arguments: <empty scratch directory>.
#import <Cocoa/Cocoa.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include "window-source.h"
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <dirent.h>
#include <unistd.h>

static RSWindowSourceStatus poll(void *handle){
    RSWindowSourceStatus status{};status.size=sizeof(status);status.version=RS_WINDOW_SOURCE_ABI_VERSION;
    assert(rsWindowSourcePoll(handle,&status)==1);return status;
}
static RSWindowSourceStatus until(void *handle,double seconds,bool(^done)(const RSWindowSourceStatus&)){
    const double deadline=CACurrentMediaTime()+seconds;RSWindowSourceStatus status=poll(handle);
    while(!done(status)&&CACurrentMediaTime()<deadline)@autoreleasepool{CFRunLoopRunInMode(kCFRunLoopDefaultMode,.1,false);status=poll(handle);}
    return status;
}
static void expect(const RSWindowSourceStatus &status,uint32_t state,const char *what){
    if(status.state==state)return;
    std::fprintf(stderr,"%s: state %u, expected %u: %s\n",what,status.state,state,status.reason);std::fflush(stderr);_exit(134);
}
static bool empty(const char *directory){
    DIR *dir=opendir(directory);if(!dir)return false;unsigned entries=0;
    while(dirent *entry=readdir(dir))if(strcmp(entry->d_name,".")&&strcmp(entry->d_name,".."))++entries;
    closedir(dir);return !entries;
}
int main(int argc,char **argv){@autoreleasepool{
    if(argc!=2){std::fputs("usage: window-source-fixture <empty scratch directory>\n",stderr);return 2;}
    if(@available(macOS 14.4,*)){}else{std::puts("skipped: current-process capture needs macOS 14.4");return 0;}
    // A regular app, so that its window can be minimized like any app's.
    [NSApplication sharedApplication];NSApp.activationPolicy=NSApplicationActivationPolicyRegular;
    NSWindow *window=nil;
    @autoreleasepool{
        window=[[NSWindow alloc]initWithContentRect:NSMakeRect(200,200,320,200) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskMiniaturizable
            backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed=NO;window.contentView.wantsLayer=YES;window.contentView.layer.backgroundColor=NSColor.systemRedColor.CGColor;
        [window orderFrontRegardless];CFRunLoopRunInMode(kCFRunLoopDefaultMode,.3,false);
    }
    RSWindowSourceOptions options{sizeof(options),RS_WINDOW_SOURCE_ABI_VERSION,0,0,30};
    RSPresenterError error{sizeof(error),1,{}};
    void *handle=rsWindowSourceCreate(&options,&error);assert(handle&&rsWindowSourceOutputWindow(handle));
    assert(poll(handle).state==RS_WINDOW_SOURCE_WAITING);
    __block SCContentFilter *filter=nil;__block bool answered=false;const auto identifier=uint32_t(window.windowNumber);
    if(@available(macOS 14.4,*))[SCShareableContent getCurrentProcessShareableContentWithCompletionHandler:^(SCShareableContent *content,NSError*){
        for(SCWindow *candidate in content.windows)if(candidate.windowID==identifier)filter=[[SCContentFilter alloc]initWithDesktopIndependentWindow:candidate];
        answered=true;}];
    const double deadline=CACurrentMediaTime()+5;
    while(!answered&&CACurrentMediaTime()<deadline)CFRunLoopRunInMode(kCFRunLoopDefaultMode,.05,false);
    assert(filter);
    RSWindowSourceTarget target{sizeof(target),RS_WINDOW_SOURCE_ABI_VERSION,(__bridge void*)filter,identifier,0};
    RSWindowSourceTarget both=target;both.displayID=1;assert(!rsWindowSourceSelect(handle,&both,&error)); // One target only.
    assert(rsWindowSourceSelect(handle,&target,&error));
    auto status=until(handle,8,^bool(const RSWindowSourceStatus &s){return s.state==RS_WINDOW_SOURCE_FAILED||(s.revealed&&s.presentedReal>2);});
    if(status.state==RS_WINDOW_SOURCE_FAILED)std::fprintf(stderr,"window source failed: %s\n",status.reason);
    assert(status.state==RS_WINDOW_SOURCE_RUNNING&&status.revealed&&status.presentedReal>2);
    assert(status.pixelsWidth==unsigned(320*window.backingScaleFactor)&&status.pixelsHeight>=unsigned(200*window.backingScaleFactor));
    // Minimized window: the overlay hides and the session is kept. A window
    // that leaves the window list, as an ordered-out one does, is closed.
    @autoreleasepool{[window miniaturize:nil];}status=until(handle,3,^bool(const RSWindowSourceStatus &s){return s.state==RS_WINDOW_SOURCE_HIDDEN;});
    expect(status,RS_WINDOW_SOURCE_HIDDEN,"minimized window");
    @autoreleasepool{[window deminiaturize:nil];}status=until(handle,4,^bool(const RSWindowSourceStatus &s){return s.state==RS_WINDOW_SOURCE_RUNNING;});
    expect(status,RS_WINDOW_SOURCE_RUNNING,"restored window");
    // Suspension (sleep, lock) stops capture; resuming restarts it.
    options.suspended=1;assert(rsWindowSourceSetOptions(handle,&options));assert(poll(handle).state==RS_WINDOW_SOURCE_SUSPENDED);
    options.suspended=0;assert(rsWindowSourceSetOptions(handle,&options));
    status=until(handle,8,^bool(const RSWindowSourceStatus &s){return s.revealed&&s.presentedReal>0;});assert(status.state==RS_WINDOW_SOURCE_RUNNING);
    // A closed window that its process still keeps has a window-server
    // description, like a minimized one, so it counts as hidden. The source
    // reports "The window closed" once the description is gone, which this
    // process cannot force for its own window.
    [window close];status=until(handle,2,^bool(const RSWindowSourceStatus &s){return s.state==RS_WINDOW_SOURCE_HIDDEN;});
    expect(status,RS_WINDOW_SOURCE_HIDDEN,"closed but retained window");
    rsWindowSourceDestroy(handle);
    for(unsigned i=0;i<5;++i)CFRunLoopRunInMode(kCFRunLoopDefaultMode,.05,false);
    // Without diagnostics no capture image or file is written.
    assert(empty(argv[1]));
    std::puts("window source: own-window capture presented, minimize/restore, suspend/resume and retained close passed; no files written");
    return 0;
}}
