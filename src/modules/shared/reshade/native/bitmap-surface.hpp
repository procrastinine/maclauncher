#pragma once
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <IOSurface/IOSurface.h>
#import <objc/runtime.h>
#include <algorithm>
#include <atomic>
#include <memory>
#include <mutex>
#include <vector>

namespace macfx {
inline bool bitmapImageObject(id value,Class imageClass){return value&&imageClass&&object_getClass(value)==imageClass&&
    CFGetTypeID((__bridge CFTypeRef)value)==CGImageGetTypeID();}
inline std::atomic<size_t>&bitmapSurfaceReservation(){static std::atomic<size_t>bytes{0};return bytes;}
struct BitmapSurface {
    IOSurfaceRef surface=nullptr;
    CGContextRef context=nullptr;
    unsigned width=0,height=0;
    size_t reserved=0;
    bool opaque=false;
    ~BitmapSurface(){if(context)CGContextRelease(context);if(surface)CFRelease(surface);bitmapSurfaceReservation().fetch_sub(reserved);}
    BitmapSurface()=default;
    BitmapSurface(const BitmapSurface&)=delete;
};

// Completed CPU images cross into the same BGRA/sRGB texture path as other
// window sources. Consumers retain a slot until their GPU snapshot/read ends;
// Core Animation's external surface use is an additional reuse constraint.
class BitmapSurfacePool {
    std::mutex mutex;
    std::vector<std::shared_ptr<BitmapSurface>>slots;
    static constexpr size_t sourceLimit=64u*1024u*1024u,globalLimit=256u*1024u*1024u;
    static bool reserve(size_t bytes){auto &used=bitmapSurfaceReservation();size_t before=used.load();
        do{if(before>globalLimit||bytes>globalLimit-before)return false;}while(!used.compare_exchange_weak(before,before+bytes));return true;}
    std::shared_ptr<BitmapSurface>acquire(unsigned width,unsigned height){
        std::lock_guard<std::mutex>guard(mutex);
        for(auto&slot:slots)if(slot.use_count()==1&&slot->width==width&&slot->height==height&&!IOSurfaceIsInUse(slot->surface))return slot;
        // Idle old sizes do not accumulate across a resize. Leased or displayed
        // surfaces remain counted until their actual final consumer releases them.
        slots.erase(std::remove_if(slots.begin(),slots.end(),[&](const auto&slot){return slot.use_count()==1&&
            (slot->width!=width||slot->height!=height)&&!IOSurfaceIsInUse(slot->surface);}),slots.end());
        if(slots.size()>=4)return {};
        const size_t row=IOSurfaceAlignProperty(kIOSurfaceBytesPerRow,size_t(width)*4);
        if(!row||row>sourceLimit/height)return {};
        const size_t bytes=IOSurfaceAlignProperty(kIOSurfaceAllocSize,row*height);
        if(!bytes||bytes>sourceLimit||!reserve(bytes))return {};
        auto slot=std::make_shared<BitmapSurface>();slot->reserved=bytes;slot->width=width;slot->height=height;
        NSDictionary*properties=@{(__bridge NSString*)kIOSurfaceWidth:@(width),(__bridge NSString*)kIOSurfaceHeight:@(height),
            (__bridge NSString*)kIOSurfaceBytesPerElement:@4,(__bridge NSString*)kIOSurfaceBytesPerRow:@(row),
            (__bridge NSString*)kIOSurfaceAllocSize:@(bytes),(__bridge NSString*)kIOSurfacePixelFormat:@(uint32_t('BGRA'))};
        slot->surface=IOSurfaceCreate((__bridge CFDictionaryRef)properties);if(!slot->surface)return {};
        CGColorSpaceRef color=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        slot->context=CGBitmapContextCreate(IOSurfaceGetBaseAddress(slot->surface),width,height,8,
            IOSurfaceGetBytesPerRow(slot->surface),color,kCGImageAlphaPremultipliedFirst|kCGBitmapByteOrder32Little);
        if(color)CGColorSpaceRelease(color);if(!slot->context)return {};
        CGContextSetBlendMode(slot->context,kCGBlendModeCopy);CGContextSetInterpolationQuality(slot->context,kCGInterpolationNone);
        slots.push_back(slot);return slot;
    }
public:
    std::shared_ptr<BitmapSurface>upload(CGImageRef image){
        if(!image)return {};const size_t width=CGImageGetWidth(image),height=CGImageGetHeight(image);
        if(!width||!height||width>16384||height>16384||width>sourceLimit/4/height)return {};
        auto slot=acquire(unsigned(width),unsigned(height));if(!slot)return {};
        if(IOSurfaceLock(slot->surface,0,nullptr)!=kIOReturnSuccess)return {};
        // Quartz's bitmap rows retain CGImage's top-to-bottom order. No flip or
        // readback is added between this one upload and subsequent GPU stages.
        CGContextDrawImage(slot->context,CGRectMake(0,0,width,height),image);CGContextFlush(slot->context);
        IOSurfaceUnlock(slot->surface,0,nullptr);
        const auto alpha=CGImageGetAlphaInfo(image);
        slot->opaque=alpha==kCGImageAlphaNone||alpha==kCGImageAlphaNoneSkipFirst||alpha==kCGImageAlphaNoneSkipLast;
        return slot;
    }
    void clear(){std::lock_guard<std::mutex>guard(mutex);slots.clear();}
    size_t retained(){std::lock_guard<std::mutex>guard(mutex);return slots.size();}
};
}
