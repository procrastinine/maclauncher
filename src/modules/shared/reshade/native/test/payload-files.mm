// Copyright (c) MacLauncher contributors. MIT license.
// The shared payload resolver maps a removed provider file to its stored copy
// through the nearest alias index and leaves every other path unchanged.
#include "temporal-payload-files.hpp"
#include "fixture-files.hpp"
#include <cassert>
#include <cstdio>
#include <string>
static void write(const std::string &path, const std::string &text) {
  NSString *file = [NSString stringWithUTF8String:path.c_str()];
  assert([NSFileManager.defaultManager createDirectoryAtPath:file.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil]);
  assert([[NSData dataWithBytes:text.data() length:text.size()] writeToFile:file atomically:NO]);
}
int main() {
  @autoreleasepool {
    char buffer[1024];
    const char *created = mkdtemp(temporaryPath(buffer, "payload-files-XXXXXX"));
    assert(created);
    const std::string root = created, provider = root + "/temporal/provider";
    write(root + "/runtime.json", "{}");
    write(provider + "/a/1.metal", "stored");
    write(provider + "/payload-aliases.json",
          R"({"schema":1,"files":{"b/1.metal":"a/1.metal","b/2.metal":"../escape","c/3.metal":"a/1.metal","../outside":"a/1.metal"}})");
    using maclauncher::payloadFile;
    const auto stored = provider + "/a/1.metal";
    // A stored file is returned as it is.
    assert(payloadFile(stored) == stored);
    // A removed file resolves to its stored copy, also below a missing directory.
    assert(payloadFile(provider + "/b/1.metal") == stored);
    assert(payloadFile(provider + "/c/3.metal") == stored);
    // Empty, "." and ".." parts of the logical path are normalized first.
    assert(payloadFile(provider + "//b/./1.metal") == stored);
    assert(payloadFile(provider + "/x/../b/1.metal") == stored);
    // Unsafe entries are ignored and an unnamed path is unchanged.
    assert(payloadFile(provider + "/b/2.metal") == provider + "/b/2.metal");
    assert(payloadFile(provider + "/b/9.metal") == provider + "/b/9.metal");
    // Another payload without an index stops at the package root.
    assert(payloadFile(root + "/temporal/other/b/1.metal") == root + "/temporal/other/b/1.metal");
    // A malformed index has no aliases.
    write(root + "/temporal/invalid/payload-aliases.json", "{");
    assert(payloadFile(root + "/temporal/invalid/b/1.metal") == root + "/temporal/invalid/b/1.metal");
    // The Foundation form follows the same rule.
    NSString *removed = [NSString stringWithUTF8String:(provider + "/b/1.metal").c_str()];
    assert([maclauncher::payloadFile(removed) isEqualToString:[NSString stringWithUTF8String:stored.c_str()]]);
    assert(maclauncher::payloadFile((NSString *)nil) == nil);
    [NSFileManager.defaultManager removeItemAtPath:[NSString stringWithUTF8String:root.c_str()] error:nil];
  }
  std::puts("payload-files: passed");
  return 0;
}
