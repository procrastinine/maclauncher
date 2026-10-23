#import <Foundation/Foundation.h>
#include "depth-demand.hpp"
#include <cassert>
int main(){@autoreleasepool{
    NSObject *first=[NSObject new],*second=[NSObject new];
    assert(!macfx::colorRequiresDepth(first)&&!macfx::colorRequiresDepth(second));
    macfx::setColorDepthDemand(first,true);assert(macfx::colorRequiresDepth(first));
    macfx::setColorDepthDemand(second,false);assert(macfx::colorRequiresDepth(first)&&!macfx::colorRequiresDepth(second));
    macfx::setColorDepthDemand(first,false);assert(!macfx::colorRequiresDepth(first));
    macfx::setColorDepthDemand(second,true);macfx::setColorDepthDemand(first,false);assert(macfx::colorRequiresDepth(second));
    macfx::setColorDepthDemand(second,false);assert(!macfx::colorRequiresDepth(second));
    puts("Exact presentation-color depth demand retires independently across owners and depth-to-color-only changes; metadata-only, no GPU capture asserted");
}}
