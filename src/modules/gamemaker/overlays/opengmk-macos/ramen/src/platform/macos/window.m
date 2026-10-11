// MacLauncher-owned AppKit backend for the pinned ramen window library.
// All AppKit access runs on the process main thread; event queues are bounded.
#import <AppKit/AppKit.h>
#include <dispatch/dispatch.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

typedef struct { uint32_t kind; int32_t a, b; } MLRamenEvent;
typedef struct MLRamenWindow MLRamenWindow;
@class MLRamenView, MLRamenDelegate;
struct MLRamenWindow {
    NSWindow *window;
    MLRamenView *view;
    MLRamenDelegate *delegate;
    MLRamenWindow *next;
    MLRamenEvent events[4096];
    size_t head, count;
    BOOL keys[128], buttons[3], maximised, borderless, resizable;
    uint32_t controls, cursor;
    double scroll;
};
static MLRamenWindow *windows = NULL;

static void emit(MLRamenWindow *state, uint32_t kind, int32_t a, int32_t b) {
    if (!state) return;
    // Motion/geometry floods need only their latest consecutive value.
    size_t last = (state->head + state->count + 4095) % 4096;
    if (state->count && (kind == 5 || kind == 6 || kind == 14) && state->events[last].kind == kind) {
        state->events[last] = (MLRamenEvent){kind, a, b}; return;
    }
    if (state->count == 4096) {
        state->head = (state->head + 1) % 4096; state->count -= 1;
    }
    state->events[(state->head + state->count) % 4096] = (MLRamenEvent){kind, a, b}; state->count += 1;
}
static double desktopTop(void) { return NSMaxY([[[NSScreen screens] firstObject] frame]); }
static int32_t coordinate(double value) { return (int32_t)fmax(INT16_MIN, fmin(INT16_MAX, round(value))); }
static int32_t dimension(double value) { return (int32_t)fmax(0, fmin(UINT16_MAX, round(value))); }
static void geometry(MLRamenWindow *state, BOOL resized) {
    NSRect content = [state->window contentRectForFrameRect:state->window.frame];
    if (resized) {
        emit(state, 6, dimension(content.size.width), dimension(content.size.height));
        BOOL zoomed = state->window.zoomed;
        if (zoomed != state->maximised) { state->maximised = zoomed; emit(state, 3, zoomed, 0); }
    } else emit(state, 5, coordinate(content.origin.x), coordinate(desktopTop() - NSMaxY(content)));
}
static void releaseInputs(MLRamenWindow *state) {
    if (!state) return;
    for (int key = 0; key < 128; key++) if (state->keys[key]) { state->keys[key] = NO; emit(state, 10, key, 0); }
    for (int button = 0; button < 3; button++) if (state->buttons[button]) { state->buttons[button] = NO; emit(state, 13, button, 0); }
}
static NSCursor *cursorFor(uint32_t cursor) {
    switch (cursor) {
        case 1: {
            static NSCursor *blank;
            if (!blank) {
                NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:1 pixelsHigh:1
                    bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:4 bitsPerPixel:32];
                memset(rep.bitmapData, 0, 4);
                NSImage *image = [[NSImage alloc] initWithSize:NSMakeSize(1, 1)]; [image addRepresentation:rep];
                blank = [[NSCursor alloc] initWithImage:image hotSpot:NSZeroPoint]; [image release]; [rep release];
            }
            return blank;
        }
        case 2: return NSCursor.crosshairCursor;
        case 3: case 4: return NSCursor.pointingHandCursor;
        case 5: return NSCursor.IBeamCursor;
        case 7: case 9: return NSCursor.crosshairCursor;
        case 8: return NSCursor.resizeUpDownCursor;
        case 10: return NSCursor.resizeLeftRightCursor;
        case 11: return NSCursor.openHandCursor;
        case 12: return NSCursor.operationNotAllowedCursor;
        default: return NSCursor.arrowCursor;
    }
}

