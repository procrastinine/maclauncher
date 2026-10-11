// Copyright (c) MacLauncher contributors. MIT; see the repository LICENSE.
// Independent software image viewport. No proprietary engine or game assets.
#import <AppKit/AppKit.h>
#import <ImageIO/ImageIO.h>
#import <CoreGraphics/CoreGraphics.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <math.h>
#include <stdatomic.h>
#include <stdbool.h>

#define VIEWPORT_VERSION "1.1.0-ml1"
#define MAX_LINE (1024 * 1024)
#define MAX_PIXELS (16 * 1024 * 1024)
#define MAX_IMAGE (64 * 1024 * 1024)
#define MAX_SCENE (256 * 1024 * 1024)
#define MAX_LAYERS 256

static NSString *cacheRoot;
static int cacheFD = -1;
static _Atomic(bool) closing = false;
static void emit(NSDictionary *event) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
  if (!json || json.length > 16384) return;
  @synchronized(NSFileHandle.class) { fwrite(json.bytes, 1, json.length, stdout); fputc('\n', stdout); fflush(stdout); }
}
static BOOL fail(NSString **error, NSString *message) { if (error) *error = message; return NO; }
static BOOL integer(id value, long long minimum, long long maximum) {
  if (![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return NO;
  double n = [value doubleValue]; return isfinite(n) && floor(n) == n && n >= minimum && n <= maximum;
}
static BOOL scalar(id value, double minimum, double maximum) {
  if (![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return NO;
  double n = [value doubleValue]; return isfinite(n) && n >= minimum && n <= maximum;
}
static BOOL safeText(id text, NSUInteger limit) {
  return [text isKindOfClass:NSString.class] && [text length] <= limit &&
    [text rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location == NSNotFound;
}
static NSArray<NSString *> *relativeParts(NSString *file) {
  if (!safeText(file, 4096) || !file.length) return nil;
  NSString *relative = file;
  if ([file hasPrefix:@"/"]) {
    NSString *prefix = [cacheRoot stringByAppendingString:@"/"];
    if (![file hasPrefix:prefix]) return nil;
    relative = [file substringFromIndex:prefix.length];
  }
  NSArray *parts = [relative componentsSeparatedByString:@"/"];
  for (NSString *part in parts) if (!part.length || [part isEqualToString:@"."] || [part isEqualToString:@".."] || [part containsString:@"\\"]) return nil;
  return parts;
}
static int openRoot(NSString *root) {
  if (![root hasPrefix:@"/"] || !safeText(root, 4096)) return -1;
  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  for (NSString *part in [[root substringFromIndex:1] componentsSeparatedByString:@"/"]) {
    if (!part.length || [part isEqualToString:@"."] || [part isEqualToString:@".."]) { close(current); return -1; }
    int next = openat(current, part.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(current); if (next < 0) return -1; current = next;
  }
  return current;
}
static int openMember(NSString *file, BOOL create) {
  NSArray *parts = relativeParts(file); if (!parts.count || cacheFD < 0) return -1;
  int current = dup(cacheFD);
  for (NSUInteger i = 0; i < parts.count; i++) {
    BOOL last = i + 1 == parts.count;
    int flags = last ? (create ? O_WRONLY | O_CREAT | O_EXCL : O_RDONLY) : O_RDONLY | O_DIRECTORY;
    int next = openat(current, [parts[i] fileSystemRepresentation], flags | O_NOFOLLOW | O_CLOEXEC, 0600);
    close(current); if (next < 0) return -1; current = next;
  }
  return current;
}
static BOOL sameStat(struct stat before, struct stat after) {
  return before.st_dev == after.st_dev && before.st_ino == after.st_ino && before.st_size == after.st_size &&
    before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec && before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec &&
    before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec && before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec;
}
static NSData *readMember(NSString *file, NSUInteger expected, BOOL exact, NSString **error) {
  int fd = openMember(file, NO); struct stat before, after;
  if (fd < 0 || fstat(fd, &before) || !S_ISREG(before.st_mode) || before.st_size < 1 || before.st_size > MAX_IMAGE ||
      (exact && before.st_size != (off_t)expected)) { if (fd >= 0) close(fd); fail(error, @"Invalid viewport cache image."); return nil; }
  NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)before.st_size]; NSUInteger at = 0;
  while (at < data.length) {
    ssize_t amount = read(fd, (uint8_t *)data.mutableBytes + at, data.length - at);
    if (amount < 0 && errno == EINTR) continue;
    if (amount <= 0) { close(fd); fail(error, @"Truncated viewport cache image."); return nil; }
    at += (NSUInteger)amount;
  }
  BOOL unchanged = fstat(fd, &after) == 0 && sameStat(before, after); close(fd);
  if (!unchanged) { fail(error, @"Viewport cache image changed during reading."); return nil; }
  return data;
}

@interface MLLayer : NSObject
@property NSString *identifier;
@property double x, y, opacity, z;
@property NSUInteger width, height, order;
@property BOOL visible;
@property NSImage *image;
@end
@implementation MLLayer @end

@interface MLScene : NSObject
@property long long sequence;
@property NSUInteger width, height;
@property NSString *title;
@property NSArray<MLLayer *> *layers;
@end
@implementation MLScene @end

static MLScene *sceneFromJSON(id json, NSString **error) {
  if (![json isKindOfClass:NSDictionary.class] || ![json[@"type"] isEqual:@"scene"] || !integer(json[@"sequence"], 0, 9007199254740991LL)) {
    fail(error, @"Invalid viewport scene message."); return nil;
  }
  id canvas = json[@"canvas"], layers = json[@"layers"];
  if (![canvas isKindOfClass:NSDictionary.class] || !integer(canvas[@"width"], 1, 16384) || !integer(canvas[@"height"], 1, 16384) ||
      [canvas[@"width"] unsignedLongLongValue] * [canvas[@"height"] unsignedLongLongValue] > MAX_PIXELS ||
      (canvas[@"title"] && !safeText(canvas[@"title"], 256)) || ![layers isKindOfClass:NSArray.class] || [layers count] > MAX_LAYERS) {
    fail(error, @"Viewport canvas or layer count exceeds its limit."); return nil;
  }
  MLScene *scene = [MLScene new]; scene.sequence = [json[@"sequence"] longLongValue];
  scene.width = [canvas[@"width"] unsignedIntegerValue]; scene.height = [canvas[@"height"] unsignedIntegerValue];
  scene.title = canvas[@"title"] ?: @"MacLauncher";
  NSMutableArray *result = [NSMutableArray array]; NSMutableSet *identifiers = [NSMutableSet set]; NSUInteger total = 0;
  for (id record in layers) {
    if (![record isKindOfClass:NSDictionary.class] || !safeText(record[@"id"], 128) || ![record[@"id"] length] || [identifiers containsObject:record[@"id"]] ||
        !integer(record[@"width"], 1, 16384) || !integer(record[@"height"], 1, 16384) ||
        !scalar(record[@"x"], -32768, 32768) || !scalar(record[@"y"], -32768, 32768) || !scalar(record[@"z"], -1000000000, 1000000000) ||
        !scalar(record[@"opacity"], 0, 1) || ![record[@"visible"] isKindOfClass:NSNumber.class] ||
        CFGetTypeID((__bridge CFTypeRef)record[@"visible"]) != CFBooleanGetTypeID() || !relativeParts(record[@"rgbaPath"]) ||
        (record[@"frameId"] && !integer(record[@"frameId"], 0, 0xffffffffLL))) {
      fail(error, @"Invalid viewport layer."); return nil;
    }
    NSUInteger width = [record[@"width"] unsignedIntegerValue], height = [record[@"height"] unsignedIntegerValue];
    if (width * height > MAX_PIXELS || width * height * 4 > MAX_SCENE - total) { fail(error, @"Viewport images exceed their limit."); return nil; }
    total += width * height * 4; [identifiers addObject:record[@"id"]];
    NSData *bytes = readMember(record[@"rgbaPath"], width * height * 4, YES, error); if (!bytes) return nil;
    CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)bytes);
    CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGImageRef image = CGImageCreate(width, height, 8, 32, width * 4, color, kCGImageAlphaLast | kCGBitmapByteOrderDefault, provider, NULL, NO, kCGRenderingIntentDefault);
    CGColorSpaceRelease(color); CGDataProviderRelease(provider);
    if (!image) { fail(error, @"Viewport RGBA image cannot be rendered."); return nil; }
    MLLayer *layer = [MLLayer new]; layer.identifier = record[@"id"]; layer.width = width; layer.height = height;
    layer.x = [record[@"x"] doubleValue]; layer.y = [record[@"y"] doubleValue]; layer.z = [record[@"z"] doubleValue];
    layer.opacity = [record[@"opacity"] doubleValue]; layer.visible = [record[@"visible"] boolValue]; layer.order = result.count;
    layer.image = [[NSImage alloc] initWithCGImage:image size:NSMakeSize(width, height)]; CGImageRelease(image); [result addObject:layer];
  }
  scene.layers = [result sortedArrayUsingComparator:^NSComparisonResult(MLLayer *a, MLLayer *b) {
    if (a.z != b.z) return a.z < b.z ? NSOrderedAscending : NSOrderedDescending;
    return a.order < b.order ? NSOrderedAscending : (a.order > b.order ? NSOrderedDescending : NSOrderedSame);
  }];
  return scene;
}

static NSCursor *cursorFromJSON(id json, NSString **error) {
  if (![json isKindOfClass:NSDictionary.class] || ![json[@"type"] isEqual:@"cursor"] || !integer(json[@"sequence"], 0, 9007199254740991LL)) {
    fail(error, @"Invalid viewport cursor message."); return nil;
  }
  id cursor = json[@"cursor"];
  if (![cursor isKindOfClass:NSDictionary.class]) { fail(error, @"Invalid viewport cursor."); return nil; }
  if ([cursor[@"kind"] isEqual:@"system"]) {
    if ([cursor[@"name"] isEqual:@"arrow"]) return NSCursor.arrowCursor;
    if ([cursor[@"name"] isEqual:@"pointingHand"]) return NSCursor.pointingHandCursor;
    if ([cursor[@"name"] isEqual:@"IBeam"]) return NSCursor.IBeamCursor;
    if ([cursor[@"name"] isEqual:@"crosshair"]) return NSCursor.crosshairCursor;
    fail(error, @"Unsupported viewport system cursor."); return nil;
  }
  if (![cursor[@"kind"] isEqual:@"image"] || !integer(cursor[@"width"], 1, 256) || !integer(cursor[@"height"], 1, 256) ||
      !integer(cursor[@"hotspotX"], 0, [cursor[@"width"] longLongValue] - 1) || !integer(cursor[@"hotspotY"], 0, [cursor[@"height"] longLongValue] - 1) ||
      !relativeParts(cursor[@"rgbaPath"])) { fail(error, @"Invalid viewport cursor image or hotspot."); return nil; }
  NSUInteger width = [cursor[@"width"] unsignedIntegerValue], height = [cursor[@"height"] unsignedIntegerValue];
  NSData *bytes = readMember(cursor[@"rgbaPath"], width * height * 4, YES, error); if (!bytes) return nil;
  CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)bytes);
  CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGImageRef image = CGImageCreate(width, height, 8, 32, width * 4, color, kCGImageAlphaLast | kCGBitmapByteOrderDefault, provider, NULL, NO, kCGRenderingIntentDefault);
  CGColorSpaceRelease(color); CGDataProviderRelease(provider);
  if (!image) { fail(error, @"Viewport cursor image cannot be rendered."); return nil; }
  NSImage *native = [[NSImage alloc] initWithCGImage:image size:NSMakeSize(width, height)]; CGImageRelease(image);
  NSCursor *result = [[NSCursor alloc] initWithImage:native hotSpot:NSMakePoint([cursor[@"hotspotX"] doubleValue], [cursor[@"hotspotY"] doubleValue])];
  if (!result) fail(error, @"Viewport cursor cannot be created."); return result;
}

