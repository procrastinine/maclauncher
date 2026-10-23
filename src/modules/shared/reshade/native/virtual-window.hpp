#pragma once
#import <Cocoa/Cocoa.h>
namespace macfx {
struct VirtualPresentationTarget {
    NSView *view = nil;
    CGSize outputPixels = CGSizeZero;
    bool active = false;
};
// Main-thread AppKit integration. The source retains its renderer/responder.
// Only an explicit virtual control with a real source-size request activates it.
bool virtualWindowEnabled() noexcept;
// Uses the existing selected-window metadata tick. Initial Off creates no
// reader, timer, controller, output or GPU resource.
void pollVirtualSourceControl(bool imageProcessingRequested);
// OpenGL declares its resolution convention. Metal instead supplies its real
// allocation; its pixel density is independent of the view's OpenGL flag.
enum class VirtualPublisherPixelSpace { Backing, Points };
void setVirtualPublisherPixelSpace(NSView *, VirtualPublisherPixelSpace);
void setVirtualPublisherPixelSpace(NSView *, VirtualPublisherPixelSpace, const void *publisher);
void setVirtualPublisherExtent(NSView *, const void *publisher, CGSize pixels);
// Main-thread identity of the measured publisher, without retaining it. A
// missing identity cannot prove that a non-proxy completed receipt is reusable.
const void *virtualPublisherIdentity(NSView *) noexcept;
bool virtualPresentationRequired(NSView *) noexcept;
// Main-thread, no-allocation query. A normal minimize transition pauses an
// owned source/output pair without retiring its renderer or virtual session.
bool virtualWindowSuspended(NSWindow *) noexcept;
VirtualPresentationTarget virtualPresentationSource(NSView *, CGSize sourcePixels = CGSizeZero);
CGSize virtualOutputSize(NSView *);
bool isVirtualOutputWindow(NSWindow *) noexcept;
void revealVirtualWindow(NSView *);
bool virtualWindowPrepared(NSView *) noexcept;
bool virtualWindowTransitioning(NSView *) noexcept;
// Called only after an actual positive display receipt for this target.
bool commitVirtualWindow(NSView *, NSView *expectedTarget);
void failVirtualWindowPreparation(NSView *, NSView *expectedTarget);
// A retiring presenter may remove only the session attached to its own target.
void stopVirtualWindow(NSView *);
void stopVirtualWindow(NSView *, NSView *expectedTarget);
// Render-thread demand query uses only the source object's address.
bool virtualSourceFramePending(const void *source) noexcept;
// Main thread, after successful GPU completion. Layout alone does not
// acknowledge a live allocation: the producer must deliver its actual extent.
void virtualSourceFrameReady(NSView *, NSView *expectedTarget, CGSize sourcePixels);
void virtualSourceFrameReady(NSView *, NSView *expectedTarget, CGSize sourcePixels, const void *expectedPublisher);
void toggleVirtualFullscreen(NSView *);
// Same geometry as the black host's aspect-fitted presentation child. Points
// outside the image are rejected. These helpers do not poll or warp the cursor.
bool virtualMapScreenPoint(NSView *, NSPoint outputScreenPoint, NSPoint *sourceScreenPoint);
bool virtualUnmapScreenPoint(NSView *, NSPoint sourceScreenPoint, NSPoint *outputScreenPoint);
// Thread-safe snapshots used by local polling/warp hooks. Relative deltas are
// unchanged. Outside the owned image/active source these return the input.
NSPoint virtualMappedPollingPoint(NSPoint);
NSPoint virtualMappedWindowPollingPoint(NSWindow *, NSPoint);
CGPoint virtualMappedWarpPoint(CGPoint);
// Returns a distinct source-window event for rendered content, the original
// event for a fresh native chrome/resize gesture, or nil for letterbox content.
// A down delivered to the source retains its matching drag/up outside the image
// with clamped coordinates. Relative deltas and standard event fields survive.
NSEvent *virtualMappedEvent(NSView *, NSEvent *);
}
