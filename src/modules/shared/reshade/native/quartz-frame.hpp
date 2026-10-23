#pragma once
#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#import <objc/runtime.h>
#include "bitmap-surface.hpp"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <memory>
#include <mutex>
#include <set>
#include <vector>

// AppKit must keep painting the original Quartz producer behind this host.
// The internal Metal output may be opaque; neither this view nor its backing
// layer may advertise occlusion of the producer or consume game input.
@interface MacFXQuartzPresentationView : NSView
@end
@implementation MacFXQuartzPresentationView
- (NSView*)hitTest:(NSPoint)point{return nil;}
- (BOOL)acceptsFirstResponder{return NO;}
- (BOOL)isOpaque{return NO;}
@end

namespace macfx {
inline std::atomic<size_t>&quartzImageReservation(){return bitmapSurfaceReservation();}
// Retaining a COW bitmap can keep its old allocation alive after the game
// paints again. Bound those queued source references as well as upload slots.
struct QuartzFrameImage {
    CGImageRef image;
    size_t bytes;
    QuartzFrameImage(CGImageRef source,size_t size):image(CGImageRetain(source)),bytes(size){}
    ~QuartzFrameImage(){CGImageRelease(image);quartzImageReservation().fetch_sub(bytes);}
    static std::shared_ptr<QuartzFrameImage>retain(CGImageRef source){
        if(!source)return {};const auto h=CGImageGetHeight(source),row=CGImageGetBytesPerRow(source);
        constexpr size_t sourceLimit=64u*1024u*1024u,globalLimit=256u*1024u*1024u;
        if(!h||!row||row>sourceLimit/h)return {};const auto bytes=row*h;
        auto&used=quartzImageReservation();size_t before=used.load();
        do{if(before>globalLimit||bytes>globalLimit-before)return {};}while(!used.compare_exchange_weak(before,before+bytes));
        return std::make_shared<QuartzFrameImage>(source,bytes);
    }
};
// A completed bitmap is eligible only if the original view actually draws it
// (or one of its crops) into the CGContext belonging to this drawing scope.
// Capturing an arbitrary intermediate image of the same size is insufficient.
class QuartzFrameCapture {
    CGContextRef destination;
    CGSize points,pixels;
    CGImageRef image=nullptr;
    std::vector<CGImageRef>crops;
    bool drawn=false,ambiguous=false;
public:
    static bool matchesExtent(CGImageRef value,CGSize points,CGSize pixels){
        if(!value)return false;
        const auto w=CGImageGetWidth(value),h=CGImageGetHeight(value);
        if(!w||!h||w>16384||h>16384||w>64u*1024u*1024u/4/h)return false;
        const auto same=[&](CGSize size){return double(w)==std::round(size.width)&&double(h)==std::round(size.height);};
        return same(points)||same(pixels);
    }
private:
    bool includes(CGImageRef value)const {
        return value==image||std::find(crops.begin(),crops.end(),value)!=crops.end();
    }
public:
    QuartzFrameCapture(CGContextRef context,CGSize logical,CGSize physical):destination(context),points(logical),pixels(physical){}
    ~QuartzFrameCapture(){for(auto crop:crops)CGImageRelease(crop);if(image)CGImageRelease(image);}
    QuartzFrameCapture(const QuartzFrameCapture&)=delete;
    void bitmap(CGImageRef value){
        if(!matchesExtent(value,points,pixels))return;
        if(image&&image!=value){ambiguous=true;return;}
        if(!image)image=CGImageRetain(value);
    }
    void crop(CGImageRef parent,CGImageRef value){
        if(!image||!value||ambiguous||!includes(parent)||includes(value))return;
        if(crops.size()>=64){ambiguous=true;return;}
        crops.push_back(CGImageRetain(value));
    }
    void draw(CGContextRef context,CGImageRef value){if(image&&!ambiguous&&context==destination&&includes(value))drawn=true;}
    CGImageRef completed()const{return drawn&&!ambiguous?image:nullptr;}
};

using QuartzDrawImplementation=void(*)(id,SEL,NSRect);
using QuartzDrawScope=void(*)(id,NSRect,QuartzDrawImplementation);
// Each closure retains the exact class's IMP. Looking it up through self.class
// would recurse when a subclass invokes its superclass's wrapped drawRect.
// Preserve the original selector for ordinary and forwarding-based methods.
inline bool installQuartzDrawScope(Class cls,QuartzDrawScope scope){
    static std::mutex mutex;static std::set<Class>classes;static std::set<IMP>wrappers;
    std::lock_guard<std::mutex>guard(mutex);
    if(!cls||classes.count(cls)||classes.size()>=128)return false;
    SEL selector=@selector(drawRect:);Method method=nullptr;unsigned count=0;
    Method*methods=class_copyMethodList(cls,&count);
    for(unsigned i=0;i<count;++i)if(method_getName(methods[i])==selector){method=methods[i];break;}
    free(methods);if(!method)return false;
    IMP previous=method_getImplementation(method);if(wrappers.count(previous))return false;
    auto original=reinterpret_cast<QuartzDrawImplementation>(previous);
    IMP replacement=imp_implementationWithBlock(^(id view,NSRect dirty){scope(view,dirty,original);});
    if(!replacement)return false;
    classes.insert(cls);wrappers.insert(replacement);method_setImplementation(method,replacement);return true;
}
}
