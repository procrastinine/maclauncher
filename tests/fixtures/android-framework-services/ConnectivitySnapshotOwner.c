#include <SystemConfiguration/SystemConfiguration.h>
#include <assert.h>
#include <stdatomic.h>
static _Atomic unsigned interface_reads;
static CFArrayRef offline_interfaces(void){
 atomic_fetch_add(&interface_reads,1);
 return CFArrayCreate(NULL,NULL,0,&kCFTypeArrayCallBacks);
}
#define SCNetworkInterfaceCopyAll offline_interfaces
#include "connectivity-core.h"
static _Atomic unsigned notifications;
static uint64_t heard_token,heard_snapshot;
static void heard(uint64_t token,uint64_t snapshot){heard_token=token;heard_snapshot=snapshot;atomic_fetch_add(&notifications,1);}

int main(void){
 assert(state==-1&&revision==0&&!closed);
 // Initial state reads local configuration only; no installed transport appears without an interface.
 int initial=initial_state();assert((initial>>8)==0&&atomic_load(&interface_reads)>=1);
 listener=heard;epoch=7;
 network_publish(initial,0);
 assert(revision==1&&state==initial&&packed()==((uint64_t)1<<32|(uint32_t)initial));
 assert(atomic_load(&notifications)==1&&heard_token==7&&heard_snapshot==packed());
 // An unchanged path is coalesced; only a forced resolver change republishes it.
 network_publish(initial,0);
 assert(revision==1&&atomic_load(&notifications)==1);
 network_publish(initial,1);
 assert(revision==2&&atomic_load(&notifications)==2&&heard_snapshot==packed());
 network_publish(initial^1,0);
 assert(revision==3&&state==(initial^1)&&atomic_load(&notifications)==3&&(int32_t)heard_snapshot==(initial^1));
 // Final close is terminal: the listener is released and later work cannot publish or restart observation.
 uint64_t closed_revision=revision;
 network_close();
 assert(closed&&!listener&&!epoch&&!monitor&&!queue&&!dnsStore);
 network_publish(initial,1);
 assert(revision==closed_revision&&atomic_load(&notifications)==3);
 assert(network_observe()==ECANCELED&&!monitor&&!queue);
 puts("PASS offline network state publication, matching revisions, coalescing and terminal close");
}
