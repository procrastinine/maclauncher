#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <Metal/Metal.h>
#include "effects-plan.hpp"
#include "live-controls.hpp"
#include <cstdint>
#include <optional>

namespace macfx {
// Automatic publishers may negotiate a different image after initialization.
// Suppress repeated failures only for the exact rejected image contract.
class MetalFrameFailure {
    struct Key {
        uintptr_t device;NSUInteger width,height;MTLPixelFormat format;bool framebufferOnly;uint64_t plan,controls;
        bool operator==(const Key &other)const{return device==other.device&&width==other.width&&height==other.height&&format==other.format&&framebufferOnly==other.framebufferOnly&&plan==other.plan&&controls==other.controls;}
    };
    std::optional<Key> rejected;
    static Key key(id<MTLDevice>device,NSUInteger width,NSUInteger height,MTLPixelFormat format,bool framebufferOnly){return {reinterpret_cast<uintptr_t>((__bridge void*)device),width,height,format,framebufferOnly,effectPlanDemandGeneration(),liveState().generation};}
    static Key key(id<MTLTexture> image){return key(image.device,image.width,image.height,image.pixelFormat,bool(image.framebufferOnly));}
public:
    bool blocks(id<MTLTexture> image){
        if(!rejected)return false;
        if(*rejected==key(image))return true;
        rejected.reset();return false;
    }
    bool reject(id<MTLTexture> image){const auto next=key(image);const bool changed=!rejected||!(*rejected==next);rejected=next;return changed;}
    bool blocks(id<MTLDevice>device,NSUInteger width,NSUInteger height,MTLPixelFormat format){if(!rejected)return false;if(*rejected==key(device,width,height,format,false))return true;rejected.reset();return false;}
    bool reject(id<MTLDevice>device,NSUInteger width,NSUInteger height,MTLPixelFormat format){const auto next=key(device,width,height,format,false);const bool changed=!rejected||!(*rejected==next);rejected=next;return changed;}
    void clear(){rejected.reset();}
};
}
