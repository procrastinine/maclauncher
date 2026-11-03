#pragma once
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#include <vector>
#include <sys/types.h>

int runCaptureService(NSArray<NSString*> *arguments);
int runCatalogRelay(NSArray<NSString*> *arguments);

namespace macfx::wcap {
// Window-server coordinates, independent of the attached screen hardware.
size_t captureScreen(const CGRect &target,const std::vector<CGRect> &screens,size_t fallback=0);
}

@class SCShareableContent,SCContentFilter,SCDisplay,SCStream;
// Main-queue service owner. Capture callbacks and Mach intake have their own
// serial queues; stopping retains every stream through its completion.
@interface MacFXCaptureService : NSObject
- (instancetype)initWithId:(NSString*)identifier admission:(BOOL (^)(pid_t process,pid_t claimed))admission;
- (BOOL)start:(NSError *__autoreleasing *)error;
- (void)stop;
- (BOOL)running;
- (unsigned)pendingStops;
- (size_t)clientCount;
- (NSDictionary*)feedSnapshot:(uint32_t)feed process:(pid_t)process;
- (BOOL)captureAvailable;
- (void)requestContent:(void (^)(SCShareableContent*,NSError*))completion;
- (void)presentPicker;
- (SCContentFilter*)displayFilter:(SCDisplay*)display content:(SCShareableContent*)content;
@end
