#pragma once
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
namespace macfx {
// Layers and views remain owned by the application. Replacing or deleting
// either endpoint invalidates the binding without a timer or retained view.
struct LayerBinding {
    __weak NSView *view=nil;
    // Cache only a direct view/layer match. An ancestor match can change its
    // nearest owning view when an application inserts a new nested view.
    NSView *currentView(CALayer *layer)const {NSView *value=view;return value&&value.layer==layer?value:nil;}
};
}
