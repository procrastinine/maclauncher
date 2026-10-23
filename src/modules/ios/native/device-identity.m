#import <Foundation/Foundation.h>
#import <objc/runtime.h>

// A directly launched Catalyst app may have no vendor UUID. Some Unity iOS
// players pass its UTF8String to strlen without checking for nil. Preserve the
// system value when present; the launcher supplies a persistent, game-local
// fallback without querying a hardware identifier or another app's container.
static id (*originalIdentifier)(id, SEL);
static NSUUID *fallbackIdentifier;
static id vendorIdentifier(id device, SEL selector) {
    id value = originalIdentifier(device, selector);
    return value ?: fallbackIdentifier;
}

@interface MacLauncherDeviceIdentity : NSObject
@end
@implementation MacLauncherDeviceIdentity
+ (void)load {
    const char *value = getenv("MACLAUNCHER_IOS_VENDOR_ID");
    if (!value || strlen(value) != 36) return;
    fallbackIdentifier = [[NSUUID alloc] initWithUUIDString:[NSString stringWithUTF8String:value]];
    if (!fallbackIdentifier) return;
    Class device = objc_getClass("UIDevice");
    SEL selector = sel_registerName("identifierForVendor");
    Method method = class_getInstanceMethod(device, selector);
    if (!method) return;
    originalIdentifier = (id (*)(id, SEL))method_getImplementation(method);
    class_replaceMethod(device, selector, (IMP)vendorIdentifier, method_getTypeEncoding(method));
}
@end