@interface MLView : NSView
@property MLScene *scene;
@property NSTrackingArea *tracking;
@property NSCursor *activeCursor;
@end
@implementation MLView
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (void)updateTrackingAreas {
  if (self.tracking) [self removeTrackingArea:self.tracking];
  self.tracking = [[NSTrackingArea alloc] initWithRect:self.bounds options:NSTrackingMouseMoved | NSTrackingCursorUpdate | NSTrackingActiveInKeyWindow | NSTrackingInVisibleRect owner:self userInfo:nil];
  [self addTrackingArea:self.tracking]; [super updateTrackingAreas];
}
- (void)resetCursorRects { [self addCursorRect:self.bounds cursor:self.activeCursor ?: NSCursor.arrowCursor]; }
- (void)cursorUpdate:(NSEvent *)event { (void)event; [(self.activeCursor ?: NSCursor.arrowCursor) set]; }
- (NSRect)canvasRect {
  if (!self.scene) return NSZeroRect;
  double scale = MIN(self.bounds.size.width / self.scene.width, self.bounds.size.height / self.scene.height);
  return NSMakeRect((self.bounds.size.width - self.scene.width * scale) / 2, (self.bounds.size.height - self.scene.height * scale) / 2,
    self.scene.width * scale, self.scene.height * scale);
}
- (void)drawRect:(NSRect)dirty {
  (void)dirty; [NSColor.blackColor setFill]; NSRectFill(self.bounds);
  if (!self.scene) return;
  NSRect canvas = [self canvasRect]; double scale = canvas.size.width / self.scene.width;
  for (MLLayer *layer in self.scene.layers) {
    if (!layer.visible || !layer.opacity) continue;
    NSRect destination = NSMakeRect(canvas.origin.x + layer.x * scale, canvas.origin.y + layer.y * scale, layer.width * scale, layer.height * scale);
    [NSGraphicsContext saveGraphicsState]; NSRectClip(canvas);
    [layer.image drawInRect:destination fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:layer.opacity respectFlipped:YES hints:nil];
    [NSGraphicsContext restoreGraphicsState];
  }
}
- (void)pointer:(NSEvent *)event kind:(NSString *)kind {
  if (!self.scene) return;
  NSRect canvas = [self canvasRect]; NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  if (!NSPointInRect(point, canvas)) return;
  double scale = canvas.size.width / self.scene.width;
  NSInteger button = event.buttonNumber;
  if (button > 2) return;
  // Cocoa numbers right as 1 and middle as 2; protocol v1 uses DOM ordering.
  button = button == 1 ? 2 : (button == 2 ? 1 : 0);
  emit(@{@"type":@"pointer",@"kind":kind,@"x":@((point.x-canvas.origin.x)/scale),@"y":@((point.y-canvas.origin.y)/scale),
    @"button":@(button),@"sequence":@(self.scene.sequence)});
}
- (void)mouseMoved:(NSEvent *)event { [self pointer:event kind:@"move"]; }
- (void)mouseDragged:(NSEvent *)event { [self pointer:event kind:@"move"]; }
- (void)rightMouseDragged:(NSEvent *)event { [self pointer:event kind:@"move"]; }
- (void)otherMouseDragged:(NSEvent *)event { [self pointer:event kind:@"move"]; }
- (void)mouseDown:(NSEvent *)event { [self pointer:event kind:@"down"]; }
- (void)mouseUp:(NSEvent *)event { [self pointer:event kind:@"up"]; }
- (void)rightMouseDown:(NSEvent *)event { [self pointer:event kind:@"down"]; }
- (void)rightMouseUp:(NSEvent *)event { [self pointer:event kind:@"up"]; }
- (void)otherMouseDown:(NSEvent *)event { [self pointer:event kind:@"down"]; }
- (void)otherMouseUp:(NSEvent *)event { [self pointer:event kind:@"up"]; }
- (void)key:(NSEvent *)event kind:(NSString *)kind {
  NSString *key;
  switch (event.keyCode) {
    case 36: case 76: key = @"Enter"; break; case 53: key = @"Escape"; break; case 49: key = @"Space"; break;
    case 123: key = @"ArrowLeft"; break; case 124: key = @"ArrowRight"; break; case 125: key = @"ArrowDown"; break; case 126: key = @"ArrowUp"; break;
    default: key = event.charactersIgnoringModifiers;
  }
  if (safeText(key, 16) && key.length) emit(@{@"type":@"key",@"kind":kind,@"key":key,@"repeat":@(event.isARepeat)});
}
- (void)keyDown:(NSEvent *)event { [self key:event kind:@"down"]; }
- (void)keyUp:(NSEvent *)event { [self key:event kind:@"up"]; }
@end

