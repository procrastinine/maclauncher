#include "network-host.c"
#include <assert.h>
#include <stdatomic.h>
static atomic_int waiting;
static void*waiter(void*context){
 struct KljArtNetwork*packet=context;atomic_store(&waiting,1);
 int64_t result=maclauncher_art_network((uintptr_t)packet,sizeof(*packet));
 return (void*)(intptr_t)result;
}
int main(void){
 struct KljArtNetwork access={.operation=9};assert(maclauncher_art_network((uintptr_t)&access,sizeof(access))==-ENXIO);
 access.operation=8;access.allowed=1;assert(!maclauncher_art_network((uintptr_t)&access,sizeof(access)));
 access.allowed=0;assert(maclauncher_art_network((uintptr_t)&access,sizeof(access))==-EPERM);
 access.operation=9;assert(!maclauncher_art_network((uintptr_t)&access,sizeof(access))&&access.allowed);
 struct KljArtNetwork policy={.operation=5,.allowed=0};assert(!maclauncher_art_network((uintptr_t)&policy,sizeof(policy)));
 char domain[]="a.doubleclick.net.";struct KljArtNetwork check={.operation=7,.buffer=(uintptr_t)domain,.capacity=sizeof(domain)};
 assert(!maclauncher_art_network((uintptr_t)&check,sizeof(check))&&!check.allowed);
 policy.allowed=1;assert(maclauncher_art_network((uintptr_t)&policy,sizeof(policy))==-EPERM);
 struct KljArtNetwork dns={.operation=6};assert(!maclauncher_art_network((uintptr_t)&dns,sizeof(dns))&&dns.length);
 char*bytes=malloc(dns.length);assert(bytes);dns.buffer=(uintptr_t)bytes;dns.capacity=dns.length;
 assert(!maclauncher_art_network((uintptr_t)&dns,sizeof(dns)));assert(dns.length>dns.capacity||bytes[dns.length-1]==0);free(bytes);
 struct KljArtNetwork packet={.operation=1,.token=31};assert(!maclauncher_art_network((uintptr_t)&packet,sizeof(packet)));
 // Keep a generation stable while checking cancellation, without changing
 // host routes, resolver preferences or sending a network request.
 pthread_mutex_lock(&lock);dispatch_queue_t retained=queue;dispatch_retain(retained);pthread_mutex_unlock(&lock);
 dispatch_sync(retained,^{});
 dispatch_suspend(retained);
 packet.operation=0;assert(!maclauncher_art_network((uintptr_t)&packet,sizeof(packet)));packet.operation=2;
 pthread_t worker;assert(!pthread_create(&worker,NULL,waiter,&packet));while(!atomic_load(&waiting))sched_yield();
 struct KljArtNetwork stop={.operation=3,.token=31};assert(!maclauncher_art_network((uintptr_t)&stop,sizeof(stop)));
 void*result;assert(!pthread_join(worker,&result));assert((intptr_t)result==-KLJ_ART_NETWORK_ECANCELED);dispatch_resume(retained);
 struct KljArtNetwork close={.operation=4};assert(!maclauncher_art_network((uintptr_t)&close,sizeof(close)));
 dispatch_sync(retained,^{});dispatch_release(retained);
 packet.operation=0;assert(maclauncher_art_network((uintptr_t)&packet,sizeof(packet))==-KLJ_ART_NETWORK_ECANCELED);
 puts("PASS shared network observer cancellation, immutable advertising policy and original resolver facts");
}
