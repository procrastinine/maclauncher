#pragma once
#import <Cocoa/Cocoa.h>
#include <cstdint>
#include "browser-frame-policy.hpp"
namespace macfx {
// Enables only the completed-window fallback. Native full-frame ingress is
// preferred. A rejected tile or an authenticated registration probe can admit
// the fallback; neither metadata observation is a completed video frame.
bool browserFrameFallbackEnabled() noexcept;
void browserFrameNativeObservation(uint32_t window,bool fullExtent) noexcept;
// The mapped main-window demand is authoritative even when a sandboxed child
// cannot reopen a replaced live-controls file. This grants metadata only.
BrowserFrameDemand browserFrameDemand() noexcept;
bool browserFrameNativeProbe(uint32_t window,uint32_t epoch) noexcept;
bool browserFrameProcessingAllowed() noexcept;
bool browserFrameOwnsWindow(uint32_t window) noexcept;
bool isBrowserFrameOutputWindow(NSWindow *) noexcept;
// Main-thread selected original window. No capture/API/device is touched while
// image processing is off. Exact-window stream epochs reject late callbacks.
void pollBrowserFrameFallback(NSWindow *selected,bool processing);
}
extern "C" unsigned rsBrowserFrameAPI();
