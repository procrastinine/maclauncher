#include "connectivity-core.h"
#include <assert.h>

int main(void){
 assert(network_observe()==0);
 pthread_mutex_lock(&lock);uint64_t first=packed();dispatch_queue_t retiring=queue;dispatch_retain(retiring);pthread_mutex_unlock(&lock);
 // The caller observes the current route synchronously: the first generation
 // is complete and its state is a real route, never an unknown placeholder.
 assert((first>>32)>=1&&(int32_t)first>=0);
 network_close();
 dispatch_sync(retiring,^{});dispatch_release(retiring);
 printf("PASS complete passive route snapshot online=%d state=%u revision=%llu\n",(int)first&1,(unsigned)first,(unsigned long long)(first>>32));
 return 0;
}
