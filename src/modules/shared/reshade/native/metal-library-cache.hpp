#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <Metal/Metal.h>
#include <atomic>
#include <condition_variable>
#include <exception>
#include <list>
#include <memory>
#include <mutex>
#include <string>

namespace macfx {
// Only the existing nil/default MTLCompileOptions profile is accepted. Device
// object identity and every source byte form the key; retaining the device
// prevents an evicted device's address from identifying a different device.
// Pipelines, functions, parameters and mutable effect resources stay outside.
class MetalLibraryCache {
    struct Entry {
        id<MTLDevice> device;
        std::string source;
        id<MTLLibrary> library=nil;
        NSError *error=nil;
        NSException *exception=nil;
        std::exception_ptr failure;
        std::mutex lock;
        std::condition_variable completion;
        std::atomic<bool> ready{false};
        Entry(id<MTLDevice> gpu,const std::string &text):device(gpu),source(text){}
    };
    const size_t maximumEntries,maximumSourceBytes;
    size_t sourceBytes=0;
    std::mutex lock;
    std::list<std::shared_ptr<Entry>> entries;
    bool makeRoom(size_t bytes) {
        if(!maximumEntries||bytes>maximumSourceBytes)return false;
        while(entries.size()>=maximumEntries||sourceBytes>maximumSourceBytes-bytes) {
            auto found=entries.end();
            for(auto i=entries.end();i!=entries.begin();) {
                --i;if((*i)->ready.load(std::memory_order_acquire)){found=i;break;}
            }
            // An admitted compilation keeps its single-flight identity until
            // completion. Capacity pressure falls back to an uncached call.
            if(found==entries.end())return false;
            sourceBytes-=(*found)->source.size();entries.erase(found);
        }
        return true;
    }
    static id<MTLLibrary> compile(id<MTLDevice> device,const std::string &source,NSError **error) {
        return [device newLibraryWithSource:[NSString stringWithUTF8String:source.c_str()] options:nil error:error];
    }
public:
    explicit MetalLibraryCache(size_t count=128,size_t bytes=32*1024*1024):maximumEntries(count),maximumSourceBytes(bytes){}
    id<MTLLibrary> library(id<MTLDevice> device,const std::string &source,NSError **error) {
        if(error)*error=nil;
        std::shared_ptr<Entry> entry;bool owner=false;
        {
            std::lock_guard<std::mutex> guard(lock);
            for(auto i=entries.begin();i!=entries.end();++i)if((*i)->device==device&&(*i)->source==source) {
                entry=*i;entries.splice(entries.begin(),entries,i);break;
            }
            if(!entry&&makeRoom(source.size())) {
                entry=std::make_shared<Entry>(device,source);entries.push_front(entry);
                sourceBytes+=source.size();owner=true;
            }
        }
        if(!entry)return compile(device,source,error);
        if(owner) {
            id<MTLLibrary> library=nil;NSError *failure=nil;NSException *exception=nil;std::exception_ptr cppFailure;
            // Metal compilation holds neither the cache lock nor an entry lock.
            // Unrelated keys/hits and other devices can continue concurrently.
            @try {try{library=compile(device,source,&failure);}catch(...){cppFailure=std::current_exception();}}
            @catch(NSException *caught){exception=caught;}
            {
                std::lock_guard<std::mutex> guard(entry->lock);
                entry->library=library;entry->error=failure;entry->exception=exception;entry->failure=cppFailure;
                entry->ready.store(true,std::memory_order_release);
            }
            if(!library) {
                std::lock_guard<std::mutex> guard(lock);
                for(auto i=entries.begin();i!=entries.end();++i)if(*i==entry) {
                    sourceBytes-=entry->source.size();entries.erase(i);break;
                }
            }
            entry->completion.notify_all();
        }
        std::unique_lock<std::mutex> guard(entry->lock);
        entry->completion.wait(guard,[&]{return entry->ready.load(std::memory_order_acquire);});
        if(entry->failure)std::rethrow_exception(entry->failure);
        if(entry->exception)@throw entry->exception;
        if(error)*error=entry->error;
        return entry->library;
    }
};
inline id<MTLLibrary> cachedMetalLibrary(id<MTLDevice> device,const std::string &source,NSError **error) {
    static MetalLibraryCache cache;
    return cache.library(device,source,error);
}
}
