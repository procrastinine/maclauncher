#import <AppKit/AppKit.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static NSBitmapImageRep *bitmap(void) {
    return [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:256 pixelsHigh:256
        bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSCalibratedRGBColorSpace
        bytesPerRow:0 bitsPerPixel:0];
}
static NSBitmapImageRep *render(NSImage *image) {
    NSBitmapImageRep *result = bitmap();
    [NSGraphicsContext saveGraphicsState];
    NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithBitmapImageRep:result];
    [image drawInRect:NSMakeRect(0, 0, 256, 256) fromRect:NSZeroRect operation:NSCompositingOperationCopy fraction:1];
    [NSGraphicsContext restoreGraphicsState];
    return result;
}
int main(int argc, const char **argv) { @autoreleasepool {
    if (argc < 3) return 2;
    NSString *file = [NSString stringWithUTF8String:argv[2]];
    if (strcmp(argv[1], "create") == 0) {
        NSBitmapImageRep *rep = bitmap();
        for (int y = 0; y < 256; ++y) for (int x = 0; x < 256; ++x) {
            NSUInteger color[] = { x < 128 ? 240 : 40, y < 128 ? 200 : 20, 80,
                ((x < 20 || x > 235) && (y < 20 || y > 235)) ? 0 : 255 };
            [rep setPixel:color atX:x y:y];
        }
        return [[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:file atomically:YES] ? 0 : 3;
    }
    BOOL application = strcmp(argv[1], "application") == 0;
    NSImage *actual;
    if (application) {
        if (argc != 6) return 2;
        [NSApplication sharedApplication];
        [NSApp finishLaunching];
        NSString *title = [NSString stringWithUTF8String:argv[3]], *identifier = [NSString stringWithUTF8String:argv[4]];
        NSRunningApplication *running = NSRunningApplication.currentApplication;
        if (![running.localizedName isEqualToString:title] || ![NSProcessInfo.processInfo.processName isEqualToString:title] ||
            ![running.bundleIdentifier isEqualToString:identifier] || ![NSBundle.mainBundle.bundleIdentifier isEqualToString:identifier] ||
            NSApp.activationPolicy != NSApplicationActivationPolicyRegular ||
            [NSBundle.mainBundle.infoDictionary[@"LSUIElement"] boolValue] ||
            getpid() == atoi(argv[5]) || getppid() != atoi(argv[5])) return 6;
        actual = NSApp.applicationIconImage;
        printf("PASS standalone application name, executable, Dock policy and separate process identity\n");
    } else {
        if (argc != 4) return 2;
        actual = [[NSWorkspace sharedWorkspace] iconForFile:[NSString stringWithUTF8String:argv[3]]];
    }
    NSImage *source = [[NSImage alloc] initWithContentsOfFile:file];
    if (!source || !actual) return 4;
    NSBitmapImageRep *expectedPixels = render(source), *actualPixels = render(actual);
    double error = 0;
    for (int y = 0; y < 256; ++y) for (int x = 0; x < 256; ++x) {
        NSUInteger expected[4], value[4];
        [expectedPixels getPixel:expected atX:x y:y]; [actualPixels getPixel:value atX:x y:y];
        for (int channel = 0; channel < 4; ++channel)
            if (channel == 3 || expected[3] != 0) error += fabs((double)expected[channel] - (double)value[channel]);
    }
    error /= 256 * 256 * 4;
    printf("IconServices mean pixel difference: %.6f\n", error);
    return error < 1 ? 0 : 5;
}}
