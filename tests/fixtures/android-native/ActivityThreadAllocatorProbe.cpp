#include <jni.h>
#include <malloc/malloc.h>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>

extern "C" void Java_android_app_ActivityThread_nPurgePendingResources(JNIEnv*,jobject);
extern "C" void Java_android_app_ActivityThread_nInitZygoteChildHeapProfiling(JNIEnv*,jobject);
static unsigned calls;
static size_t pressure(malloc_zone_t*,size_t goal){assert(goal==0);++calls;return 0;}

int main(){
    constexpr size_t bytes=4*1024*1024;
    auto live=static_cast<unsigned char*>(malloc(bytes));assert(live);memset(live,0xa5,bytes);
    malloc_zone_t zone={};zone.version=8;zone.pressure_relief=pressure;
    malloc_zone_register(&zone);
    Java_android_app_ActivityThread_nPurgePendingResources(nullptr,nullptr);
    malloc_zone_unregister(&zone);
    assert(calls==1);
    for(size_t i=0;i<bytes;i++)assert(live[i]==0xa5);
    free(live);
    Java_android_app_ActivityThread_nInitZygoteChildHeapProfiling(nullptr,nullptr);
    std::puts("PASS ActivityThread purge reaches Darwin allocator zones and preserves live storage");
}
