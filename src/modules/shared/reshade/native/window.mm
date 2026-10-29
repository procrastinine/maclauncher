#include "image-admission.hpp"
#include "runtime-status.hpp"
#include "color-contract.hpp"
#include "color-formats.hpp"
#include "live-controls.hpp"
#include "log.hpp"
#include "native-config.hpp"
#include "window.hpp"
#include "view-presentation.hpp"
#include "browser-frame.hpp"
#include "effects-plan.hpp"
#include "presentation-hold.hpp"
#include "virtual-window.hpp"
#include "layer-presentation.hpp"
#include "resolution-scale.hpp"
#include "presentation-internal.hpp"
#include "graphics.hpp"
#include <cstring>
#include "window-state.hpp"
#include "remote-ingress-diagnostics.hpp"
#include "contents-geometry.hpp"
#include "diagnostics.hpp"
#include "window-binding.hpp"
#include "bitmap-surface.hpp"
#include "quartz-frame.hpp"
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import <objc/message.h>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <vector>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
extern "C" IOSurfaceRef rsFilterWindowSurface(void *,IOSurfaceRef);

struct MacFXRemotePublicationState {
    std::recursive_mutex publication;
    __weak CALayer *layer=nil;
    uint64_t generation=0,awaitingGeneration=0;
    uint32_t identifier=0;
    void *contextLayer=nullptr;
    IOSurfaceRef awaiting=nullptr;
    size_t reserved=0;
    ~MacFXRemotePublicationState(){clear();}
    void clear(){if(awaiting)CFRelease(awaiting);awaiting=nullptr;identifier=0;contextLayer=nullptr;awaitingGeneration=0;
        if(reserved)macfx::bitmapSurfaceReservation().fetch_sub(reserved);reserved=0;}
};
@interface MacFXRemotePublication : NSObject {
@public std::shared_ptr<MacFXRemotePublicationState> value;
}
@end
@implementation MacFXRemotePublication
@end

// NSOpenGLContext.view takes the CGL driver lock. Capture the weak binding when
// it changes, then inspect the AppKit hierarchy without contending with render.
@interface MacFXOpenGLViewBinding : NSObject
@property(nonatomic,weak) NSView *view;
@end
@implementation MacFXOpenGLViewBinding
@end

@interface MacFXLayerBinding : NSObject {
@public macfx::LayerBinding value;
}
@end
@implementation MacFXLayerBinding
@end

@interface MacFXOwnerLifetime : NSObject {
@public void *owner;void(*cleanup)(void *);
}
@end
@implementation MacFXOwnerLifetime
- (void)dealloc {if(cleanup)cleanup(owner);}
@end

