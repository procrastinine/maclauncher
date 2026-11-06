#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <node_api.h>
#include <unistd.h>

// Loaded in Electron's main process: only the active NSApplication can yield.
static napi_value status(napi_env env, pid_t pid, BOOL activate) {
    @autoreleasepool {
        NSRunningApplication *target = pid > 0 ? [NSRunningApplication runningApplicationWithProcessIdentifier:pid] : nil;
        pid_t front = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
        BOOL active = NSApp && NSApp.isActive;
        CGWindowID window = 0;
        pid_t frontWindowPid = 0;
        NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
        for (NSDictionary *row in windows) {
            CGRect bounds;
            if ([row[(id)kCGWindowLayer] intValue] != 0 ||
                [row[(id)kCGWindowAlpha] doubleValue] <= 0 || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)row[(id)kCGWindowBounds], &bounds) ||
                bounds.size.width <= 1 || bounds.size.height <= 1) continue;
            pid_t owner = [row[(id)kCGWindowOwnerPID] intValue];
            if (!frontWindowPid) frontWindowPid = owner;
            if (owner == pid && !window) window = [row[(id)kCGWindowNumber] unsignedIntValue];
        }
        BOOL yielded = NO;
        if (activate && active && front == getpid() && target && !target.terminated && window) {
            if (@available(macOS 14.0, *)) {
                [NSApp yieldActivationToApplication:target];
                // Distributed notifications can arrive after Wine's activate.
                yielded = [target activateFromApplication:NSRunningApplication.currentApplication options:0];
            } else yielded = [target activateWithOptions:NSApplicationActivateIgnoringOtherApps];
        }
        napi_value result, value;
        napi_create_object(env, &result);
        napi_get_boolean(env, active, &value); napi_set_named_property(env, result, "active", value);
        napi_create_int32(env, front, &value); napi_set_named_property(env, result, "frontmostPid", value);
        napi_create_uint32(env, window, &value); napi_set_named_property(env, result, "windowId", value);
        napi_create_int32(env, frontWindowPid, &value); napi_set_named_property(env, result, "frontWindowPid", value);
        napi_get_boolean(env, yielded, &value); napi_set_named_property(env, result, "yielded", value);
        return result;
    }
}
static napi_value inspect(napi_env env, napi_callback_info info) {
    napi_value args[1]; size_t count = 1; int32_t pid = 0;
    napi_get_cb_info(env, info, &count, args, NULL, NULL);
    if (count) napi_get_value_int32(env, args[0], &pid);
    return status(env, pid, NO);
}
static napi_value yield(napi_env env, napi_callback_info info) {
    napi_value args[1]; size_t count = 1; int32_t pid = 0;
    napi_get_cb_info(env, info, &count, args, NULL, NULL);
    if (count) napi_get_value_int32(env, args[0], &pid);
    return status(env, pid, YES);
}
static napi_value init(napi_env env, napi_value exports) {
    napi_property_descriptor methods[] = {
        {"inspect", NULL, inspect, NULL, NULL, NULL, napi_default, NULL},
        {"yield", NULL, yield, NULL, NULL, NULL, napi_default, NULL}
    };
    napi_define_properties(env, exports, 2, methods);
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