@interface MLHost : NSObject <NSApplicationDelegate,NSWindowDelegate>
@property NSWindow *window;
@property MLView *view;
@property long long sequence;
@property long long cursorSequence;
@property NSCursor *activeCursor;
- (void)message:(id)message;
@end
@implementation MLHost
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification; self.sequence = -1; self.cursorSequence = -1; emit(@{@"type":@"ready",@"protocolVersion":@2,@"version":@VIEWPORT_VERSION});
}
- (void)message:(id)message {
  if ([message isKindOfClass:NSDictionary.class] && [message[@"type"] isEqual:@"close"]) { [NSApp terminate:nil]; return; }
  if ([message isKindOfClass:NSDictionary.class] && [message[@"type"] isEqual:@"cursor"]) {
    NSString *cursorError; NSCursor *cursor = cursorFromJSON(message, &cursorError);
    if (!cursor || [message[@"sequence"] longLongValue] <= self.cursorSequence) {
      emit(@{@"type":@"error",@"message":cursorError ?: @"Viewport cursor sequence is stale."}); [NSApp terminate:nil]; return;
    }
    self.cursorSequence = [message[@"sequence"] longLongValue]; self.activeCursor = cursor; self.view.activeCursor = cursor;
    if (self.window) { [self.window invalidateCursorRectsForView:self.view]; [cursor set]; }
    emit(@{@"type":@"cursor-set",@"sequence":@(self.cursorSequence)}); return;
  }
  NSString *error; MLScene *scene = sceneFromJSON(message, &error);
  if (!scene || scene.sequence <= self.sequence) {
    emit(@{@"type":@"error",@"message":error ?: @"Viewport scene sequence is stale."}); [NSApp terminate:nil]; return;
  }
  BOOL newWindow = !self.window;
  if (newWindow) {
    NSRect visible = NSScreen.mainScreen.visibleFrame;
    double scale = MIN(1.0, MIN(MAX(1, visible.size.width-80)/scene.width, MAX(1, visible.size.height-80)/scene.height));
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,scene.width*scale,scene.height*scale)
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
    self.view = [[MLView alloc] initWithFrame:self.window.contentView.bounds]; self.view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.view.activeCursor = self.activeCursor;
    self.window.contentView = self.view; self.window.delegate = self; self.window.acceptsMouseMovedEvents = YES;
    self.window.contentMinSize = NSMakeSize(MIN(320,scene.width),MIN(180,scene.height)); [self.window center];
  }
  self.sequence = scene.sequence; self.view.scene = scene; self.window.title = scene.title;
  [self.view setNeedsDisplay:YES]; [self.view displayIfNeeded];
  if (newWindow) { [self.window makeKeyAndOrderFront:nil]; [self.window makeFirstResponder:self.view]; [NSApp activateIgnoringOtherApps:YES]; }
  emit(@{@"type":@"presented",@"sequence":@(scene.sequence),@"layers":@(scene.layers.count)});
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { (void)sender; return YES; }
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
  (void)sender; if (!closing) { closing = YES; emit(@{@"type":@"close"}); } return NSTerminateNow;
}
@end

