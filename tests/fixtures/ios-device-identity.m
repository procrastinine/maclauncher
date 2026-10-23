#import <Foundation/Foundation.h>
#import <dlfcn.h>
#include <assert.h>

@interface UIDevice : NSObject
- (NSUUID *)identifierForVendor;
@end
static NSUUID *systemIdentifier;
@implementation UIDevice
- (NSUUID *)identifierForVendor { return systemIdentifier; }
@end
int main(int argc, const char **argv) {
    @autoreleasepool {
        assert(argc == 3);
        NSUUID *expected = [[NSUUID alloc] initWithUUIDString:@"ABCDEF12-3456-4789-ABCD-0123456789AB"];
        if (strcmp(argv[2], "missing") == 0) unsetenv("MACLAUNCHER_IOS_VENDOR_ID");
        else setenv("MACLAUNCHER_IOS_VENDOR_ID", argv[2], 1);
        assert(dlopen(argv[1], RTLD_NOW | RTLD_LOCAL));
        UIDevice *device = [UIDevice new];
        if (strcmp(argv[2], expected.UUIDString.UTF8String) == 0)
            assert([[device identifierForVendor] isEqual:expected]);
        else assert([device identifierForVendor] == nil);
        systemIdentifier = [NSUUID UUID];
        assert([[device identifierForVendor] isEqual:systemIdentifier]);
        puts("Missing vendor UUID fallback and existing system UUID preservation passed");
    }
}
