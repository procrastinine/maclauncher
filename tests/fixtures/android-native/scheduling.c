#include "native-scheduling.h"
#include <assert.h>
#include <unistd.h>
#include <stdio.h>
int main(void){
    long cores=sysconf(_SC_NPROCESSORS_ONLN);assert(cores>0);
    for(int i=0;i<1000;i++){
        unsigned cpu=~0u,node=~0u;
        assert(klj_getcpu(&cpu,&node,NULL)==0&&cpu<(unsigned long)cores&&node==0);
        int current=klj_sched_getcpu();assert(current>=0&&current<cores);
    }
    assert(klj_getcpu(NULL,NULL,NULL)==0);
    puts("PASS actual Darwin CPU identity through Android scheduling adapters");
}
