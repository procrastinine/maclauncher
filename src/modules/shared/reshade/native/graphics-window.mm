// maclauncher-graphics-window: applies the graphics stack to a window or a
// display that the user picks with the system content picker. One process
// serves one session; MacLauncher starts it as the session's process and
// removes the session's library entry when it exits.
//   --list-applications [--exclude-pid PID]   running apps, front to back (JSON)
//   --installed BUNDLE-ID...                  which apps are still installed (JSON)
//   --pid PID [--owner-only] [--scaled] | --display  [--library PATH] [--cursor] [--capture-rate FPS] [--wait-window SECONDS]
// Session events are JSON lines on standard output, with a heartbeat every
// second. Standard input takes option lines such as {"cursor":true} or
// {"scaled":false}; its end stops the session. A window shown in place needs
// no permission: the picker is the consent, and window tracking reads
// window-server metadata. Scaled output posts pointer events to the window's
// app, which needs Accessibility. A display needs Screen Recording so that
// its capture can leave out this session's own overlay.
#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include "window-source.h"
#include <cerrno>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <initializer_list>
#include <libproc.h>
#include <sys/stat.h>
#include <unistd.h>

namespace {
void emit(NSDictionary *object){
    NSData *data=[NSJSONSerialization dataWithJSONObject:object options:NSJSONWritingSortedKeys error:nil];
    if(data){fwrite(data.bytes,1,data.length,stdout);fputc('\n',stdout);fflush(stdout);}
}
// Scaled output forwards the pointer with posted events. MacLauncher asks
// for Accessibility when Scaled is chosen; without it the window stays in
// place and the session reports why.
uint32_t scaledFlags(uint32_t flags,bool scaled){
    if(scaled&&CGPreflightPostEventAccess())return flags|RS_WINDOW_SOURCE_SCALED;
    if(scaled)emit(@{@"event":@"output",@"output":@"in-place",@"reason":@"Scaled output needs the Accessibility permission"});
    return flags&~uint32_t(RS_WINDOW_SOURCE_SCALED);
}
[[noreturn]] void finish(int status,NSString *event,NSString *reason=nil){
    NSMutableDictionary *value=[@{@"event":event} mutableCopy];if(reason.length)value[@"reason"]=reason;emit(value);
    fflush(stdout);_exit(status);
}
double option(NSString *text,double minimum,double maximum){
    char *end=nullptr;errno=0;const double value=strtod(text.UTF8String,&end);
    if(!text.length||!end||*end||errno||!std::isfinite(value)||value<minimum||value>maximum)finish(2,@"failed",@"Invalid window graphics option");
    return value;
}
// Front-to-back order of each app's frontmost on-screen window approximates
// the most recently active apps first.
NSArray<NSRunningApplication*> *frontToBack(NSArray<NSRunningApplication*> *apps){
    NSMutableArray<NSNumber*> *order=[NSMutableArray array];
    NSArray *windows=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements,kCGNullWindowID));
    for(NSDictionary *info in windows){NSNumber *pid=info[(__bridge NSString*)kCGWindowOwnerPID];
        if([info[(__bridge NSString*)kCGWindowLayer] intValue]==0&&pid&&![order containsObject:pid])[order addObject:pid];}
    return [apps sortedArrayUsingComparator:^NSComparisonResult(NSRunningApplication *a,NSRunningApplication *b){
        const auto ia=[order indexOfObject:@(a.processIdentifier)],ib=[order indexOfObject:@(b.processIdentifier)];
        if(ia!=ib)return ia<ib?NSOrderedAscending:NSOrderedDescending;
        return [a.localizedName?:@"" localizedCaseInsensitiveCompare:b.localizedName?:@""];
    }];
}
int listApplications(pid_t excluded){
    NSRunningApplication *launcher=excluded>0?[NSRunningApplication runningApplicationWithProcessIdentifier:excluded]:nil;
    NSMutableArray *rows=[NSMutableArray array];
    for(NSRunningApplication *app in frontToBack(NSWorkspace.sharedWorkspace.runningApplications)){
        if(app.activationPolicy!=NSApplicationActivationPolicyRegular||app.terminated||app.processIdentifier<=0||app.processIdentifier==getpid()||app.processIdentifier==excluded)continue;
        if(launcher.bundleIdentifier&&[app.bundleIdentifier isEqualToString:launcher.bundleIdentifier])continue;
        NSMutableDictionary *row=[@{@"name":app.localizedName?:app.executableURL.lastPathComponent?:@"Application",@"pid":@(app.processIdentifier),
            @"active":@(app.active)} mutableCopy];
        if(app.bundleIdentifier)row[@"bundleIdentifier"]=app.bundleIdentifier;
        if(app.bundleURL.path)row[@"path"]=app.bundleURL.path;else if(app.executableURL.path)row[@"path"]=app.executableURL.path;
        if(app.executableURL.path)row[@"executable"]=app.executableURL.path;
        [rows addObject:row];
    }
    NSData *data=[NSJSONSerialization dataWithJSONObject:@{@"schema":@1,@"applications":rows} options:NSJSONWritingSortedKeys error:nil];
    fwrite(data.bytes,1,data.length,stdout);fputc('\n',stdout);return fflush(stdout)?1:0;
}
int installed(NSArray<NSString*> *identifiers){
    NSMutableDictionary *result=[NSMutableDictionary dictionary];
    for(NSString *identifier in identifiers)result[identifier]=@([NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:identifier]!=nil);
    NSData *data=[NSJSONSerialization dataWithJSONObject:@{@"schema":@1,@"installed":result} options:NSJSONWritingSortedKeys error:nil];
    fwrite(data.bytes,1,data.length,stdout);fputc('\n',stdout);return fflush(stdout)?1:0;
}
struct Core {
    decltype(&rsWindowSourceCreate)create=nullptr;decltype(&rsWindowSourceOutputWindow)outputWindow=nullptr;
    decltype(&rsWindowSourceSelect)select=nullptr;decltype(&rsWindowSourceSetOptions)setOptions=nullptr;
    decltype(&rsWindowSourcePoll)poll=nullptr;decltype(&rsWindowSourceDestroy)destroy=nullptr;
    void *handle=nullptr;
    // The session declares itself an explicit host before any frame call, as
    // the video tool does. The launch environment also carries the same value.
    void open(NSString *path){
        void *library=dlopen(path.fileSystemRepresentation,RTLD_NOW|RTLD_LOCAL);
        if(!library)finish(3,@"failed",@"The graphics runtime could not be loaded");
        const auto explicitHost=reinterpret_cast<int(*)(uint32_t,int)>(dlsym(library,"rsSetExplicitHost"));
        const auto api=reinterpret_cast<unsigned(*)()>(dlsym(library,"rsWindowSourceAPI"));
        if(!explicitHost||explicitHost(1,1)!=1||!api||api()!=RS_WINDOW_SOURCE_ABI_VERSION)finish(3,@"failed",@"The graphics runtime does not support window graphics");
        create=reinterpret_cast<decltype(create)>(dlsym(library,"rsWindowSourceCreate"));
        outputWindow=reinterpret_cast<decltype(outputWindow)>(dlsym(library,"rsWindowSourceOutputWindow"));
        select=reinterpret_cast<decltype(select)>(dlsym(library,"rsWindowSourceSelect"));
        setOptions=reinterpret_cast<decltype(setOptions)>(dlsym(library,"rsWindowSourceSetOptions"));
        poll=reinterpret_cast<decltype(poll)>(dlsym(library,"rsWindowSourcePoll"));
        destroy=reinterpret_cast<decltype(destroy)>(dlsym(library,"rsWindowSourceDestroy"));
        if(!create||!outputWindow||!select||!setOptions||!poll||!destroy)finish(3,@"failed",@"The graphics runtime does not support window graphics");
    }
};
NSString *libraryPath(NSString *requested){
    if(requested.length)return requested;
    for(NSString *file in [NSProcessInfo.processInfo.environment[@"DYLD_INSERT_LIBRARIES"] componentsSeparatedByString:@":"])
        if([file.lastPathComponent isEqualToString:@"libreshade-macos.dylib"])return file;
    NSString *executable=NSProcessInfo.processInfo.arguments.firstObject.stringByStandardizingPath;
    return [executable.stringByDeletingLastPathComponent stringByAppendingPathComponent:@"libreshade-macos.dylib"];
}
// A layer-0 window of this process large enough to be a main window.
bool alive(pid_t pid){return pid>0&&(kill(pid,0)==0||errno==EPERM);}
uint32_t mainWindow(pid_t pid){
    NSArray *windows=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements,kCGNullWindowID));
    for(NSDictionary *info in windows){
        if([info[(__bridge NSString*)kCGWindowOwnerPID] intValue]!=pid||[info[(__bridge NSString*)kCGWindowLayer] intValue]!=0)continue;
        CGRect bounds=CGRectZero;CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)info[(__bridge NSString*)kCGWindowBounds],&bounds);
        if(bounds.size.width>=64&&bounds.size.height>=64)return [info[(__bridge NSString*)kCGWindowNumber] unsignedIntValue];
    }
    return 0;
}
NSString *stateName(uint32_t state){
    static NSArray *names=@[@"waiting",@"running",@"hidden",@"off",@"suspended",@"failed",@"closed"];
    return state<names.count?names[state]:@"unknown";
}
}

