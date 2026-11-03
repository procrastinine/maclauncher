#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include "graphics-window-catalog.hpp"
#include <algorithm>
#include <cmath>
#include <libproc.h>
#include <unistd.h>
#include <vector>

namespace {
// Thumbnails fit this box in pixels; at most this many captures run at once.
constexpr double ThumbnailWidth=400,ThumbnailHeight=250;
constexpr unsigned CapturesInFlight=4,WindowLimit=96;
// Seconds before a late thumbnail is discarded.
constexpr double CaptureTimeout=2;
// Seconds between shareable-content list requests.
constexpr double ListRefreshInterval=2;
// Minimum seconds between attempts for an existing target.
constexpr double ThumbnailRefreshInterval=5;
// Seconds between repeat captures globally, and between scheduler ticks.
constexpr double ThumbnailRepeatInterval=.5;
NSString *displayName(CGDirectDisplayID display){
    for(NSScreen *screen in NSScreen.screens)
        if([screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue]==display&&screen.localizedName.length)return screen.localizedName;
    return CGDisplayIsBuiltin(display)?@"Built-in Display":@"Display";
}
NSString *displayUUID(CGDirectDisplayID display){
    CFUUIDRef uuid=CGDisplayCreateUUIDFromDisplayID(display);if(!uuid)return nil;
    NSString *text=CFBridgingRelease(CFUUIDCreateString(nullptr,uuid));CFRelease(uuid);return text;
}
NSString *executablePath(pid_t pid){
    char path[PROC_PIDPATHINFO_MAXSIZE]{};
    return proc_pidpath(pid,path,sizeof(path))>0?[NSString stringWithUTF8String:path]:nil;
}
NSData *jpeg(CGImageRef image){
    NSBitmapImageRep *rep=[[NSBitmapImageRep alloc]initWithCGImage:image];
    return [rep representationUsingType:NSBitmapImageFileTypeJPEG properties:@{NSImageCompressionFactor:@.7}];
}
// Front-to-back position of each on-screen window, for ordering apps and
// their windows the way they are stacked.
NSDictionary<NSNumber*,NSNumber*> *stackOrder(){
    NSMutableDictionary *order=[NSMutableDictionary dictionary];
    NSArray *windows=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements,kCGNullWindowID));
    for(NSDictionary *info in windows)if(NSNumber *number=info[(__bridge NSString*)kCGWindowNumber])order[number]=@(order.count);
    return order;
}
struct Capture {NSString *key;SCContentFilter *filter;double width=0,height=0;bool visible=true;};
// Capture refused for lack of the permission, or the permission is gone. The
// picker then shows its permission notice instead of previews that stop.
bool declined(NSError *error){
    return !CGPreflightScreenCaptureAccess()||([error.domain isEqualToString:SCStreamErrorDomain]&&error.code==SCStreamErrorUserDeclined);
}
// An app's icon from NSWorkspace as a PNG data URL, 32 points at 2x.
NSString *iconData(NSString *path){
    NSImage *icon=[NSWorkspace.sharedWorkspace iconForFile:path];if(!icon)return nil;
    NSBitmapImageRep *rep=[[NSBitmapImageRep alloc]initWithBitmapDataPlanes:nullptr pixelsWide:64 pixelsHigh:64 bitsPerSample:8 samplesPerPixel:4
        hasAlpha:YES isPlanar:NO colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    if(!rep)return nil;
    rep.size=NSMakeSize(32,32);
    NSGraphicsContext *context=[NSGraphicsContext graphicsContextWithBitmapImageRep:rep];if(!context)return nil;
    [NSGraphicsContext saveGraphicsState];NSGraphicsContext.currentContext=context;
    [icon drawInRect:NSMakeRect(0,0,32,32) fromRect:NSZeroRect operation:NSCompositingOperationCopy fraction:1];
    [NSGraphicsContext restoreGraphicsState];
    NSData *png=[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    return png.length?[@"data:image/png;base64," stringByAppendingString:[png base64EncodedStringWithOptions:0]]:nil;
}
}

NSDictionary *rsCatalogModel(NSArray<NSDictionary*> *displays,NSArray<NSDictionary*> *windows,
    size_t limit,NSSet<NSNumber*> *__autoreleasing *thumbnailWindows){
    std::vector<pid_t> owners;owners.reserve(windows.count);
    for(NSDictionary *row in windows)owners.push_back([row[@"pid"] intValue]);
    const auto kept=macfx::wcap::catalogKeep(owners,limit);
    NSMutableArray *shown=[NSMutableArray array],*more=[NSMutableArray array];
    NSMutableSet<NSNumber*> *thumbnails=[NSMutableSet set];
    size_t next=0;
    for(size_t i=0;i<windows.count;++i){
        NSDictionary *row=windows[i];
        if(next<kept.size()&&kept[next]==i){
            [shown addObject:row];if(NSNumber *number=row[@"id"])[thumbnails addObject:number];++next;
        }else [more addObject:row];
    }
    if(thumbnailWindows)*thumbnailWindows=thumbnails;
    return @{@"event":@"catalog",@"displays":displays,@"windows":shown,@"more":more};
}

@interface MacFXWindowCatalog : NSObject
@end
@implementation MacFXWindowCatalog {
    pid_t _excluded;NSString *_launcherBundle;NSData *_published;bool _busy,_active,_thumbnails;
    void (^_emit)(NSDictionary*);void (^_done)(void);
    // Requests to the capture service that have not answered yet, including
    // captures whose slot timed out.
    unsigned _requests;
    std::vector<Capture> _captures;unsigned _running;double _nextRepeat;
    NSMutableDictionary<NSString*,NSNumber*> *_attempted;NSMutableSet<NSString*> *_capturing;NSTimer *_thumbnailTimer;
    NSMutableDictionary<NSString*,NSData*> *_images;NSMutableSet<NSString*> *_icons;NSTimer *_timer;
}
- (instancetype)initExcluding:(pid_t)excluded thumbnails:(BOOL)thumbnails emit:(void (^)(NSDictionary*))emit {
    if(!(self=[super init]))return nil;
    _emit=[emit copy];_thumbnails=thumbnails;_excluded=excluded;_images=[NSMutableDictionary dictionary];_icons=[NSMutableSet set];_active=true;
    _attempted=[NSMutableDictionary dictionary];_capturing=[NSMutableSet set];
    _launcherBundle=excluded>0?[NSRunningApplication runningApplicationWithProcessIdentifier:excluded].bundleIdentifier:nil;
    return self;
}
- (void)emit:(NSDictionary*)event { if(_active&&_emit)_emit(event); }
- (void)permissionMissing {
    [self emit:@{@"event":@"permission",@"screenRecording":@NO}];[self end];
}
- (void)start {
    _timer=[NSTimer scheduledTimerWithTimeInterval:ListRefreshInterval repeats:YES block:^(NSTimer*){[self refresh];}];
    _thumbnailTimer=[NSTimer scheduledTimerWithTimeInterval:ThumbnailRepeatInterval repeats:YES block:^(NSTimer*){[self captureNext];}];
    [self refresh];
}
- (void)end {
    if(!_active)return;_active=false;
    [_timer invalidate];_timer=nil;[_thumbnailTimer invalidate];_thumbnailTimer=nil;
    if(!_requests){[self drained];return;}
}
- (void)stop:(void (^)(void))done {
    _done=[done copy];
    if(_active)[self end];else if(!_requests)[self drained];
}
- (void)drained {
    void (^done)(void)=_done;_done=nil;_emit=nil;if(done)done();
}
// Main thread: one request to the capture service has answered.
- (void)answered {
    if(--_requests==0&&!_active)[self drained];
}
- (void)refresh {
    if(!_active)return;
    if(!CGPreflightScreenCaptureAccess()){[self permissionMissing];return;}
    if(_busy)return;_busy=true;++_requests;
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:NO completionHandler:^(SCShareableContent *content,NSError *error){
        dispatch_async(dispatch_get_main_queue(),^{
            [self answered];
            if(!self->_active)return;
            if(!content){
                // A permission removed while the window is open ends previews.
                if(declined(error)){[self permissionMissing];return;}
                [self emit:@{@"event":@"failed",@"reason":error.localizedDescription?:@"The window list is unavailable"}];
                self->_busy=false;return;
            }
            [self publish:content];
            self->_busy=false;[self captureNext];
        });
    }];
}
// Ordinary windows of regular apps, at least 64 points on each side. A window
// that is not on screen, on another Space or minimized, is listed when it has
// a title; untitled off-screen windows are internal to their apps.
- (void)publish:(SCShareableContent*)content {
    NSDictionary *order=stackOrder();
    NSMutableArray<SCWindow*> *windows=[NSMutableArray array];
    for(SCWindow *window in content.windows){
        SCRunningApplication *owner=window.owningApplication;
        if(!owner||window.windowLayer!=0||window.frame.size.width<64||window.frame.size.height<64)continue;
        if(owner.processID==getpid()||owner.processID==_excluded||(_launcherBundle&&[owner.bundleIdentifier isEqualToString:_launcherBundle]))continue;
        if(!window.onScreen&&!window.title.length)continue;
        NSRunningApplication *app=[NSRunningApplication runningApplicationWithProcessIdentifier:owner.processID];
        if(app.activationPolicy!=NSApplicationActivationPolicyRegular)continue;
        [windows addObject:window];
    }
    // Apps in the order of their frontmost window, then each app's windows
    // front to back, with off-screen windows after them by title.
    NSMutableDictionary<NSNumber*,NSNumber*> *appOrder=[NSMutableDictionary dictionary];
    for(SCWindow *window in windows){
        NSNumber *position=order[@(window.windowID)]?:@(NSIntegerMax);NSNumber *pid=@(window.owningApplication.processID);
        if(!appOrder[pid]||position.integerValue<appOrder[pid].integerValue)appOrder[pid]=position;
    }
    [windows sortUsingComparator:^NSComparisonResult(SCWindow *a,SCWindow *b){
        const NSInteger appA=appOrder[@(a.owningApplication.processID)].integerValue,appB=appOrder[@(b.owningApplication.processID)].integerValue;
        if(appA!=appB)return appA<appB?NSOrderedAscending:NSOrderedDescending;
        if(a.owningApplication.processID!=b.owningApplication.processID)
            return [a.owningApplication.applicationName?:@"" localizedCaseInsensitiveCompare:b.owningApplication.applicationName?:@""];
        const NSInteger windowA=[order[@(a.windowID)]?:@(NSIntegerMax) integerValue],windowB=[order[@(b.windowID)]?:@(NSIntegerMax) integerValue];
        if(windowA!=windowB)return windowA<windowB?NSOrderedAscending:NSOrderedDescending;
        return [a.title?:@"" localizedCaseInsensitiveCompare:b.title?:@""];
    }];
    std::vector<Capture> captures;
    NSMutableArray *displayRows=[NSMutableArray array],*windowRows=[NSMutableArray array];
    for(SCDisplay *display in content.displays){
        NSMutableDictionary *row=[@{@"id":@(display.displayID),@"name":displayName(display.displayID),@"width":@(display.width),@"height":@(display.height),
            @"main":@(CGDisplayIsMain(display.displayID)!=0)} mutableCopy];
        if(NSString *uuid=displayUUID(display.displayID))row[@"uuid"]=uuid;
        [displayRows addObject:row];
        SCContentFilter *filter=[[SCContentFilter alloc]initWithDisplay:display excludingWindows:@[]];
        if(@available(macOS 14.2,*))filter.includeMenuBar=NO;
        captures.push_back({[NSString stringWithFormat:@"display:%u",display.displayID],filter,double(display.width),double(display.height)});
    }
    for(SCWindow *window in windows){
        SCRunningApplication *owner=window.owningApplication;
        NSRunningApplication *app=[NSRunningApplication runningApplicationWithProcessIdentifier:owner.processID];
        NSMutableDictionary *row=[@{@"id":@(window.windowID),@"pid":@(owner.processID),@"application":owner.applicationName.length?owner.applicationName:app.localizedName?:@"Application",
            @"width":@(window.frame.size.width),@"height":@(window.frame.size.height),@"onScreen":@(window.onScreen)} mutableCopy];
        if(window.title.length)row[@"title"]=window.title;
        if(owner.bundleIdentifier.length)row[@"bundleIdentifier"]=owner.bundleIdentifier;
        if(NSString *bundle=app.bundleURL.path){
            row[@"path"]=bundle;
            if(![_icons containsObject:bundle]){
                [_icons addObject:bundle];
                if(NSString *image=iconData(bundle))[self emit:@{@"event":@"icon",@"path":bundle,@"image":image}];
            }
        }
        if(NSString *executable=executablePath(owner.processID)?:app.executableURL.path)row[@"executable"]=executable;
        [windowRows addObject:row];
    }
    NSSet<NSNumber*> *thumbnailWindows;
    NSDictionary *catalog=rsCatalogModel(displayRows,windowRows,WindowLimit,&thumbnailWindows);
    for(SCWindow *window in windows)if([thumbnailWindows containsObject:@(window.windowID)])
        captures.push_back({[NSString stringWithFormat:@"window:%u",window.windowID],[[SCContentFilter alloc]initWithDesktopIndependentWindow:window],
            window.frame.size.width,window.frame.size.height,window.onScreen!=NO});
    NSData *data=[NSJSONSerialization dataWithJSONObject:catalog options:NSJSONWritingSortedKeys error:nil];
    if(data&&![data isEqualToData:_published]){_published=data;[self emit:catalog];}
    // Thumbnails of targets that left the list are forgotten.
    NSMutableSet *keys=[NSMutableSet set];for(const auto &capture:captures)[keys addObject:capture.key];
    for(NSString *key in _images.allKeys)if(![keys containsObject:key])[_images removeObjectForKey:key];
    for(NSString *key in _attempted.allKeys)if(![keys containsObject:key])[_attempted removeObjectForKey:key];
    _captures=std::move(captures);
}
// New targets fill immediately; existing visible targets refresh stalest first.
- (NSInteger)nextCaptureAt:(double)now {
    NSInteger candidate=-1;double oldest=now;
    for(size_t index=0;index<_captures.size();++index){
        const auto &capture=_captures[index];
        if([_capturing containsObject:capture.key])continue;
        NSNumber *last=_attempted[capture.key];
        if(!last)return NSInteger(index);
        if(capture.visible&&now>=_nextRepeat&&now-last.doubleValue>=ThumbnailRefreshInterval&&last.doubleValue<=oldest){
            oldest=last.doubleValue;candidate=NSInteger(index);
        }
    }
    return candidate;
}
- (void)captureNext {
    while(_active&&_thumbnails&&_running<CapturesInFlight){
        const double now=NSProcessInfo.processInfo.systemUptime;
        const NSInteger index=[self nextCaptureAt:now];if(index<0)break;
        const Capture capture=_captures[size_t(index)];
        if(_attempted[capture.key])_nextRepeat=now+ThumbnailRepeatInterval;
        _attempted[capture.key]=@(now);[_capturing addObject:capture.key];++_running;
        const double scale=std::min({ThumbnailWidth/std::max(capture.width,1.),ThumbnailHeight/std::max(capture.height,1.),2.});
        auto configuration=[SCStreamConfiguration new];
        configuration.width=size_t(std::max(1.,std::round(capture.width*scale)));configuration.height=size_t(std::max(1.,std::round(capture.height*scale)));
        configuration.showsCursor=NO;configuration.ignoreShadowsSingleWindow=YES;configuration.scalesToFit=YES;
        NSString *key=capture.key;
        // Discard late results, but keep the slot until the capture service
        // answers so timed-out requests cannot exceed the in-flight cap.
        __block bool finished=false;
        void (^complete)(NSData*)=^(NSData *data){
            if(finished)return;
            finished=true;
            if(self->_active&&data&&![data isEqualToData:self->_images[key]]){
                self->_images[key]=data;
                [self emit:@{@"event":@"thumbnail",@"target":key,@"image":[@"data:image/jpeg;base64," stringByAppendingString:[data base64EncodedStringWithOptions:0]]}];
            }
        };
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW,int64_t(CaptureTimeout*NSEC_PER_SEC)),dispatch_get_main_queue(),^{complete(nil);});
        ++_requests;
        [SCScreenshotManager captureImageWithFilter:capture.filter configuration:configuration completionHandler:^(CGImageRef image,NSError *error){
            NSData *data=image?jpeg(image):nil;
            dispatch_async(dispatch_get_main_queue(),^{
                [self answered];
                --self->_running;[self->_capturing removeObject:key];
                if(!self->_active)return;
                if(!image&&declined(error)){[self permissionMissing];return;}
                complete(data);[self captureNext];
            });
        }];
    }
}
@end

