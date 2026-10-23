// MacLauncher launch adapter for RLVM's Cocoa game-directory picker (MIT).
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

static IMP originalRunModal;
static IMP originalFilenames;
static NSOpenPanel *gamePanel;
static NSString *gameDirectory;

static NSInteger selectGame(NSOpenPanel *panel, SEL selector) {
    // Only RLVM's initial picker is handled. Other panels retain normal behavior.
    if (!gamePanel && [NSStringFromClass([[panel delegate] class]) isEqualToString:@"FileValidator"]) {
        gamePanel = panel;
        // The normal modal picker also makes a directly spawned app interactive.
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp activateIgnoringOtherApps:YES];
        return NSModalResponseOK;
    }
    return ((NSInteger (*)(id, SEL))originalRunModal)(panel, selector);
}

static NSArray *selectedFiles(NSOpenPanel *panel, SEL selector) {
    if (panel == gamePanel) return @[gameDirectory];
    return ((id (*)(id, SEL))originalFilenames)(panel, selector);
}

__attribute__((constructor)) static void configureLaunch(void) {
    const char *directory = getenv("MACLAUNCHER_RLVM_GAME");
    if (!directory || !*directory) return;
    @autoreleasepool {
        gameDirectory = [[NSString alloc] initWithUTF8String:directory];
        BOOL isDirectory = NO;
        if (![gameDirectory isAbsolutePath] ||
            ![[NSFileManager defaultManager] fileExistsAtPath:gameDirectory isDirectory:&isDirectory] || !isDirectory) {
            fputs("RLVM game directory is unavailable.\n", stderr);
            exit(2);
        }
        Class panelClass = [NSOpenPanel class];
        SEL filenames = NSSelectorFromString(@"filenames");
        Method run = class_getInstanceMethod(panelClass, @selector(runModal));
        Method files = class_getInstanceMethod(panelClass, filenames);
        if (!run || !files) {
            fputs("This RLVM interface is unsupported on this macOS version.\n", stderr);
            exit(2);
        }
        originalRunModal = method_getImplementation(run);
        originalFilenames = method_getImplementation(files);
        class_replaceMethod(panelClass, @selector(runModal), (IMP)selectGame, method_getTypeEncoding(run));
        class_replaceMethod(panelClass, filenames, (IMP)selectedFiles, method_getTypeEncoding(files));
    }
}
