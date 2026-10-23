#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <OpenGL/CGLRenderers.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Process-local, opt-in workaround for a failed hardware-only pixel-format
// request. Game code, profiles, buffer sizes and working native formats are kept.
typedef id (*PixelFormatInitializer)(id, SEL, const NSOpenGLPixelFormatAttribute *);
static PixelFormatInitializer originalInitializer;

static int attributeHasValue(NSOpenGLPixelFormatAttribute attribute) {
    switch (attribute) {
        case NSOpenGLPFAAuxBuffers: case NSOpenGLPFAColorSize:
        case NSOpenGLPFAAlphaSize: case NSOpenGLPFADepthSize:
        case NSOpenGLPFAStencilSize: case NSOpenGLPFAAccumSize:
        case NSOpenGLPFASampleBuffers: case NSOpenGLPFASamples:
        case NSOpenGLPFARendererID: case NSOpenGLPFAScreenMask:
        case NSOpenGLPFAOpenGLProfile:
            return 1;
        case NSOpenGLPFAAllRenderers: case NSOpenGLPFATripleBuffer:
        case NSOpenGLPFADoubleBuffer: case NSOpenGLPFAStereo:
        case NSOpenGLPFAMinimumPolicy: case NSOpenGLPFAMaximumPolicy:
        case NSOpenGLPFAOffScreen: case NSOpenGLPFAFullScreen:
        case NSOpenGLPFAAuxDepthStencil: case NSOpenGLPFAColorFloat:
        case NSOpenGLPFAMultisample: case NSOpenGLPFASupersample:
        case NSOpenGLPFASampleAlpha: case NSOpenGLPFASingleRenderer:
        case NSOpenGLPFANoRecovery: case NSOpenGLPFAAccelerated:
        case NSOpenGLPFAClosestPolicy: case NSOpenGLPFARobust:
        case NSOpenGLPFABackingStore: case NSOpenGLPFAMPSafe:
        case NSOpenGLPFAWindow: case NSOpenGLPFAMultiScreen:
        case NSOpenGLPFACompliant: case NSOpenGLPFAPixelBuffer:
        case NSOpenGLPFARemotePixelBuffer: case NSOpenGLPFAAllowOfflineRenderers:
        case NSOpenGLPFAAcceleratedCompute:
            return 0;
        default:
            return -1;
    }
}

// Unknown/unterminated lists are left to AppKit; do not guess their layout.
static BOOL copySoftwareEligibleAttributes(const NSOpenGLPixelFormatAttribute *input,
                                           NSOpenGLPixelFormatAttribute *output) {
    if (!input) return NO;
    size_t written = 0;
    BOOL removedAcceleration = NO;
    for (size_t i = 0; i < 64; i++) {
        NSOpenGLPixelFormatAttribute attribute = input[i];
        if (!attribute) { output[written] = 0; return removedAcceleration; }
        int hasValue = attributeHasValue(attribute);
        if (hasValue < 0) return NO;
        if (attribute == NSOpenGLPFAAccelerated) { removedAcceleration = YES; continue; }
        output[written++] = attribute;
        if (hasValue) {
            if (++i >= 64) return NO;
            output[written++] = input[i];
        }
    }
    return NO;
}

static id initializePixelFormat(id receiver, SEL selector,
                               const NSOpenGLPixelFormatAttribute *attributes) {
    // A failed initializer may release receiver. Capture its class and the
    // copied attribute list before calling it, then retry on a fresh allocation.
    Class formatClass = object_getClass(receiver);
    NSOpenGLPixelFormatAttribute retryAttributes[65];
    BOOL canRetry = copySoftwareEligibleAttributes(attributes, retryAttributes);
    id original = originalInitializer(receiver, selector, attributes);
    if (original || !canRetry) return original;
    id retryReceiver = [formatClass alloc];
    id retried = originalInitializer(retryReceiver, selector, retryAttributes);
    fprintf(stderr, "[MacLauncher OpenGL v2] hardware-only pixel format failed; retry without Accelerated: %s\n",
            retried ? "created" : "unavailable");
    return retried;
}


// Reviewed legacy runners bind a one-pixel-per-point software surface while
// NSView conversions still report Retina backing pixels. Keep those units
// consistent only for their own view and its actual software GL context.
static BOOL legacyLogicalRequested;
typedef NSRect (*RectConverter)(id, SEL, NSRect);
static RectConverter originalToBacking, originalFromBacking;

@interface NSView (MacLauncherLegacyGLContext)
- (NSOpenGLContext *)getContext;
@end

static BOOL usesLegacySoftwareCoordinates(id receiver) {
    if (!legacyLogicalRequested) return NO;
    Class viewClass = objc_getClass("YYGLView");
    if (!viewClass || ![receiver isKindOfClass:viewClass] || ![receiver respondsToSelector:@selector(getContext)]) return NO;
    NSOpenGLContext *context = [receiver getContext];
    if (![context isKindOfClass:[NSOpenGLContext class]]) return NO;
    NSOpenGLPixelFormat *format = [context pixelFormat];
    if (![format isKindOfClass:[NSOpenGLPixelFormat class]]) return NO;
    GLint screen = [context currentVirtualScreen], renderer = 0;
    if (screen < 0 || screen > 31) return NO;
    [format getValues:&renderer forAttribute:NSOpenGLPFARendererID forVirtualScreen:screen];
    GLint family = renderer & kCGLRendererIDMatchingMask;
    return family == kCGLRendererGenericFloatID || family == kCGLRendererGenericID;
}

static NSRect convertToBacking(id receiver, SEL selector, NSRect rect) {
    return usesLegacySoftwareCoordinates(receiver) ? rect : originalToBacking(receiver, selector, rect);
}
static NSRect convertFromBacking(id receiver, SEL selector, NSRect rect) {
    return usesLegacySoftwareCoordinates(receiver) ? rect : originalFromBacking(receiver, selector, rect);
}

@interface MacLauncherSoftwareOpenGLFallback : NSObject
@end
@implementation MacLauncherSoftwareOpenGLFallback
+ (void)load {
    const char *enabled = getenv("MACLAUNCHER_ALLOW_SOFTWARE_OPENGL");
    if (!enabled || strcmp(enabled, "1") != 0) return;
    Method method = class_getInstanceMethod([NSOpenGLPixelFormat class], @selector(initWithAttributes:));
    if (!method) return;
    originalInitializer = (PixelFormatInitializer)method_getImplementation(method);
    method_setImplementation(method, (IMP)initializePixelFormat);
    const char *logical = getenv("MACLAUNCHER_LEGACY_LOGICAL_OPENGL");
    legacyLogicalRequested = logical && strcmp(logical, "1") == 0;
    if (legacyLogicalRequested) {
        Method to = class_getInstanceMethod([NSView class], @selector(convertRectToBacking:));
        Method from = class_getInstanceMethod([NSView class], @selector(convertRectFromBacking:));
        if (to && from) {
            originalToBacking = (RectConverter)method_getImplementation(to);
            originalFromBacking = (RectConverter)method_getImplementation(from);
            method_setImplementation(to, (IMP)convertToBacking);
            method_setImplementation(from, (IMP)convertFromBacking);
        }
    }
    fprintf(stderr, "[MacLauncher OpenGL v2] process-local software fallback enabled; legacy coordinates %s\n", legacyLogicalRequested ? "eligible" : "unchanged");
}
@end
