// Copyright (c) MacLauncher contributors. MIT license.
#import <Foundation/Foundation.h>
#include "temporal-plan.hpp"
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <thread>
#include <unistd.h>

static void require(bool value,const char *reason){if(!value)throw std::runtime_error(reason);}
static char *lateDirectory=nullptr;
static void lateCheck(){@autoreleasepool{
    if(!lateDirectory)return;
    if(!macfx::temporalPlanRequested())std::abort();
    unsetenv("RESHADE_EFFECT_PLAN");
    if(![[NSFileManager defaultManager] removeItemAtPath:[NSString stringWithUTF8String:lateDirectory] error:nil])std::abort();
    std::free(lateDirectory);std::puts("Linked temporal reader late shutdown: pass");
}}
int main(){@autoreleasepool{try{
    require(std::atexit(lateCheck)==0,"Cannot register shutdown check");
    char scratch[]="/tmp/maclauncher-linked-plan-XXXXXX";
    require(mkdtemp(scratch)!=nullptr,"Cannot create plan directory");
    NSString *directory=[NSString stringWithUTF8String:scratch];
    NSString *path=[directory stringByAppendingPathComponent:@"plan.json"];
    NSString *hash=[@"" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0];
    unsetenv("RESHADE_EFFECT_PLAN");
    require(!macfx::temporalPlanRequested(),"Absent plan requests temporal processing");
    const auto check=[&](NSString *mode,NSArray *nodes,bool expected){
        NSDictionary *plan=@{@"schema":@1,@"revision":hash,@"mode":mode,@"nodes":nodes};
        NSData *bytes=[NSJSONSerialization dataWithJSONObject:plan options:0 error:nil];
        require(bytes&&[bytes writeToFile:path atomically:YES],"Cannot publish plan");
        setenv("RESHADE_EFFECT_PLAN",path.fileSystemRepresentation,1);
        std::this_thread::sleep_for(std::chrono::milliseconds(110));
        // Both calls use the linked library. Recompiling the parser into this
        // executable would conceal inconsistent layouts between library units.
        macfx::EffectPlanState reader;const auto result=reader.poll();
        require(result.valid&&result.error.empty(),"Linked parser rejected valid plan");
        auto snapshot=reader.snapshot();
        require(snapshot&&snapshot->nodes.size()==nodes.count,"Linked plan layout differs");
        for(NSUInteger index=0;index<nodes.count;++index)
            require(snapshot->nodes[index].id==[nodes[index][@"id"] UTF8String],"Linked row layout differs");
        require(macfx::temporalPlanRequested()==expected,"Temporal selection differs from plan");
    };
    auto disabled=@{@"id":@"disabled",@"kind":@"shader",@"enabled":@NO};
    auto shader=@{@"id":@"shader",@"kind":@"shader",@"enabled":@YES,@"format":@"fx",@"file":@"/prepared/effect.json",@"key":hash,@"revision":hash};
    auto temporal=@{@"id":@"temporal",@"kind":@"temporal",@"enabled":@YES,@"method":@"metalfx",@"settings":@{}};
    auto offTemporal=@{@"id":@"off-temporal",@"kind":@"temporal",@"enabled":@NO};
    check(@"advanced",@[disabled],false);
    check(@"advanced",@[shader],false);
    check(@"advanced",@[disabled,shader,offTemporal],false);
    check(@"advanced",@[disabled,shader,temporal],true);
    check(@"advanced",@[temporal,shader,disabled],true);
    check(@"advanced",@[],false);
    check(@"simple",@[],false);
    unsetenv("RESHADE_EFFECT_PLAN");
    require(!macfx::temporalPlanRequested(),"Removed plan retains temporal processing");
    check(@"advanced",@[disabled,temporal],true);
    std::atomic<bool> concurrent{true};
    const auto lookup=[&]{for(unsigned i=0;i<100;++i)if(!macfx::temporalPlanRequested())concurrent.store(false);};
    std::thread first(lookup),second(lookup);first.join();second.join();
    require(concurrent.load(),"Concurrent temporal readers disagree");
    lateDirectory=strdup(directory.fileSystemRepresentation);
    require(lateDirectory!=nullptr,"Cannot retain plan directory");
    std::puts("Linked effect-plan parser/temporal reader: pass");return 0;
}catch(const std::exception &error){std::fprintf(stderr,"%s\n",error.what());return 1;}}}