namespace {
char openGLViewBindingKey,layerBindingKey,remotePublicationKey;
MacFXLayerBinding *layerBinding(CALayer *layer) {
    // Automatic discovery and setContents already execute on their publisher's
    // thread. Association publication is serialized only on the first miss.
    MacFXLayerBinding *binding=objc_getAssociatedObject(layer,&layerBindingKey);
    if(binding)return binding;
    @synchronized(layer){
        binding=objc_getAssociatedObject(layer,&layerBindingKey);
        if(!binding){binding=[MacFXLayerBinding new];objc_setAssociatedObject(layer,&layerBindingKey,binding,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
    }
    return binding;
}
void bindOpenGLView(NSOpenGLContext *context,NSView *view) {
    MacFXOpenGLViewBinding *binding=[MacFXOpenGLViewBinding new];binding.view=view;
    objc_setAssociatedObject(context,&openGLViewBindingKey,binding,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
NSView *openGLView(NSOpenGLContext *context) {
    MacFXOpenGLViewBinding *binding=objc_getAssociatedObject(context,&openGLViewBindingKey);
    if(!binding) {bindOpenGLView(context,context.view);binding=objc_getAssociatedObject(context,&openGLViewBindingKey);}
    return binding.view;
}
// Never call AppKit, Core Animation or context accessors while this map lock is
// held: the render thread may already hold a driver lock before querying it.
std::mutex &mutex() { static auto *m=new std::mutex; return *m; }
struct Owner { NSInteger number; std::string title; unsigned width=0,height=0; };
Owner resolveLocalSurfaceOwner(CALayer*layer);
using macfx::WindowState;
WindowState *state=nullptr;
std::map<void *,Owner> &owners() { static auto *m=new std::map<void *,Owner>; return *m; }
std::map<CGLContextObj,std::shared_ptr<macfx::ViewPresentation>> &presentations() { static auto *m=new std::map<CGLContextObj,std::shared_ptr<macfx::ViewPresentation>>; return *m; }
std::map<void*,std::shared_ptr<macfx::ViewPresentation>> &metalPresentations() {static auto *m=new std::map<void*,std::shared_ptr<macfx::ViewPresentation>>;return *m;}
struct RemotePresentation {void *contextLayer;uint32_t window,identifier;std::shared_ptr<macfx::LayerPresentation> presentation;__weak CALayer*localLayer=nil;};
std::map<void*,RemotePresentation>&remotePresentations(){static auto *m=new std::map<void*,RemotePresentation>;return *m;}
std::map<void*,std::shared_ptr<MacFXRemotePublicationState>>&pendingRemote(){static auto*m=new std::map<void*,std::shared_ptr<MacFXRemotePublicationState>>;return *m;}
std::shared_ptr<MacFXRemotePublicationState>remotePublication(CALayer*layer,bool create){
    MacFXRemotePublication*binding=objc_getAssociatedObject(layer,&remotePublicationKey);
    if(!binding&&create){@synchronized(layer){binding=objc_getAssociatedObject(layer,&remotePublicationKey);
        if(!binding){binding=[MacFXRemotePublication new];binding->value=std::make_shared<MacFXRemotePublicationState>();binding->value->layer=layer;
            objc_setAssociatedObject(layer,&remotePublicationKey,binding,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}}}
    return binding?binding->value:nullptr;
}
void clearPendingRemote(const std::shared_ptr<MacFXRemotePublicationState>&entry){
    if(!entry->awaiting)return;
    {std::lock_guard<std::mutex>guard(mutex());auto at=pendingRemote().find((__bridge void*)entry->layer);
        if(at!=pendingRemote().end()&&at->second==entry)pendingRemote().erase(at);}
    entry->clear();
}
void queuePendingRemote(const std::shared_ptr<MacFXRemotePublicationState>&entry,IOSurfaceRef surface,uint32_t identifier,void*contextLayer){
    if(!entry||!state)return;
    const auto width=IOSurfaceGetWidth(surface),height=IOSurfaceGetHeight(surface),bytes=IOSurfaceGetAllocSize(surface);
    constexpr size_t limit=64u<<20,total=256u<<20;
    if(!width||!height||width>16384||height>16384||!bytes||bytes>limit)return;
    const auto format=IOSurfaceGetPixelFormat(surface);if(format!='BGRA'&&format!='RGBA')return;
    {std::lock_guard<std::mutex>guard(mutex());if(pendingRemote().size()>=32)return;
        auto&used=macfx::bitmapSurfaceReservation();size_t before=used.load();
        do{if(before>total||bytes>total-before)return;}while(!used.compare_exchange_weak(before,before+bytes));
        entry->awaiting=(IOSurfaceRef)CFRetain(surface);entry->reserved=bytes;entry->identifier=identifier;entry->contextLayer=contextLayer;entry->awaitingGeneration=entry->generation;
        pendingRemote()[(__bridge void*)entry->layer]=entry;}
}
void forgetPendingRemote(void*key){
    std::vector<std::pair<void*,std::shared_ptr<MacFXRemotePublicationState>>>entries;
    {std::lock_guard<std::mutex>guard(mutex());for(const auto&entry:pendingRemote())entries.push_back(entry);}
    for(auto&item:entries){const auto&entry=item.second;std::lock_guard<std::recursive_mutex>serial(entry->publication);
        if(item.first!=key&&entry->contextLayer!=key)continue;
        {std::lock_guard<std::mutex>guard(mutex());auto at=pendingRemote().find(item.first);if(at!=pendingRemote().end()&&at->second==entry)pendingRemote().erase(at);}
        entry->clear();}
}
void retryRemoteContents();
void forgetRemotePresentation(void *key) {
    std::vector<std::pair<void*,std::shared_ptr<macfx::LayerPresentation>>> retired;
    {std::lock_guard<std::mutex>guard(mutex());for(auto at=remotePresentations().begin();at!=remotePresentations().end();)
        if(at->first==key||at->second.contextLayer==key){retired.emplace_back(at->first,std::move(at->second.presentation));at=remotePresentations().erase(at);}else ++at;}
    for(auto&entry:retired){entry.second->stop();macfx::releaseFrameOwner(entry.first);}
}
std::set<void *> &pending() { static auto *s=new std::set<void *>; return *s; }
std::atomic<void*> surfaceClassValue{nullptr},imageClassValue{nullptr};
Class surfaceClass(){return (__bridge Class)surfaceClassValue.load(std::memory_order_acquire);}
Class imageClass(){return (__bridge Class)imageClassValue.load(std::memory_order_acquire);}
void prepareContentsClasses(){
    static std::once_flag prepared;
    std::call_once(prepared,[]{
        NSDictionary *properties=@{(__bridge NSString*)kIOSurfaceWidth:@1,(__bridge NSString*)kIOSurfaceHeight:@1,
            (__bridge NSString*)kIOSurfaceBytesPerElement:@4};
        IOSurfaceRef probe=IOSurfaceCreate((__bridge CFDictionaryRef)properties);
        if(probe){surfaceClassValue.store((__bridge void*)object_getClass((__bridge id)probe),std::memory_order_release);CFRelease(probe);}
        CGColorSpaceRef color=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        CGContextRef bitmap=CGBitmapContextCreate(nullptr,1,1,8,4,color,kCGImageAlphaPremultipliedFirst|kCGBitmapByteOrder32Little);
        CGImageRef image=bitmap?CGBitmapContextCreateImage(bitmap):nullptr;
        if(image){imageClassValue.store((__bridge void*)object_getClass((__bridge id)image),std::memory_order_release);CGImageRelease(image);}
        if(bitmap)CGContextRelease(bitmap);if(color)CGColorSpaceRelease(color);
    });
}
struct BitmapImage {
    CGImageRef image;
    explicit BitmapImage(CGImageRef source):image(CGImageRetain(source)){}
    ~BitmapImage(){CGImageRelease(image);}
};
struct BitmapOwner {
    macfx::BitmapSurfacePool pool;
    std::shared_ptr<macfx::LayerPresentation> presentation;
    std::atomic<bool>retired{false};
    NSInteger window=0;
    unsigned width=0,height=0;
    bool accepted=false;
    uint64_t generation=0,awaitingGeneration=0;
    std::shared_ptr<BitmapImage>awaiting;
};
std::map<void*,std::shared_ptr<BitmapOwner>>&bitmapOwners(){static auto*m=new std::map<void*,std::shared_ptr<BitmapOwner>>;return *m;}
struct QuartzOwner {
    macfx::BitmapSurfacePool pool;
    __weak NSView*source;
    MacFXQuartzPresentationView*overlay=nil;
    std::shared_ptr<macfx::LayerPresentation>presentation;
    std::atomic<bool>retired{false};
    NSInteger window=0;
    std::shared_ptr<macfx::QuartzFrameImage>awaiting;
    bool queued=false;
};
std::map<void*,std::shared_ptr<QuartzOwner>>&quartzOwners(){static auto*m=new std::map<void*,std::shared_ptr<QuartzOwner>>;return *m;}
thread_local macfx::QuartzFrameCapture*quartzCapture=nullptr;
void installQuartzView(NSView*view);
void retireQuartzPresentations();
void forgetQuartz(void*key){
    std::shared_ptr<QuartzOwner>retired;
    {std::lock_guard<std::mutex>guard(mutex());auto at=quartzOwners().find(key);if(at==quartzOwners().end())return;
        retired=std::move(at->second);quartzOwners().erase(at);owners().erase(key);retired->retired.store(true);}
    retired->pool.clear();macfx::releaseFrameOwner(key);
    void(^remove)(void)=^{if(retired->presentation)retired->presentation->stop();retired->presentation.reset();
        retired->awaiting.reset();[retired->overlay removeFromSuperview];retired->overlay=nil;};
    if(NSThread.isMainThread)remove();else dispatch_async(dispatch_get_main_queue(),remove);
}
void stopBitmapPresentation(std::shared_ptr<macfx::LayerPresentation>presentation){
    if(!presentation)return;
    if(NSThread.isMainThread)presentation->stop();
    else dispatch_async(dispatch_get_main_queue(),^{presentation->stop();});
}
void forgetBitmap(void*key){
    std::shared_ptr<BitmapOwner>retired;std::shared_ptr<macfx::LayerPresentation>presentation;std::shared_ptr<BitmapImage>image;
    {std::lock_guard<std::mutex>guard(mutex());auto at=bitmapOwners().find(key);if(at==bitmapOwners().end())return;pending().erase(key);
        retired=std::move(at->second);bitmapOwners().erase(at);owners().erase(key);retired->retired.store(true);
        presentation=std::move(retired->presentation);image=std::move(retired->awaiting);}
    retired->pool.clear();stopBitmapPresentation(std::move(presentation));macfx::releaseFrameOwner(key);
}
void retireBitmapPresentation(const std::shared_ptr<BitmapOwner>&bitmap){
    std::shared_ptr<macfx::LayerPresentation>presentation;
    {std::lock_guard<std::mutex>guard(mutex());presentation=std::move(bitmap->presentation);}
    stopBitmapPresentation(std::move(presentation));
}
struct ContextBinding {uint32_t identifier;void *context;};
std::map<void*,ContextBinding> &contexts(){static auto *m=new std::map<void*,ContextBinding>;return *m;}
std::map<void*,void*> &contextLayers(){static auto *m=new std::map<void*,void*>;return *m;}
std::map<void*,uint32_t> &remoteOwners(){static auto *m=new std::map<void*,uint32_t>;return *m;}
char layerLifetimeKey,contextLifetimeKey;
void retainLifetime(id object,char *association,void(*cleanup)(void*)) {
    if(objc_getAssociatedObject(object,association))return;
    @synchronized(object) {
        if(objc_getAssociatedObject(object,association))return;
        MacFXOwnerLifetime *lifetime=[MacFXOwnerLifetime new];lifetime->owner=(__bridge void*)object;lifetime->cleanup=cleanup;
        objc_setAssociatedObject(object,association,lifetime,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
}
void forgetLayer(void *key) {
    std::shared_ptr<macfx::ViewPresentation> retired;
    {std::lock_guard<std::mutex>guard(mutex());
        owners().erase(key);pending().erase(key);contexts().erase(key);remoteOwners().erase(key);
        for(auto at=contextLayers().begin();at!=contextLayers().end();)if(at->second==key)at=contextLayers().erase(at);else ++at;
        auto at=metalPresentations().find(key);if(at!=metalPresentations().end()){retired=std::move(at->second);metalPresentations().erase(at);}
    }
    if(retired)retired->stop();
    forgetPendingRemote(key);
    forgetBitmap(key);
    forgetRemotePresentation(key);
    macfx::releaseFrameOwner(key);
}
void forgetContext(void *key) {
    void *layer=nullptr;
    {std::lock_guard<std::mutex>guard(mutex());auto found=contextLayers().find(key);
        if(found!=contextLayers().end()) {layer=found->second;contextLayers().erase(found);auto binding=contexts().find(layer);
            if(binding!=contexts().end()&&binding->second.context==key)contexts().erase(binding);else layer=nullptr;}
        if(layer)remoteOwners().erase(layer);
    }
    if(layer){forgetPendingRemote(layer);forgetRemotePresentation(layer);macfx::releaseFrameOwner(layer);}
}
NSInteger &selectedWindow() { static NSInteger number=0; return number; }
bool visible(NSWindow *window) {
    return window && !macfx::isBrowserFrameOutputWindow(window) && !macfx::isVirtualOutputWindow(window) && window.windowNumber>0 && window.isVisible && !window.isMiniaturized &&
        window.contentView.bounds.size.width>0 && window.contentView.bounds.size.height>0;
}
bool gameContentView(NSView *view) {
    NSView *content=view.window.contentView;
    return content&&(view==content||[view isDescendantOf:content]);
}
void forgetPresentation(CGLContextObj context) {
    std::shared_ptr<macfx::ViewPresentation> retired;
    {std::lock_guard<std::mutex>guard(mutex());auto found=presentations().find(context);if(found!=presentations().end()){retired=std::move(found->second);presentations().erase(found);}}
    if(retired)retired->stop();
}
void forgetMetalPresentation(CALayer *layer) {
    std::shared_ptr<macfx::ViewPresentation> retired;
    {std::lock_guard<std::mutex>guard(mutex());auto found=metalPresentations().find((__bridge void*)layer);if(found!=metalPresentations().end()){retired=std::move(found->second);metalPresentations().erase(found);}}
    if(retired)retired->stop();
}
macfx::PresenterConfig presentationConfig(macfx::FrameOrigin origin,macfx::RuntimeFrameSource frameSource=macfx::RuntimeFrameSource::MetalDrawable) {
    const auto graphics=macfx::presentationGraphicsEnvironment();macfx::PresenterConfig config;config.origin=origin;config.frameSource=frameSource;config.generation=graphics.generation;config.adaptive=graphics.adaptive;
    config.method=macfx::spatialMethodForName(graphics.spatialMethod);
    return config;
}
void forgetWindow(NSInteger number) {
    std::vector<std::shared_ptr<macfx::ViewPresentation>> retired;std::vector<void*>retiredOwners;
    {std::lock_guard<std::mutex> guard(mutex());
    for(auto at=owners().begin();at!=owners().end();) {
        if(at->second.number==number) {
            retiredOwners.push_back(at->first);
            auto presentation=presentations().find(static_cast<CGLContextObj>(at->first));
            if(presentation!=presentations().end()){retired.push_back(std::move(presentation->second));presentations().erase(presentation);}
            auto metal=metalPresentations().find(at->first);
            if(metal!=metalPresentations().end()){retired.push_back(std::move(metal->second));metalPresentations().erase(metal);}
            at=owners().erase(at);
        }else ++at;
    }
    if(selectedWindow()==number) selectedWindow()=0;}
    for(auto &presentation:retired)presentation->stop();
    for(void *owner:retiredOwners){forgetBitmap(owner);forgetQuartz(owner);forgetRemotePresentation(owner);macfx::releaseFrameOwner(owner);}
}
// A splash can be ordered out without being closed. Refresh the automatic
// selection on the AppKit thread before resolving the next rendered surface.
void refreshSelection() {
    NSInteger selected;
    { std::lock_guard<std::mutex> guard(mutex()); selected=selectedWindow(); }
    NSWindow *window=selected?[NSApp windowWithWindowNumber:selected]:nil;
    if(selected&&!visible(window)&&!macfx::virtualWindowSuspended(window))forgetWindow(selected);
}
bool matches(const Owner &owner) {
    const auto &config=macfx::nativeConfig();
    if(config.windowId) return owner.number==*config.windowId;
    if(config.windowTitle) return owner.title==*config.windowTitle;
    if(!selectedWindow()) {selectedWindow()=owner.number;macfx::diagnosticEvent(macfx::DiagnosticStage::WindowSelected,owner.number,owner.width,owner.height);}
    return selectedWindow()==owner.number;
}
uint32_t contextId(id object) {
    SEL selector=NSSelectorFromString(@"contextId");
    if(![object respondsToSelector:selector]) return 0;
    return reinterpret_cast<uint32_t(*)(id,SEL)>(objc_msgSend)(object,selector);
}
NSView *viewForLayer(NSView *view,CALayer *layer) {
    for(NSView *child in view.subviews)if(NSView *found=viewForLayer(child,layer))return found;
    if(view.layer)for(CALayer *at=layer;at;at=at.superlayer)if(at==view.layer)return view;
    return nil;
}
// Catalyst publishes UIKit layers through a CAContextHostLayer in AppKit.
// They are not descendants of an NSView.layer. Match the actual live context
// identity on both sides; window dimensions or "the first window" are not
// sufficient evidence that a drawable belongs to that window.
bool containsContext(CALayer *layer,uint32_t identifier,unsigned &remaining,unsigned depth=0) {
    if(!layer||!remaining||depth>=128)return false;
    --remaining;if(contextId(layer)==identifier)return true;
    for(CALayer *child in layer.sublayers)if(containsContext(child,identifier,remaining,depth+1))return true;
    return false;
}
NSView *viewForContext(NSView *view,uint32_t identifier,unsigned &remaining,unsigned depth=0) {
    if(!view||!remaining||depth>=128)return nil;
    --remaining;
    for(NSView *child in view.subviews)if(NSView *found=viewForContext(child,identifier,remaining,depth+1))return found;
    return containsContext(view.layer,identifier,remaining)?view:nil;
}
// UIKit's scene compositor can publish a different remote CAContext from the
// app's Metal layer. Use the same live scene identifier on UIKit and AppKit,
// rather than inferring ownership from size or selecting an arbitrary window.
id objectGetter(id object,const char *name) {
    if(!object)return nil;SEL selector=sel_registerName(name);
    Method method=class_getInstanceMethod(object_getClass(object),selector);
    char result[32]={};if(method)method_getReturnType(method,result,sizeof(result));
    if(!method||method_getNumberOfArguments(method)!=2||result[0]!='@'||result[1]=='?')return nil;
    return reinterpret_cast<id(*)(id,SEL)>(objc_msgSend)(object,selector);
}
NSView *viewForScene(NSView *view,NSString *identifier,Class sceneViewClass,unsigned &remaining,unsigned depth=0) {
    if(!view||!remaining||depth>=128)return nil;--remaining;
    if([view isKindOfClass:sceneViewClass]){
        id actual=objectGetter(view,"sceneIdentifier");
        if([actual isKindOfClass:NSString.class]&&[actual isEqualToString:identifier])return view;
    }
    for(NSView *child in view.subviews)if(NSView *found=viewForScene(child,identifier,sceneViewClass,remaining,depth+1))return found;
    return nil;
}
NSView *catalystView(CALayer *layer) {
    Class uiView=NSClassFromString(@"UIView"),uiWindow=NSClassFromString(@"UIWindow"),uiScene=NSClassFromString(@"UIWindowScene"),sceneView=NSClassFromString(@"UINSSceneView");
    if(!uiView||!uiWindow||!uiScene||!sceneView)return nil;
    @try {
        unsigned depth=0;
        for(CALayer *at=layer;at&&depth++<256;at=at.superlayer){
            id view=at.delegate;if(![view isKindOfClass:uiView]||objectGetter(view,"layer")!=at)continue;
            id window=objectGetter(view,"window");if(![window isKindOfClass:uiWindow])continue;
            id scene=objectGetter(window,"windowScene");if(![scene isKindOfClass:uiScene])continue;
            id identifier=objectGetter(scene,"_sceneIdentifier");
            if(![identifier isKindOfClass:NSString.class]||![identifier length]||[identifier length]>1024)continue;
            for(NSWindow *host in NSApp.windows)if(visible(host)){
                unsigned remaining=4096;
                if(NSView *source=viewForScene(host.contentView,identifier,sceneView,remaining))return source;
            }
        }
    }@catch(NSException *exception){return nil;}
    return nil;
}
uint32_t ancestorContext(CALayer *layer) {
    CALayer *hierarchy[256]{};unsigned count=0;CALayer *ancestor=layer;
    while(ancestor&&count<256){hierarchy[count++]=ancestor;ancestor=ancestor.superlayer;}
    if(ancestor)return 0;
    std::lock_guard<std::mutex>guard(mutex());
    for(unsigned i=0;i<count;++i){auto found=contexts().find((__bridge void*)hierarchy[i]);if(found!=contexts().end())return found->second.identifier;}
    return 0;
}
void collectLayers(CALayer *layer,std::vector<uint32_t> &ids) {
    if(!layer) return;
    const auto id=contextId(layer); if(id) ids.push_back(id);
    for(CALayer *child in layer.sublayers) collectLayers(child,ids);
}
void collectViews(NSView *view,std::vector<uint32_t> &ids) {
    installQuartzView(view);
    collectLayers(view.layer,ids);
    for(NSView *child in view.subviews) collectViews(child,ids);
}
void retireHiddenRemotePresentations() {
    if(!state)return;uint32_t selected=0;std::set<uint32_t>ids;bool valid=false;
    for(unsigned attempt=0;attempt<3&&!valid;++attempt){const auto sequence=__atomic_load_n(&state->sequence,__ATOMIC_ACQUIRE);if(sequence&1)continue;
        selected=__atomic_load_n(&state->window,__ATOMIC_RELAXED);ids.clear();const auto count=std::min(__atomic_load_n(&state->count,__ATOMIC_RELAXED),64u);
        for(unsigned i=0;i<count;++i)ids.insert(__atomic_load_n(&state->contexts[i],__ATOMIC_RELAXED));valid=sequence==__atomic_load_n(&state->sequence,__ATOMIC_ACQUIRE);
    }
    if(!valid)return;std::vector<void*>retired;
    std::vector<std::pair<void*,RemotePresentation>>local;
    {std::lock_guard<std::mutex>guard(mutex());for(const auto&entry:remotePresentations()){
        if(!entry.second.identifier)local.push_back(entry);
        else if(entry.second.window!=selected||!ids.count(entry.second.identifier))retired.push_back(entry.first);}}
    for(const auto&entry:local)if(resolveLocalSurfaceOwner(entry.second.localLayer).number!=entry.second.window)retired.push_back(entry.first);
    for(auto key:retired)forgetRemotePresentation(key);
}
// Without processing a route may stop drawing (a closed browser stream, an
// ended remote or bitmap owner) or the game may be idle. The selected window,
// or the earlier selection while it stays visible, then acknowledges a
// pass-through plan from this tick: at most every 250 ms, only while a reader
// leases the status page, and without drawing. Once processing resumes or the
// selection changes, that context is retired so it never outvotes the
// contexts that draw.
void acknowledgePassThrough(NSWindow *selected) {
    static uintptr_t acknowledged=0;
    if(!selected){NSInteger number;{std::lock_guard<std::mutex>guard(mutex());number=selectedWindow();}
        if(!number&&macfx::nativeConfig().windowId)number=NSInteger(*macfx::nativeConfig().windowId);
        NSWindow *window=number?[NSApp windowWithWindowNumber:number]:nil;selected=visible(window)?window:nil;}
    const auto window=selected&&!macfx::imageProcessingRequested()?reinterpret_cast<uintptr_t>((__bridge void*)selected):0;
    if(acknowledged&&acknowledged!=window){macfx::retireRuntimeStatus(acknowledged);acknowledged=0;}
    // A process that never processed, such as an Off launch, maps a leased
    // page here (bounded to one attempt per second) before acknowledging.
    if(window&&!macfx::runtimeStatusLeased())macfx::pollRuntimeStatus(false);
    if(window&&macfx::runtimeStatusLeased()){macfx::observeBypassedPlan(window);acknowledged=window;}
}
void publishWindows() {
    if(!state) return;
    retireHiddenRemotePresentations();
    macfx::DiagnosticScope diagnostics(macfx::DiagnosticStage::WindowPublish);
    refreshSelection();
    retireQuartzPresentations();
    uint32_t windowNumber=0,width=0,height=0; std::vector<uint32_t> ids;
    for(NSWindow *window in NSApp.windows) {
        if(!visible(window)) continue;
        std::vector<uint32_t> found;
        collectViews(window.contentView,found);
        if(found.empty()){
            bool bitmap=false;
            {std::lock_guard<std::mutex>guard(mutex());for(const auto&entry:remoteOwners()){
                auto owner=owners().find(entry.first);if(owner!=owners().end()&&owner->second.number==window.windowNumber){bitmap=true;break;}}}
            {std::lock_guard<std::mutex>guard(mutex());for(const auto&entry:bitmapOwners())
                if(entry.second->accepted&&entry.second->window==window.windowNumber){bitmap=true;break;}}
            if(!bitmap){std::lock_guard<std::mutex>guard(mutex());for(const auto&entry:quartzOwners())
                if(!entry.second->retired.load()&&entry.second->window==window.windowNumber){bitmap=true;break;}}
            if(!bitmap)continue;
        }
        Owner owner={window.windowNumber,window.title.UTF8String ?: ""};
        const NSRect pixels=[window.contentView convertRectToBacking:window.contentView.bounds];
        std::lock_guard<std::mutex> guard(mutex());
        if(matches(owner)) {
            windowNumber=uint32_t(owner.number); ids=std::move(found);
            width=uint32_t(pixels.size.width); height=uint32_t(pixels.size.height); break;
        }
    }
    NSWindow *selected=[NSApp windowWithWindowNumber:windowNumber];
    macfx::pollBrowserFrameFallback(selected,macfx::imageProcessingRequested()&&macfx::automaticPresentationNeeded(width,height,width,height));
    acknowledgePassThrough(selected);
    const unsigned count=std::min<size_t>(ids.size(),64);
    macfx::WindowSnapshot snapshot;
    snapshot.window=windowNumber;snapshot.width=width;snapshot.height=height;snapshot.count=count;
    snapshot.pointsWidth=uint32_t(selected.contentView.bounds.size.width);
    snapshot.pointsHeight=uint32_t(selected.contentView.bounds.size.height);
    std::copy_n(ids.begin(),count,snapshot.contexts);
    if(!macfx::publishWindowState(state,snapshot,uint32_t(getpid()))) return;
    if(macfx::nativeConfig().diagnostics.trace) {
        static uint32_t last=0,lastW=0,lastH=0;
        if(windowNumber && (last!=windowNumber || lastW!=width || lastH!=height)) { last=windowNumber;lastW=width;lastH=height;macfx::nativeLog("selected window="+std::to_string(windowNumber)+" size="+std::to_string(width)+"x"+std::to_string(height)+" contexts="+std::to_string(count)); }
    }
}
uint32_t windowForContext(uint32_t id,unsigned width,unsigned height,unsigned *outputWidth=nullptr,unsigned *outputHeight=nullptr,
                          macfx::remoteIngressDiagnostics::Selection *diagnostic=nullptr) {
    if(diagnostic){*diagnostic={};diagnostic->state=state!=nullptr;}
    if(!state || (!id&&!diagnostic)) return 0;
    // A browser helper whose sandbox refuses the plan path keeps an earlier
    // plan and cannot read later edits or effect sources. It admits no native
    // full frame; its observation counts as a rejection, so the launcher-side
    // completed-window path, which reads every edit, processes the window.
    const bool followsPlan=!macfx::browserFrameFallbackEnabled()||!macfx::effectPlanReadDenied();
    for(unsigned attempt=0;attempt<3;++attempt) {
        const auto sequence=__atomic_load_n(&state->sequence,__ATOMIC_ACQUIRE);
        if(sequence&1) continue;
        uint32_t result=0,window=__atomic_load_n(&state->window,__ATOMIC_RELAXED);
        const bool dimensions=followsPlan&&((width==__atomic_load_n(&state->width,__ATOMIC_RELAXED) && height==__atomic_load_n(&state->height,__ATOMIC_RELAXED)) ||
            (width==__atomic_load_n(&state->pointsWidth,__ATOMIC_RELAXED) && height==__atomic_load_n(&state->pointsHeight,__ATOMIC_RELAXED)));
        const auto count=std::min(__atomic_load_n(&state->count,__ATOMIC_RELAXED),64u);
        for(unsigned i=0;i<count;++i) if(id && dimensions && __atomic_load_n(&state->contexts[i],__ATOMIC_RELAXED)==id) result=window;
        const auto physicalWidth=__atomic_load_n(&state->width,__ATOMIC_RELAXED),physicalHeight=__atomic_load_n(&state->height,__ATOMIC_RELAXED);
        if(diagnostic){diagnostic->state=true;diagnostic->window=window;diagnostic->width=physicalWidth;diagnostic->height=physicalHeight;
            diagnostic->pointsWidth=__atomic_load_n(&state->pointsWidth,__ATOMIC_RELAXED);diagnostic->pointsHeight=__atomic_load_n(&state->pointsHeight,__ATOMIC_RELAXED);
            diagnostic->count=count;diagnostic->listed=false;diagnostic->dimensions=dimensions;
            for(unsigned i=0;i<count;++i)if(id&&__atomic_load_n(&state->contexts[i],__ATOMIC_RELAXED)==id)diagnostic->listed=true;
        }
        if(sequence==__atomic_load_n(&state->sequence,__ATOMIC_ACQUIRE)){
            if(diagnostic)diagnostic->stable=true;
            // Extent-admitted native ingress stays preferred. Tile rejection is
            // scoped to a context already authenticated in this window state.
            if(id&&macfx::browserFrameFallbackEnabled()){
                bool listed=false;for(unsigned i=0;i<count;++i)if(__atomic_load_n(&state->contexts[i],__ATOMIC_RELAXED)==id)listed=true;
                if(listed)macfx::browserFrameNativeObservation(window,dimensions);
            }
            if(result){if(outputWidth)*outputWidth=physicalWidth;if(outputHeight)*outputHeight=physicalHeight;}return result;}
    }
    return 0;
}
void probeBrowserNativeRegistration(){
    if(!state||!macfx::browserFrameFallbackEnabled())return;
    const auto demand=macfx::browserFrameDemand();
    static uint32_t probedWindow=0,probedEpoch=0;
    if(!demand.window||!demand.epoch||(probedWindow==demand.window&&probedEpoch==demand.epoch))return;
    // Only registration metadata crosses this boundary. In particular a
    // sandboxed helper's cached local Off packet cannot suppress its parent's
    // explicit On request, and no retained IOSurface is replayed as a frame.
    macfx::WindowSnapshot selected;bool stable=false;uint32_t publisher=0;
    for(unsigned attempt=0;attempt<3&&!stable;++attempt){const auto sequence=__atomic_load_n(&state->sequence,__ATOMIC_ACQUIRE);if(sequence&1)continue;
        selected.window=__atomic_load_n(&state->window,__ATOMIC_RELAXED);selected.count=std::min(__atomic_load_n(&state->count,__ATOMIC_RELAXED),64u);
        publisher=__atomic_load_n(&state->publisher,__ATOMIC_RELAXED);
        for(unsigned i=0;i<selected.count;++i)selected.contexts[i]=__atomic_load_n(&state->contexts[i],__ATOMIC_RELAXED);
        stable=sequence==__atomic_load_n(&state->sequence,__ATOMIC_ACQUIRE);
    }
    if(!stable||selected.window!=demand.window||publisher!=demand.publisher)return;
    bool registered=false;
    {std::lock_guard<std::mutex>guard(mutex());unsigned visited=0;
        for(const auto &entry:contexts()){if(++visited>256)break;
            registered=macfx::browserFrameRegistrationMatches(demand,selected.window,publisher,selected.contexts,selected.count,entry.second.identifier);
            if(registered)break;
        }}
    if(registered&&macfx::browserFrameNativeProbe(demand.window,demand.epoch)){probedWindow=demand.window;probedEpoch=demand.epoch;}
}
void resolve(CALayer *layer) {
    macfx::DiagnosticScope diagnostics(macfx::DiagnosticStage::WindowResolve,reinterpret_cast<uintptr_t>((__bridge void *)layer));
    refreshSelection();
    MacFXLayerBinding *binding=layerBinding(layer);
    NSView *source=binding->value.currentView(layer);Owner owner{};bool remote=false,catalyst=false;
    if(source&&macfx::virtualWindowSuspended(source.window)){
        if(auto presentation=macfx::metalPresentation(layer))presentation->update(source,0,0);
        std::lock_guard<std::mutex>guard(mutex());pending().erase((__bridge void*)layer);return;
    }
    if(source&&(!visible(source.window)||!gameContentView(source)))source=nil;
    if(!source){
        for(NSWindow *window in NSApp.windows)if(visible(window))
            if((source=viewForLayer(window.contentView,layer)))break;
        binding->value.view=source;
    }
    if(!source){source=catalystView(layer);remote=catalyst=source!=nil;}
    if(!source){
        const auto identifier=ancestorContext(layer);
        if(identifier)for(NSWindow *window in NSApp.windows)if(visible(window)){
            unsigned remaining=4096;
            if((source=viewForContext(window.contentView,identifier,remaining))){remote=true;break;}
        }
    }
    if(source){
        NSWindow *window=source.window;const auto size=[window convertRectToBacking:[source convertRect:source.bounds toView:nil]];
        owner={window.windowNumber,window.title.UTF8String ?: "",unsigned(size.size.width),unsigned(size.size.height)};
        if(catalyst){
            // The scene can contain several UIKit layers. Scale only this
            // renderer's local bounds; its parents retain transforms/clipping.
            const double w=std::ceil(layer.bounds.size.width*layer.contentsScale),h=std::ceil(layer.bounds.size.height*layer.contentsScale);
            if(!std::isfinite(w)||!std::isfinite(h)||w<1||h<1||w>16384||h>16384)source=nil;
            else {owner.width=unsigned(w);owner.height=unsigned(h);}
        }
        // A layer that does not stretch its whole drawable over its bounds
        // is presented at the publisher's drawable extent with the same
        // mapping, never fitted to the view. A virtual output keeps filling
        // its own target.
        if(source&&[layer isKindOfClass:CAMetalLayer.class]&&!macfx::contentsGeometry(layer).stretched&&!macfx::virtualPresentationRequired(source)){
            const auto extent=macfx::publisherDrawableSize((CAMetalLayer*)layer);
            if(std::isfinite(extent.width)&&std::isfinite(extent.height)&&extent.width>=1&&extent.height>=1&&extent.width<=16384&&extent.height<=16384)
                {owner.width=unsigned(extent.width);owner.height=unsigned(extent.height);}
        }
    }
    if(source&&macfx::browserFrameOwnsWindow(uint32_t(owner.number))){
        {std::lock_guard<std::mutex>guard(mutex());owners().erase((__bridge void*)layer);pending().erase((__bridge void*)layer);}
        forgetMetalPresentation(layer);return;
    }
    bool accepted=false;
    // Discover a candidate without withdrawing the last accepted binding.
    // Producer threads must not mistake an in-progress lookup for retirement.
    bool changed=false;
    {std::lock_guard<std::mutex>guard(mutex());const auto previous=owners().find((__bridge void*)layer);
        changed=source?(previous==owners().end()||previous->second.number!=owner.number||previous->second.width!=owner.width||previous->second.height!=owner.height):previous!=owners().end();
        if(source){owners()[(__bridge void*)layer]=owner;accepted=matches(owner);}
        else owners().erase((__bridge void*)layer);pending().erase((__bridge void*)layer);}
    const char *decision=!source?"owner-retired":!accepted?"owner-unselected":changed?"owner-published-new":"owner-published-unchanged";
    macfx::observeRuntimeAdmission(reinterpret_cast<uintptr_t>((__bridge void*)layer),decision,owner.width,owner.height);
    if(macfx::diagnosticsEnabled()){
        macfx::DiagnosticScope publication(macfx::DiagnosticStage::WindowResolve,reinterpret_cast<uintptr_t>((__bridge void*)layer),owner.width,owner.height,
            decision);
    }
    const bool diagnostic=macfx::nativeConfig().diagnostics.enabled&&macfx::nativeConfig().diagnostics.metalPresentation;
    const CGSize input=[layer isKindOfClass:CAMetalLayer.class]?((CAMetalLayer*)layer).drawableSize:CGSizeZero;
    if(source&&accepted&&[layer isKindOfClass:CAMetalLayer.class])
        macfx::setVirtualPublisherExtent(source,(__bridge const void*)layer,input);
    bool resolution=false;
    try {resolution=macfx::drawableResolutionRequested();}catch(const std::exception&e){static bool warned=false;if(!warned){warned=true;macfx::nativeLog(e.what());}}
    const auto retainedPresentation=macfx::presentationHoldConfigured()?macfx::metalPresentation(layer):nullptr;
    const bool held=retainedPresentation&&retainedPresentation->presentationHeld();
    const auto existingPresentation=retainedPresentation?retainedPresentation:macfx::metalPresentation(layer);
    CAMetalLayer *metalSource=[layer isKindOfClass:CAMetalLayer.class]?(CAMetalLayer*)layer:nil;
    const auto sourceFormat=macfx::nativeFxColorFormat(metalSource.pixelFormat);
    const bool readable=metalSource&&macfx::nativeMetalSourceReadable(metalSource.pixelFormat,metalSource.framebufferOnly,
        metalSource.framebufferOnly&&macfx::nativeFramebufferColorFormatSupported(metalSource.pixelFormat)&&[metalSource.device supportsFamily:MTLGPUFamilyApple2]);
    const bool nativeFxInPlace=!remote&&readable&&macfx::nativeFxColorFormatSupported(sourceFormat);
    const auto sourceColor=macfx::imageColorSpace(metalSource.colorspace,metalSource.wantsExtendedDynamicRangeContent);
    const bool colorSupported=!metalSource||sourceColor!=macfx::ImageColorSpace::Unsupported;
    const bool ownedSourceSupported=readable&&macfx::imageRGBFormat(sourceFormat)&&colorSupported;
    const bool sourcePresentationRequired=resolution||macfx::virtualPresentationRequired(source);
    if(metalSource&&existingPresentation)existingPresentation->setNativeMetalCapabilities(nativeFxInPlace,ownedSourceSupported&&existingPresentation->colorSpaceMatches(metalSource.colorspace,sourceColor),sourcePresentationRequired);
    // Fresh size-preserving FX uses its original drawable even while native
    // window backing and drawable extents briefly differ during a resize.
    // An existing owner remains necessary until its last processed image can be handed back to a
    // matching original presentation; removing it here could expose old pixels.
    const bool retiringFxOwner=existingPresentation&&!existingPresentation->snapshot().stopped&&macfx::effectRequested();
    const bool processing=macfx::graphicsRequested()&&(sourcePresentationRequired||retiringFxOwner||
        macfx::automaticPresentationNeeded(input.width,input.height,owner.width,owner.height,{nativeFxInPlace}));
    // The owned presenter retains the actual source color description and
    // creates a floating-point EDR output for a declared HDR publisher.
    if(metalSource&&!colorSupported){
        if(processing||diagnostic||held){static bool warned=false;if(!warned){warned=true;macfx::nativeLog(std::string(macfx::imageColorReason(sourceColor)));}}
        if(!held)forgetMetalPresentation(layer);return;
    }
    // Check the actual readable publisher contract before constructing an
    // output or reducing a virtual source. Unknown color remains untouched.
    if(metalSource&&!ownedSourceSupported){
        if(processing||diagnostic||held){static bool warned=false;if(!warned){warned=true;macfx::nativeLog("Owned presentation is unavailable for this Metal image contract; original layer retained");}}
        if(!held)forgetMetalPresentation(layer);return;
    }
    // Keep UIKit children and input above their own renderer. A layer-local
    // output uses the same FramePresenter without covering the remote scene.
    if(accepted&&(!remote||catalyst)&&(processing||diagnostic||held)) {
        auto presentation=existingPresentation;
        auto selectedPresentation=presentationConfig(macfx::FrameOrigin::TopLeft);
        if(metalSource){selectedPresentation.sourceColorSpace=sourceColor;selectedPresentation.sourceColor=macfx::describeImageColor(sourceColor);selectedPresentation.sourceColor->alpha=metalSource.opaque?macfx::ColorAlpha::Opaque:macfx::ColorAlpha::Straight;}
        try {
            if(presentation&&catalyst)presentation->update((CAMetalLayer*)layer,source,owner.width,owner.height);
            else if(presentation)presentation->update(source,owner.width,owner.height);
            if(presentation&&presentation->snapshot().stopped&&presentation->failedForCurrentContract(owner.width,owner.height,sourceFormat,metalSource.device))return;
            if(presentation&&presentation->snapshot().stopped){auto previous=presentation->takePreviousOutput();forgetMetalPresentation(layer);presentation=std::move(previous);if(presentation){std::lock_guard<std::mutex>guard(mutex());metalPresentations()[(__bridge void*)layer]=presentation;}}
            if(presentation&&metalSource&&!held&&!presentation->colorSpaceMatches(metalSource.colorspace,sourceColor)){
                auto candidate=catalyst?std::make_shared<macfx::ViewPresentation>(metalSource,source,owner.width,owner.height,selectedPresentation,metalSource.colorspace,presentation):
                    std::make_shared<macfx::ViewPresentation>(source,owner.width,owner.height,selectedPresentation,metalSource.colorspace,presentation);
                presentation=std::move(candidate);std::lock_guard<std::mutex>guard(mutex());metalPresentations()[(__bridge void*)layer]=presentation;
            }
            if(!presentation&&catalyst&&[layer isKindOfClass:CAMetalLayer.class]){
                presentation=std::make_shared<macfx::ViewPresentation>((CAMetalLayer*)layer,source,owner.width,owner.height,selectedPresentation);
                std::lock_guard<std::mutex>guard(mutex());metalPresentations()[(__bridge void*)layer]=presentation;
            }
            else if(!presentation&&source.superview){
                presentation=std::make_shared<macfx::ViewPresentation>(source,owner.width,owner.height,selectedPresentation,metalSource?metalSource.colorspace:nullptr);
                std::lock_guard<std::mutex>guard(mutex());metalPresentations()[(__bridge void*)layer]=presentation;
            }
            if(presentation&&!catalyst&&presentation->setContentsSource(layer))presentation->update(source,owner.width,owner.height);
            if(metalSource&&presentation)presentation->setNativeMetalCapabilities(nativeFxInPlace,ownedSourceSupported,sourcePresentationRequired);
        }catch(const std::exception&e){macfx::nativeLog("View presentation unavailable: "+std::string(e.what()));if(!existingPresentation)forgetMetalPresentation(layer);}
    }else {forgetMetalPresentation(layer);if(!accepted)macfx::releaseFrameOwner((__bridge void*)layer);}
}
IMP originalContents=nullptr,originalSetView=nullptr,originalClearDrawable=nullptr,originalContextLayer=nullptr;
IMP originalSetTitle=nullptr,originalClose=nullptr;
IMP originalOrderOut=nullptr,originalMiniaturize=nullptr;
// Only AppKit resolves view ownership and creates/removes presentation layers.
// Render publishers never wait synchronously for the main queue.
char quartzLifetimeKey;
IMP originalViewDidMoveToWindow=nullptr;
bool quartzViewOwner(NSView*view,Owner&owner){
    if(!NSThread.isMainThread||!view||[view isKindOfClass:MacFXQuartzPresentationView.class]||
        view.hiddenOrHasHiddenAncestor||!visible(view.window)||!gameContentView(view)||view.boundsRotation!=0||view.frameRotation!=0)return false;
    if(macfx::browserFrameOwnsWindow(uint32_t(view.window.windowNumber)))return false;
    NSView*content=view.window.contentView;
    const NSRect coverage=[view convertRect:view.bounds toView:content],required=content.bounds;
    if(std::abs(NSMinX(coverage)-NSMinX(required))>1||std::abs(NSMinY(coverage)-NSMinY(required))>1||
        std::abs(NSMaxX(coverage)-NSMaxX(required))>1||std::abs(NSMaxY(coverage)-NSMaxY(required))>1)return false;
    const NSRect pixels=[view convertRectToBacking:view.bounds];
    const double w=std::ceil(pixels.size.width),h=std::ceil(pixels.size.height);
    if(!std::isfinite(w)||!std::isfinite(h)||w<1||h<1||w>16384||h>16384)return false;
    owner={view.window.windowNumber,view.window.title.UTF8String?:"",unsigned(w),unsigned(h)};
    std::lock_guard<std::mutex>guard(mutex());
    const auto &config=macfx::nativeConfig();
    if(config.windowId)return owner.number==*config.windowId;
    if(config.windowTitle)return owner.title==*config.windowTitle;
    return !selectedWindow()||selectedWindow()==owner.number;
}
void retireQuartzPresentations(){
    std::vector<std::pair<void*,std::shared_ptr<QuartzOwner>>>entries;
    {std::lock_guard<std::mutex>guard(mutex());for(const auto&entry:quartzOwners())entries.push_back(entry);}
    for(const auto&entry:entries){Owner owner{};
        if(!macfx::imageProcessingRequested(macfx::virtualPresentationRequired(entry.second->source))||!quartzViewOwner(entry.second->source,owner)||owner.number!=entry.second->window)
            forgetQuartz(entry.first);}
}
void submitQuartz(const std::shared_ptr<QuartzOwner>&entry){
    entry->queued=false;if(entry->retired.load())return;
    NSView*view=entry->source;void*key=(__bridge void*)view;Owner owner{};
    auto image=std::move(entry->awaiting);
    if(!image||!quartzViewOwner(view,owner)||owner.number!=entry->window||
        !macfx::imageProcessingRequested(macfx::virtualPresentationRequired(view))){forgetQuartz(key);return;}
    if(!macfx::QuartzFrameCapture::matchesExtent(image->image,view.bounds.size,[view convertRectToBacking:view.bounds].size)){
        forgetQuartz(key);return;
    }
    {std::lock_guard<std::mutex>guard(mutex());if(!matches(owner)){image.reset();}}
    if(!image){forgetQuartz(key);return;}
    auto uploaded=entry->pool.upload(image->image);
    // The current shared overlay is opaque. Preserve original transparent
    // drawing until its presenter can faithfully retire/composite the base.
    if(!uploaded||!uploaded->opaque){forgetQuartz(key);return;}
    try{
        if(!entry->overlay){
            auto overlay=[[MacFXQuartzPresentationView alloc]initWithFrame:view.bounds];
            overlay.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
            overlay.wantsLayer=YES;overlay.layer.opaque=NO;
            [view addSubview:overlay positioned:NSWindowBelow relativeTo:nil];entry->overlay=overlay;
        }
        if(entry->overlay.superview!=view){forgetQuartz(key);return;}
        entry->overlay.frame=view.bounds;
        if(entry->presentation)entry->presentation->update(owner.width,owner.height);
        else entry->presentation=std::make_shared<macfx::LayerPresentation>(entry->overlay.layer,owner.width,owner.height,presentationConfig(macfx::FrameOrigin::TopLeft,macfx::RuntimeFrameSource::SoftwareBitmap));
        macfx::DiagnosticScope diagnostics(macfx::DiagnosticStage::WindowSurface,owner.number,uploaded->width,uploaded->height);
        const auto result=entry->presentation->submit(uploaded->surface);
        if(!result.encoded&&!result.busy){macfx::nativeLog("Quartz graphics presentation unavailable: "+result.reason);forgetQuartz(key);}
    }catch(const std::exception&error){macfx::nativeLog("Quartz graphics presentation unavailable: "+std::string(error.what()));forgetQuartz(key);}
}
void recordQuartz(NSView*view,const Owner&owner,CGImageRef image){
    void*key=(__bridge void*)view;std::shared_ptr<QuartzOwner>entry;
    const auto alpha=CGImageGetAlphaInfo(image);
    if(alpha!=kCGImageAlphaNone&&alpha!=kCGImageAlphaNoneSkipFirst&&alpha!=kCGImageAlphaNoneSkipLast){forgetQuartz(key);return;}
    {std::lock_guard<std::mutex>guard(mutex());if(!matches(owner))return;
        auto at=quartzOwners().find(key);if(at!=quartzOwners().end())entry=at->second;
        else if(quartzOwners().size()<32){entry=std::make_shared<QuartzOwner>();entry->source=view;entry->window=owner.number;quartzOwners()[key]=entry;}
        if(entry)owners()[key]=owner;}
    if(!entry)return;
    retainLifetime(view,&quartzLifetimeKey,forgetQuartz);
    entry->awaiting=macfx::QuartzFrameImage::retain(image);
    if(!entry->awaiting){forgetQuartz(key);return;}
    if(!entry->queued){entry->queued=true;dispatch_async(dispatch_get_main_queue(),^{submitQuartz(entry);});}
}
void drawQuartzScope(id object,NSRect dirty,macfx::QuartzDrawImplementation original){
    NSView*view=object;Owner owner{};
    if(quartzCapture||!macfx::imageProcessingRequested(macfx::virtualPresentationRequired(view))||!quartzViewOwner(view,owner)){
        if(!quartzCapture&&NSThread.isMainThread)forgetQuartz((__bridge void*)view);
        original(object,@selector(drawRect:),dirty);return;
    }
    CGContextRef context=NSGraphicsContext.currentContext.CGContext;
    if(!context){original(object,@selector(drawRect:),dirty);return;}
    const NSRect pixels=[view convertRectToBacking:view.bounds];
    macfx::QuartzFrameCapture capture(context,view.bounds.size,pixels.size);quartzCapture=&capture;
    @try{original(object,@selector(drawRect:),dirty);}
    @finally{quartzCapture=nullptr;}
    // One queued, latest completed frame survives a static scene as well as a
    // continuous publisher. No AppKit tree mutation occurs inside drawRect.
    if(auto image=capture.completed())recordQuartz(view,owner,image);
    else forgetQuartz((__bridge void*)view);
}
void installQuartzView(NSView*view){
    if(!view||!NSThread.isMainThread||[view isKindOfClass:MacFXQuartzPresentationView.class])return;
    const Class cls=object_getClass(view);if(cls==NSView.class)return;
    macfx::installQuartzDrawScope(cls,drawQuartzScope);
}
void quartzViewDidMoveToWindow(id object,SEL selector){
    reinterpret_cast<void(*)(id,SEL)>(originalViewDidMoveToWindow)(object,selector);
    if(!NSThread.isMainThread)return;
    NSView*view=object;if(view.window)installQuartzView(view);else forgetQuartz((__bridge void*)view);
}
CGImageRef quartzBitmapImage(CGContextRef context){
    CGImageRef image=CGBitmapContextCreateImage(context);if(quartzCapture)quartzCapture->bitmap(image);return image;
}
CGImageRef quartzCroppedImage(CGImageRef source,CGRect rect){
    CGImageRef image=CGImageCreateWithImageInRect(source,rect);if(quartzCapture)quartzCapture->crop(source,image);return image;
}
void quartzDrawImage(CGContextRef context,CGRect rect,CGImageRef image){
    CGContextDrawImage(context,rect,image);if(quartzCapture)quartzCapture->draw(context,image);
}
__attribute__((used)) static const struct{const void*replacement;const void*original;}quartzInterpose[]
__attribute__((section("__DATA,__interpose")))={
    {reinterpret_cast<const void*>(quartzBitmapImage),reinterpret_cast<const void*>(CGBitmapContextCreateImage)},
    {reinterpret_cast<const void*>(quartzCroppedImage),reinterpret_cast<const void*>(CGImageCreateWithImageInRect)},
    {reinterpret_cast<const void*>(quartzDrawImage),reinterpret_cast<const void*>(CGContextDrawImage)}};

NSView*bitmapViewForLayer(NSView*view,CALayer*layer,unsigned&remaining,unsigned depth=0){
    if(!view||!layer||!remaining||depth>=128)return nil;--remaining;
    for(NSView*child in view.subviews)if(auto found=bitmapViewForLayer(child,layer,remaining,depth+1))return found;
    if(!remaining)return nil;
    if(view.layer){unsigned ancestors=0;for(CALayer*at=layer;at&&ancestors++<256;at=at.superlayer)if(at==view.layer)return view;}
    return nil;
}
Owner localLayerOwner(CALayer*layer){
    if(!layer)return {};refreshSelection();MacFXLayerBinding*binding=layerBinding(layer);
    NSView*view=binding->value.currentView(layer);
    if(view&&(!visible(view.window)||!gameContentView(view)||macfx::browserFrameOwnsWindow(uint32_t(view.window.windowNumber))))view=nil;
    if(!view){unsigned remaining=4096;for(NSWindow*window in NSApp.windows)if(remaining&&visible(window))
        if((view=bitmapViewForLayer(window.contentView,layer,remaining)))break;binding->value.view=view;}
    Owner owner{};
    // A backing image can live on the view layer or a full-content descendant.
    // Measure this publisher's actual rectangle, not its owning view's size:
    // small image decorations inside a full-window view are not frame sources.
    if(view&&view.layer&&visible(view.window)){
        NSWindow*window=view.window;NSView*content=window.contentView;
        const NSRect local=NSRectFromCGRect([layer convertRect:layer.bounds toLayer:view.layer]);
        const NSRect coverage=[view convertRect:local toView:content],required=content.bounds;
        if(std::abs(NSMinX(coverage)-NSMinX(required))<=1&&std::abs(NSMinY(coverage)-NSMinY(required))<=1&&
            std::abs(NSMaxX(coverage)-NSMaxX(required))<=1&&std::abs(NSMaxY(coverage)-NSMaxY(required))<=1){
            const NSRect pixels=[view convertRectToBacking:local];
            const double width=std::ceil(pixels.size.width),height=std::ceil(pixels.size.height);
            if(std::isfinite(width)&&std::isfinite(height)&&width>=1&&height>=1&&width<=16384&&height<=16384)
                owner={window.windowNumber,window.title.UTF8String?:"",unsigned(width),unsigned(height)};
        }
    }
    return owner;
}
Owner resolveLocalSurfaceOwner(CALayer*layer){
    Owner owner=localLayerOwner(layer);
    if(!layer||!CGRectEqualToRect(layer.contentsRect,CGRectMake(0,0,1,1))||
        !CGRectEqualToRect(layer.contentsCenter,CGRectMake(0,0,1,1))||![layer.contentsGravity isEqualToString:kCAGravityResize])owner={};
    std::lock_guard<std::mutex>guard(mutex());const auto key=(__bridge void*)layer;
    if(owner.number){owners()[key]=owner;if(!matches(owner))return {};}
    else owners().erase(key);
    return owner;
}
void resolveBitmap(CALayer*layer,const std::shared_ptr<BitmapOwner>&bitmap,unsigned inputWidth,unsigned inputHeight,bool opaque){
    if(bitmap->retired.load())return;
    const Owner owner=localLayerOwner(layer);if(bitmap->retired.load())return;bool accepted=false;
    std::shared_ptr<macfx::LayerPresentation>presentation;
    {std::lock_guard<std::mutex>guard(mutex());
        if(owner.number){owners()[(__bridge void*)layer]=owner;accepted=matches(owner);}else owners().erase((__bridge void*)layer);
        bitmap->accepted=accepted;bitmap->window=owner.number;bitmap->width=owner.width;bitmap->height=owner.height;
        presentation=bitmap->presentation;pending().erase((__bridge void*)layer);
    }
    const bool ordinaryGeometry=CGRectEqualToRect(layer.contentsRect,CGRectMake(0,0,1,1))&&
        CGRectEqualToRect(layer.contentsCenter,CGRectMake(0,0,1,1))&&[layer.contentsGravity isEqualToString:kCAGravityResize];
    const bool needed=accepted&&opaque&&ordinaryGeometry&&macfx::graphicsRequested()&&
        macfx::automaticPresentationNeeded(inputWidth,inputHeight,owner.width,owner.height);
    if(needed){try{
        if(presentation)presentation->update(owner.width,owner.height);
        else presentation=std::make_shared<macfx::LayerPresentation>(layer,owner.width,owner.height,presentationConfig(macfx::FrameOrigin::TopLeft,macfx::RuntimeFrameSource::SoftwareBitmap));
        bool retired=false;{std::lock_guard<std::mutex>guard(mutex());retired=bitmap->retired.load();if(!retired)bitmap->presentation=presentation;}
        if(retired){stopBitmapPresentation(std::move(presentation));}
    }catch(const std::exception&error){macfx::nativeLog("Bitmap graphics presentation unavailable: "+std::string(error.what()));
        {std::lock_guard<std::mutex>guard(mutex());bitmap->presentation.reset();}stopBitmapPresentation(std::move(presentation));}}
    else {
        {std::lock_guard<std::mutex>guard(mutex());bitmap->presentation.reset();}
        stopBitmapPresentation(std::move(presentation));
        if(!accepted)forgetBitmap((__bridge void*)layer);
    }
}
bool bitmapContents(id object,SEL selector,id contents,uint64_t replayGeneration=0);
void resolveBitmapAndReplay(CALayer*layer,SEL selector,const std::shared_ptr<BitmapOwner>&bitmap,unsigned width,unsigned height,bool opaque){
    resolveBitmap(layer,bitmap,width,height,opaque);
    std::shared_ptr<BitmapImage>image;uint64_t generation=0;
    {std::lock_guard<std::mutex>guard(mutex());if(bitmap->accepted&&!bitmap->retired.load()){
        image=std::move(bitmap->awaiting);generation=bitmap->awaitingGeneration;}}
    if(!image||layer.contents!=(__bridge id)image->image)return;
    bool current=false;{std::lock_guard<std::mutex>guard(mutex());current=!bitmap->retired.load()&&bitmap->generation==generation;}
    // Resolve a one-shot publisher once. Newer content/generations invalidate
    // this replay, and an unowned image never schedules another attempt.
    if(current)bitmapContents(layer,selector,(__bridge id)image->image,generation);
}
bool bitmapContents(id object,SEL selector,id contents,uint64_t replayGeneration){
    // CGImage uses a CF runtime class on some macOS releases. The exact probed
    // class establishes safe CF identity before querying the image type ID.
    if(!macfx::bitmapImageObject(contents,imageClass()))return false;
    const auto key=(__bridge void*)object;
    if(!macfx::effectRequested()&&!macfx::graphicsRequested()){
        forgetBitmap(key);reinterpret_cast<void(*)(id,SEL,id)>(originalContents)(object,selector,contents);return true;
    }
    auto image=(__bridge CGImageRef)contents;
    const auto inputWidth=CGImageGetWidth(image),inputHeight=CGImageGetHeight(image);
    if(!inputWidth||!inputHeight||inputWidth>16384||inputHeight>16384||inputWidth>64u*1024u*1024u/4/inputHeight){
        forgetBitmap(key);reinterpret_cast<void(*)(id,SEL,id)>(originalContents)(object,selector,contents);return true;
    }
    const auto alpha=CGImageGetAlphaInfo(image);
    const bool opaque=alpha==kCGImageAlphaNone||alpha==kCGImageAlphaNoneSkipFirst||alpha==kCGImageAlphaNoneSkipLast;
    retainLifetime(object,&layerLifetimeKey,forgetLayer);
    std::shared_ptr<BitmapOwner>bitmap;
    {std::lock_guard<std::mutex>guard(mutex());auto at=bitmapOwners().find(key);
        if(at!=bitmapOwners().end())bitmap=at->second;
        else if(bitmapOwners().size()<32){bitmap=std::make_shared<BitmapOwner>();bitmapOwners()[key]=bitmap;}}
    if(!bitmap){reinterpret_cast<void(*)(id,SEL,id)>(originalContents)(object,selector,contents);return true;}
    bool schedule=false;uint64_t publicationGeneration=0;std::shared_ptr<BitmapImage>previousImage;
    const bool main=NSThread.isMainThread;
    auto imageLease=!main?std::make_shared<BitmapImage>(image):nullptr;
    {std::lock_guard<std::mutex>guard(mutex());if(replayGeneration&&bitmap->generation!=replayGeneration)return true;
        publicationGeneration=++bitmap->generation;previousImage=std::move(bitmap->awaiting);
        if(!main){schedule=pending().insert(key).second;if(!bitmap->accepted){bitmap->awaiting=imageLease;bitmap->awaitingGeneration=bitmap->generation;}}}
    const auto currentReplay=[&](){
        if(!replayGeneration)return true;
        bool current=false;{std::lock_guard<std::mutex>guard(mutex());current=!bitmap->retired.load()&&bitmap->generation==publicationGeneration;}
        return current&&[(CALayer*)object contents]==contents;
    };
    const auto publish=[&](id value){
        bool current=true;
        if(value!=contents){std::lock_guard<std::mutex>guard(mutex());current=!bitmap->retired.load()&&bitmap->generation==publicationGeneration;}
        if(current&&currentReplay())reinterpret_cast<void(*)(id,SEL,id)>(originalContents)(object,selector,value);
        // Queue only after the original assignment, so a single static frame
        // can be checked by identity on main without racing its first publish.
        if(schedule)dispatch_async(dispatch_get_main_queue(),^{resolveBitmapAndReplay(object,selector,bitmap,unsigned(inputWidth),unsigned(inputHeight),opaque);});
    };
    if(main)resolveBitmap(object,bitmap,unsigned(inputWidth),unsigned(inputHeight),opaque);
    bool accepted=false;unsigned width=0,height=0;uint32_t window=0;std::shared_ptr<macfx::LayerPresentation>presentation;
    {std::lock_guard<std::mutex>guard(mutex());accepted=bitmap->accepted&&!bitmap->retired.load();
        window=uint32_t(bitmap->window);width=bitmap->width;height=bitmap->height;presentation=bitmap->presentation;}
    const bool needsPresentation=accepted&&macfx::graphicsRequested()&&macfx::automaticPresentationNeeded(inputWidth,inputHeight,width,height);
    if(!accepted||needsPresentation&&(!opaque||!presentation)||!needsPresentation&&!macfx::effectRequested()){
        if(needsPresentation&&!opaque)retireBitmapPresentation(bitmap);
        publish(contents);return true;
    }
    auto uploaded=bitmap->pool.upload(image);
    if(!uploaded){retireBitmapPresentation(bitmap);publish(contents);return true;}
    if(!currentReplay())return true;
    if(needsPresentation){
        auto result=presentation->submit(uploaded->surface);
        if(!result.encoded&&!result.busy){macfx::nativeLog("Bitmap graphics presentation unavailable: "+result.reason);
            {std::lock_guard<std::mutex>guard(mutex());if(bitmap->presentation==presentation)bitmap->presentation.reset();}
            stopBitmapPresentation(std::move(presentation));}
        publish(contents);return true;
    }
    IOSurfaceRef output=nullptr;
    {macfx::DiagnosticScope scope(macfx::DiagnosticStage::WindowSurface,window,inputWidth,inputHeight);output=rsFilterWindowSurface(key,uploaded->surface);}
    publish(output?(__bridge id)output:contents);
    if(output)CFRelease(output);return true;
}
void setTitle(id object,SEL selector,NSString *title) {
    reinterpret_cast<void(*)(id,SEL,NSString *)>(originalSetTitle)(object,selector,title);
    NSWindow *window=object;
    // AppKit calls this setter while constructing its chrome. Asking for a
    // window number there can realize the window before titlebar layout.
    // Invisible windows have no active frame owner; resolve reads their title
    // after the application presents its completed window.
    if(!window.isVisible)return;
    const Owner owner={window.windowNumber,window.title.UTF8String ?: ""};
    std::lock_guard<std::mutex> guard(mutex());
    for(auto &item:owners()) if(item.second.number==owner.number)
        item.second.title=owner.title;
}
void closeWindow(id object,SEL selector) {
    NSWindow *window=object;
    const NSInteger number=window.windowNumber;
    reinterpret_cast<void(*)(id,SEL)>(originalClose)(object,selector);
    forgetWindow(number);
    publishWindows();
}
void orderOut(id object,SEL selector,id sender) {
    NSWindow *window=object;const NSInteger number=window.windowNumber;
    reinterpret_cast<void(*)(id,SEL,id)>(originalOrderOut)(object,selector,sender);
    if(!macfx::virtualWindowSuspended(window))forgetWindow(number);
    publishWindows();
}
void miniaturize(id object,SEL selector,id sender) {
    NSWindow *window=object;const NSInteger number=window.windowNumber;
    reinterpret_cast<void(*)(id,SEL,id)>(originalMiniaturize)(object,selector,sender);
    if(!macfx::virtualWindowSuspended(window))forgetWindow(number);
    publishWindows();
}
void publishContents(id object,SEL selector,id contents,uint64_t replayGeneration=0) {
    // This is the raw setter entrance, before ownership, contents class and demand gates.
    if(macfx::remoteIngressDiagnostics::active()){
        const Class type=contents?object_getClass(contents):Nil;const Class parent=type?class_getSuperclass(type):Nil;
        macfx::remoteIngressDiagnostics::contents(reinterpret_cast<uintptr_t>((__bridge void*)object),reinterpret_cast<uintptr_t>((__bridge void*)contents),
            reinterpret_cast<uintptr_t>((__bridge void*)type),reinterpret_cast<uintptr_t>((__bridge void*)parent),type?class_getName(type):nullptr,parent?class_getName(parent):nullptr,
            contents&&type==surfaceClass(),replayGeneration!=0);
    }
    if(macfx::ownsPresentation(object)){macfx::remoteIngressDiagnostics::skip(macfx::remoteIngressDiagnostics::Skip::Owned);reinterpret_cast<void(*)(id,SEL,id)>(originalContents)(object,selector,contents);return;}
    bool source=false;try{source=macfx::drawableResolutionRequested();}catch(...){}
    if(!macfx::browserFrameProcessingAllowed()||!macfx::imageProcessingRequested()&&!source&&!macfx::virtualWindowEnabled()){
        // Unused hooks retain no images or per-publisher state. An earlier
        // owner still invalidates queued work before its original is restored.
        auto previous=remotePublication(object,false);
        if(!previous&&!objc_getAssociatedObject(object,&layerLifetimeKey)){
            if(!replayGeneration)reinterpret_cast<void(*)(id,SEL,id)>(originalContents)(object,selector,contents);
            return;
        }
        std::unique_lock<std::recursive_mutex>serial;
        if(previous){serial=std::unique_lock<std::recursive_mutex>(previous->publication);
            if(replayGeneration&&(previous->generation!=replayGeneration||[(CALayer*)object contents]!=contents))return;
            if(!replayGeneration)++previous->generation;clearPendingRemote(previous);
        }else if(replayGeneration)return;
        const auto key=(__bridge void*)object;
        forgetBitmap(key);forgetRemotePresentation(key);macfx::releaseFrameOwner(key);
        {std::lock_guard<std::mutex>guard(mutex());remoteOwners().erase(key);}
        reinterpret_cast<void(*)(id,SEL,id)>(originalContents)(object,selector,contents);return;
    }
    if(contents)prepareContentsClasses();
    const bool surface=contents&&object_getClass(contents)==surfaceClass();
    auto publication=remotePublication(object,surface);
    std::unique_lock<std::recursive_mutex>serial;if(publication){serial=std::unique_lock<std::recursive_mutex>(publication->publication);
        if(replayGeneration&&(publication->generation!=replayGeneration||[(CALayer*)object contents]!=contents))return;
        if(!replayGeneration)++publication->generation;
        clearPendingRemote(publication);}
    if(bitmapContents(object,selector,contents)){macfx::remoteIngressDiagnostics::skip(macfx::remoteIngressDiagnostics::Skip::Bitmap);return;}
    forgetBitmap((__bridge void*)object);
    if((!contents||object_getClass(contents)!=surfaceClass())&&!objc_getAssociatedObject(object,&layerLifetimeKey)) {
        macfx::remoteIngressDiagnostics::skip(macfx::remoteIngressDiagnostics::Skip::Other);
        reinterpret_cast<void(*)(id,SEL,id)>(originalContents)(object,selector,contents);return;
    }
    IOSurfaceRef input=nullptr; uint32_t window=0;unsigned outputWidth=0,outputHeight=0;uint32_t remoteIdentifier=0;void *contextLayer=nullptr;
    std::optional<macfx::remoteIngressDiagnostics::Surface> diagnostic;
    if(macfx::remoteIngressDiagnostics::active())diagnostic.emplace();
    if(contents && object_getClass(contents)==surfaceClass()) {
        retainLifetime(object,&layerLifetimeKey,forgetLayer);
        IOSurfaceRef surface=(__bridge IOSurfaceRef)contents;
        const auto width=IOSurfaceGetWidth(surface),height=IOSurfaceGetHeight(surface);
        if(diagnostic){diagnostic->layer=reinterpret_cast<uintptr_t>((__bridge void*)object);diagnostic->contents=reinterpret_cast<uintptr_t>((__bridge void*)contents);
            diagnostic->surface=IOSurfaceGetID(surface);diagnostic->format=IOSurfaceGetPixelFormat(surface);diagnostic->width=unsigned(width);diagnostic->height=unsigned(height);
            diagnostic->replay=replayGeneration!=0;windowForContext(0,unsigned(width),unsigned(height),nullptr,nullptr,&diagnostic->selected);}
        // A fixed retained ancestor stack avoids a heap allocation on every
        // remote frame. Re-evaluate the live map, including newly nested contexts.
        CALayer *hierarchy[256]{};unsigned count=0;CALayer *ancestor=object;
        while(ancestor&&count<256){hierarchy[count++]=ancestor;ancestor=ancestor.superlayer;}
        if(diagnostic){diagnostic->ancestors=count;diagnostic->completeHierarchy=ancestor==nil;}
        if(!ancestor){std::lock_guard<std::mutex>guard(mutex());for(unsigned i=0;i<count;++i){
            auto context=contexts().find((__bridge void*)hierarchy[i]);
            if(context!=contexts().end()){
                window=windowForContext(context->second.identifier,width,height,&outputWidth,&outputHeight,diagnostic?&diagnostic->selected:nullptr);contextLayer=(__bridge void*)hierarchy[i];remoteIdentifier=context->second.identifier;break;
            }
        }}
        if(!window){
            Owner owner{};
            if(NSThread.isMainThread)owner=resolveLocalSurfaceOwner(object);
            else{
                bool schedule=false;{std::lock_guard<std::mutex>guard(mutex());auto at=owners().find((__bridge void*)object);
                    if(at!=owners().end()&&matches(at->second))owner=at->second;schedule=pending().insert((__bridge void*)object).second;}
                if(schedule)dispatch_async(dispatch_get_main_queue(),^{resolveLocalSurfaceOwner(object);std::lock_guard<std::mutex>guard(mutex());pending().erase((__bridge void*)object);});
            }
            if(owner.number){window=uint32_t(owner.number);outputWidth=owner.width;outputHeight=owner.height;contextLayer=nullptr;remoteIdentifier=0;if(diagnostic)diagnostic->local=true;}
        }
        if(window&&macfx::browserFrameOwnsWindow(window)){
            reinterpret_cast<void(*)(id,SEL,id)>(originalContents)(object,selector,contents);return;
        }
        // A layer that does not stretch its whole surface over its bounds is
        // presented at the surface's own extent with the same mapping.
        if(window&&!macfx::contentsGeometry((CALayer*)object).stretched){outputWidth=unsigned(width);outputHeight=unsigned(height);}
        if(window)input=(IOSurfaceRef)CFRetain(surface);
        if(diagnostic){diagnostic->contextLayer=reinterpret_cast<uintptr_t>(contextLayer);diagnostic->context=remoteIdentifier;diagnostic->window=window;
            diagnostic->outputWidth=outputWidth;diagnostic->outputHeight=outputHeight;diagnostic->graphics=macfx::graphicsRequested();diagnostic->effects=macfx::effectRequested();
            macfx::remoteIngressDiagnostics::control(macfx::lastLiveControlPollDiagnostic());
            macfx::remoteIngressDiagnostics::surface(*diagnostic);}
    }
    if(macfx::nativeConfig().diagnostics.trace && contents && object_getClass(contents)==surfaceClass()) {
        static std::set<std::string> seen;
        const auto surface=(__bridge IOSurfaceRef)contents;
        auto key=std::to_string(window)+":"+std::to_string(IOSurfaceGetWidth(surface))+"x"+std::to_string(IOSurfaceGetHeight(surface));
        std::lock_guard<std::mutex> guard(mutex());
        if(seen.size()<64 && seen.insert(key).second)
            macfx::nativeLog("display surface window="+std::to_string(window)+" size="+std::to_string(IOSurfaceGetWidth(surface))+"x"+std::to_string(IOSurfaceGetHeight(surface))+" class="+class_getName(surfaceClass()));
    }
    const auto key=(__bridge void*)object;uint32_t previousWindow=0;
    {std::lock_guard<std::mutex>guard(mutex());auto previous=remoteOwners().find(key);
        if(previous!=remoteOwners().end())previousWindow=previous->second;
        if(window)remoteOwners()[key]=window;else remoteOwners().erase(key);}
    if(previousWindow&&previousWindow!=window){forgetRemotePresentation(key);macfx::releaseFrameOwner(key);}
    if(input&&macfx::graphicsRequested()&&!macfx::automaticPresentationNeeded(IOSurfaceGetWidth(input),IOSurfaceGetHeight(input),outputWidth,outputHeight)){
        // No source snapshot, processing queue or owned output is needed.
        // Retire an earlier scaled output before revealing publisher contents.
        forgetRemotePresentation(key);
        reinterpret_cast<void(*)(id,SEL,id)>(originalContents)(object,selector,contents);CFRelease(input);return;
    }
    if(input&&macfx::graphicsRequested()){
        std::shared_ptr<macfx::LayerPresentation> presentation;
        {std::lock_guard<std::mutex>guard(mutex());auto found=remotePresentations().find(key);if(found!=remotePresentations().end())presentation=found->second.presentation;}
        try {
            if(presentation)presentation->update(outputWidth,outputHeight);
            else {presentation=std::make_shared<macfx::LayerPresentation>((CALayer*)object,outputWidth,outputHeight,presentationConfig(macfx::FrameOrigin::TopLeft,macfx::RuntimeFrameSource::LayerSurface),contextLayer?true:((CALayer*)object).opaque);std::lock_guard<std::mutex>guard(mutex());remotePresentations().emplace(key,RemotePresentation{contextLayer,window,remoteIdentifier,presentation,contextLayer?nil:(CALayer*)object});}
            auto result=presentation->submit(input);
            if(result.encoded||result.busy){reinterpret_cast<void(*)(id,SEL,id)>(originalContents)(object,selector,contents);CFRelease(input);return;}
            macfx::nativeLog("Remote graphics presentation unavailable: "+result.reason);forgetRemotePresentation(key);
        }catch(const std::exception&e){macfx::nativeLog("Remote graphics presentation unavailable: "+std::string(e.what()));forgetRemotePresentation(key);}
    }
    IOSurfaceRef output=nullptr;
    if(input&&macfx::effectRequested()) {macfx::DiagnosticScope scope(macfx::DiagnosticStage::WindowSurface,window,IOSurfaceGetWidth(input),IOSurfaceGetHeight(input));output=rsFilterWindowSurface(key,input);}
    reinterpret_cast<void(*)(id,SEL,id)>(originalContents)(object,selector,output?(__bridge id)output:contents);
    // Ownership can arrive after a one-shot publisher's first contents. Keep
    // only its unchanged original surface; a later timer authenticates the
    // live context and extent before processing the currently displayed image.
    if(!window&&surface&&(macfx::effectRequested()||macfx::graphicsRequested()))queuePendingRemote(publication,(__bridge IOSurfaceRef)contents,remoteIdentifier,contextLayer);
    if(output) CFRelease(output);
    if(input) CFRelease(input);
}
void setContents(id object,SEL selector,id contents){publishContents(object,selector,contents);}
void retryRemoteContents(){
    std::vector<std::pair<void*,std::shared_ptr<MacFXRemotePublicationState>>>entries;
    {std::lock_guard<std::mutex>guard(mutex());for(const auto&entry:pendingRemote())entries.push_back(entry);}
    for(auto&item:entries){const auto&entry=item.second;std::lock_guard<std::recursive_mutex>serial(entry->publication);
        CALayer*layer=entry->layer;id contents=layer.contents;
        if(!layer||!entry->awaiting||contents!=(__bridge id)entry->awaiting){
            {std::lock_guard<std::mutex>guard(mutex());auto at=pendingRemote().find(item.first);if(at!=pendingRemote().end()&&at->second==entry)pendingRemote().erase(at);}
            entry->clear();continue;}
        if((entry->identifier&&windowForContext(entry->identifier,IOSurfaceGetWidth(entry->awaiting),IOSurfaceGetHeight(entry->awaiting)))||resolveLocalSurfaceOwner(layer).number)
            publishContents(layer,@selector(setContents:),contents,entry->awaitingGeneration);
    }
}
void setContextLayer(id object,SEL selector,CALayer *layer) {
    reinterpret_cast<void(*)(id,SEL,CALayer *)>(originalContextLayer)(object,selector,layer);
    const auto identifier=layer?contextId(object):0;const auto key=(__bridge void*)object;const auto layerKey=(__bridge void*)layer;
    if(layer){retainLifetime(object,&contextLifetimeKey,forgetContext);retainLifetime(layer,&layerLifetimeKey,forgetLayer);}
    void *retired=nullptr;
    {std::lock_guard<std::mutex>guard(mutex());auto previous=contextLayers().find(key);
        if(previous!=contextLayers().end()&&previous->second!=layerKey){auto binding=contexts().find(previous->second);
            if(binding!=contexts().end()&&binding->second.context==key){retired=previous->second;contexts().erase(binding);remoteOwners().erase(retired);}
            contextLayers().erase(previous);}
        if(layer){contexts()[layerKey]={identifier,key};contextLayers()[key]=layerKey;}
    }
    macfx::remoteIngressDiagnostics::context(reinterpret_cast<uintptr_t>(key),reinterpret_cast<uintptr_t>(layerKey),identifier,retired!=nullptr);
    if(retired){forgetPendingRemote(retired);forgetRemotePresentation(retired);macfx::releaseFrameOwner(retired);}
}
void setView(id object,SEL selector,NSView *view) {
    reinterpret_cast<void(*)(id,SEL,NSView *)>(originalSetView)(object,selector,view);
    forgetPresentation([(NSOpenGLContext *)object CGLContextObj]);
    bindOpenGLView(object,view);
    NSWindow *window=view.window;
    const auto context=[(NSOpenGLContext *)object CGLContextObj];
    refreshSelection();
    if(visible(window)&&gameContentView(view)) {
        const NSRect size=view.wantsBestResolutionOpenGLSurface ? [view convertRectToBacking:view.bounds] : view.bounds;
        const Owner owner={window.windowNumber,window.title.UTF8String ?: "",unsigned(size.size.width),unsigned(size.size.height)};
        std::lock_guard<std::mutex> guard(mutex());
        owners()[context]=owner;
    } else {
        std::lock_guard<std::mutex> guard(mutex());
        owners().erase(context);
    }
}
void clearDrawable(id object,SEL selector) {
    const auto cgl=[(NSOpenGLContext *)object CGLContextObj];
    reinterpret_cast<void(*)(id,SEL)>(originalClearDrawable)(object,selector);
    forgetPresentation(cgl);
    bindOpenGLView(object,nil);
    {std::lock_guard<std::mutex> guard(mutex());owners().erase(cgl);}
    macfx::releaseFrameOwner(cgl);
}
void resolveOpenGL(NSOpenGLContext *context,CGLContextObj cgl) {
    macfx::DiagnosticScope diagnostics(macfx::DiagnosticStage::WindowResolve,reinterpret_cast<uintptr_t>((__bridge void *)context));
    const auto diagnosticOwner=reinterpret_cast<uintptr_t>((__bridge void *)context);
    NSView *view;NSWindow *window;
    {macfx::DiagnosticScope phase(macfx::DiagnosticStage::WindowResolve,diagnosticOwner,0,0,"opengl.resolve.view-binding");view=openGLView(context);window=view.window;}
    {macfx::DiagnosticScope phase(macfx::DiagnosticStage::WindowResolve,diagnosticOwner,0,0,"opengl.resolve.selection");refreshSelection();}
    if(macfx::virtualWindowSuspended(window)){
        if(auto presentation=macfx::openGLPresentation(cgl))presentation->update(view,0,0);
        return;
    }
    if(macfx::browserFrameOwnsWindow(uint32_t(window.windowNumber))){forgetPresentation(cgl);return;}
    if(visible(window)&&gameContentView(view)) {
        NSRect size,physical;
        {macfx::DiagnosticScope phase(macfx::DiagnosticStage::WindowResolve,diagnosticOwner,0,0,"opengl.resolve.geometry");
         size=view.wantsBestResolutionOpenGLSurface ? [view convertRectToBacking:view.bounds] : view.bounds;
         physical=[window convertRectToBacking:[view convertRect:view.bounds toView:nil]];}
        const Owner owner={window.windowNumber,window.title.UTF8String ?: "",unsigned(size.size.width),unsigned(size.size.height)};
        bool accepted;
        {std::lock_guard<std::mutex> guard(mutex());owners()[cgl]=owner;accepted=matches(owner);}
        if(accepted)macfx::setVirtualPublisherPixelSpace(view,view.wantsBestResolutionOpenGLSurface?macfx::VirtualPublisherPixelSpace::Backing:macfx::VirtualPublisherPixelSpace::Points,cgl);
        const auto &diagnostics=macfx::nativeConfig().diagnostics;
        const unsigned outputWidth=physical.size.width,outputHeight=physical.size.height;
        const auto retainedPresentation=macfx::presentationHoldConfigured()?macfx::openGLPresentation(cgl):nullptr;
        bool held,processing;
        {macfx::DiagnosticScope phase(macfx::DiagnosticStage::WindowResolve,diagnosticOwner,0,0,"opengl.resolve.demand");
         held=retainedPresentation&&retainedPresentation->presentationHeld();
         processing=macfx::graphicsRequested()&&(macfx::virtualPresentationRequired(view)||macfx::automaticPresentationNeeded(owner.width,owner.height,outputWidth,outputHeight));}
        if(accepted && (processing || held || (diagnostics.enabled && diagnostics.openGLTransport=="overlay"))) {
            auto presentation=retainedPresentation?retainedPresentation:macfx::openGLPresentation(cgl);
            try {
                if(presentation){macfx::DiagnosticScope phase(macfx::DiagnosticStage::WindowResolve,diagnosticOwner,0,0,"opengl.resolve.owner-update");presentation->update(view,outputWidth,outputHeight);}
                if(presentation){macfx::DiagnosticScope phase(macfx::DiagnosticStage::WindowResolve,diagnosticOwner,0,0,"opengl.resolve.owner-snapshot");if(presentation->snapshot().stopped){if(presentation->failedForCurrentContract(outputWidth,outputHeight))return;forgetPresentation(cgl);presentation.reset();}}
                if(!presentation&&view.superview){
                    macfx::DiagnosticScope phase(macfx::DiagnosticStage::WindowResolve,diagnosticOwner,0,0,"opengl.resolve.owner-create");
                    // CoreVideo color and depth are normalized by their GPU
                    // copies before entering the shared Metal pipeline.
                    const auto config=presentationConfig(macfx::FrameOrigin::TopLeft,macfx::RuntimeFrameSource::OpenGLFramebuffer);
                    presentation=std::make_shared<macfx::ViewPresentation>(view,outputWidth,outputHeight,config);
                    std::lock_guard<std::mutex>guard(mutex());presentations()[cgl]=presentation;
                }
            }catch(const std::exception&e){macfx::nativeLog("View presentation unavailable: "+std::string(e.what()));forgetPresentation(cgl);}
        }else {macfx::DiagnosticScope phase(macfx::DiagnosticStage::WindowResolve,diagnosticOwner,0,0,"opengl.resolve.owner-forget");forgetPresentation(cgl);}
    } else {
        {std::lock_guard<std::mutex> guard(mutex());owners().erase(cgl);}
        forgetPresentation(cgl);
    }
}
}
namespace macfx {
std::shared_ptr<ViewPresentation> viewPresentationForOwner(void *owner) {
    std::lock_guard<std::mutex>guard(mutex());
    const auto metal=metalPresentations().find(owner);
    if(metal!=metalPresentations().end())return metal->second;
    const auto gl=presentations().find(static_cast<CGLContextObj>(owner));
    return gl==presentations().end()?nullptr:gl->second;
}
std::shared_ptr<LayerPresentation> remotePresentation(CALayer *layer) {std::lock_guard<std::mutex>guard(mutex());auto found=remotePresentations().find((__bridge void*)layer);return found==remotePresentations().end()?nullptr:found->second.presentation;}
std::shared_ptr<ViewPresentation> openGLPresentation(CGLContextObj context) {
    std::lock_guard<std::mutex>guard(mutex());auto found=presentations().find(context);return found==presentations().end()?nullptr:found->second;
}
std::shared_ptr<ViewPresentation> metalPresentation(CALayer *layer) {
    // Every owned entry originates in resolve(), which installs this binding.
    // A fresh dormant layer must not allocate lookup maps just to find none.
    if(!objc_getAssociatedObject(layer,&layerBindingKey))return {};
    std::lock_guard<std::mutex>guard(mutex());auto found=metalPresentations().find((__bridge void*)layer);return found==metalPresentations().end()?nullptr:found->second;
}
void stopOpenGLPresentation(CGLContextObj context) {
    auto presentation=openGLPresentation(context);if(presentation)presentation->stop();
}
void forgetOpenGL(CGLContextObj context) {
    forgetPresentation(context);
    {std::lock_guard<std::mutex> guard(mutex());owners().erase(context);pending().erase(context);}
    macfx::releaseFrameOwner(context);
}
bool openGLSize(CGLContextObj context,unsigned &width,unsigned &height) {
    std::lock_guard<std::mutex> guard(mutex());
    const auto found=owners().find(context);
    if(found==owners().end() || !found->second.width || !found->second.height) return false;
    width=found->second.width;height=found->second.height;return true;
}
bool acceptsLayer(CALayer *layer) {
    retainLifetime(layer,&layerLifetimeKey,forgetLayer);
    void *key=(__bridge void *)layer;
    if(NSThread.isMainThread) resolve(layer);
    else {
        bool schedule=false;
        { std::lock_guard<std::mutex> guard(mutex()); schedule=pending().insert(key).second; }
        if(schedule) dispatch_async(dispatch_get_main_queue(),^{ resolve(layer); });
    }
    std::lock_guard<std::mutex> guard(mutex());
    auto found=owners().find(key); return found!=owners().end() && matches(found->second) && !macfx::browserFrameOwnsWindow(uint32_t(found->second.number));
}
bool acceptsOpenGL(CGLContextObj context) {
    NSOpenGLContext *current=NSOpenGLContext.currentContext;
    if(current.CGLContextObj==context) {
        if(NSThread.isMainThread) resolveOpenGL(current,context);
        else {
            bool schedule=false;
            { std::lock_guard<std::mutex> guard(mutex()); schedule=pending().insert(context).second; }
            if(schedule) dispatch_async(dispatch_get_main_queue(),^{
                resolveOpenGL(current,context);
                std::lock_guard<std::mutex> guard(mutex());pending().erase(context);
            });
        }
    }
    std::lock_guard<std::mutex> guard(mutex());
    auto found=owners().find(context);
    if(found!=owners().end()) return matches(found->second)&&!macfx::browserFrameOwnsWindow(uint32_t(found->second.number));
    return false;
}
}
__attribute__((constructor)) static void loadWindowHooks() { @autoreleasepool {
    if(macfx::nativeConfig().explicitHost) return;
    macfx::DiagnosticScope diagnostics(macfx::DiagnosticStage::Hooks,3);
    if(!macfx::liveEffects() && !macfx::effectRequested() && !std::getenv("RESHADE_GPU_TIMING") && !macfx::graphicsRequested()) return;
    // Title and close changes invalidate render-thread ownership immediately;
    // AppKit hierarchy queries remain on the main thread.
    Method title=class_getInstanceMethod(NSWindow.class,@selector(setTitle:));
    originalSetTitle=method_setImplementation(title,reinterpret_cast<IMP>(setTitle));
    Method closeMethod=class_getInstanceMethod(NSWindow.class,@selector(close));
    originalClose=method_setImplementation(closeMethod,reinterpret_cast<IMP>(closeWindow));
    Method orderOutMethod=class_getInstanceMethod(NSWindow.class,@selector(orderOut:));
    originalOrderOut=method_setImplementation(orderOutMethod,reinterpret_cast<IMP>(orderOut));
    Method miniaturizeMethod=class_getInstanceMethod(NSWindow.class,@selector(miniaturize:));
    originalMiniaturize=method_setImplementation(miniaturizeMethod,reinterpret_cast<IMP>(miniaturize));
    Method view=class_getInstanceMethod(NSOpenGLContext.class,@selector(setView:));
    originalSetView=method_setImplementation(view,reinterpret_cast<IMP>(setView));
    Method drawable=class_getInstanceMethod(NSOpenGLContext.class,@selector(clearDrawable));
    originalClearDrawable=method_setImplementation(drawable,reinterpret_cast<IMP>(clearDrawable));
    if(std::getenv("RESHADE_LAYER_SURFACE")) {
        if(const char *file=std::getenv("RESHADE_WINDOW_STATE")) {
            int fd=open(file,O_RDWR|O_NOFOLLOW); struct stat stat;
            if(fd>=0) {
                if(fstat(fd,&stat)==0 && S_ISREG(stat.st_mode) && stat.st_size>=4096) {
                    void *mapped=mmap(nullptr,4096,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0);
                    if(mapped!=MAP_FAILED) state=static_cast<WindowState *>(mapped);
                }
                close(fd);
            }
        }
        Method contents=class_getInstanceMethod(CALayer.class,@selector(setContents:));
        originalContents=method_setImplementation(contents,reinterpret_cast<IMP>(setContents));
        Method moved=class_getInstanceMethod(NSView.class,@selector(viewDidMoveToWindow));
        originalViewDidMoveToWindow=method_setImplementation(moved,reinterpret_cast<IMP>(quartzViewDidMoveToWindow));
        Method layer=class_getInstanceMethod(NSClassFromString(@"CAContext"),NSSelectorFromString(@"setLayer:"));
        if(layer) originalContextLayer=method_setImplementation(layer,reinterpret_cast<IMP>(setContextLayer));
        if(macfx::remoteIngressDiagnostics::active()){
            macfx::remoteIngressDiagnostics::hooks(true,originalContents!=nullptr,NSClassFromString(@"CAContext")!=Nil,originalContextLayer!=nullptr,
                surfaceClass()?class_getName(surfaceClass()):nullptr,surfaceClass()&&class_getSuperclass(surfaceClass())?class_getName(class_getSuperclass(surfaceClass())):nullptr,state!=nullptr);
            macfx::remoteIngressDiagnostics::poll();
            macfx::pollRetiredImages();
            macfx::pollRuntimeStatus(macfx::imageProcessingRequested());
        }
        dispatch_async(dispatch_get_main_queue(),^{
            [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *) {
                publishWindows();retryRemoteContents();probeBrowserNativeRegistration();
                macfx::pollVirtualSourceControl(macfx::imageProcessingRequested());
                macfx::remoteIngressDiagnostics::poll();
            macfx::pollRetiredImages();
            macfx::pollRuntimeStatus(macfx::imageProcessingRequested());
                macfx::pollPresentationHold([](std::string &reason){
                    std::vector<std::shared_ptr<macfx::ViewPresentation>> candidates;
                    {std::lock_guard<std::mutex>guard(mutex());
                        for(const auto &item:metalPresentations()){auto owner=owners().find(item.first);if(owner!=owners().end()&&matches(owner->second))candidates.push_back(item.second);}
                        for(const auto &item:presentations()){auto owner=owners().find(item.first);if(owner!=owners().end()&&matches(owner->second))candidates.push_back(item.second);}
                    }
                    std::shared_ptr<macfx::ViewPresentation> result;
                    for(const auto &item:candidates)if(item->canHoldPresentation(reason)){
                        if(result&&result!=item){reason="More than one owned output is selected";return std::shared_ptr<macfx::ViewPresentation>{};}result=item;
                    }
                    return result;
                });
            }];
        });
    }
}}