@interface MLRamenDelegate : NSObject <NSWindowDelegate> { @public MLRamenWindow *state; }
@end
@implementation MLRamenDelegate
- (BOOL)windowShouldClose:(NSWindow *)sender { (void)sender; emit(state, 1, 0, 0); return NO; }
- (void)windowDidBecomeKey:(NSNotification *)note { (void)note; emit(state, 2, 1, 0); }
- (void)windowDidResignKey:(NSNotification *)note { (void)note; releaseInputs(state); emit(state, 2, 0, 0); }
- (void)windowDidMove:(NSNotification *)note { (void)note; if (state) geometry(state, NO); }
- (void)windowDidResize:(NSNotification *)note { (void)note; if (state) geometry(state, YES); }
- (void)windowDidMiniaturize:(NSNotification *)note { (void)note; emit(state, 4, 1, 0); }
- (void)windowDidDeminiaturize:(NSNotification *)note { (void)note; emit(state, 4, 0, 0); }
@end

@interface MLRamenView : NSOpenGLView <NSTextInputClient> {
@public MLRamenWindow *state;
@private NSTrackingArea *tracking; NSAttributedString *marked;
}
@end
@implementation MLRamenView
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { (void)event; return YES; }
- (BOOL)isOpaque { return YES; }
- (void)dealloc { [tracking release]; [marked release]; [super dealloc]; }
- (void)updateTrackingAreas {
    if (tracking) { [self removeTrackingArea:tracking]; [tracking release]; }
    tracking = [[NSTrackingArea alloc] initWithRect:NSZeroRect options:NSTrackingMouseEnteredAndExited | NSTrackingMouseMoved | NSTrackingActiveInKeyWindow | NSTrackingInVisibleRect owner:self userInfo:nil];
    [self addTrackingArea:tracking]; [super updateTrackingAreas];
}
- (void)resetCursorRects { if (state) [self addCursorRect:self.bounds cursor:cursorFor(state->cursor)]; }
- (void)keyDown:(NSEvent *)event {
    if (!state) return;
    unsigned key = event.keyCode;
    if (key < 128) { state->keys[key] = YES; emit(state, event.isARepeat ? 9 : 8, key, 0); }
    [self interpretKeyEvents:@[event]];
}
- (void)keyUp:(NSEvent *)event {
    unsigned key = event.keyCode; if (state && key < 128) { state->keys[key] = NO; emit(state, 10, key, 0); }
}
- (void)flagsChanged:(NSEvent *)event {
    if (!state || event.keyCode >= 128) return;
    NSEventModifierFlags flag = 0;
    switch (event.keyCode) {
        case 54: case 55: flag = NSEventModifierFlagCommand; break;
        case 56: case 60: flag = NSEventModifierFlagShift; break;
        case 58: case 61: flag = NSEventModifierFlagOption; break;
        case 59: case 62: flag = NSEventModifierFlagControl; break;
        case 57: flag = NSEventModifierFlagCapsLock; break;
        default: return;
    }
    // Joint modifier flags cover either side; the changed key identifies which
    // side toggled even while its counterpart remains held.
    BOOL down = (event.modifierFlags & flag) && (event.keyCode == 57 || !state->keys[event.keyCode]);
    if (down != state->keys[event.keyCode]) { state->keys[event.keyCode] = down; emit(state, down ? 8 : 10, event.keyCode, 0); }
}
- (void)mousePosition:(NSEvent *)event {
    if (!state) return;
    NSPoint position = [self convertPoint:event.locationInWindow fromView:nil];
    emit(state, 14, dimension(position.x), dimension(self.bounds.size.height - position.y));
}
- (void)mouseMoved:(NSEvent *)event { [self mousePosition:event]; }
- (void)mouseDragged:(NSEvent *)event { [self mousePosition:event]; }
- (void)rightMouseDragged:(NSEvent *)event { [self mousePosition:event]; }
- (void)otherMouseDragged:(NSEvent *)event { [self mousePosition:event]; }
- (void)mouseEntered:(NSEvent *)event { [self mousePosition:event]; emit(state, 17, 0, 0); }
- (void)mouseExited:(NSEvent *)event { (void)event; emit(state, 18, 0, 0); }
- (void)mouseButton:(NSEvent *)event down:(BOOL)down {
    if (!state) return;
    [self mousePosition:event]; NSInteger button = event.buttonNumber;
    if (button >= 0 && button < 3) { state->buttons[button] = down; emit(state, down ? 12 : 13, (int32_t)button, 0); }
}
- (void)mouseDown:(NSEvent *)event { [self mouseButton:event down:YES]; }
- (void)mouseUp:(NSEvent *)event { [self mouseButton:event down:NO]; }
- (void)rightMouseDown:(NSEvent *)event { [self mouseButton:event down:YES]; }
- (void)rightMouseUp:(NSEvent *)event { [self mouseButton:event down:NO]; }
- (void)otherMouseDown:(NSEvent *)event { [self mouseButton:event down:YES]; }
- (void)otherMouseUp:(NSEvent *)event { [self mouseButton:event down:NO]; }
- (void)scrollWheel:(NSEvent *)event {
    if (!state) return;
    state->scroll += event.scrollingDeltaY;
    int steps = (int)fmax(-32, fmin(32, trunc(state->scroll))); state->scroll -= steps;
    for (int i = 0; i < abs(steps); i++) emit(state, steps > 0 ? 15 : 16, 0, 0);
}
- (void)insertText:(id)value replacementRange:(NSRange)range {
    (void)range; [self unmarkText];
    NSString *text = [value isKindOfClass:NSAttributedString.class] ? [value string] : value;
    for (NSUInteger i = 0; i < text.length; i++) {
        uint32_t scalar = [text characterAtIndex:i];
        if (scalar >= 0xd800 && scalar <= 0xdbff && i + 1 < text.length) {
            uint32_t low = [text characterAtIndex:i + 1];
            if (low >= 0xdc00 && low <= 0xdfff) { scalar = 0x10000 + ((scalar - 0xd800) << 10) + (low - 0xdc00); i++; }
        }
        if (!(scalar >= 0xd800 && scalar <= 0xdfff) && !(scalar >= 0xf700 && scalar <= 0xf8ff)) emit(state, 11, scalar, 0);
    }
}
- (void)setMarkedText:(id)value selectedRange:(NSRange)selected replacementRange:(NSRange)replacement {
    (void)selected; (void)replacement; [marked release];
    marked = [value isKindOfClass:NSAttributedString.class] ? [value copy] : [[NSAttributedString alloc] initWithString:value];
}
- (void)unmarkText { [marked release]; marked = nil; }
- (BOOL)hasMarkedText { return marked.length != 0; }
- (NSRange)markedRange { return marked ? NSMakeRange(0, marked.length) : NSMakeRange(NSNotFound, 0); }
- (NSRange)selectedRange { return NSMakeRange(NSNotFound, 0); }
- (NSArray<NSAttributedStringKey> *)validAttributesForMarkedText { return @[]; }
- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actual {
    (void)range; if (actual) *actual = NSMakeRange(NSNotFound, 0); return nil;
}
- (NSUInteger)characterIndexForPoint:(NSPoint)point { (void)point; return NSNotFound; }
- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actual {
    if (actual) *actual = range;
    return [self.window convertRectToScreen:[self convertRect:NSMakeRect(0, 0, 1, 16) toView:nil]];
}
- (void)doCommandBySelector:(SEL)selector { (void)selector; }
@end

