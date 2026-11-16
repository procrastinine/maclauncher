// A game layer's opaque composition (layer-composition.h): its opaque property, or the Vulkan WSI's declaration.
#include "layer-composition.h"
#import <QuartzCore/CAMetalLayer.h>
#include <cstdio>
int main(){@autoreleasepool{
 unsigned failures=0,checks=0;auto expect=[&](bool ok,const char*what){++checks;if(!ok){++failures;std::printf("FAIL %s\n",what);}};
 CAMetalLayer*layer=[CAMetalLayer layer];layer.opaque=NO;
 expect(!macfx::layerComposesOpaquely(nil),"no layer");
 expect(!macfx::layerComposesOpaquely(layer),"a translucent layer without a WSI declaration");
 [layer setValue:@YES forKey:@"MesaWSIOpaqueComposition"];
 expect(macfx::layerComposesOpaquely(layer),"KosmicKrisp's opaque composition on a layer whose opaque property is false");
 [layer setValue:nil forKey:@"MesaWSIOpaqueComposition"];
 expect(!macfx::layerComposesOpaquely(layer),"a cleared declaration");
 [layer setValue:@"YES" forKey:@"MesaWSIOpaqueComposition"];
 expect(!macfx::layerComposesOpaquely(layer),"a declaration that is not a number");
 [layer setValue:nil forKey:@"MesaWSIOpaqueComposition"];layer.opaque=YES;
 expect(macfx::layerComposesOpaquely(layer),"an opaque layer");
 std::printf("layer-composition: %s %u\n",failures?"fail":"pass",checks);return failures?1:0;}}
