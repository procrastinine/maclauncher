#include <SystemConfiguration/SystemConfiguration.h>
#include <pthread.h>
#include <stdatomic.h>
#include <assert.h>
static _Atomic unsigned interface_reads;
static pthread_t caller;
static CFArrayRef offline_interfaces(void){
 assert(!pthread_equal(caller,pthread_self()));
 atomic_fetch_add(&interface_reads,1);
 return CFArrayCreate(NULL,NULL,0,&kCFTypeArrayCallBacks);
}
#define SCNetworkInterfaceCopyAll offline_interfaces
#include "connectivity.c"

int main(void){
 caller=pthread_self();
 assert(state==-1&&revision==0&&copy_links(0)==NULL);
 assert((path_value(1,0,1,PATH_WIFI)&PATH_EXPENSIVE)==0);
 assert(path_value(1,0,1,PATH_WIFI)&PATH_CONSTRAINED);
 assert(path_value(1,1,0,PATH_WIFI)&PATH_EXPENSIVE);
 CFMutableArrayRef row=CFArrayCreateMutable(NULL,0,&kCFTypeArrayCallBacks);
 CFArrayAppendValue(row,CFSTR("interface"));CFArrayAppendValue(row,CFSTR("en-fixture"));
 const void* value[]={row};CFArrayRef rows=CFArrayCreate(NULL,value,1,&kCFTypeArrayCallBacks);
 publish(path_value(1,0,1,PATH_WIFI),rows);uint64_t first=revision;
 CFArraySetValueAtIndex(row,1,CFSTR("changed-after-publication"));
 CFArrayRef retained=copy_links(first);assert(retained);
 CFArrayRef copied_row=CFArrayGetValueAtIndex(retained,0);
 assert(CFEqual(CFArrayGetValueAtIndex(copied_row,1),CFSTR("en-fixture")));
 publish(path_value(1,1,0,PATH_WIRED),rows);
 assert(copy_links(first)==NULL); // State and links cannot cross generations.
 assert(CFEqual(CFArrayGetValueAtIndex(copied_row,1),CFSTR("en-fixture")));
 CFRelease(retained);CFRelease(rows);CFRelease(row);

 queue=dispatch_queue_create("offline connectivity owner",DISPATCH_QUEUE_SERIAL);
 dispatch_queue_t observed=queue;dispatch_retain(observed);
 dispatch_semaphore_t gate=dispatch_semaphore_create(0);
 dispatch_async(observed,^{dispatch_semaphore_wait(gate,DISPATCH_TIME_FOREVER);});
 path_state=path_value(0,0,0,0);uint64_t before=revision;
 for(unsigned i=0;i<1000;i++)request_snapshot();
 dispatch_semaphore_signal(gate);dispatch_sync(observed,^{});
 assert(revision==before+1&&atomic_load(&interface_reads)==1);
 retained=copy_links(revision);assert(retained&&CFArrayGetCount(retained)==0);CFRelease(retained);

 dispatch_async(observed,^{dispatch_semaphore_wait(gate,DISPATCH_TIME_FOREVER);});
 request_snapshot();before=revision;
 Java_maclauncher_android_framework_HostNetworkAgent_nativeClose(NULL,NULL);
 dispatch_semaphore_signal(gate);dispatch_sync(observed,^{});
 assert(closed&&revision==before+1&&atomic_load(&interface_reads)==1);
 assert(!snapshot_links&&copy_links(revision)==NULL&&!queue);
 rows=CFArrayCreate(NULL,NULL,0,&kCFTypeArrayCallBacks);publish(1,rows);CFRelease(rows);
 assert(revision==before+1&&!snapshot_links);
 dispatch_release(gate);dispatch_release(observed);
 puts("PASS offline network snapshot ownership, matching revisions, coalescing and terminal close");
}
