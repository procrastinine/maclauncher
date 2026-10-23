#include "window-physical.h"
#include <cstdio>

static NSBitmapImageRep*render(NSImage*image){
 NSBitmapImageRep*result=[[NSBitmapImageRep alloc]initWithBitmapDataPlanes:nullptr pixelsWide:256 pixelsHigh:256 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
 [NSGraphicsContext saveGraphicsState];NSGraphicsContext.currentContext=[NSGraphicsContext graphicsContextWithBitmapImageRep:result];
 [image drawInRect:NSMakeRect(0,0,256,256) fromRect:NSZeroRect operation:NSCompositingOperationCopy fraction:1];
 [NSGraphicsContext restoreGraphicsState];return result;
}
int main(int argc,char**argv){@autoreleasepool{
 if(argc!=3)return 2;
 SDL_SetHintWithPriority(SDL_HINT_MAC_BACKGROUND_APP,"1",SDL_HINT_OVERRIDE);
 SDL_SetHintWithPriority(SDL_HINT_WINDOW_ACTIVATE_WHEN_SHOWN,"0",SDL_HINT_OVERRIDE);
 // Restoration must already be disabled while AppKit handles its initial
 // launch event, rather than only when SDL receives didFinishLaunching.
 [[NSUserDefaults standardUserDefaults]registerDefaults:@{@"ApplePersistenceIgnoreState":@NO}];
 __block BOOL ignoredAtWillFinish=NO;
 id observer=[NSNotificationCenter.defaultCenter addObserverForName:NSApplicationWillFinishLaunchingNotification object:nil queue:nil usingBlock:^(NSNotification*){ignoredAtWillFinish=[NSUserDefaults.standardUserDefaults boolForKey:@"ApplePersistenceIgnoreState"];}];
 double began=NSProcessInfo.processInfo.systemUptime;
 NSData*png=[NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[2]]];
 if(!png||!kl_application_start(argv[1],png.bytes,png.length,false))return 3;
 [NSNotificationCenter.defaultCenter removeObserver:observer];
 if(!ignoredAtWillFinish){fputs("Restoration policy was applied after AppKit began launching\n",stderr);return 7;}
 double initialized=NSProcessInfo.processInfo.systemUptime-began;
 SDL_Window*window=kl_window_physical_create("Hidden identity component",320,240,SDL_WINDOW_HIDDEN);if(!window)return 8;
 NSWindow*cocoa=(__bridge NSWindow*)SDL_GetPointerProperty(SDL_GetWindowProperties(window),SDL_PROP_WINDOW_COCOA_WINDOW_POINTER,nullptr);
 if(!cocoa||cocoa.restorable)return 9;
 SDL_DestroyWindow(window);
 NSString*expected=[NSString stringWithUTF8String:argv[1]];
 NSRunningApplication*application=NSRunningApplication.currentApplication;
 if(![NSProcessInfo.processInfo.processName isEqualToString:expected]||
    ![application.localizedName isEqualToString:expected]||
    ![NSBundle.mainBundle.bundleIdentifier hasPrefix:@"com.maclauncher.android."]||
    NSApp.activationPolicy!=NSApplicationActivationPolicyRegular||application.active)return 4;
 NSBitmapImageRep*source=render([[NSImage alloc]initWithData:png]),*actual=render(NSApp.applicationIconImage);
 if(!source||!actual)return 5;
 double difference=0;
 for(int y=0;y<256;y++)for(int x=0;x<256;x++){NSUInteger a[4],b[4];[actual getPixel:a atX:x y:y];[source getPixel:b atX:x y:y];for(int c=0;c<4;c++)if(c==3||b[3])difference+=fabs(double(a[c])-double(b[c]));}
 difference/=256*256*4;if(difference>=1){fprintf(stderr,"Application icon mean pixel difference: %f\n",difference);return 6;}
 kl_application_stop();printf("PASS shared native application identity, icon, Dock eligibility and background startup; restoration disabled before AppKit launch; initialization %.3f ms\n",initialized*1000);return 0;
}}
