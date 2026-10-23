#import <Foundation/Foundation.h>
#include <assert.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) { @autoreleasepool {
    assert(argc == 2);
    char cache[4096], temporary[4096];
    assert(confstr(_CS_DARWIN_USER_CACHE_DIR, cache, sizeof cache));
    assert(strcmp(cache, argv[1]) == 0); /* No native cache relocation. */
    const char *configured = getenv("TMPDIR");
    if (!configured || configured[0] != '/') {
        assert(confstr(_CS_DARWIN_USER_TEMP_DIR, temporary, sizeof temporary));
        assert(temporary[0] == '/');
        errno = 0; assert(confstr(-1, temporary, sizeof temporary) == 0 && errno == EINVAL);
        puts("PASS original fallback and errors"); return 0;
    }
    NSString *expected = [@(configured) stringByAppendingString:configured[strlen(configured)-1]=='/'?@"":@"/"];
    const char *text = expected.UTF8String; size_t required = strlen(text) + 1;
    errno = EBUSY;
    assert(confstr(_CS_DARWIN_USER_TEMP_DIR, NULL, 0) == required && errno == EBUSY);
    for (size_t size = 0; size <= required + 1; size++) {
        memset(temporary, 0x5a, sizeof temporary);
        assert(confstr(_CS_DARWIN_USER_TEMP_DIR, temporary, size) == required);
        assert(errno == EBUSY);
        if (size) {
            size_t count = size < required ? size : required;
            assert(strncmp(temporary, text, count - 1) == 0 && temporary[count - 1] == 0);
            assert(temporary[count] == 0x5a);
        } else assert(temporary[0] == 0x5a);
    }
    assert([NSTemporaryDirectory() isEqualToString:expected]);
    setenv("TMPDIR", "/different-after-startup/", 1);
    assert(confstr(_CS_DARWIN_USER_TEMP_DIR, temporary, sizeof temporary) == required);
    assert(strcmp(temporary, text) == 0);
    errno = 0; assert(confstr(-1, temporary, sizeof temporary) == 0 && errno == EINVAL);
    puts("PASS native temporary owner, lengths, truncation, errno, Foundation and cache");
}}
