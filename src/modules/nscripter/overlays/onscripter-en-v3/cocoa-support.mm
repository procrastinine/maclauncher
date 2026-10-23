// Modern Cocoa integration for the unmodified ONScripter-EN engine. The old
// upstream nib/QuickTime application shell is replaced by SDL12-compat's shell.
#import <Cocoa/Cocoa.h>
#include <cstring>
#include "cocoa_alertbox.h"
#include "cocoa_bundle.h"
#include "cocoa_directories.h"
#include "cocoa_url.h"

namespace ONSCocoa {
static NSString *string(const char *text, encoding_type encoding = ENC_UTF8) {
    if (!text) return @"";
    NSStringEncoding code = encoding == ENC_SJIS ? NSShiftJISStringEncoding : NSUTF8StringEncoding;
    NSString *value = [[NSString alloc] initWithBytes:text length:std::strlen(text) encoding:code];
    return [value autorelease] ?: @"";
}
static char *copy(NSString *value) {
    const char *text = [value UTF8String];
    char *result = new char[std::strlen(text) + 1];
    std::strcpy(result, text);
    return result;
}
void getBundleInfo(char **resources, char **bundle, char **name) {
    // Managed native executables deliberately have no application resource root.
    // The module always supplies the actual game's root and its save directory.
    *resources = nullptr; *bundle = nullptr; *name = nullptr;
}
void getGameAppSupportPath(char **result, const char *gameid) {
    NSArray *paths = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES);
    NSString *folder = [[paths firstObject] stringByAppendingPathComponent:string(gameid)];
    [[NSFileManager defaultManager] createDirectoryAtPath:folder withIntermediateDirectories:YES attributes:nil error:nil];
    *result = copy(folder);
}
void sjis_to_utf8(char *out, const char *input) {
    std::strcpy(out, [string(input, ENC_SJIS) UTF8String]);
}
void alertbox(const char *title, const char *message) {
    NSAlert *alert = [[[NSAlert alloc] init] autorelease];
    [alert setMessageText:string(title)]; [alert setInformativeText:string(message)];
    [alert addButtonWithTitle:@"OK"]; [alert runModal];
}
bool choicebox(const char *title, const char *message, const char *yes, const char *no, encoding_type encoding) {
    NSAlert *alert = [[[NSAlert alloc] init] autorelease];
    [alert setMessageText:string(title, encoding)]; [alert setInformativeText:string(message, encoding)];
    [alert addButtonWithTitle:string(yes, encoding)]; [alert addButtonWithTitle:string(no, encoding)];
    return [alert runModal] == NSAlertFirstButtonReturn;
}
scriptErrorBoxResult scriptErrorBox(const char *title, const char *message, bool allowIgnore, encoding_type encoding) {
    NSAlert *alert = [[[NSAlert alloc] init] autorelease];
    [alert setMessageText:string(title, encoding)]; [alert setInformativeText:string(message, encoding)];
    [alert addButtonWithTitle:@"Quit"];
    if (allowIgnore) [alert addButtonWithTitle:@"Ignore"];
    return [alert runModal] == NSAlertSecondButtonReturn ? SCRIPTERROR_IGNORE : SCRIPTERROR_QUIT;
}
void open_url(const char *url, encoding_type encoding) {
    NSURL *value = [NSURL URLWithString:string(url, encoding)];
    if (value) [[NSWorkspace sharedWorkspace] openURL:value];
}
}
