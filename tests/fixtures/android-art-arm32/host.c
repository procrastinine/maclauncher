#include "arm32-bridge.h"
#ifdef ANDROID_IDENTITY_PROOF
#include "process-ids.h"
#include <stdatomic.h>
#include <stdio.h>
#include <unistd.h>
#endif
__attribute__((visibility("default")))
int64_t maclauncher_art_host_call(uint32_t function,uint64_t address,uint64_t size,KljArtCallback callback){
#ifdef ANDROID_IDENTITY_PROOF
 static atomic_bool observed;
 if(!atomic_exchange(&observed,1))fprintf(stderr,"SHARED_IDENTITY logical=%d physical=%d\n",klj_process_id(),getpid());
#endif
 return function==9?maclauncher_art_arm32(address,size,callback):-38;
}
