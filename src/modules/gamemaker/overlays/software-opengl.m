#import <AppKit/AppKit.h>
#import <objc/runtime.h>
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
    fprintf(stderr, "[MacLauncher OpenGL v1] hardware-only pixel format failed; retry without Accelerated: %s\n",
            retried ? "created" : "unavailable");
    return retried;
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
    fprintf(stderr, "[MacLauncher OpenGL v1] process-local software fallback enabled\n");
}
@end
