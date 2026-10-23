#include "connectivity.c"
#include <assert.h>

int main(void){
 assert(observe(NULL));
 pthread_mutex_lock(&lock);uint64_t first=packed();pthread_mutex_unlock(&lock);
 // Starting observation does no configuration lookup on this caller. Before the
 // first completed callback it reports unknown, never an invented online route.
 if(!(first>>32))assert((int32_t)first==-1);
 CFArrayRef links=NULL;uint64_t completed=0;
 for(unsigned i=0;i<5000&&!links;i++){
  pthread_mutex_lock(&lock);completed=packed();pthread_mutex_unlock(&lock);
  links=copy_links(completed>>32);if(!links)usleep(1000);
 }
 assert(links&&(completed>>32)&&(int32_t)completed>=0);
 for(CFIndex i=0;i<CFArrayGetCount(links);i++){
  CFArrayRef row=CFArrayGetValueAtIndex(links,i);assert(CFArrayGetCount(row)>=2);
  if(CFEqual(CFArrayGetValueAtIndex(row,0),CFSTR("interface"))){
   char name[IFNAMSIZ];assert(CFStringGetCString(CFArrayGetValueAtIndex(row,1),name,sizeof name,kCFStringEncodingUTF8));assert(if_nametoindex(name));
  }
 }
 CFRelease(links);
 pthread_mutex_lock(&lock);dispatch_queue_t retiring=queue;dispatch_retain(retiring);pthread_mutex_unlock(&lock);
 Java_maclauncher_android_framework_HostNetworkAgent_nativeClose(NULL,NULL);
 dispatch_sync(retiring,^{});dispatch_release(retiring);
 printf("PASS complete passive route snapshot online=%d state=%u revision=%llu\n",(int)completed&1,(unsigned)completed,(unsigned long long)(completed>>32));
 return 0;
}
