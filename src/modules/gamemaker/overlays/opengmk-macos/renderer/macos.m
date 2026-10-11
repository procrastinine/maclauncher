#import <AppKit/AppKit.h>
#import <OpenGL/gl3.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct {
    NSOpenGLContext *context;
    NSView *view;
} MLGM8OpenGL;

void *ml_gm8_gl_create(void *nativeView, char *error, size_t capacity) {
    if (capacity) error[0] = 0;
    if (!pthread_main_np() || !nativeView) {
        snprintf(error, capacity, "OpenGMK requires a native content view on the macOS main thread");
        return NULL;
    }
    @autoreleasepool {
        // Do not require a hardware-only format: virtualized Macs may expose
        // a valid core context through Apple's fallback renderer.
        NSOpenGLPixelFormatAttribute attributes[] = {
            NSOpenGLPFAOpenGLProfile, NSOpenGLProfileVersion4_1Core,
            NSOpenGLPFADoubleBuffer, NSOpenGLPFAColorSize, 24,
            NSOpenGLPFAAlphaSize, 8, NSOpenGLPFADepthSize, 24,
            NSOpenGLPFAStencilSize, 8, 0
        };
        NSOpenGLPixelFormat *format = [[NSOpenGLPixelFormat alloc] initWithAttributes:attributes];
        if (!format) {
            snprintf(error, capacity, "macOS could not create the OpenGL core profile required by OpenGMK");
            return NULL;
        }
        // A view initialized before the renderer exists starts with AppKit's
        // default legacy format. Keep its format and context consistent so
        // AppKit does not attach a legacy drawable to our core-profile context.
        if ([(NSView *)nativeView isKindOfClass:[NSOpenGLView class]]) {
            [(NSOpenGLView *)nativeView setPixelFormat:format];
        }
        NSOpenGLContext *context = [[NSOpenGLContext alloc] initWithFormat:format shareContext:nil];
        [format release];
        if (!context) {
            snprintf(error, capacity, "macOS could not create OpenGMK's OpenGL context");
            return NULL;
        }
        MLGM8OpenGL *result = calloc(1, sizeof(*result));
        if (!result) { [context release]; snprintf(error, capacity, "OpenGL context allocation failed"); return NULL; }
        result->context = context;
        result->view = [(NSView *)nativeView retain];
        // AppKit's OpenGL view owns the onscreen drawable. Attaching a context
        // only to a plain view can render a valid framebuffer that the window
        // compositor never presents on newer macOS versions.
        if ([result->view isKindOfClass:[NSOpenGLView class]]) {
            [(NSOpenGLView *)result->view setOpenGLContext:context];
        }
        [result->view setWantsBestResolutionOpenGLSurface:NO];
        [context setView:result->view];
        [context makeCurrentContext];
        [context update];
        return result;
    }
}

void ml_gm8_gl_destroy(void *opaque) {
    MLGM8OpenGL *state = opaque;
    if (!state) return;
    // Windows and contexts belong to the emulator's main loop.
    @autoreleasepool {
        if ([NSOpenGLContext currentContext] == state->context) [NSOpenGLContext clearCurrentContext];
        [state->context clearDrawable];
        [state->context release];
        [state->view release];
        free(state);
    }
}

void ml_gm8_gl_present(void *opaque) {
    MLGM8OpenGL *state = opaque;
    // Updating the drawable after the renderer has blitted the back buffer can
    // replace that buffer before it reaches the compositor. NSOpenGLView's
    // reshape handling updates the drawable when the view actually changes.
    @autoreleasepool {
        // Upstream restores its offscreen render target before swapping. Apple's
        // software renderer presents only while the window framebuffer is bound.
        // Preserve the game render target around this platform-specific swap.
        GLint drawFramebuffer = 0;
        glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &drawFramebuffer);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
        [state->context flushBuffer];
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)drawFramebuffer);
    }
}

void ml_gm8_gl_set_interval(void *opaque, unsigned interval) {
    MLGM8OpenGL *state = opaque;
    GLint value = interval ? 1 : 0;
    [state->context setValues:&value forParameter:NSOpenGLContextParameterSwapInterval];
}

unsigned ml_gm8_gl_get_interval(void *opaque) {
    MLGM8OpenGL *state = opaque;
    GLint value = 0;
    [state->context getValues:&value forParameter:NSOpenGLContextParameterSwapInterval];
    return value > 0 ? 1 : 0;
}

void ml_gm8_display_size(void *nativeWindow, int32_t *width, int32_t *height) {
    NSWindow *window = nativeWindow;
    NSScreen *screen = window.screen ?: NSScreen.mainScreen;
    *width = (int32_t)screen.frame.size.width;
    *height = (int32_t)screen.frame.size.height;
}

void ml_gm8_window_position(void *nativeWindow, int32_t *x, int32_t *y) {
    NSWindow *window = nativeWindow;
    NSRect content = [window contentRectForFrameRect:window.frame];
    *x = (int32_t)content.origin.x;
    *y = (int32_t)(NSMaxY(NSScreen.screens.firstObject.frame) - NSMaxY(content));
}

void ml_gm8_window_set_position(void *nativeWindow, int32_t x, int32_t y) {
    NSWindow *window = nativeWindow;
    NSRect content = [window contentRectForFrameRect:window.frame];
    content.origin = NSMakePoint(x, NSMaxY(NSScreen.screens.firstObject.frame) - y - content.size.height);
    NSRect frame = [window frameRectForContentRect:content];
    // AppKit keeps the native title controls available when a creator requests
    // coordinates whose border would extend under the menu bar.
    frame = [window constrainFrameRect:frame toScreen:window.screen ?: NSScreen.mainScreen];
    [window setFrame:frame display:YES];
}

void ml_gm8_window_center(void *nativeWindow, int32_t *x, int32_t *y) {
    NSWindow *window = nativeWindow;
    [window center];
    // Keep a tall GM8 window's title controls available on small Mac displays.
    NSScreen *screen = window.screen ?: NSScreen.mainScreen;
    NSRect frame = window.frame;
    if (NSMaxY(frame) > NSMaxY(screen.visibleFrame)) {
        frame.origin.y = NSMaxY(screen.visibleFrame) - frame.size.height;
        [window setFrame:frame display:YES];
    }
    ml_gm8_window_position(nativeWindow, x, y);
}
