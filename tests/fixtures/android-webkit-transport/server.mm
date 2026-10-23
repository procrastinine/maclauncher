#import <AppKit/AppKit.h>
#include "network-policy.h"
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <signal.h>
extern "C" int klj_art_webkit_open(const char*,int,int,void*);
extern "C" int klj_art_webkit_poll();
extern "C" void klj_art_webkit_close();
static volatile sig_atomic_t stopped;
static void stop(int){stopped=1;}
int main(int argc,char**argv){@autoreleasepool{
 if(argc!=2)return 2;signal(SIGTERM,stop);signal(SIGPIPE,SIG_IGN);[NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
 NSWindow*window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,96,64) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
 int socket=::socket(AF_UNIX,SOCK_STREAM,0);sockaddr_un address{};address.sun_family=AF_UNIX;if(strlen(argv[1])>=sizeof(address.sun_path))return 3;strcpy(address.sun_path,argv[1]);if(bind(socket,reinterpret_cast<sockaddr*>(&address),sizeof(address)))return 4;
 klj_network_configure_ads(false);if(klj_art_webkit_open(argv[1],socket,3,(__bridge void*)window.contentView))return 5;
 puts("READY");fflush(stdout);
 while(!stopped){if(klj_art_webkit_poll())break;[NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.002]];}
 klj_art_webkit_close();[window close];return 0;
}}
