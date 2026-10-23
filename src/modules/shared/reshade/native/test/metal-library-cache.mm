// Copyright (c) MacLauncher contributors. MIT license.
#include "metal-library-cache.hpp"
#import <Foundation/Foundation.h>
#include <chrono>
#include <cstdio>
#include <future>
#include <map>
#include <stdexcept>

static void require(bool value,const char *reason){if(!value)throw std::runtime_error(reason);}
struct Compilation {
    std::mutex lock;
    std::condition_variable changed;
    std::map<std::string,unsigned> calls;
    std::string blocked;
    bool entered=false,released=false,fail=false,raise=false;
    void wait(){std::unique_lock<std::mutex> guard(lock);require(changed.wait_for(guard,std::chrono::seconds(2),[&]{return entered;}),"Compilation did not enter");}
    void release(){std::lock_guard<std::mutex> guard(lock);released=true;changed.notify_all();}
    unsigned count(const std::string &source){std::lock_guard<std::mutex> guard(lock);return calls[source];}
};
@interface MACFXCacheDevice : NSObject { @public Compilation *compilation; }
- (id<MTLLibrary>)newLibraryWithSource:(NSString *)source options:(MTLCompileOptions *)options error:(NSError **)error;
@end
@implementation MACFXCacheDevice
- (id<MTLLibrary>)newLibraryWithSource:(NSString *)source options:(MTLCompileOptions *)options error:(NSError **)error {
    require(options==nil,"Compile options changed");
    auto &c=*compilation;std::unique_lock<std::mutex> guard(c.lock);++c.calls[source.UTF8String];
    if(c.blocked==source.UTF8String){c.entered=true;c.changed.notify_all();c.changed.wait(guard,[&]{return c.released;});}
    if(c.raise)@throw [NSException exceptionWithName:@"CacheCompilation" reason:@"Original compiler exception" userInfo:nil];
    if(c.fail){if(error)*error=[NSError errorWithDomain:@"CacheCompilation" code:42 userInfo:nil];return nil;}
    return (id<MTLLibrary>)[NSObject new];
}
@end
static MACFXCacheDevice *device(Compilation &compilation){auto value=[MACFXCacheDevice new];value->compilation=&compilation;return value;}
static id<MTLLibrary> compile(macfx::MetalLibraryCache &cache,MACFXCacheDevice *gpu,const std::string &source){NSError *error=nil;auto value=cache.library((id<MTLDevice>)gpu,source,&error);require(value&&error==nil,"Compilation failed");return value;}

int main(){@autoreleasepool{try{
    Compilation first,second;auto a=device(first),b=device(second);macfx::MetalLibraryCache exact;
    auto original=compile(exact,a,"shader");require(compile(exact,a,"shader")==original,"Identical source was not reused");
    require(compile(exact,a,"shader\n")!=original&&first.count("shader")==1&&first.count("shader\n")==1,"Exact source identity was lost");
    require(compile(exact,b,"shader")!=original&&second.count("shader")==1,"Device identity was lost");

    // A held compilation cannot serialize an unrelated hit. A second caller
    // of the admitted cold key must share its one immutable result.
    Compilation concurrent;concurrent.blocked="cold";auto gpu=device(concurrent);macfx::MetalLibraryCache shared;
    auto warm=compile(shared,gpu,"warm");
    auto cold=std::async(std::launch::async,[&]{@autoreleasepool{return compile(shared,gpu,"cold")!=nil;}});concurrent.wait();
    auto same=std::async(std::launch::async,[&]{@autoreleasepool{return compile(shared,gpu,"cold")!=nil;}});
    auto hit=std::async(std::launch::async,[&]{@autoreleasepool{return compile(shared,gpu,"warm")==warm;}});
    const auto hitReady=hit.wait_for(std::chrono::seconds(1));
    const auto waiting=same.wait_for(std::chrono::milliseconds(20));concurrent.release();
    require(cold.get()&&same.get()&&hit.get(),"Concurrent result changed");
    require(hitReady==std::future_status::ready&&waiting==std::future_status::timeout,"Unrelated hit waited for compilation or cold key did not wait");
    require(concurrent.count("cold")==1&&concurrent.count("warm")==1,"Concurrent compilation was duplicated");

    Compilation failures;failures.fail=true;failures.blocked="bad";auto badDevice=device(failures);macfx::MetalLibraryCache retry;
    const auto failed=[&]{@autoreleasepool{NSError *error=nil;return retry.library((id<MTLDevice>)badDevice,"bad",&error)==nil&&error.code==42;}};
    auto failedOwner=std::async(std::launch::async,failed);failures.wait();
    auto failedWaiter=std::async(std::launch::async,failed);
    const auto failureWait=failedWaiter.wait_for(std::chrono::milliseconds(20));failures.release();
    require(failedOwner.get()&&failedWaiter.get()&&failureWait==std::future_status::timeout&&failures.count("bad")==1,"Concurrent failure was not preserved");
    failures.fail=false;require(compile(retry,badDevice,"bad")!=nil&&failures.count("bad")==2,"Failure was cached instead of retried");
    failures.raise=true;bool caught=false;@try{retry.library((id<MTLDevice>)badDevice,"exception",nullptr);}@catch(NSException *error){caught=[error.name isEqualToString:@"CacheCompilation"];}
    failures.raise=false;require(caught&&compile(retry,badDevice,"exception")!=nil&&failures.count("exception")==2,"Compiler exception was changed or cached");

    Compilation bounded;auto boundedDevice=device(bounded);macfx::MetalLibraryCache lru(2,64);
    __weak id evicted=nil;@autoreleasepool{compile(lru,boundedDevice,"a");evicted=compile(lru,boundedDevice,"b");compile(lru,boundedDevice,"a");compile(lru,boundedDevice,"c");}
    require(evicted==nil,"Eviction retained the old library");
    compile(lru,boundedDevice,"a");compile(lru,boundedDevice,"b");require(bounded.count("a")==1&&bounded.count("b")==2,"Entry limit or LRU ordering changed");
    macfx::MetalLibraryCache bytes(8,4);compile(bytes,boundedDevice,"1234");compile(bytes,boundedDevice,"12345");compile(bytes,boundedDevice,"12345");compile(bytes,boundedDevice,"1234");
    require(bounded.count("12345")==2&&bounded.count("1234")==1,"Oversized source was cached or evicted valid source");
    compile(bytes,boundedDevice,"x");compile(bytes,boundedDevice,"1234");require(bounded.count("1234")==2,"Source byte bound was ignored");

    Compilation lifetime;__weak id retainedDevice=nil,retainedLibrary=nil;
    {macfx::MetalLibraryCache owned(1,64);@autoreleasepool{auto temporary=device(lifetime);retainedDevice=temporary;retainedLibrary=compile(owned,temporary,"owner");}
        require(retainedDevice!=nil&&retainedLibrary!=nil,"Cache did not retain device/library identity");}
    require(retainedDevice==nil&&retainedLibrary==nil,"Cache destruction retained Metal objects");
    puts("Metal library cache: exact source/device, shared concurrent compilation, independent hits, retry, bounds, eviction and ownership passed without a GPU");return 0;
}catch(const std::exception &error){fprintf(stderr,"%s\n",error.what());return 1;}}}