static NSDictionary *readJSONLine(FILE *input, NSString **error) {
  NSMutableData *bytes = [NSMutableData data]; int ch;
  while ((ch = fgetc(input)) != EOF && ch != '\n') {
    if (bytes.length >= MAX_LINE) { fail(error,@"Viewport message exceeds its limit."); return nil; }
    uint8_t value = (uint8_t)ch; [bytes appendBytes:&value length:1];
  }
  if (!bytes.length && ch == EOF) return nil;
  id value = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
  if (![value isKindOfClass:NSDictionary.class]) { fail(error,@"Invalid viewport JSON message."); return nil; }
  return value;
}
static BOOL writeMember(NSString *file, NSData *bytes) {
  int fd = openMember(file, YES); if (fd < 0) return NO; NSUInteger at = 0;
  while (at < bytes.length) {
    ssize_t amount = write(fd, (const uint8_t *)bytes.bytes + at, bytes.length-at);
    if (amount < 0 && errno == EINTR) continue;
    if (amount <= 0) { close(fd); return NO; } at += (NSUInteger)amount;
  }
  BOOL okay = fsync(fd) == 0; close(fd); return okay;
}
static int decodeRaster(NSString *input, NSString *output, NSString *encoding, NSUInteger width, NSUInteger height) {
  NSString *error; NSData *bytes = readMember(input,0,NO,&error);
  if (!bytes || !width || !height || width > 16384 || height > 16384 || width*height > MAX_PIXELS) { emit(@{@"type":@"error",@"message":error ?: @"Invalid raster dimensions."}); return 2; }
  CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)bytes, (__bridge CFDictionaryRef)@{(id)kCGImageSourceShouldCache:@NO});
  NSString *type = source ? (__bridge NSString *)CGImageSourceGetType(source) : nil;
  BOOL jpeg = [encoding isEqual:@"jpeg"] && [type isEqual:@"public.jpeg"];
  BOOL webp = [encoding isEqual:@"webp"] && ([type isEqual:@"org.webmproject.webp"] || [type isEqual:@"public.webp"]);
  if (!source || CGImageSourceGetCount(source) != 1 || (!jpeg && !webp)) { if(source)CFRelease(source); emit(@{@"type":@"error",@"message":@"Unsupported or corrupt HG-3 raster image."}); return 2; }
  NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source,0,NULL));
  if ([properties[(id)kCGImagePropertyPixelWidth] unsignedIntegerValue] != width || [properties[(id)kCGImagePropertyPixelHeight] unsignedIntegerValue] != height) {
    CFRelease(source); emit(@{@"type":@"error",@"message":@"HG-3 raster dimensions disagree."}); return 2;
  }
  CGImageRef image = CGImageSourceCreateImageAtIndex(source,0,(__bridge CFDictionaryRef)@{(id)kCGImageSourceShouldCache:@NO}); CFRelease(source);
  NSMutableData *rgba = [NSMutableData dataWithLength:width*height*4]; CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef context = CGBitmapContextCreate(rgba.mutableBytes,width,height,8,width*4,color,kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big); CGColorSpaceRelease(color);
  if (!image || !context) { if(image)CGImageRelease(image); if(context)CGContextRelease(context); emit(@{@"type":@"error",@"message":@"HG-3 raster image cannot be decoded."}); return 2; }
  CGContextDrawImage(context,CGRectMake(0,0,width,height),image); CGContextRelease(context); CGImageRelease(image);
  uint8_t *pixels = rgba.mutableBytes;
  for(NSUInteger i=0;i<width*height;i++) { unsigned alpha=pixels[i*4+3]; if(alpha && alpha<255) for(int c=0;c<3;c++) pixels[i*4+c]=(uint8_t)MIN(255,(pixels[i*4+c]*255+alpha/2)/alpha); }
  if (!writeMember(output,rgba)) { emit(@{@"type":@"error",@"message":@"HG-3 raster cache output cannot be created."}); return 2; }
  emit(@{@"type":@"decoded",@"bytes":@(rgba.length),@"width":@(width),@"height":@(height)}); return 0;
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1],"--version") == 0) { puts("maclauncher-catsystem2-viewport " VIEWPORT_VERSION " protocol2"); return 0; }
    NSMutableDictionary *args = [NSMutableDictionary dictionary];
    for(int i=1;i<argc;i+=2) { if(i+1>=argc) return 2; NSString *key=[NSString stringWithUTF8String:argv[i]], *value=[NSString stringWithUTF8String:argv[i+1]]; if(!key || !value || args[key])return 2; args[key]=value; }
    NSSet *allowed = [NSSet setWithArray:@[@"--cache-root",@"--decode-raster",@"--output",@"--encoding",@"--width",@"--height",@"--validate-scene",@"--validate-cursor"]];
    for(NSString *key in args) if(![allowed containsObject:key]) return 2;
    if(args[@"--decode-raster"] && args[@"--validate-scene"]) return 2;
    if(args[@"--validate-cursor"] && (args[@"--decode-raster"] || args[@"--validate-scene"])) return 2;
    cacheRoot = args[@"--cache-root"]; cacheFD = openRoot(cacheRoot); if(cacheFD<0) { fputs("Invalid viewport cache root.\n",stderr); return 2; }
    if (args[@"--decode-raster"]) return decodeRaster(args[@"--decode-raster"],args[@"--output"],args[@"--encoding"],(NSUInteger)[args[@"--width"] longLongValue],(NSUInteger)[args[@"--height"] longLongValue]);
    if (args[@"--validate-cursor"]) {
      [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
      NSString *error; NSDictionary *json = readJSONLine(stdin, &error); NSCursor *cursor = json ? cursorFromJSON(json, &error) : nil;
      if (!cursor) { emit(@{@"type":@"error",@"message":error ?: @"Missing viewport cursor."}); return 2; }
      emit(@{@"type":@"cursor-validated",@"sequence":json[@"sequence"],@"width":@(cursor.image.size.width),@"height":@(cursor.image.size.height),
        @"hotspotX":@(cursor.hotSpot.x),@"hotspotY":@(cursor.hotSpot.y)}); return 0;
    }
    if (args[@"--validate-scene"]) {
      NSString *error; NSDictionary *json=readJSONLine(stdin,&error); MLScene *scene=json?sceneFromJSON(json,&error):nil;
      if(!scene){emit(@{@"type":@"error",@"message":error?:@"Missing viewport scene."});return 2;}
      emit(@{@"type":@"validated",@"sequence":@(scene.sequence),@"layers":@(scene.layers.count)}); return 0;
    }
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular]; MLHost *host=[MLHost new]; NSApp.delegate=host;
    NSMenu *bar=[NSMenu new], *menu=[NSMenu new]; NSMenuItem *app=[NSMenuItem new]; app.submenu=menu; [bar addItem:app];
    NSMenuItem *quit=[[NSMenuItem alloc] initWithTitle:@"Quit" action:@selector(terminate:) keyEquivalent:@"q"]; quit.target=NSApp; [menu addItem:quit]; NSApp.mainMenu=bar;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
      while(!closing) { @autoreleasepool {
        NSString *error; NSDictionary *message=readJSONLine(stdin,&error);
        if(!message) { dispatch_async(dispatch_get_main_queue(),^{if(error)emit(@{@"type":@"error",@"message":error});[NSApp terminate:nil];}); break; }
        dispatch_sync(dispatch_get_main_queue(),^{[host message:message];});
      } }
    });
    [NSApp run]; close(cacheFD); return 0;
  }
}
