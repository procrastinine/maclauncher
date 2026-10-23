#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <Metal/Metal.h>
#include <cstdint>
#include <optional>

namespace macfx {
// Automatic publishers may negotiate a different image after initialization.
// Suppress repeated failures only for the exact rejected image contract.
class MetalFrameFailure {
    struct Key {
        uintptr_t device;NSUInteger width,height;MTLPixelFormat format;bool framebufferOnly;
        bool operator==(const Key &other)const{return device==other.device&&width==other.width&&height==other.height&&format==other.format&&framebufferOnly==other.framebufferOnly;}
    };
    std::optional<Key> rejected;
    static Key key(id<MTLTexture> image){return {reinterpret_cast<uintptr_t>((__bridge void*)image.device),image.width,image.height,image.pixelFormat,bool(image.framebufferOnly)};}
public:
    bool blocks(id<MTLTexture> image){
        if(!rejected)return false;
        if(*rejected==key(image))return true;
        rejected.reset();return false;
    }
    bool reject(id<MTLTexture> image){const auto next=key(image);const bool changed=!rejected||!(*rejected==next);rejected=next;return changed;}
    void clear(){rejected.reset();}
};
}
