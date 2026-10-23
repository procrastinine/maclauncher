#include "clock/tick-mailbox.hpp"
#include <cassert>
#include <thread>
#include <cstdio>
#include <climits>
int main(){
    using namespace klclock;assert(scale(3,125,3)==125);assert(scale(UINT64_MAX,UINT32_MAX,1)==0);assert(scale(5,2,0)==0);
    Mailbox box;uint64_t consumed=0,skipped=0;Tick value{};assert(!box.read(consumed,value,skipped));
    box.publish({5,10,15});assert(box.read(consumed,value,skipped)&&value.callback==5&&skipped==0);assert(!box.read(consumed,value,skipped));
    uint64_t nativeCursor=0;assert(box.read(nativeCursor,value,skipped)&&value.callback==5);assert(!box.read(consumed,value,skipped));
    for(uint64_t i=6;i<=100005;i++)box.publish({i,i*2,i*3});assert(box.read(consumed,value,skipped)&&value.callback==100005&&skipped==99999);
    box.discard(consumed);assert(!box.read(consumed,value,skipped));
    std::atomic<bool> finished=false;std::thread writer([&]{for(uint64_t i=100006;i<1000006;i++)box.publish({i,i*2,i*3});finished.store(true);});
    uint64_t observed=0,previous=100005;do{if(box.read(consumed,value,skipped)){assert(value.callback>previous&&value.output==value.callback*2&&value.interval==value.callback*3);previous=value.callback;observed++;}}while(!finished.load());writer.join();
    if(box.read(consumed,value,skipped)){assert(value.output==value.callback*2&&value.interval==value.callback*3);previous=value.callback;}
    assert(previous==1000005);printf("PASS 1000000 source ticks, %llu concurrent bounded mailbox observations, checked conversion overflow\n",(unsigned long long)observed);
}
