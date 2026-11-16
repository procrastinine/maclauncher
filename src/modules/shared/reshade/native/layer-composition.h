#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <QuartzCore/CALayer.h>
#import <Foundation/Foundation.h>
namespace macfx {
// Whether every image a game presents to its layer is opaque: the layer's opaque property, or the Vulkan WSI's
// "MesaWSIOpaqueComposition" value. KosmicKrisp keeps CAMetalLayer.opaque false for its Metal 4 presentation
// workaround and blits every image with alpha 1 when the swapchain's compositeAlpha is opaque, which it publishes
// as that value; a D3D12 flip-model swapchain through vkd3d-proton requests an opaque composite alpha.
inline bool layerComposesOpaquely(CALayer*layer){
 if(!layer)return false;if(layer.opaque)return true;
 id value=[layer valueForKey:@"MesaWSIOpaqueComposition"];return [value isKindOfClass:[NSNumber class]]&&[(NSNumber*)value boolValue];
}
}