@interface MacFXWindowGraphicsSession : NSObject<SCContentSharingPickerObserver>
@end
@implementation MacFXWindowGraphicsSession {
    Core _core;RSWindowSourceOptions _options;
    pid_t _target,_parent;bool _display,_offered,_picking,_ownerOnly;double _wait;
    uint32_t _lastState;NSString *_lastReason;NSTimer *_timer,*_heartbeat;dispatch_source_t _input;NSMutableArray *_signals;NSMutableData *_line;
}
- (instancetype)initWithArguments:(NSArray<NSString*>*)arguments {
    if(!(self=[super init]))return nil;
    _options={sizeof(RSWindowSourceOptions),RS_WINDOW_SOURCE_ABI_VERSION,0,0,0};_lastState=~0u;_parent=getppid();_signals=[NSMutableArray array];
    NSString *library=nil;bool scaled=false;
    for(NSUInteger i=0;i<arguments.count;++i){
        NSString *key=arguments[i];
        auto value=[&]()->NSString*{if(i+1>=arguments.count)finish(2,@"failed",@"Invalid window graphics option");return arguments[++i];};
        if([key isEqualToString:@"--pid"])_target=pid_t(option(value(),1,INT32_MAX));
        else if([key isEqualToString:@"--display"])_display=true;
        else if([key isEqualToString:@"--owner-only"])_ownerOnly=true;
        else if([key isEqualToString:@"--library"])library=value();
        else if([key isEqualToString:@"--cursor"])_options.flags|=RS_WINDOW_SOURCE_CURSOR;
        else if([key isEqualToString:@"--scaled"])scaled=true;
        else if([key isEqualToString:@"--capture-rate"])_options.captureRate=option(value(),0,1000);
        else if([key isEqualToString:@"--wait-window"])_wait=option(value(),0,600);
        else finish(2,@"failed",[@"Unknown window graphics option: " stringByAppendingString:key]);
    }
    if(_display==(_target>0))finish(2,@"failed",@"Choose an application or a display");
    if(_target&&!alive(_target))finish(0,@"closed",@"The application is not running");
    if(scaled&&!_display)_options.flags=scaledFlags(_options.flags,true);
    _core.open(libraryPath(library));
    RSPresenterError error{sizeof(RSPresenterError),1,{}};
    _core.handle=_core.create(&_options,&error);
    if(!_core.handle)finish(3,@"failed",[NSString stringWithUTF8String:error.reason]?:@"The window overlay could not be created");
    return self;
}
- (void)start {
    [self watchLifecycle];
    // MacLauncher ends a session whose heartbeat stops, which also removes
    // its overlay with the process.
    _heartbeat=[NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer*){emit(@{@"event":@"heartbeat"});}];
    if(_wait>0&&!_display)[self waitForWindow:_wait];else [self presentPicker];
}
- (void)stopWithStatus:(int)status event:(NSString*)event reason:(NSString*)reason {
    [_timer invalidate];_timer=nil;[_heartbeat invalidate];_heartbeat=nil;
    if(_core.handle){_core.destroy(_core.handle);_core.handle=nullptr;}
    finish(status,event,reason);
}
- (void)watchLifecycle {
    // Stop from the library, MacLauncher quitting and the target app quitting
    // all end the session; the window it processed is never changed.
    for(int number:{SIGTERM,SIGINT,SIGHUP}){
        signal(number,SIG_IGN);dispatch_source_t source=dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL,number,0,dispatch_get_main_queue());
        dispatch_source_set_event_handler(source,^{[self stopWithStatus:0 event:@"stopped" reason:nil];});dispatch_resume(source);[_signals addObject:source];
    }
    struct stat input{};
    if(!fstat(STDIN_FILENO,&input)&&(S_ISFIFO(input.st_mode)||S_ISSOCK(input.st_mode))){
        _input=dispatch_source_create(DISPATCH_SOURCE_TYPE_READ,STDIN_FILENO,0,dispatch_get_main_queue());
        _line=[NSMutableData data];
        dispatch_source_set_event_handler(_input,^{char bytes[4096];const auto count=read(STDIN_FILENO,bytes,sizeof(bytes));
            if(count==0||(count<0&&errno!=EAGAIN&&errno!=EINTR))[self stopWithStatus:0 event:@"stopped" reason:nil];
            if(count>0)[self receive:bytes length:size_t(count)];});
        dispatch_resume(_input);
    }
    NSNotificationCenter *center=NSWorkspace.sharedWorkspace.notificationCenter;
    [center addObserverForName:NSWorkspaceDidTerminateApplicationNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note){
        NSRunningApplication *app=note.userInfo[NSWorkspaceApplicationKey];
        if(self->_target&&app.processIdentifier==self->_target)[self stopWithStatus:0 event:@"closed" reason:@"The application quit"];
    }];
    for(NSNotificationName name in @[NSWorkspaceWillSleepNotification,NSWorkspaceScreensDidSleepNotification,NSWorkspaceSessionDidResignActiveNotification])
        [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification*){[self suspend:true];}];
    for(NSNotificationName name in @[NSWorkspaceDidWakeNotification,NSWorkspaceScreensDidWakeNotification,NSWorkspaceSessionDidBecomeActiveNotification])
        [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification*){[self suspend:false];}];
}
// Option lines from MacLauncher apply live; a malformed line is ignored.
- (void)receive:(const char*)bytes length:(size_t)length {
    for(size_t i=0;i<length;++i){
        if(bytes[i]!='\n'){if(_line.length<16384)[_line appendBytes:bytes+i length:1];continue;}
        NSDictionary *value=[NSJSONSerialization JSONObjectWithData:_line options:0 error:nil];_line.length=0;
        if(![value isKindOfClass:NSDictionary.class])continue;
        RSWindowSourceOptions next=_options;
        if([value[@"cursor"] isKindOfClass:NSNumber.class])next.flags=[value[@"cursor"] boolValue]?next.flags|RS_WINDOW_SOURCE_CURSOR:next.flags&~uint32_t(RS_WINDOW_SOURCE_CURSOR);
        if(!_display&&[value[@"scaled"] isKindOfClass:NSNumber.class])next.flags=scaledFlags(next.flags,[value[@"scaled"] boolValue]);
        if(next.flags!=_options.flags){_options=next;_core.setOptions(_core.handle,&_options);[self poll];}
    }
}
- (void)suspend:(bool)value {
    if(bool(_options.suspended)==value)return;_options.suspended=value;_core.setOptions(_core.handle,&_options);[self poll];
}
- (void)waitForWindow:(double)seconds {
    // A launcher window can give way to the game window, and some games
    // recreate their window when changing modes. The picker opens once for
    // the first new window; cancelling or the time limit ends the session.
    const double deadline=NSProcessInfo.processInfo.systemUptime+seconds;
    _timer=[NSTimer scheduledTimerWithTimeInterval:.25 repeats:YES block:^(NSTimer *timer){
        const auto window=mainWindow(self->_target);
        if(window){[timer invalidate];self->_timer=nil;[self presentPicker];}
        else if(!alive(self->_target))[self stopWithStatus:0 event:@"closed" reason:@"The application quit"];
        else if(NSProcessInfo.processInfo.systemUptime>deadline||getppid()!=self->_parent)[self stopWithStatus:0 event:@"closed" reason:@"No new window opened"];
    }];
}
- (void)presentPicker {
    SCContentSharingPicker *picker=SCContentSharingPicker.sharedPicker;
    auto configuration=[SCContentSharingPickerConfiguration new];
    configuration.allowedPickerModes=_display?SCContentSharingPickerModeSingleDisplay:SCContentSharingPickerModeSingleWindow;
    configuration.allowsChangingSelectedContent=NO;
    // Only the chosen app's windows are offered. For a display, MacLauncher
    // and this session stay out of the captured image.
    NSMutableArray<NSString*> *excluded=[NSMutableArray array];
    NSRunningApplication *target=_target?[NSRunningApplication runningApplicationWithProcessIdentifier:_target]:nil;
    NSRunningApplication *launcher=[NSRunningApplication runningApplicationWithProcessIdentifier:_parent];
    if(NSString *own=NSBundle.mainBundle.bundleIdentifier)[excluded addObject:own];
    if(launcher.bundleIdentifier)[excluded addObject:launcher.bundleIdentifier];
    if(!_display)for(NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications)
        if(app.bundleIdentifier&&![app.bundleIdentifier isEqualToString:target.bundleIdentifier]&&![excluded containsObject:app.bundleIdentifier])[excluded addObject:app.bundleIdentifier];
    configuration.excludedBundleIDs=excluded;
    configuration.excludedWindowIDs=@[@(_core.outputWindow(_core.handle))];
    picker.defaultConfiguration=configuration;picker.maximumStreamCount=@1;
    [picker addObserver:self];picker.active=YES;_picking=true;
    emit(@{@"event":@"picking",@"mode":_display?@"display":@"window"});
    [picker presentPickerUsingContentStyle:_display?SCShareableContentStyleDisplay:SCShareableContentStyleWindow];
}
- (void)contentSharingPicker:(SCContentSharingPicker*)picker didCancelForStream:(SCStream*)stream {
    dispatch_async(dispatch_get_main_queue(),^{if(!self->_picking)return;self->_picking=false;[self stopWithStatus:0 event:@"cancelled" reason:nil];});
}
- (void)contentSharingPickerStartDidFailWithError:(NSError*)error {
    NSString *reason=error.localizedDescription?:@"The window picker could not open";
    dispatch_async(dispatch_get_main_queue(),^{[self stopWithStatus:4 event:@"failed" reason:reason];});
}
- (void)contentSharingPicker:(SCContentSharingPicker*)picker didUpdateWithFilter:(SCContentFilter*)filter forStream:(SCStream*)stream {
    dispatch_async(dispatch_get_main_queue(),^{
        if(!self->_picking)return;self->_picking=false;picker.active=NO;
        NSMutableDictionary *event=[@{@"event":@"selected"} mutableCopy];
        RSWindowSourceTarget target{sizeof(RSWindowSourceTarget),RS_WINDOW_SOURCE_ABI_VERSION,(__bridge void*)filter,0,0};
        if(self->_display){
            if(SCDisplay *display=filter.includedDisplays.firstObject){[self selectDisplay:display.displayID];return;}
            [self stopWithStatus:4 event:@"failed" reason:@"The picked content is not a single window or display"];
        }
        if(SCWindow *window=filter.includedWindows.firstObject){
            target.windowID=window.windowID;event[@"windowID"]=@(window.windowID);
            // A process without a bundle identifier can pass the exclusion
            // list; the session then follows the app that owns the pick. A
            // library game's companion accepts only the game's own window.
            if(SCRunningApplication *owner=window.owningApplication){
                if(self->_ownerOnly&&owner.processID!=self->_target)
                    [self stopWithStatus:0 event:@"cancelled" reason:@"The picked window does not belong to the game"];
                event[@"pid"]=@(owner.processID);if(owner.bundleIdentifier.length)event[@"bundleIdentifier"]=owner.bundleIdentifier;
                if(owner.applicationName.length)event[@"name"]=owner.applicationName;self->_target=owner.processID;
                char executable[PROC_PIDPATHINFO_MAXSIZE]{};
                if(proc_pidpath(owner.processID,executable,sizeof(executable))>0)if(NSString *path=[NSString stringWithUTF8String:executable])event[@"executable"]=path;
            }
        }
        if(!target.windowID)[self stopWithStatus:4 event:@"failed" reason:@"The picked content is not a single window or display"];
        [self selectTarget:&target event:event];
    });
}
- (void)selectTarget:(RSWindowSourceTarget*)target event:(NSDictionary*)event {
    RSPresenterError error{sizeof(RSPresenterError),1,{}};
    if(!_core.select(_core.handle,target,&error))[self stopWithStatus:4 event:@"failed" reason:[NSString stringWithUTF8String:error.reason]];
    emit(event);
    _timer=[NSTimer scheduledTimerWithTimeInterval:.1 repeats:YES block:^(NSTimer*){[self poll];}];
    [self poll];
}
// The picker's display filter would also capture this session's overlay and
// feed each processed image back into the next one. A filter that leaves out
// this process needs the Screen Recording permission, asked for once.
- (void)selectDisplay:(CGDirectDisplayID)identifier {
    if(!CGPreflightScreenCaptureAccess()&&!CGRequestScreenCaptureAccess())
        [self stopWithStatus:5 event:@"failed" reason:@"Entire Display needs the Screen & System Audio Recording permission in System Settings > Privacy & Security"];
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:NO completionHandler:^(SCShareableContent *content,NSError *failure){
        dispatch_async(dispatch_get_main_queue(),^{
            SCDisplay *display=nil;SCRunningApplication *own=nil;NSMutableArray<SCWindow*> *overlay=[NSMutableArray array];
            for(SCDisplay *value in content.displays)if(value.displayID==identifier)display=value;
            for(SCRunningApplication *value in content.applications)if(value.processID==getpid())own=value;
            const uint32_t window=self->_core.outputWindow(self->_core.handle);
            for(SCWindow *value in content.windows)if(value.windowID==window)[overlay addObject:value];
            if(!display||(!own&&!overlay.count))[self stopWithStatus:5 event:@"failed" reason:failure.localizedDescription?:
                @"Entire Display needs the Screen & System Audio Recording permission in System Settings > Privacy & Security"];
            SCContentFilter *excluding=own?[[SCContentFilter alloc]initWithDisplay:display excludingApplications:@[own] exceptingWindows:@[]]
                :[[SCContentFilter alloc]initWithDisplay:display excludingWindows:overlay];
            RSWindowSourceTarget target{sizeof(RSWindowSourceTarget),RS_WINDOW_SOURCE_ABI_VERSION,(__bridge void*)excluding,0,identifier};
            [self selectTarget:&target event:@{@"event":@"selected",@"displayID":@(identifier)}];
        });
    }];
}
- (void)poll {
    if(!_core.handle||_picking)return;
    if(getppid()!=_parent){[self stopWithStatus:0 event:@"stopped" reason:@"MacLauncher quit"];return;}
    RSWindowSourceStatus status{};status.size=sizeof(status);status.version=RS_WINDOW_SOURCE_ABI_VERSION;
    _core.poll(_core.handle,&status);
    NSString *reason=[NSString stringWithUTF8String:status.reason]?:@"";
    if(status.state!=_lastState||![reason isEqualToString:_lastReason?:@""]){
        _lastState=status.state;_lastReason=reason;
        NSMutableDictionary *event=[@{@"event":@"state",@"state":stateName(status.state)} mutableCopy];if(reason.length)event[@"reason"]=reason;emit(event);
    }
    if(status.state!=RS_WINDOW_SOURCE_CLOSED)return;
    if(_display||_offered||!alive(_target)){
        [self stopWithStatus:0 event:@"closed" reason:reason];return;
    }
    // The picker reopens once if the same app opens a new window within ten
    // seconds. The closed window's session has ended; a pick starts a new one.
    _offered=true;[_timer invalidate];_timer=nil;
    emit(@{@"event":@"waiting-for-window"});
    [self waitForWindow:10];
}
@end

int main(int argc,const char **argv){@autoreleasepool{
    NSMutableArray<NSString*> *arguments=[NSMutableArray array];
    for(int i=1;i<argc;++i)[arguments addObject:[NSString stringWithUTF8String:argv[i]]?:@""];
    if(arguments.count&&[arguments[0] isEqualToString:@"--list-applications"]){
        pid_t excluded=0;
        if(arguments.count==3&&[arguments[1] isEqualToString:@"--exclude-pid"])excluded=pid_t(option(arguments[2],1,INT32_MAX));
        else if(arguments.count!=1)finish(2,@"failed",@"Invalid window graphics option");
        return listApplications(excluded);
    }
    if(arguments.count&&[arguments[0] isEqualToString:@"--installed"])
        return installed([arguments subarrayWithRange:NSMakeRange(1,arguments.count-1)]);
    [NSApplication sharedApplication];
    NSApp.activationPolicy=NSApplicationActivationPolicyAccessory;
    static MacFXWindowGraphicsSession *session=[[MacFXWindowGraphicsSession alloc]initWithArguments:arguments];
    dispatch_async(dispatch_get_main_queue(),^{[session start];});
    [NSApp run];
    return 0;
}}
