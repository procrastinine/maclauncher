#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// Captured-source import reuse follows the technique demonstrated by MacShade
// (BSD-3-Clause), commit 2dafaf2; see macshade-BSD-3-Clause.txt.
// This Metal implementation is independent.
#import <Metal/Metal.h>
#import <IOSurface/IOSurface.h>
#include <list>
#include <memory>

namespace macfx {
// Producer-owned and externally serialized. Retaining the surface and device
// prevents recycled object/IOSurface IDs from matching an unrelated import.
// An import is immutable; its pixels remain protected by a separate frame lease.
class IOSurfaceTextureCache {
    struct Entry {
        IOSurfaceRef surface;
        id<MTLDevice>device;
        id<MTLTexture>texture;
        MTLPixelFormat format;
        MTLTextureUsage usage;
        Entry(IOSurfaceRef image,id<MTLDevice>gpu,id<MTLTexture>view,MTLPixelFormat pixel,MTLTextureUsage access)
            :surface(image),device(gpu),texture(view),format(pixel),usage(access){CFRetain(surface);}
        ~Entry(){CFRelease(surface);}
    };
    const size_t maximum;
    std::list<std::shared_ptr<Entry>>entries;
public:
    explicit IOSurfaceTextureCache(size_t count=4):maximum(count){}
    id<MTLTexture>texture(id<MTLDevice>device,IOSurfaceRef surface,MTLPixelFormat format,MTLTextureUsage usage=MTLTextureUsageShaderRead){
        if(!device||!surface)return nil;
        for(auto entry=entries.begin();entry!=entries.end();++entry)if((*entry)->surface==surface&&(*entry)->device==device&&(*entry)->format==format&&(*entry)->usage==usage){
            auto found=*entry;entries.splice(entries.begin(),entries,entry);return found->texture;
        }
        const auto width=IOSurfaceGetWidth(surface),height=IOSurfaceGetHeight(surface);
        if(!width||!height)return nil;
        auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];
        descriptor.storageMode=MTLStorageModeShared;descriptor.usage=usage;
        auto view=[device newTextureWithDescriptor:descriptor iosurface:surface plane:0];
        if(!view)return nil; // An unavailable import can be retried on a later frame.
        if(maximum){
            while(entries.size()>=maximum)entries.pop_back();
            entries.push_front(std::make_shared<Entry>(surface,device,view,format,usage));
        }
        return view;
    }
    void clear(){entries.clear();}
    size_t retained()const noexcept{return entries.size();}
};
}
