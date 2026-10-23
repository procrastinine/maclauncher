#include "log.hpp"
#include "window.hpp"
#include "view-presentation.hpp"
#include "layer-presentation.hpp"
#include "presentation-internal.hpp"
#include "graphics.hpp"
#include <cstring>
#include "window-state.hpp"
#include "diagnostics.hpp"
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import <objc/message.h>
#include <algorithm>
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

// NSOpenGLContext.view takes the CGL driver lock. Capture the weak binding when
// it changes, then inspect the AppKit hierarchy without contending with render.
@interface MacFXOpenGLViewBinding : NSObject
@property(nonatomic,weak) NSView *view;
@end
@implementation MacFXOpenGLViewBinding
@end

@interface MacFXOwnerLifetime : NSObject {
@public void *owner;void(*cleanup)(void *);
}
@end
@implementation MacFXOwnerLifetime
- (void)dealloc {if(cleanup)cleanup(owner);}
@end

namespace {
char openGLViewBindingKey;
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
using macfx::WindowState;
WindowState *state=nullptr;
std::map<void *,Owner> &owners() { static auto *m=new std::map<void *,Owner>; return *m; }
std::map<CGLContextObj,std::shared_ptr<macfx::ViewPresentation>> &presentations() { static auto *m=new std::map<CGLContextObj,std::shared_ptr<macfx::ViewPresentation>>; return *m; }
std::map<void*,std::shared_ptr<macfx::ViewPresentation>> &metalPresentations() {static auto *m=new std::map<void*,std::shared_ptr<macfx::ViewPresentation>>;return *m;}
struct RemotePresentation {void *contextLayer;uint32_t window,identifier;std::shared_ptr<macfx::LayerPresentation> presentation;};
std::map<void*,RemotePresentation>&remotePresentations(){static auto *m=new std::map<void*,RemotePresentation>;return *m;}
void forgetRemotePresentation(void *key) {
    std::vector<std::pair<void*,std::shared_ptr<macfx::LayerPresentation>>> retired;
    {std::lock_guard<std::mutex>guard(mutex());for(auto at=remotePresentations().begin();at!=remotePresentations().end();)
        if(at->first==key||at->second.contextLayer==key){retired.emplace_back(at->first,std::move(at->second.presentation));at=remotePresentations().erase(at);}else ++at;}
    for(auto&entry:retired){entry.second->stop();macfx::releaseFrameOwner(entry.first);}
}
std::set<void *> &pending() { static auto *s=new std::set<void *>; return *s; }
Class surfaceClass=Nil;
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
    if(layer){forgetRemotePresentation(layer);macfx::releaseFrameOwner(layer);}
}
NSInteger &selectedWindow() { static NSInteger number=0; return number; }
bool visible(NSWindow *window) {
    return window && window.windowNumber>0 && window.isVisible && !window.isMiniaturized &&
        window.contentView.bounds.size.width>0 && window.contentView.bounds.size.height>0;
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
macfx::PresenterConfig presentationConfig(macfx::FrameOrigin origin) {
    const auto graphics=macfx::graphicsEnvironment();macfx::PresenterConfig config;config.origin=origin;config.generation=graphics.generation;config.adaptive=graphics.adaptive;
    if(graphics.spatialMethod=="metalfx")config.method=macfx::SpatialMethod::MetalFX;
    else if(graphics.spatialMethod=="ls1")config.method=macfx::SpatialMethod::LS1;
    else if(graphics.spatialMethod=="mako")config.method=macfx::SpatialMethod::Mako;
  else if(graphics.spatialMethod=="fsr1")config.method=macfx::SpatialMethod::FSR1;
    else if(graphics.spatialMethod!="off"&&graphics.spatialMethod!="bilinear")throw std::runtime_error("The selected spatial method is not available in this runtime");
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
    for(void *owner:retiredOwners)macfx::releaseFrameOwner(owner);
}
// A splash can be ordered out without being closed. Refresh the automatic
// selection on the AppKit thread before resolving the next rendered surface.
void refreshSelection() {
    NSInteger selected;
    { std::lock_guard<std::mutex> guard(mutex()); selected=selectedWindow(); }
    if(selected && !visible([NSApp windowWithWindowNumber:selected])) forgetWindow(selected);
}
bool matches(const Owner &owner) {
    if(const char *number=std::getenv("RESHADE_WINDOW_ID")) return owner.number==std::strtol(number,nullptr,10);
    if(const char *title=std::getenv("RESHADE_WINDOW_TITLE")) return owner.title==title;
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
void collectLayers(CALayer *layer,std::vector<uint32_t> &ids) {
    if(!layer) return;
    const auto id=contextId(layer); if(id) ids.push_back(id);
    for(CALayer *child in layer.sublayers) collectLayers(child,ids);
}
void collectViews(NSView *view,std::vector<uint32_t> &ids) {
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
    {std::lock_guard<std::mutex>guard(mutex());for(const auto&entry:remotePresentations())if(entry.second.window!=selected||!ids.count(entry.second.identifier))retired.push_back(entry.first);}
    for(auto key:retired)forgetRemotePresentation(key);
}
void publishWindows() {
    if(!state) return;
    retireHiddenRemotePresentations();
    macfx::DiagnosticScope diagnostics(macfx::DiagnosticStage::WindowPublish);
    refreshSelection();
    uint32_t windowNumber=0,width=0,height=0; std::vector<uint32_t> ids;
    for(NSWindow *window in NSApp.windows) {
        if(!visible(window)) continue;
        std::vector<uint32_t> found;
        collectViews(window.contentView.superview ?: window.contentView,found);
        if(found.empty()) continue;
        Owner owner={window.windowNumber,window.title.UTF8String ?: ""};
        const NSRect pixels=[window.contentView convertRectToBacking:window.contentView.bounds];
        std::lock_guard<std::mutex> guard(mutex());
        if(matches(owner)) {
            windowNumber=uint32_t(owner.number); ids=std::move(found);
            width=uint32_t(pixels.size.width); height=uint32_t(pixels.size.height); break;
        }
    }
    NSWindow *selected=[NSApp windowWithWindowNumber:windowNumber];
    const unsigned count=std::min<size_t>(ids.size(),64);
    macfx::WindowSnapshot snapshot;
    snapshot.window=windowNumber;snapshot.width=width;snapshot.height=height;snapshot.count=count;
    snapshot.pointsWidth=uint32_t(selected.contentView.bounds.size.width);
    snapshot.pointsHeight=uint32_t(selected.contentView.bounds.size.height);
    std::copy_n(ids.begin(),count,snapshot.contexts);
    if(!macfx::publishWindowState(state,snapshot,uint32_t(getpid()))) return;
    if(std::getenv("RESHADE_TRACE")) {
        static uint32_t last=0,lastW=0,lastH=0;
        if(windowNumber && (last!=windowNumber || lastW!=width || lastH!=height)) { last=windowNumber;lastW=width;lastH=height;macfx::nativeLog("selected window="+std::to_string(windowNumber)+" size="+std::to_string(width)+"x"+std::to_string(height)+" contexts="+std::to_string(count)); }
    }
}
uint32_t windowForContext(uint32_t id,unsigned width,unsigned height,unsigned *outputWidth=nullptr,unsigned *outputHeight=nullptr) {
    if(!state || !id) return 0;
    for(unsigned attempt=0;attempt<3;++attempt) {
        const auto sequence=__atomic_load_n(&state->sequence,__ATOMIC_ACQUIRE);
        if(sequence&1) continue;
        uint32_t result=0,window=__atomic_load_n(&state->window,__ATOMIC_RELAXED);
        const bool dimensions=(width==__atomic_load_n(&state->width,__ATOMIC_RELAXED) && height==__atomic_load_n(&state->height,__ATOMIC_RELAXED)) ||
            (width==__atomic_load_n(&state->pointsWidth,__ATOMIC_RELAXED) && height==__atomic_load_n(&state->pointsHeight,__ATOMIC_RELAXED));
        const auto count=std::min(__atomic_load_n(&state->count,__ATOMIC_RELAXED),64u);
        for(unsigned i=0;i<count;++i) if(dimensions && __atomic_load_n(&state->contexts[i],__ATOMIC_RELAXED)==id) result=window;
        const auto physicalWidth=__atomic_load_n(&state->width,__ATOMIC_RELAXED),physicalHeight=__atomic_load_n(&state->height,__ATOMIC_RELAXED);
        if(sequence==__atomic_load_n(&state->sequence,__ATOMIC_ACQUIRE)){if(result){if(outputWidth)*outputWidth=physicalWidth;if(outputHeight)*outputHeight=physicalHeight;}return result;}
    }
    return 0;
}
void resolve(CALayer *layer) {
    macfx::DiagnosticScope diagnostics(macfx::DiagnosticStage::WindowResolve,reinterpret_cast<uintptr_t>((__bridge void *)layer));
    refreshSelection();
    {std::lock_guard<std::mutex>guard(mutex());owners().erase((__bridge void*)layer);}
    NSView *source=nil;Owner owner{};
    for(NSWindow *window in NSApp.windows)if(visible(window)) {
        if(NSView *view=viewForLayer(window.contentView.superview ?: window.contentView,layer)) {
            source=view;const auto size=[window convertRectToBacking:[view convertRect:view.bounds toView:nil]];
            owner={window.windowNumber,window.title.UTF8String ?: "",unsigned(size.size.width),unsigned(size.size.height)};break;
        }
    }
    bool accepted=false;
    {std::lock_guard<std::mutex>guard(mutex());if(source){owners()[(__bridge void*)layer]=owner;accepted=matches(owner);}pending().erase((__bridge void*)layer);}
    const bool diagnostic=std::getenv("RESHADE_DIAGNOSTICS")&&std::getenv("RESHADE_DIAGNOSTICS_METAL_PRESENTATION");
    const CGSize input=[layer isKindOfClass:CAMetalLayer.class]?((CAMetalLayer*)layer).drawableSize:CGSizeZero;
    const bool processing=macfx::graphicsRequested()&&macfx::automaticPresentationNeeded(input.width,input.height,owner.width,owner.height);
    if(accepted&&(processing||diagnostic)) {
        auto presentation=macfx::metalPresentation(layer);
        try {
            if(presentation)presentation->update(source,owner.width,owner.height);
            else if(source.superview){
                presentation=std::make_shared<macfx::ViewPresentation>(source,owner.width,owner.height,presentationConfig(macfx::FrameOrigin::TopLeft));
                std::lock_guard<std::mutex>guard(mutex());metalPresentations()[(__bridge void*)layer]=presentation;
            }
        }catch(const std::exception&e){macfx::nativeLog("View presentation unavailable: "+std::string(e.what()));forgetMetalPresentation(layer);}
    }else {forgetMetalPresentation(layer);macfx::releaseFrameOwner((__bridge void*)layer);}
}
IMP originalContents=nullptr,originalSetView=nullptr,originalClearDrawable=nullptr,originalContextLayer=nullptr;
IMP originalSetTitle=nullptr,originalClose=nullptr;
IMP originalOrderOut=nullptr,originalMiniaturize=nullptr;
void setTitle(id object,SEL selector,NSString *title) {
    reinterpret_cast<void(*)(id,SEL,NSString *)>(originalSetTitle)(object,selector,title);
    NSWindow *window=object;
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
    const NSInteger number=[(NSWindow *)object windowNumber];
    reinterpret_cast<void(*)(id,SEL,id)>(originalOrderOut)(object,selector,sender);
    forgetWindow(number);
    publishWindows();
}
void miniaturize(id object,SEL selector,id sender) {
    const NSInteger number=[(NSWindow *)object windowNumber];
    reinterpret_cast<void(*)(id,SEL,id)>(originalMiniaturize)(object,selector,sender);
    forgetWindow(number);
    publishWindows();
}
void setContents(id object,SEL selector,id contents) {
    if(macfx::ownsPresentation(object)){reinterpret_cast<void(*)(id,SEL,id)>(originalContents)(object,selector,contents);return;}
    if((!contents||object_getClass(contents)!=surfaceClass)&&!objc_getAssociatedObject(object,&layerLifetimeKey)) {
        reinterpret_cast<void(*)(id,SEL,id)>(originalContents)(object,selector,contents);return;
    }
    IOSurfaceRef input=nullptr; uint32_t window=0;unsigned outputWidth=0,outputHeight=0;uint32_t remoteIdentifier=0;void *contextLayer=nullptr;
    if(contents && object_getClass(contents)==surfaceClass) {
        retainLifetime(object,&layerLifetimeKey,forgetLayer);
        IOSurfaceRef surface=(__bridge IOSurfaceRef)contents;
        const auto width=IOSurfaceGetWidth(surface),height=IOSurfaceGetHeight(surface);
        std::vector<CALayer *> hierarchy;
        for(CALayer *layer=object;layer;layer=layer.superlayer) hierarchy.push_back(layer);
        std::lock_guard<std::mutex> guard(mutex());
        for(CALayer *layer:hierarchy) {
            auto context=contexts().find((__bridge void*)layer);
            if(context!=contexts().end()) {
                window=windowForContext(context->second.identifier,width,height,&outputWidth,&outputHeight);contextLayer=(__bridge void*)layer;remoteIdentifier=context->second.identifier;
                if(window) input=(IOSurfaceRef)CFRetain(surface);
                break;
            }
        }
    }
    if(std::getenv("RESHADE_TRACE") && contents && object_getClass(contents)==surfaceClass) {
        static std::set<std::string> seen;
        const auto surface=(__bridge IOSurfaceRef)contents;
        auto key=std::to_string(window)+":"+std::to_string(IOSurfaceGetWidth(surface))+"x"+std::to_string(IOSurfaceGetHeight(surface));
        std::lock_guard<std::mutex> guard(mutex());
        if(seen.size()<64 && seen.insert(key).second)
            macfx::nativeLog("display surface window="+std::to_string(window)+" size="+std::to_string(IOSurfaceGetWidth(surface))+"x"+std::to_string(IOSurfaceGetHeight(surface))+" class="+class_getName(surfaceClass));
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
            else {presentation=std::make_shared<macfx::LayerPresentation>((CALayer*)object,outputWidth,outputHeight,presentationConfig(macfx::FrameOrigin::TopLeft));std::lock_guard<std::mutex>guard(mutex());remotePresentations().emplace(key,RemotePresentation{contextLayer,window,remoteIdentifier,presentation});}
            auto result=presentation->submit(input);
            if(result.encoded||result.busy){reinterpret_cast<void(*)(id,SEL,id)>(originalContents)(object,selector,contents);CFRelease(input);return;}
            macfx::nativeLog("Remote graphics presentation unavailable: "+result.reason);forgetRemotePresentation(key);
        }catch(const std::exception&e){macfx::nativeLog("Remote graphics presentation unavailable: "+std::string(e.what()));forgetRemotePresentation(key);}
    }
    IOSurfaceRef output=nullptr;
    if(input&&std::getenv("RESHADE_EFFECT")) {macfx::DiagnosticScope scope(macfx::DiagnosticStage::WindowSurface,window,IOSurfaceGetWidth(input),IOSurfaceGetHeight(input));output=rsFilterWindowSurface(key,input);}
    reinterpret_cast<void(*)(id,SEL,id)>(originalContents)(object,selector,output?(__bridge id)output:contents);
    if(output) CFRelease(output);
    if(input) CFRelease(input);
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
    if(retired){forgetRemotePresentation(retired);macfx::releaseFrameOwner(retired);}
}
void setView(id object,SEL selector,NSView *view) {
    reinterpret_cast<void(*)(id,SEL,NSView *)>(originalSetView)(object,selector,view);
    forgetPresentation([(NSOpenGLContext *)object CGLContextObj]);
    bindOpenGLView(object,view);
    NSWindow *window=view.window;
    const auto context=[(NSOpenGLContext *)object CGLContextObj];
    refreshSelection();
    if(visible(window)) {
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
    NSView *view=openGLView(context);
    NSWindow *window=view.window;
    refreshSelection();
    if(visible(window)) {
        const NSRect size=view.wantsBestResolutionOpenGLSurface ? [view convertRectToBacking:view.bounds] : view.bounds;
        const Owner owner={window.windowNumber,window.title.UTF8String ?: "",unsigned(size.size.width),unsigned(size.size.height)};
        bool accepted;
        {std::lock_guard<std::mutex> guard(mutex());owners()[cgl]=owner;accepted=matches(owner);}
        const char *transport=std::getenv("RESHADE_DIAGNOSTICS_OPENGL_TRANSPORT");
        const NSRect physical=[window convertRectToBacking:[view convertRect:view.bounds toView:nil]];
        const unsigned outputWidth=physical.size.width,outputHeight=physical.size.height;
        const bool processing=macfx::graphicsRequested()&&macfx::automaticPresentationNeeded(owner.width,owner.height,outputWidth,outputHeight);
        if(accepted && (processing || (std::getenv("RESHADE_DIAGNOSTICS") && transport && std::strcmp(transport,"overlay")==0))) {
            auto presentation=macfx::openGLPresentation(cgl);
            try {
                if(presentation)presentation->update(view,outputWidth,outputHeight);
                else if(view.superview){
                    const auto config=presentationConfig(macfx::FrameOrigin::BottomLeft);
                    presentation=std::make_shared<macfx::ViewPresentation>(view,outputWidth,outputHeight,config);
                    std::lock_guard<std::mutex>guard(mutex());presentations()[cgl]=presentation;
                }
            }catch(const std::exception&e){macfx::nativeLog("View presentation unavailable: "+std::string(e.what()));forgetPresentation(cgl);}
        }else forgetPresentation(cgl);
    } else {
        {std::lock_guard<std::mutex> guard(mutex());owners().erase(cgl);}
        forgetPresentation(cgl);
    }
}
}
namespace macfx {
std::shared_ptr<LayerPresentation> remotePresentation(CALayer *layer) {std::lock_guard<std::mutex>guard(mutex());auto found=remotePresentations().find((__bridge void*)layer);return found==remotePresentations().end()?nullptr:found->second.presentation;}
std::shared_ptr<ViewPresentation> openGLPresentation(CGLContextObj context) {
    std::lock_guard<std::mutex>guard(mutex());auto found=presentations().find(context);return found==presentations().end()?nullptr:found->second;
}
std::shared_ptr<ViewPresentation> metalPresentation(CALayer *layer) {
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
    auto found=owners().find(key); return found!=owners().end() && matches(found->second);
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
    if(found!=owners().end()) return matches(found->second);
    return false;
}
}
__attribute__((constructor)) static void loadWindowHooks() { @autoreleasepool {
    macfx::DiagnosticScope diagnostics(macfx::DiagnosticStage::Hooks,3);
    if(std::getenv("RESHADE_EXPLICIT_HOST")) return;
    if(!std::getenv("RESHADE_EFFECT") && !std::getenv("RESHADE_GPU_TIMING") && !macfx::graphicsRequested()) return;
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
        NSDictionary *properties=@{(__bridge NSString*)kIOSurfaceWidth:@1,(__bridge NSString*)kIOSurfaceHeight:@1,
            (__bridge NSString*)kIOSurfaceBytesPerElement:@4};
        IOSurfaceRef probe=IOSurfaceCreate((__bridge CFDictionaryRef)properties);
        if(probe) {surfaceClass=object_getClass((__bridge id)probe);CFRelease(probe);}
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
        Method layer=class_getInstanceMethod(NSClassFromString(@"CAContext"),NSSelectorFromString(@"setLayer:"));
        if(layer) originalContextLayer=method_setImplementation(layer,reinterpret_cast<IMP>(setContextLayer));
        dispatch_async(dispatch_get_main_queue(),^{
            [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *) { publishWindows(); }];
        });
    }
}}
