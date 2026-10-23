// MacLauncher MKXP-Z display identity helper, MIT.
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <ImageIO/ImageIO.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static NSString *game_icon_path;
static id game_icon_observer;
static BOOL configured;

static NSData *read_icon(void) {
  const char *file = game_icon_path.fileSystemRepresentation;
  char canonical[PATH_MAX];
  if (!file || !realpath(file, canonical) || strcmp(file, canonical)) return nil;
  int fd = open(file, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return nil;
  @try {
    struct stat before, after;
    if (fstat(fd, &before) || !S_ISREG(before.st_mode) || before.st_size <= 0 || before.st_size > 8 * 1024 * 1024) return nil;
    NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)before.st_size];
    size_t offset = 0;
    while (offset < data.length) {
      ssize_t count = read(fd, (char *)data.mutableBytes + offset, data.length - offset);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) return nil;
      offset += (size_t)count;
    }
    if (fstat(fd, &after) || before.st_dev != after.st_dev || before.st_ino != after.st_ino || before.st_size != after.st_size ||
        before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec || before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec ||
        before.st_ctimespec.tv_sec != after.st_ctimespec.tv_sec || before.st_ctimespec.tv_nsec != after.st_ctimespec.tv_nsec) return nil;
    return data;
  } @finally { close(fd); }
}

static void apply_icon(void) {
  @try {
    NSData *data = read_icon();
    if (!data || !NSApp) return;
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
    if (!source) return;
    NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
    double width = [properties[(id)kCGImagePropertyPixelWidth] doubleValue];
    double height = [properties[(id)kCGImagePropertyPixelHeight] doubleValue];
    if (!(width > 0 && height > 0 && width <= 4096 && height <= 4096)) { CFRelease(source); return; }
    // Decode one small representation; compressed source dimensions do not
    // determine the amount of image memory retained by the application icon.
    NSDictionary *options = @{(id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
      (id)kCGImageSourceThumbnailMaxPixelSize: @512, (id)kCGImageSourceCreateThumbnailWithTransform: @YES};
    CGImageRef bitmap = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)options);
    CFRelease(source);
    if (!bitmap) return;
    NSImage *image = [[NSImage alloc] initWithCGImage:bitmap size:NSZeroSize];
    CGImageRelease(bitmap);
    if (image) [NSApp setApplicationIconImage:image];
  } @catch (NSException *exception) { (void)exception; }
}

void mkxpz_configure_display_identity(const char *name, const char *icon) {
  (void)name; // Native application metadata supplies the game name.
  if (configured) return;
  configured = YES;
  @autoreleasepool {
    @try {
      if (icon && *icon && strnlen(icon, PATH_MAX) < PATH_MAX) game_icon_path = [[NSString alloc] initWithUTF8String:icon];
      if (game_icon_path.isAbsolutePath) {
        if (NSApp && NSRunningApplication.currentApplication.finishedLaunching) apply_icon();
        else game_icon_observer = [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidFinishLaunchingNotification
          object:nil queue:nil usingBlock:^(NSNotification *notification) {
            (void)notification;
            id observer = game_icon_observer; game_icon_observer = nil;
            if (observer) [NSNotificationCenter.defaultCenter removeObserver:observer];
            apply_icon();
          }];
      }
    } @catch (NSException *exception) {
      (void)exception;
      fputs("MacLauncher MKXP-Z display identity is unavailable; continuing with the runtime identity.\n", stderr);
    }
  }
}
