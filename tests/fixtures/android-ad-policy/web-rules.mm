#import <WebKit/WebKit.h>
#include <cassert>
#include "webview-ad-rules.h"
int main(int argc,char **argv){@autoreleasepool{
    assert(argc==2);NSArray *rules=klj_webview_ad_rules();
    auto blocked=^(NSString *url){for(NSDictionary *rule in rules){NSError *error=nil;
        auto regex=[NSRegularExpression regularExpressionWithPattern:rule[@"trigger"][@"url-filter"] options:NSRegularExpressionCaseInsensitive error:&error];assert(regex&&!error);
        if([regex firstMatchInString:url options:0 range:NSMakeRange(0,url.length)])return YES;
    }return NO;};
    assert(blocked(@"https://ads.doubleclick.net/a.js"));assert(blocked(@"HTTPS://ADS.DOUBLECLICK.NET.:443/a"));
    assert(blocked(@"wss://user@ads.doubleclick.net:1234/path"));
    assert(!blocked(@"https://doubleclick.net.evil.example/a"));assert(!blocked(@"https://notdoubleclick.net/a"));
    assert(!blocked(@"https://accounts.google.com/login"));assert(!blocked(@"https://example.com/doubleclick.net"));
    assert(!blocked(@"https://xn--bcher-kva.example/a"));
    NSError *error=nil;NSData *json=[NSJSONSerialization dataWithJSONObject:rules options:0 error:&error];assert(json&&!error);
    NSString *encoded=[[NSString alloc]initWithData:json encoding:NSUTF8StringEncoding];
    auto store=[WKContentRuleListStore storeWithURL:[NSURL fileURLWithPath:@(argv[1]) isDirectory:YES]];
    __block BOOL done=NO;__block NSError *failure=nil;__block WKContentRuleList *result=nil;
    [store compileContentRuleListForIdentifier:@"test-android-ads" encodedContentRuleList:encoded completionHandler:^(WKContentRuleList *compiled,NSError *error){result=compiled;failure=error;done=YES;}];
    while(!done)[NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.01]];
    if(failure)fprintf(stderr,"%s\n",failure.localizedDescription.UTF8String);assert(result&&!failure);
    puts("PASS shared WebKit ad rules compile and hostname boundaries");
}}