@interface MLRamenApplicationDelegate : NSObject <NSApplicationDelegate>
@end
@implementation MLRamenApplicationDelegate
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    (void)sender; for (MLRamenWindow *state = windows; state; state = state->next) emit(state, 1, 0, 0);
    return NSTerminateCancel;
}
- (void)quitGame:(id)sender { (void)sender; [NSApp terminate:nil]; }
@end

int32_t ml_ramen_is_main_thread(void) { return pthread_main_np() != 0; }
int32_t ml_ramen_initialize(void) {
    if (!pthread_main_np()) return 0;
    @autoreleasepool {
        @try {
            static MLRamenApplicationDelegate *delegate;
            [NSApplication sharedApplication];
            if (!delegate) {
                delegate = [MLRamenApplicationDelegate new]; [NSApp setDelegate:delegate];
                [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
                NSMenu *bar = [NSMenu new], *application = [NSMenu new];
                NSMenuItem *item = [NSMenuItem new]; [item setSubmenu:application]; [bar addItem:item];
                NSMenuItem *quit = [[NSMenuItem alloc] initWithTitle:@"Quit OpenGMK" action:@selector(quitGame:) keyEquivalent:@"q"];
                [quit setTarget:delegate]; [application addItem:quit]; [NSApp setMainMenu:bar];
                [quit release]; [item release]; [application release]; [bar release];
                [NSApp finishLaunching];
            }
            return 1;
        } @catch (NSException *exception) { (void)exception; return 0; }
    }
}

static void applyStyle(MLRamenWindow *state) {
    NSRect content = [state->window contentRectForFrameRect:state->window.frame];
    NSWindowStyleMask style = state->borderless ? NSWindowStyleMaskBorderless : NSWindowStyleMaskTitled;
    if (!state->borderless) {
        if (state->controls & 1) style |= NSWindowStyleMaskClosable;
        if (state->controls & 2) style |= NSWindowStyleMaskMiniaturizable;
        if (state->resizable) style |= NSWindowStyleMaskResizable;
    }
    [state->window setStyleMask:style];
    [state->window setFrame:[state->window frameRectForContentRect:content] display:YES];
    [[state->window standardWindowButton:NSWindowZoomButton] setHidden:!(state->controls & 4)];
    [[state->window standardWindowButton:NSWindowZoomButton] setEnabled:state->resizable && (state->controls & 4)];
}

void *ml_ramen_window_create(const char *title, uint32_t width, uint32_t height, int32_t x, int32_t y,
    int32_t positioned, int32_t borderless, int32_t resizable, int32_t visible, int32_t maximised, uint32_t controls, uint32_t cursor) {
    if (!pthread_main_np()) return NULL;
    @autoreleasepool {
        MLRamenWindow *state = calloc(1, sizeof(*state)); if (!state) return NULL;
        state->borderless = borderless; state->resizable = resizable; state->controls = controls; state->cursor = cursor;
        state->window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, fmax(1, width), fmax(1, height))
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        [state->window setReleasedWhenClosed:NO]; [state->window setAcceptsMouseMovedEvents:YES];
        state->delegate = [MLRamenDelegate new]; state->delegate->state = state; [state->window setDelegate:state->delegate];
        state->view = [[MLRamenView alloc] initWithFrame:NSMakeRect(0, 0, fmax(1, width), fmax(1, height)) pixelFormat:nil];
        state->view->state = state;
        // GM8's logical window/input dimensions use one pixel per AppKit point.
        [state->view setWantsBestResolutionOpenGLSurface:NO];
        [state->window setContentView:state->view]; [state->window makeFirstResponder:state->view];
        [state->window setTitle:[NSString stringWithUTF8String:title] ?: @"OpenGMK"]; applyStyle(state);
        if (positioned) {
            NSRect content = [state->window contentRectForFrameRect:state->window.frame];
            content.origin = NSMakePoint(x, desktopTop() - y - content.size.height);
            [state->window setFrame:[state->window frameRectForContentRect:content] display:NO];
        } else [state->window center];
        state->next = windows; windows = state;
        if (visible) { [state->window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES]; emit(state, 7, 1, 0); }
        if (maximised && resizable) [state->window zoom:nil];
        [state->window invalidateCursorRectsForView:state->view];
        return state;
    }
}
static void destroyOnMain(void *pointer) {
    @autoreleasepool {
        MLRamenWindow *state = pointer, **link = &windows;
        while (*link && *link != state) link = &(*link)->next;
        if (*link == state) *link = state->next;
        state->delegate->state = NULL; state->view->state = NULL;
        [state->window setDelegate:nil]; [state->window orderOut:nil]; [state->window close];
        [state->view release]; [state->delegate release]; [state->window release]; free(state);
    }
}
void ml_ramen_window_destroy(void *state) {
    if (pthread_main_np()) destroyOnMain(state);
    else dispatch_async_f(dispatch_get_main_queue(), state, destroyOnMain);
}
void ml_ramen_pump_events(void) {
    if (!pthread_main_np()) return;
    @autoreleasepool {
        for (size_t count = 0; count < 4096; count++) {
            NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:NSDate.distantPast inMode:NSDefaultRunLoopMode dequeue:YES];
            if (!event) break;
            [NSApp sendEvent:event];
        }
        [NSApp updateWindows];
    }
}
int32_t ml_ramen_window_next_event(void *pointer, MLRamenEvent *event) {
    MLRamenWindow *state = pointer; if (!state->count) return 0;
    *event = state->events[state->head]; state->head = (state->head + 1) % 4096; state->count -= 1;
    return 1;
}
void ml_ramen_window_set_cursor(void *pointer, uint32_t cursor) {
    @autoreleasepool {
        MLRamenWindow *state = pointer; state->cursor = cursor; [state->window invalidateCursorRectsForView:state->view];
        if (state->window.keyWindow) [cursorFor(cursor) set];
    }
}
void ml_ramen_window_set_borderless(void *pointer, int32_t value) {
    @autoreleasepool { MLRamenWindow *state = pointer; state->borderless = value; applyStyle(state); }
}
void ml_ramen_window_set_resizable(void *pointer, int32_t value) {
    @autoreleasepool { MLRamenWindow *state = pointer; state->resizable = value; applyStyle(state); }
}
void ml_ramen_window_set_maximised(void *pointer, int32_t value) {
    @autoreleasepool { MLRamenWindow *state = pointer; if (state->window.zoomed != (BOOL)value) [state->window zoom:nil]; }
}
void ml_ramen_window_set_position(void *pointer, int32_t x, int32_t y) {
    @autoreleasepool {
        MLRamenWindow *state = pointer; NSRect content = [state->window contentRectForFrameRect:state->window.frame];
        content.origin = NSMakePoint(x, desktopTop() - y - content.size.height);
        [state->window setFrame:[state->window frameRectForContentRect:content] display:YES];
    }
}
void ml_ramen_window_set_size(void *pointer, uint32_t width, uint32_t height) {
    @autoreleasepool {
        MLRamenWindow *state = pointer;
        NSRect before = state->window.frame;
        [state->window setContentSize:NSMakeSize(fmax(1, width), fmax(1, height))];
        NSRect after = state->window.frame;
        // Creator code can apply a new scale after the first room has loaded.
        // Keep the existing visual center rather than growing off the right edge.
        after.origin = NSMakePoint(NSMidX(before) - after.size.width / 2,
            NSMidY(before) - after.size.height / 2);
        after = [state->window constrainFrameRect:after toScreen:state->window.screen ?: NSScreen.mainScreen];
        [state->window setFrame:after display:YES];
    }
}
void ml_ramen_window_set_title(void *pointer, const char *title) {
    MLRamenWindow *state = pointer; @autoreleasepool { [state->window setTitle:[NSString stringWithUTF8String:title] ?: @""]; }
}
void ml_ramen_window_set_visible(void *pointer, int32_t visible) {
    @autoreleasepool {
        MLRamenWindow *state = pointer;
        if (state->window.visible != (BOOL)visible) {
            if (visible) { [state->window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES]; }
            else [state->window orderOut:nil];
            emit(state, 7, visible != 0, 0);
        }
    }
}
void *ml_ramen_window_nsview(void *pointer) { return ((MLRamenWindow *)pointer)->view; }
void *ml_ramen_window_nswindow(void *pointer) { return ((MLRamenWindow *)pointer)->window; }
