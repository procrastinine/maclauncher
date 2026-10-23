#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/pwr_mgt/IOPMLib.h>
#include <stdio.h>

int main(void) {
    const CFStringRef types[] = { kIOPMAssertionTypePreventUserIdleSystemSleep,
        kIOPMAssertionTypePreventUserIdleDisplaySleep };
    for (unsigned i = 0; i < sizeof(types) / sizeof(types[0]); ++i) {
        IOPMAssertionID assertion = kIOPMNullAssertionID;
        IOReturn result = IOPMAssertionCreateWithName(types[i], kIOPMAssertionLevelOn,
            CFSTR("Runtime power ownership check"), &assertion);
        if (result != kIOReturnSuccess) {
            fprintf(stderr, "IOPMAssertionCreateWithName[%u]=0x%x\n", i, result);
            return 1;
        }
        CFDictionaryRef properties = IOPMAssertionCopyProperties(assertion);
        if (!properties) { IOPMAssertionRelease(assertion); return 2; }
        CFRelease(properties);
        result = IOPMAssertionRelease(assertion);
        if (result != kIOReturnSuccess) return 3;
        properties = IOPMAssertionCopyProperties(assertion);
        if (properties) { CFRelease(properties); return 4; }
    }
    puts("Native power assertions acquired, observed and released");
    return 0;
}
