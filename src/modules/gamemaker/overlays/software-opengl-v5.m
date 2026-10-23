#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <OpenGL/CGLRenderers.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Process-local, opt-in workaround for a failed hardware-only pixel format.
// The exact legacy runner/checksum and coordinate opt-in are gated in Node.
typedef id (*PixelFormatInitializer)(id, SEL, const NSOpenGLPixelFormatAttribute *);
typedef id (*ContextInitializer)(id, SEL, NSOpenGLPixelFormat *, NSOpenGLContext *);
typedef void (*ContextViewSetter)(id, SEL, NSView *);
typedef void (*SurfacePreferenceSetter)(id, SEL, BOOL);
typedef NSRect (*RectConverter)(id, SEL, NSRect);
static PixelFormatInitializer originalInitializer;
static ContextInitializer originalContextInitializer;
static ContextViewSetter originalContextViewSetter;
static SurfacePreferenceSetter originalSurfacePreferenceSetter;
static RectConverter originalToBacking, originalFromBacking;
static BOOL legacyLogicalRequested;
static char softwareFormatKey, softwareContextKey, contextFormatKey, viewSelectionKey;
static char boundViewKey, surfaceOwnerKey, surfacePreferenceKey;
static NSHashTable *pendingSoftwareFormats, *provisionalViews;

// This check runs once when a failed hardware request is retried. Rendering
// never asks AppKit for pixel formats, virtual screens or renderer attributes.
static BOOL isSoftwareFormat(id format) {
    if (![format isKindOfClass:[NSOpenGLPixelFormat class]]) return NO;
    GLint count = [format numberOfVirtualScreens];
    if (count < 1 || count > 32) return NO;
    for (GLint screen = 0; screen < count; screen++) {
        GLint renderer = 0, accelerated = 0;
        [format getValues:&renderer forAttribute:NSOpenGLPFARendererID forVirtualScreen:screen];
        [format getValues:&accelerated forAttribute:NSOpenGLPFAAccelerated forVirtualScreen:screen];
        GLint family = renderer & kCGLRendererIDMatchingMask;
        if (accelerated || (family != kCGLRendererGenericFloatID && family != kCGLRendererGenericID)) return NO;
    }
    return YES;
}

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

