#import <Foundation/Foundation.h>
#include <errno.h>
#include <dlfcn.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, const char **argv) {
  if (argc != 5) return 2;
  @autoreleasepool {
    if (const char *library = getenv("MACLAUNCHER_TEST_EXPECT_GRAPHICS_LIBRARY")) {
      void *symbol = dlsym(RTLD_DEFAULT, "rsProcessRGBA"); Dl_info image;
      char expected[PATH_MAX], loaded[PATH_MAX];
      if (!symbol || !dladdr(symbol, &image) || !realpath(library, expected) || !realpath(image.dli_fname, loaded) || strcmp(expected, loaded)) return 15;
      puts("actual graphics library and config helper coexist in the native application entry");
    }
    const char *expectedName = getenv("MACLAUNCHER_TEST_EXPECT_DISPLAY_NAME");
    if (expectedName) {
      NSString *name = [NSString stringWithUTF8String:expectedName];
      NSBundle *bundle = NSBundle.mainBundle;
      if (![[bundle objectForInfoDictionaryKey:@"CFBundleName"] isEqualToString:name]) return 10;
      if (![bundle.infoDictionary[@"CFBundleName"] isEqualToString:name]) return 11;
      const char *expectedBundleIdentifier = getenv("MACLAUNCHER_TEST_EXPECT_BUNDLE_IDENTIFIER");
      NSString *bundleIdentifier = expectedBundleIdentifier && *expectedBundleIdentifier ? [NSString stringWithUTF8String:expectedBundleIdentifier] : nil;
      if (bundleIdentifier ? ![bundle.bundleIdentifier isEqualToString:bundleIdentifier] : bundle.bundleIdentifier != nil) return 12;
      const char *expectedProcessName = getenv("MACLAUNCHER_TEST_EXPECT_PROCESS_NAME");
      NSString *processName = expectedProcessName ? [NSString stringWithUTF8String:expectedProcessName] : @"fixture";
      if (![NSProcessInfo.processInfo.processName isEqualToString:processName]) return 13;
      NSBundle *framework = [NSBundle bundleForClass:NSFileManager.class];
      if ([[framework objectForInfoDictionaryKey:@"CFBundleName"] isEqualToString:name]) return 14;
    }
    if (![NSFileManager.defaultManager changeCurrentDirectoryPath:[NSString stringWithUTF8String:argv[1]]]) return 3;
    char current[PATH_MAX];
    if (!getcwd(current, sizeof(current)) || strcmp(current, argv[2])) return 4;
    FILE *config = fopen("mkxp.json", "r");
    if (!config) return 5;
    char value[4096] = {0}; fread(value, 1, sizeof(value) - 1, config); fclose(config);
    if (strcmp(value, argv[4])) return 6;
    if (![NSFileManager.defaultManager changeCurrentDirectoryPath:[NSString stringWithUTF8String:argv[3]]]) return 7;
    if (!getcwd(current, sizeof(current)) || strcmp(current, argv[3])) return 8;
    errno = 0;
    if (chdir("/maclauncher-missing-directory-config-fixture") != -1 || errno != ENOENT) return 9;
    puts("original NSFileManager transition redirected; game transition and errno preserved");
  }
  return 0;
}
