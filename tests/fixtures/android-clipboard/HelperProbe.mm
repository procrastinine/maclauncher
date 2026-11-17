#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#import <CoreGraphics/CoreGraphics.h>
#import <objc/runtime.h>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <thread>
#include <unistd.h>

// Only this executable replaces the physical input and frontmost-application
// suppliers. The included helper retains its real timer, notifications, IPC and
// pasteboard calls; the pasteboard is unique to this process and contains only
// fixture text. No production switch can enable these suppliers.
static std::atomic<int> inputPid{0}, inputOperation{0};
static NSPasteboard* privateBoard;
static NSString* observedPath;
// The publisher may advance after the acknowledgement. One native sample
// must read the operation captured with its flags for every key query.
static int sampledOperation=0;
static CGEventFlags fixtureFlags(CGEventSourceStateID){
 int pid=inputPid.load(),operation=inputOperation.load();sampledOperation=operation;
 static int previousPid=-1,previousOperation=-1;
 // A plain write: the test polls for the exact text, and an atomic replacement needs a
 // temporary-items directory that restricted environments refuse.
 if(pid!=previousPid||operation!=previousOperation){[[NSString stringWithFormat:@"%d %d",pid,operation]writeToFile:observedPath atomically:NO encoding:NSUTF8StringEncoding error:nil];previousPid=pid;previousOperation=operation;}
 return operation?kCGEventFlagMaskCommand:0;
}
static bool fixtureKey(CGEventSourceStateID,CGKeyCode);
@interface MLClipboardTestApplication : NSObject
@property(nonatomic) pid_t processIdentifier;
@end
@implementation MLClipboardTestApplication
@end
static id fixtureApplication(id,SEL){auto app=[MLClipboardTestApplication new];app.processIdentifier=inputPid.load();return app;}
static id fixturePasteboard(id,SEL){return privateBoard;}
[[noreturn]] static void fixtureExit(int status){[privateBoard releaseGlobally];_exit(status);}

#define CGEventSourceFlagsState fixtureFlags
#define CGEventSourceKeyState fixtureKey
#define _exit fixtureExit
#define main clipboardHelperMain
#include "clipboard-gesture.mm"
#undef main
#undef _exit
#undef CGEventSourceKeyState
#undef CGEventSourceFlagsState

static bool fixtureKey(CGEventSourceStateID,CGKeyCode key){
 int operation=sampledOperation;const auto&keys=operation==1?copyKeys:pasteKeys;
 return operation&&std::find(keys.begin(),keys.end(),key)!=keys.end();
}
// Deterministically advance the publisher between flags and keys. The
// next complete sample must still capture the paste edge exactly once.
static int sampleContract(const char*observation){
 observedPath=[NSString stringWithUTF8String:observation];
 inputPid.store(101);inputOperation.store(0);copyKeys={8};pasteKeys={9};
 KLClipboardGestures contract;contract.enroll(101);
 contract.sample(101,false,false,false,false,0);
 auto flags=fixtureFlags(kCGEventSourceStateHIDSystemState);
 inputOperation.store(2);
 contract.sample(101,flags&kCGEventFlagMaskCommand,false,fixtureKey(kCGEventSourceStateHIDSystemState,8),fixtureKey(kCGEventSourceStateHIDSystemState,9),.1);
 flags=fixtureFlags(kCGEventSourceStateHIDSystemState);
 contract.sample(101,flags&kCGEventFlagMaskCommand,false,fixtureKey(kCGEventSourceStateHIDSystemState,8),fixtureKey(kCGEventSourceStateHIDSystemState,9),.2);
 const bool allowed=contract.consume(101,101,false,.3);
 fprintf(stderr,"sample contract: final paste allowed=%d\n",allowed);
 return allowed?0:1;
}
int main(int argc,char**argv){@autoreleasepool{
 if(argc==3&&strcmp(argv[2],"sample-contract")==0)return sampleContract(argv[1]);
 if(argc!=2)return 2;
 privateBoard=[NSPasteboard pasteboardWithUniqueName];
 [privateBoard setString:@"fixture initial λ" forType:NSPasteboardTypeString];
 method_setImplementation(class_getInstanceMethod(NSWorkspace.class,@selector(frontmostApplication)),(IMP)fixtureApplication);
 method_setImplementation(class_getClassMethod(NSPasteboard.class,@selector(generalPasteboard)),(IMP)fixturePasteboard);
 NSString*statePath=[NSString stringWithUTF8String:argv[1]];
 observedPath=[statePath stringByAppendingString:@".observed"];
 // Emulate workspace activation from another process, after enrollment. The
 // production helper must dispatch its real NSOperationQueue observer to arm
 // the hardware timer before the key is pressed and released.
 std::thread([statePath]{@autoreleasepool{
  int previousPid=0;
  for(;;){
   FILE*file=fopen(statePath.fileSystemRepresentation,"r");int pid=0,operation=0;
   if(file){if(fscanf(file,"%d %d",&pid,&operation)!=2){pid=previousPid;operation=0;}fclose(file);}
   inputPid.store(pid);inputOperation.store(operation);
   if(pid!=previousPid){
    auto app=[MLClipboardTestApplication new];app.processIdentifier=pid;
    [NSWorkspace.sharedWorkspace.notificationCenter postNotificationName:NSWorkspaceDidActivateApplicationNotification object:nil userInfo:@{NSWorkspaceApplicationKey:app}];previousPid=pid;
   }
   usleep(2000);
  }
 }}).detach();
 return clipboardHelperMain();
}}