static void recordSoftwareFormat(id format, BOOL selected) {
    if (!format || !legacyLogicalRequested) return;
    @synchronized([NSOpenGLContext class]) {
        objc_setAssociatedObject(format, &softwareFormatKey, selected ? @YES : nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        if (selected) {
            if (!pendingSoftwareFormats) pendingSoftwareFormats = [[NSHashTable weakObjectsHashTable] retain];
            if (!provisionalViews) provisionalViews = [[NSHashTable weakObjectsHashTable] retain];
            [pendingSoftwareFormats addObject:format];
        } else {
            // A new working format cannot invalidate another format/context.
            [pendingSoftwareFormats removeObject:format];
        }
    }
}

static id initializePixelFormat(id receiver, SEL selector,
                               const NSOpenGLPixelFormatAttribute *attributes) {
    // Failed initialization may release receiver. Copy before calling AppKit,
    // then retry only an understood accelerated request on a fresh instance.
    Class formatClass = object_getClass(receiver);
    NSOpenGLPixelFormatAttribute retryAttributes[65];
    BOOL canRetry = copySoftwareEligibleAttributes(attributes, retryAttributes);
    id original = originalInitializer(receiver, selector, attributes);
    if (original) {
        recordSoftwareFormat(original, NO);
        return original;
    }
    if (!canRetry) return nil;
    id retried = originalInitializer([formatClass alloc], selector, retryAttributes);
    recordSoftwareFormat(retried, legacyLogicalRequested && isSoftwareFormat(retried));
    fprintf(stderr, "[MacLauncher OpenGL v5] hardware-only pixel format failed; retry without Accelerated: %s\n",
            retried ? "created" : "unavailable");
    return retried;
}

static id initializeContext(id receiver, SEL selector,
                            NSOpenGLPixelFormat *format, NSOpenGLContext *shareContext) {
    BOOL selected = legacyLogicalRequested && [objc_getAssociatedObject(format, &softwareFormatKey) boolValue];
    id context = originalContextInitializer(receiver, selector, format, shareContext);
    if (context && legacyLogicalRequested) {
        objc_setAssociatedObject(context, &softwareContextKey, selected ? @YES : @NO, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        // AppKit already retains its immutable format. Keep that exact identity
        // for retiring the early selection after this context reaches its view.
        objc_setAssociatedObject(context, &contextFormatKey, selected ? format : nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    return context;
}

static BOOL isLegacyView(id view) {
    Class viewClass = objc_getClass("YYGLView");
    return viewClass && [view isKindOfClass:viewClass];
}

static NSHashTable *weakReference(id owner, const void *key) {
    NSHashTable *reference = objc_getAssociatedObject(owner, key);
    if (!reference) {
        reference = [NSHashTable weakObjectsHashTable];
        objc_setAssociatedObject(owner, key, reference, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    return reference;
}

static void restoreSurfacePreference(id view, id owner) {
    if (!view) return;
    NSHashTable *reference = objc_getAssociatedObject(view, &surfaceOwnerKey);
    NSNumber *preference = objc_getAssociatedObject(view, &surfacePreferenceKey);
    if (!preference || owner && [reference anyObject] != owner) return;
    originalSurfacePreferenceSetter(view, @selector(setWantsBestResolutionOpenGLSurface:), [preference boolValue]);
    objc_setAssociatedObject(view, &surfacePreferenceKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    [reference removeAllObjects];
}

// Match the actual software drawable to the reviewed logical-coordinate path.
// The runner's window scale/FBO sizing is not rewritten. All property reads and
// writes occur at attachment/preference changes, never in the rendering loop.
static void setContextView(id receiver, SEL selector, NSView *view) {
    @synchronized([NSOpenGLContext class]) {
        NSHashTable *binding = objc_getAssociatedObject(receiver, &boundViewKey);
        id previousView = [binding anyObject];
        if (previousView && previousView != view) restoreSurfacePreference(previousView, receiver);
        BOOL selected = legacyLogicalRequested && isLegacyView(view) &&
            [objc_getAssociatedObject(receiver, &softwareContextKey) boolValue];
        if (selected) {
            NSHashTable *owner = weakReference(view, &surfaceOwnerKey);
            if ([owner anyObject] != receiver) {
                restoreSurfacePreference(view, nil);
                objc_setAssociatedObject(view, &surfacePreferenceKey, @([view wantsBestResolutionOpenGLSurface]), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
                [owner removeAllObjects];
                [owner addObject:receiver];
            }
            if ([view wantsBestResolutionOpenGLSurface]) {
                originalSurfacePreferenceSetter(view, @selector(setWantsBestResolutionOpenGLSurface:), NO);
            }
        } else if (view) {
            restoreSurfacePreference(view, nil);
        }
        if (selected || binding) {
            binding = weakReference(receiver, &boundViewKey);
            [binding removeAllObjects];
            if (view) [binding addObject:view];
        }
    }
    originalContextViewSetter(receiver, selector, view);
}

static void setSurfacePreference(id receiver, SEL selector, BOOL requested) {
    BOOL effective = requested;
    if (legacyLogicalRequested && isLegacyView(receiver)) {
        @synchronized([NSOpenGLContext class]) {
            NSHashTable *reference = objc_getAssociatedObject(receiver, &surfaceOwnerKey);
            id owner = [reference anyObject];
            NSNumber *previous = objc_getAssociatedObject(receiver, &surfacePreferenceKey);
            if (owner && previous && [objc_getAssociatedObject(owner, &softwareContextKey) boolValue]) {
                objc_setAssociatedObject(receiver, &surfacePreferenceKey, @(requested), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
                effective = NO;
            } else if (previous) {
                objc_setAssociatedObject(receiver, &surfacePreferenceKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
                [reference removeAllObjects];
            }
        }
    }
    originalSurfacePreferenceSetter(receiver, selector, effective);
}

// The runner's getContext is a stable object getter. Its identity is compared
// with this weak cache so replacements cannot inherit another context's state.
// No context or view is kept alive by the cache, and no GL query occurs here.
@interface MacLauncherLegacyGLViewSelectionV5 : NSObject {
@public
    NSHashTable *contextReference;
    BOOL sawContext, software;
}
@end
@implementation MacLauncherLegacyGLViewSelectionV5
- (instancetype)init {
    self = [super init];
    if (self) contextReference = [[NSHashTable weakObjectsHashTable] retain];
    return self;
}
- (void)dealloc { [contextReference release]; [super dealloc]; }
@end

@interface NSView (MacLauncherLegacyGLContextV5)
- (NSOpenGLContext *)getContext;
@end

static BOOL usesLegacySoftwareCoordinates(id receiver) {
    if (!legacyLogicalRequested) return NO;
    if (!isLegacyView(receiver)) return NO;
    id context = [receiver respondsToSelector:@selector(getContext)] ? [receiver getContext] : nil;
    @synchronized([NSOpenGLContext class]) {
        MacLauncherLegacyGLViewSelectionV5 *state = objc_getAssociatedObject(receiver, &viewSelectionKey);
        if (!state) {
            state = [[[MacLauncherLegacyGLViewSelectionV5 alloc] init] autorelease];
            objc_setAssociatedObject(receiver, &viewSelectionKey, state, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
        if (context) {
            if (context != [state->contextReference anyObject] || !state->sawContext) {
                [state->contextReference removeAllObjects];
                state->software = [context isKindOfClass:[NSOpenGLContext class]] &&
                    [objc_getAssociatedObject(context, &softwareContextKey) boolValue];
                if (state->software) [pendingSoftwareFormats removeObject:objc_getAssociatedObject(context, &contextFormatKey)];
                [state->contextReference addObject:context];
                state->sawContext = YES;
            }
            return state->software;
        }
        // Clearing an attached context is not a new pre-attachment selection.
        if (state->sawContext) {
            [state->contextReference removeAllObjects];
            state->software = NO;
            return NO;
        }
        if (![pendingSoftwareFormats anyObject]) return NO;
        // The exact legacy runner converts one YYGLView before attachment.
        // Claim only that view; unrelated unbound views retain AppKit units.
        id provisional = [provisionalViews anyObject];
        if (!provisional) { [provisionalViews addObject:receiver]; provisional = receiver; }
        return provisional == receiver;
    }
}

static NSRect convertToBacking(id receiver, SEL selector, NSRect rect) {
    NSRect converted = originalToBacking(receiver, selector, rect);
    return usesLegacySoftwareCoordinates(receiver) ? rect : converted;
}
static NSRect convertFromBacking(id receiver, SEL selector, NSRect rect) {
    NSRect converted = originalFromBacking(receiver, selector, rect);
    return usesLegacySoftwareCoordinates(receiver) ? rect : converted;
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
    if (logical && strcmp(logical, "1") == 0) {
        Method context = class_getInstanceMethod([NSOpenGLContext class], @selector(initWithFormat:shareContext:));
        Method view = class_getInstanceMethod([NSOpenGLContext class], @selector(setView:));
        Method preference = class_getInstanceMethod([NSView class], @selector(setWantsBestResolutionOpenGLSurface:));
        Method to = class_getInstanceMethod([NSView class], @selector(convertRectToBacking:));
        Method from = class_getInstanceMethod([NSView class], @selector(convertRectFromBacking:));
        if (context && view && preference && to && from) {
            originalContextInitializer = (ContextInitializer)method_getImplementation(context);
            originalContextViewSetter = (ContextViewSetter)method_getImplementation(view);
            originalSurfacePreferenceSetter = (SurfacePreferenceSetter)method_getImplementation(preference);
            originalToBacking = (RectConverter)method_getImplementation(to);
            originalFromBacking = (RectConverter)method_getImplementation(from);
            method_setImplementation(context, (IMP)initializeContext);
            method_setImplementation(view, (IMP)setContextView);
            method_setImplementation(preference, (IMP)setSurfacePreference);
            method_setImplementation(to, (IMP)convertToBacking);
            method_setImplementation(from, (IMP)convertFromBacking);
            legacyLogicalRequested = YES;
        }
    }
    fprintf(stderr, "[MacLauncher OpenGL v5] process-local software fallback enabled; legacy coordinates %s\n",
            legacyLogicalRequested ? "eligible" : "unchanged");
}
@end
