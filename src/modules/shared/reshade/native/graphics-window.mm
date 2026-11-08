// One window-graphics chain process. The shared capture service supplies
// IOSurfaces; the runtime core owns the unchanged graphics chain.
#import <AppKit/AppKit.h>
#include "window-capture-client.hpp"
#include "graphics-capture-service.hpp"
#include "graphics-window-pointer.hpp"
#include "window-source.h"
#include "graphics-window-catalog.hpp"
#include <algorithm>
#include <memory>
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
#include <vector>
#include <mutex>

namespace {
void emit(NSDictionary *object){
    NSData *data=[NSJSONSerialization dataWithJSONObject:object options:NSJSONWritingSortedKeys error:nil];
    if(data){fwrite(data.bytes,1,data.length,stdout);fputc('\n',stdout);fflush(stdout);}
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
    decltype(&rsWindowSourcePendingStops)pendingStops=nullptr;
    decltype(&rsWindowSourceSetOverlays)setOverlays=nullptr;decltype(&rsWindowSourceSubmit)submit=nullptr;decltype(&rsWindowSourceSetGeometry)setGeometry=nullptr;
    decltype(&rsWindowSourceCaptureInterval)captureInterval=nullptr;decltype(&rsWindowSourceSetPointer)setPointer=nullptr;
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
        setOverlays=reinterpret_cast<decltype(setOverlays)>(dlsym(library,"rsWindowSourceSetOverlays"));
        submit=reinterpret_cast<decltype(submit)>(dlsym(library,"rsWindowSourceSubmit"));
        setGeometry=reinterpret_cast<decltype(setGeometry)>(dlsym(library,"rsWindowSourceSetGeometry"));
        captureInterval=reinterpret_cast<decltype(captureInterval)>(dlsym(library,"rsWindowSourceCaptureInterval"));
        setPointer=reinterpret_cast<decltype(setPointer)>(dlsym(library,"rsWindowSourceSetPointer"));
        if(!setOverlays||!submit||!setGeometry||!captureInterval||!setPointer)finish(3,@"failed",@"The graphics runtime does not support forwarded window frames");
        pendingStops=reinterpret_cast<decltype(pendingStops)>(dlsym(library,"rsWindowSourcePendingStops"));
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
NSString *const ScreenRecordingReason=@"needs the Screen & System Audio Recording permission in System Settings > Privacy & Security";
// Seconds a capture may stay failed, for example while a resized window
// settles, before the session ends with the failure's reason.
constexpr double FailureGrace=5;
// Seconds a stopping session waits for its captures to stop before it exits.
constexpr double StopWait=1.5;
}

namespace {
// Stable ownership survives asynchronous content-list callbacks and vector edits.
struct WindowOutput {
    void *handle=nullptr;uint32_t feed=0;NSDictionary *request=nil;bool hold=true,lastRevealed=false;NSDictionary *sentOptions=nil;uint32_t currentState=0;double cropX=0,cropY=0;macfx::PointerConstraint pointer;
    NSString *identifier,*kind,*lastReason;
    uint32_t window=0,display=0,lastState=~0u;pid_t pid=0;
    bool selected=false,selecting=false,waiting=false,offered=false,direct=false,ownerOnly=false;
    double deadline=0,failedSince=0;
};
using Output=std::shared_ptr<WindowOutput>;
bool validNumber(id value,double minimum,double maximum){
    return [value isKindOfClass:NSNumber.class]&&std::isfinite([value doubleValue])&&
        [value doubleValue]>=minimum&&[value doubleValue]<=maximum&&std::floor([value doubleValue])==[value doubleValue];
}
}
@interface MacFXWindowGraphicsSession : NSObject
@end
@implementation MacFXWindowGraphicsSession {
    std::shared_ptr<macfx::wcap::Client> _client;std::mutex _feedMutex;uint32_t _nextFeed;NSString *_serviceID;bool _connected,_frontWindow,_showPointer;double _lastLoss,_overlaySent;
    Core _core;RSWindowSourceOptions _options;
    pid_t _parent;NSDictionary *_initial;
    bool _allDisplays,_ownerOnly,_selectingDisplays,_stopping;unsigned _requests;
    std::vector<Output> _outputs;Output _pickerTarget;
    NSTimer *_timer,*_heartbeat;dispatch_source_t _input;NSMutableArray *_signals;NSMutableData *_line;
}
- (instancetype)initWithArguments:(NSArray<NSString*>*)arguments {
    if(!(self=[super init]))return nil;
    _options={sizeof(RSWindowSourceOptions),RS_WINDOW_SOURCE_ABI_VERSION,0,0,0};_parent=getppid();_showPointer=true;_signals=[NSMutableArray array];_line=[NSMutableData data];
    NSString *library=nil;pid_t pid=0;uint32_t window=0,display=0;double wait=0;
    for(NSUInteger i=0;i<arguments.count;++i){
        NSString *key=arguments[i];
        auto value=[&]()->NSString*{if(i+1>=arguments.count)finish(2,@"failed",@"Invalid window graphics option");return arguments[++i];};
        if([key isEqualToString:@"--pid"])pid=pid_t(option(value(),1,INT32_MAX));
        else if([key isEqualToString:@"--window"])window=uint32_t(option(value(),1,UINT32_MAX));
        else if([key isEqualToString:@"--display"])display=uint32_t(option(value(),1,UINT32_MAX));
        else if([key isEqualToString:@"--all-displays"])_allDisplays=true;
        else if([key isEqualToString:@"--owner-only"])_ownerOnly=true;
        else if([key isEqualToString:@"--front-window"])_frontWindow=true;
        else if([key isEqualToString:@"--capture-service"])_serviceID=value();
        else if([key isEqualToString:@"--scale"])_options.scale=option(value(),0,10);
        else if([key isEqualToString:@"--library"])library=value();
        else if([key isEqualToString:@"--cursor"])_options.flags|=RS_WINDOW_SOURCE_CURSOR;
        else if([key isEqualToString:@"--scaled"])_options.flags|=RS_WINDOW_SOURCE_SCALED;
        else if([key isEqualToString:@"--capture-rate"])_options.captureRate=option(value(),0,1000);
        else if([key isEqualToString:@"--wait-window"])wait=option(value(),0,600);
        else finish(2,@"failed",[@"Unknown window graphics option: " stringByAppendingString:key]);
    }
    if(int(pid>0)+int(window>0)+int(display>0)+int(_allDisplays)!=1)finish(2,@"failed",@"Choose a window, an application or a display");
    _initial=window?@{@"target":@"window",@"windowID":@(window)}:display?@{@"target":@"display",@"displayID":@(display)}:
        @{@"target":@"application",@"pid":@(pid),@"waitWindow":@(wait)};
    _core.open(libraryPath(library));return self;
}
- (BOOL)contains:(Output)output {
    return !_stopping&&output&&output->handle&&std::find(_outputs.begin(),_outputs.end(),output)!=_outputs.end();
}
- (void)emit:(NSDictionary*)event output:(Output)output {
    NSMutableDictionary *value=[event mutableCopy];value[@"target"]=output->identifier;emit(value);
}
- (RSWindowSourceOptions)optionsFor:(Output)output {
    auto options=_options;if(output->hold)options.flags|=RS_WINDOW_SOURCE_HOLD;
    if(output->display)options.flags&=~uint32_t(RS_WINDOW_SOURCE_SCALED);
    else if((options.flags&RS_WINDOW_SOURCE_SCALED)&&!CGPreflightPostEventAccess()){
        options.flags&=~uint32_t(RS_WINDOW_SOURCE_SCALED);
        [self emit:@{@"event":@"output",@"output":@"in-place",@"reason":@"Scaled output needs the Accessibility permission"} output:output];
    }
    return options;
}
- (void)start {
    [self watchLifecycle];
    macfx::wcap::ClientCallbacks callbacks;
    callbacks.connected=^{self->_connected=true;[self overlays];for(const auto&o:self->_outputs){o->sentOptions=nil;if(o->selected){RSWindowSourceTarget t{sizeof(t),2,o->window,o->display};RSPresenterError e{sizeof(e),1};self->_core.select(o->handle,&t,&e);}self->_client->open(o->feed,o->request);[self sendOptions:o];}};
    callbacks.disconnected=^(NSString*){
        const double now=NSProcessInfo.processInfo.systemUptime;
        if(self->_lastLoss&&now-self->_lastLoss<10){[self stopWithStatus:5 event:@"failed" reason:@"Window capture stopped unexpectedly"];return;}
        self->_lastLoss=now;self->_connected=false;
        for(const auto&o:self->_outputs){o->hold=true;auto options=[self optionsFor:o];self->_core.setOptions(o->handle,&options);}
        [self poll];
    };
    callbacks.failed=^(NSString*r){[self stopWithStatus:5 event:@"failed" reason:r];};
    callbacks.feedEvent=^(uint32_t feed,NSDictionary*event){[self feed:feed event:event];};
    callbacks.frameContext=(__bridge void*)self;
    callbacks.frame=[](void*context,uint32_t feed,IOSurfaceRef surface,const macfx::wcap::FrameInfo&i){
        auto*self=(__bridge MacFXWindowGraphicsSession*)context;std::lock_guard<std::mutex>lock(self->_feedMutex);
        struct Lease {std::shared_ptr<macfx::wcap::Client>client;uint32_t feed;};
        for(const auto&o:self->_outputs)if(o->feed==feed&&o->handle){
            RSWindowSourceFrame f{sizeof(f),2,i.sequence,i.generation,i.time,i.width,i.height,i.cropX,i.cropY,i.cropWidth,i.cropHeight,i.contentScale,i.scaleFactor};
            self->_core.submit(o->handle,surface,&f,[](void*c,uint64_t sequence){auto*l=static_cast<Lease*>(c);l->client->release(l->feed,sequence);delete l;},new Lease{self->_client,feed});return;
        }
        self->_client->release(feed,i.sequence);
    };
    NSString*error=nil;_client=macfx::wcap::Client::connect(_serviceID,@"chain",callbacks,&error);
    if(!_client){[self stopWithStatus:5 event:@"failed" reason:error];return;}

    _heartbeat=[NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer*){emit(@{@"event":@"heartbeat"});}];
    _timer=[NSTimer scheduledTimerWithTimeInterval:.1 repeats:YES block:^(NSTimer*){[self poll];}];
    // A new crop reaches the service at once, outside the core's own check.
    [NSNotificationCenter.defaultCenter addObserverForName:@RS_WINDOW_SOURCE_CROP_CHANGED object:nil queue:nil usingBlock:^(NSNotification*){
        dispatch_async(dispatch_get_main_queue(),^{[self poll];});}];
    if(_allDisplays)[self refreshDisplays];else [self addTarget:_initial];
}
- (void)stopWithStatus:(int)status event:(NSString*)event reason:(NSString*)reason {
    if(_stopping)return;_stopping=true;
    [_timer invalidate];_timer=nil;[_heartbeat invalidate];_heartbeat=nil;
    for(dispatch_source_t source in _signals)dispatch_source_cancel(source);
    if(_input)dispatch_source_cancel(_input);
    {std::lock_guard<std::mutex>lock(_feedMutex);for(auto&o:_outputs){o->pointer.stop();if(o->handle){_core.destroy(o->handle);o->handle=nullptr;}}_outputs.clear();}
    if(_client)_client->stop();_client.reset();
    const double deadline=NSProcessInfo.processInfo.systemUptime+StopWait;
    while(_core.pendingStops&&_core.pendingStops()&&NSProcessInfo.processInfo.systemUptime<deadline)CFRunLoopRunInMode(kCFRunLoopDefaultMode,.02,true);
    [self finishedWithStatus:status event:event reason:reason];
}
- (void)finishedWithStatus:(int)status event:(NSString*)event reason:(NSString*)reason {finish(status,event,reason);}
- (void)removeOutput:(Output)output reason:(NSString*)reason status:(int)status {
    if(![self contains:output])return;
    // Keep a copy: the caller may refer to an element of the vector being erased.
    const Output retained=output;
    {std::lock_guard<std::mutex>lock(_feedMutex);retained->pointer.stop();if(_client)_client->close(retained->feed);_core.destroy(retained->handle);retained->handle=nullptr;
    _outputs.erase(std::remove(_outputs.begin(),_outputs.end(),retained),_outputs.end());
    }
    NSMutableDictionary *event=[@{@"event":@"targetRemoved"} mutableCopy];if(reason.length)event[@"reason"]=reason;
    [self emit:event output:retained];
    if(_outputs.empty()){[self stopWithStatus:status event:status?@"failed":@"closed" reason:reason];return;}
    [self overlays];
}
- (void)failOutput:(Output)output reason:(NSString*)reason {
    if(![self contains:output])return;
    [self emit:@{@"event":@"failed",@"reason":reason?:@"Window capture failed"} output:output];
    [self removeOutput:output reason:reason status:5];
}
- (void)watchLifecycle {
    signal(SIGPIPE,SIG_IGN); // A closed reader still lets capture stop gracefully.
    for(int number:{SIGTERM,SIGINT,SIGHUP}){
        signal(number,SIG_IGN);dispatch_source_t source=dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL,number,0,dispatch_get_main_queue());
        dispatch_source_set_event_handler(source,^{[self stopWithStatus:0 event:@"stopped" reason:nil];});dispatch_resume(source);[_signals addObject:source];
    }
    struct stat input{};
    if(!fstat(STDIN_FILENO,&input)&&(S_ISFIFO(input.st_mode)||S_ISSOCK(input.st_mode))){
        _input=dispatch_source_create(DISPATCH_SOURCE_TYPE_READ,STDIN_FILENO,0,dispatch_get_main_queue());
        dispatch_source_set_event_handler(_input,^{char bytes[4096];const auto count=read(STDIN_FILENO,bytes,sizeof(bytes));
            if(count==0||(count<0&&errno!=EAGAIN&&errno!=EINTR))[self stopWithStatus:0 event:@"stopped" reason:nil];
            else if(count>0)[self receive:bytes length:size_t(count)];});dispatch_resume(_input);
    }
    NSNotificationCenter *center=NSWorkspace.sharedWorkspace.notificationCenter;
    [center addObserverForName:NSWorkspaceDidActivateApplicationNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification*){[self poll];}];
    [center addObserverForName:NSWorkspaceDidTerminateApplicationNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note){
        NSRunningApplication *app=note.userInfo[NSWorkspaceApplicationKey];
        for(const auto &output:std::vector<Output>(self->_outputs))if(output->pid==app.processIdentifier)
            [self removeOutput:output reason:@"The application quit" status:0];
    }];
    for(NSNotificationName name in @[NSWorkspaceWillSleepNotification,NSWorkspaceScreensDidSleepNotification,NSWorkspaceSessionDidResignActiveNotification])
        [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification*){[self suspend:true];}];
    for(NSNotificationName name in @[NSWorkspaceDidWakeNotification,NSWorkspaceScreensDidWakeNotification,NSWorkspaceSessionDidBecomeActiveNotification])
        [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification*){[self suspend:false];}];
    if(_allDisplays)[NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidChangeScreenParametersNotification object:nil
        queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification*){[self refreshDisplays];}];
}
- (void)receive:(const char*)bytes length:(size_t)length {
    for(size_t i=0;i<length&&!_stopping;++i){
        if(bytes[i]!='\n'){if(_line.length<16384)[_line appendBytes:bytes+i length:1];continue;}
        NSDictionary *value=[NSJSONSerialization JSONObjectWithData:_line options:0 error:nil];_line.length=0;
        if(![value isKindOfClass:NSDictionary.class])continue;
        if([value[@"stop"] isKindOfClass:NSNumber.class]&&[value[@"stop"] boolValue]){[self stopWithStatus:0 event:@"stopped" reason:nil];return;}
        if([value[@"remove"] isKindOfClass:NSString.class])
            for(const auto &output:std::vector<Output>(_outputs))if([output->identifier isEqualToString:value[@"remove"]])
                [self removeOutput:output reason:@"Removed by request" status:0];
        if(_stopping)return;
        auto next=_options;
        if([value[@"cursor"] isKindOfClass:NSNumber.class])next.flags=[value[@"cursor"] boolValue]?next.flags|RS_WINDOW_SOURCE_CURSOR:next.flags&~uint32_t(RS_WINDOW_SOURCE_CURSOR);
        if([value[@"scaled"] isKindOfClass:NSNumber.class])next.flags=[value[@"scaled"] boolValue]?next.flags|RS_WINDOW_SOURCE_SCALED:next.flags&~uint32_t(RS_WINDOW_SOURCE_SCALED);
        if([value[@"scale"] isKindOfClass:NSNumber.class]&&std::isfinite([value[@"scale"] doubleValue])&&[value[@"scale"] doubleValue]>=0&&[value[@"scale"] doubleValue]<=10)next.scale=[value[@"scale"] doubleValue];
        if([value[@"pointer"] isEqual:@"toggle"])_showPointer=!_showPointer;else if([value[@"pointer"] isKindOfClass:NSNumber.class])_showPointer=[value[@"pointer"] boolValue];
        if(next.flags!=_options.flags||next.scale!=_options.scale){
            const bool restart=((next.flags^_options.flags)&RS_WINDOW_SOURCE_SCALED)||next.scale!=_options.scale;
            _options=next;[self applyOptions];
            // A new output session needs a first image even for static content.
            if(restart&&_connected)for(const auto&o:_outputs){_client->close(o->feed);o->sentOptions=nil;_client->open(o->feed,o->request);[self sendOptions:o];}
        }
    }
}
- (void)applyOptions {
    for(const auto &output:_outputs){auto options=[self optionsFor:output];_core.setOptions(output->handle,&options);}
    [self poll];
}
- (void)suspend:(bool)value {
    if(bool(_options.suspended)==value)return;_options.suspended=value;[self applyOptions];
}
- (Output)addOutput:(NSDictionary*)request {
    NSString *kind=request[@"target"];if(![kind isKindOfClass:NSString.class])return {};
    const bool window=[kind isEqualToString:@"window"],display=[kind isEqualToString:@"display"],app=[kind isEqualToString:@"application"];
    id number=request[window?@"windowID":display?@"displayID":@"pid"];
    if((!window&&!display&&!app)||!validNumber(number,1,app?INT32_MAX:UINT32_MAX))return {};
    NSString *identifier=[NSString stringWithFormat:@"%@%@",window?@"w":display?@"d":@"p",number];
    for(const auto &output:_outputs)if([output->identifier isEqualToString:identifier])return {};
    auto output=std::make_shared<WindowOutput>();output->identifier=identifier;output->kind=kind;
    output->window=window?[number unsignedIntValue]:0;output->display=display?[number unsignedIntValue]:0;output->pid=app?[number intValue]:0;
    output->direct=!app;output->ownerOnly=_ownerOnly&&app;
    auto options=[self optionsFor:output];RSPresenterError error{sizeof(error),1,{}};
    output->handle=_core.create(&options,&error);
    // Add before reporting failure so the target obeys normal removal rules.
    {std::lock_guard<std::mutex>lock(_feedMutex);_outputs.push_back(output);}
    NSMutableDictionary *event=[@{@"event":@"targetAdded",@"kind":kind} mutableCopy];event[window?@"windowID":display?@"displayID":@"pid"]=number;
    if(app){NSRunningApplication *owner=[NSRunningApplication runningApplicationWithProcessIdentifier:output->pid];
        if(owner.bundleIdentifier)event[@"bundleIdentifier"]=owner.bundleIdentifier;if(owner.localizedName)event[@"name"]=owner.localizedName;}
    [self emit:event output:output];
    if(!output->handle){
        [self emit:@{@"event":@"failed",@"reason":[NSString stringWithUTF8String:error.reason]?:@"The window overlay could not be created"} output:output];
        // Removal also handles a failed allocation, which owns no core handle.
        {std::lock_guard<std::mutex>lock(_feedMutex);_outputs.pop_back();}[self emit:@{@"event":@"targetRemoved",@"reason":@"The window overlay could not be created"} output:output];
        if(_outputs.empty())[self stopWithStatus:3 event:@"failed" reason:@"The window overlay could not be created"];return {};
    }
    output->feed=++_nextFeed;output->request=request;
    if(!app){RSWindowSourceTarget t{sizeof(t),2,output->window,output->display};_core.select(output->handle,&t,&error);output->selected=true;}
    [self overlays];if(_connected){_client->open(output->feed,request);[self sendOptions:output];}
    return output;
}
- (void)addTarget:(NSDictionary*)request {
    NSMutableDictionary*r=[request mutableCopy];if(_frontWindow)r[@"frontWindow"]=@YES;[self addOutput:r];
}
- (void)overlays {
    if(!_client)return;NSMutableArray*ids=[NSMutableArray array];for(const auto&o:_outputs)if(o->handle)[ids addObject:@(_core.outputWindow(o->handle))];_client->setOverlays(ids);_overlaySent=NSProcessInfo.processInfo.systemUptime;
}
- (void)sendOptions:(Output)o {
    if(!_connected)return;
    NSDictionary *options=@{@"paused":@(o->currentState==RS_WINDOW_SOURCE_OFF||o->currentState==RS_WINDOW_SOURCE_SUSPENDED),@"interval":@(_core.captureInterval(o->handle)),@"cursor":@((_options.flags&RS_WINDOW_SOURCE_CURSOR)!=0),@"cropX":@(o->cropX),@"cropY":@(o->cropY)};
    if(![options isEqual:o->sentOptions]){o->sentOptions=options;_client->options(o->feed,options);}
}
- (void)feed:(uint32_t)feed event:(NSDictionary*)event {
    if(!feed&&[event[@"event"] isEqual:@"excluded"]){
        NSArray*ack=event[@"overlays"];std::vector<uint32_t>ids;for(NSNumber*id in ack)ids.push_back(id.unsignedIntValue);
        for(const auto&o:_outputs){_core.setOverlays(o->handle,ids.data(),uint32_t(ids.size()));if([ack containsObject:@(_core.outputWindow(o->handle))]){o->hold=false;auto options=[self optionsFor:o];_core.setOptions(o->handle,&options);}}return;
    }
    for(const auto&o:std::vector<Output>(_outputs))if(o->feed==feed){
        NSString*kind=event[@"event"];
        if([kind isEqual:@"geometry"]){RSWindowSourceGeometry g{sizeof(g),2,[event[@"exists"] unsignedIntValue],[event[@"onScreen"] unsignedIntValue],[event[@"pid"] intValue],[event[@"layer"] intValue],
            [event[@"x"] doubleValue],[event[@"y"] doubleValue],[event[@"width"] doubleValue],[event[@"height"] doubleValue],[event[@"scale"] doubleValue],[event[@"displayID"] unsignedIntValue],
            [event[@"pixelsWidth"] unsignedIntValue],[event[@"pixelsHeight"] unsignedIntValue],[event[@"generation"] unsignedLongLongValue]};_core.setGeometry(o->handle,&g);}
        else if([kind isEqual:@"excluded"]){o->hold=false;auto options=[self optionsFor:o];_core.setOptions(o->handle,&options);}
        else if([kind isEqual:@"selected"]){uint32_t w=[event[@"windowID"] unsignedIntValue],d=[event[@"displayID"] unsignedIntValue];
            if(!o->selected||w!=o->window||d!=o->display){RSWindowSourceTarget t{sizeof(t),2,w,d};RSPresenterError e{sizeof(e),1};_core.select(o->handle,&t,&e);}
            o->window=w;o->display=d;o->pid=[event[@"pid"] intValue];o->selected=true;
            o->request=w?@{@"target":@"window",@"windowID":@(w)}:@{@"target":@"display",@"displayID":@(d)};[self emit:event output:o];}
        else if([kind isEqual:@"closed"]){if([event[@"failed"] boolValue])[self failOutput:o reason:event[@"reason"]];else [self removeOutput:o reason:event[@"reason"] status:0];}
        else [self emit:event output:o];return;
    }
}
- (void)refreshDisplays {
    uint32_t count=0;CGGetActiveDisplayList(0,nullptr,&count);std::vector<CGDirectDisplayID>ids(count);CGGetActiveDisplayList(count,ids.data(),&count);
    for(auto id:ids)[self addOutput:@{@"target":@"display",@"displayID":@(id)}];
    for(const auto&o:std::vector<Output>(_outputs))if(o->display&&std::find(ids.begin(),ids.end(),o->display)==ids.end())[self removeOutput:o reason:@"The display is no longer available" status:0];
}
- (void)poll {
    if(_stopping)return;
    if(getppid()!=_parent){[self stopWithStatus:0 event:@"stopped" reason:@"MacLauncher quit"];return;}
    const double now=NSProcessInfo.processInfo.systemUptime;
    for(const auto &output:std::vector<Output>(_outputs)){
        if(![self contains:output])continue;
        if(output->hold&&now-_overlaySent>=2)[self overlays];
        if(!output->selected)continue;
        RSWindowSourceStatus status{};status.size=sizeof(status);status.version=RS_WINDOW_SOURCE_ABI_VERSION;
        _core.poll(output->handle,&status);NSString *reason=[NSString stringWithUTF8String:status.reason]?:@"";
        if(status.state!=output->lastState||bool(status.revealed)!=output->lastRevealed||![reason isEqualToString:output->lastReason?:@""]){
            output->lastRevealed=status.revealed;output->lastState=status.state;output->lastReason=reason;
            NSMutableDictionary *event=[@{@"event":@"state",@"state":stateName(status.state),@"revealed":@(bool(status.revealed))} mutableCopy];if(reason.length)event[@"reason"]=reason;
            if(output->display)event[@"displayID"]=@(output->display);[self emit:event output:output];
        }
        output->cropX=status.cropX;output->cropY=status.cropY;output->currentState=status.state;[self sendOptions:output];
        const auto point=output->pointer.update({status.targetX,status.targetY,status.targetWidth,status.targetHeight},status.targetPid,(_options.flags&RS_WINDOW_SOURCE_SCALED)&&status.outputVisible);
        RSWindowSourcePointer pointer{sizeof(pointer),2,uint32_t(point.visible&&_showPointer),point.x,point.y};_core.setPointer(output->handle,&pointer);
        if(status.state==RS_WINDOW_SOURCE_FAILED){
            if(!output->failedSince)output->failedSince=now;
            else if(now-output->failedSince>=FailureGrace)[self failOutput:output reason:reason.length?reason:@"Window capture stopped"];
        }else output->failedSince=0;
        if(status.state!=RS_WINDOW_SOURCE_CLOSED)continue;
        [self removeOutput:output reason:reason status:0];
    }
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
    if(arguments.count&&[arguments[0] isEqualToString:@"--catalog"])return runCatalogRelay(arguments);
    if(arguments.count&&[arguments[0] isEqualToString:@"--capture-service"])return runCaptureService(arguments);
    [NSApplication sharedApplication];
    NSApp.activationPolicy=NSApplicationActivationPolicyAccessory;
    static MacFXWindowGraphicsSession *session=[[MacFXWindowGraphicsSession alloc]initWithArguments:arguments];
    dispatch_async(dispatch_get_main_queue(),^{[session start];});
    [NSApp run];
    return 0;
}}
