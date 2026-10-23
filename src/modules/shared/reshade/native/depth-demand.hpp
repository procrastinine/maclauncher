#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
namespace macfx {
inline const void *depthDemandKey(){static char key;return &key;}
inline void setColorDepthDemand(id color,bool required){if(color)objc_setAssociatedObject(color,depthDemandKey(),required?@YES:nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
inline bool colorRequiresDepth(id color){return color&&objc_getAssociatedObject(color,depthDemandKey());}
}
