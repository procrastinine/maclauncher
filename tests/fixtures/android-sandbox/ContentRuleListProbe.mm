#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#include <assert.h>
#include <string.h>
#include <unistd.h>

int main(int argc,char **argv){@autoreleasepool{
 assert(argc==2);[NSApplication sharedApplication];
 const char *configured=getenv("TMPDIR");assert(configured&&*configured=='/');
 NSString *expected=[@(configured) stringByAppendingString:configured[strlen(configured)-1]=='/'?@"":@"/"];
 char temporary[4096];assert(confstr(_CS_DARWIN_USER_TEMP_DIR,temporary,sizeof temporary));
 assert(strcmp(temporary,expected.UTF8String)==0);
 NSURL *directory=[NSURL fileURLWithPath:@(argv[1]) isDirectory:YES];
 __block bool done=false,passed=false;
 [[WKContentRuleListStore storeWithURL:directory]
  compileContentRuleListForIdentifier:@"private-network-isolation"
  encodedContentRuleList:@"[{\"trigger\":{\"url-filter\":\"^https?:\"},\"action\":{\"type\":\"block\"}},{\"trigger\":{\"url-filter\":\"^wss?:\"},\"action\":{\"type\":\"block\"}},{\"trigger\":{\"url-filter\":\"^ftp:\"},\"action\":{\"type\":\"block\"}}]"
  completionHandler:^(WKContentRuleList *rules,NSError *error){
   passed=rules!=nil&&!error;done=true;
   if(error)fprintf(stderr,"Rule compilation failed: %s\n",error.description.UTF8String);
  }];
 NSDate *deadline=[NSDate dateWithTimeIntervalSinceNow:10];
 while(!done&&deadline.timeIntervalSinceNow>0)
  [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.01]];
 assert(done&&passed);puts("PASS private WebKit compiler scratch and offline rules");return 0;
}}