// The capture service calls these hooks on its main queue.
static MacFXWindowCatalog *servedCatalog;
static void (^servingEmit)(NSDictionary*);
static unsigned long servingGeneration;
static dispatch_group_t catalogDrain(){
    static dispatch_group_t group;static dispatch_once_t once;
    dispatch_once(&once,^{group=dispatch_group_create();});return group;
}
void rsCatalogServe(NSDictionary *request,void (^emit)(NSDictionary *)){
    rsCatalogStopServing(nil);
    servingEmit=[emit copy];
    const auto generation=servingGeneration;
    dispatch_group_notify(catalogDrain(),dispatch_get_main_queue(),^{
        if(generation!=servingGeneration)return;
        servedCatalog=[[MacFXWindowCatalog alloc]initExcluding:[request[@"excludePid"] intValue] thumbnails:[request[@"thumbnails"] boolValue] emit:emit];
        [servedCatalog start];
    });
}
void rsCatalogStopServing(void (^done)(void)){
    ++servingGeneration;
    void (^previousEmit)(NSDictionary*)=servingEmit;servingEmit=nil;
    if(previousEmit)previousEmit(@{@"event":@"catalogStopped"});
    MacFXWindowCatalog *previous=servedCatalog;servedCatalog=nil;
    if(previous){
        dispatch_group_enter(catalogDrain());
        [previous stop:^{dispatch_group_leave(catalogDrain());}];
    }
    if(done)dispatch_group_notify(catalogDrain(),dispatch_get_main_queue(),done);
}
