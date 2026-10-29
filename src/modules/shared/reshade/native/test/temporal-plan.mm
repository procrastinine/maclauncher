// Copyright (c) MacLauncher contributors. MIT license.
#import <Foundation/Foundation.h>
#include "fixture-files.hpp"
#include "process-phase.hpp"
#include "temporal-plan.hpp"
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <thread>
#include <unistd.h>

extern "C" uint32_t rsGetSceneAovDemand(uint32_t version);
static void require(bool value,const char *reason){if(!value)throw std::runtime_error(reason);}
// A failure exits with status 1 rather than aborting, so it raises no crash report.
static void lateCheck(){
    if(!macfx::temporalPlanRequested()){std::fputs("Linked temporal reader lost its plan at shutdown\n",stderr);std::fflush(stderr);std::_Exit(1);}
    std::puts("Linked temporal reader late shutdown: pass");
}
// The plan file is a launch setting, so each launch environment is a phase.
int main(int argc,char **argv){@autoreleasepool{try{
    const auto phase=fixture::phase(argc,argv);
    if(phase.name.empty()){
        char scratch[1024];temporaryPath(scratch,"maclauncher-linked-plan-XXXXXX");
        require(mkdtemp(scratch)!=nullptr,"Cannot create plan directory");
        NSString *directory=[NSString stringWithUTF8String:scratch];
        int status=fixture::runPhase("absent",{{"RESHADE_EFFECT_PLAN",nullptr}});
        // The legacy temporal selection must not add attachment demand to a plan.
        if(!status)status=fixture::runPhase("plan",{{"RESHADE_EFFECT_PLAN",[directory stringByAppendingPathComponent:@"plan.json"].fileSystemRepresentation},
            {"RESHADE_TEMPORAL_METHOD","metalfx-denoised"}},{directory.UTF8String});
        require([[NSFileManager defaultManager] removeItemAtPath:directory error:nil],"Cannot remove plan directory");
        if(!status)std::puts("Linked effect-plan parser/temporal reader: pass");
        return status;
    }
    if(phase.name=="absent"){require(!macfx::temporalPlanRequested(),"Absent plan requests temporal processing");return 0;}
    require(phase.name=="plan"&&phase.argc==2,"Unknown phase");
    require(std::atexit(lateCheck)==0,"Cannot register shutdown check");
    NSString *path=[[NSString stringWithUTF8String:phase.argv[1]] stringByAppendingPathComponent:@"plan.json"];
    NSString *hash=[@"" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0];
    const auto check=[&](NSString *mode,NSArray *nodes,bool expected){
        NSDictionary *plan=@{@"schema":@1,@"revision":hash,@"mode":mode,@"nodes":nodes};
        NSData *bytes=[NSJSONSerialization dataWithJSONObject:plan options:0 error:nil];
        require(replaceFile(bytes,path),"Cannot publish plan");
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
    check(@"advanced",@[disabled,temporal],true);
    std::atomic<bool> concurrent{true};
    const auto lookup=[&]{for(unsigned i=0;i<100;++i)if(!macfx::temporalPlanRequested())concurrent.store(false);};
    std::thread first(lookup),second(lookup);first.join();second.join();
    require(concurrent.load(),"Concurrent temporal readers disagree");
    require(rsGetSceneAovDemand(1)==0,"A plan without attachment rows demands legacy attachments");
    auto attachments=@{@"id":@"attachments",@"kind":@"shader",@"enabled":@YES,@"format":@"fx",@"file":@"/prepared/effect.json",@"key":hash,@"revision":hash,
        @"requirements":@{@"depth":@NO,@"motion":@NO,@"sceneAovs":@[@"normal"]}};
    check(@"advanced",@[attachments],true);
    const auto demanded=rsGetSceneAovDemand(1);require(demanded&&!(demanded&(demanded-1)),"A plan row's attachment is not its only demand");
    check(@"advanced",@[shader],false);require(rsGetSceneAovDemand(1)==0,"Attachment demand outlived its plan row");
    // The late shutdown check reads a temporal plan.
    check(@"advanced",@[disabled,temporal],true);
    return 0;
}catch(const std::exception &error){std::fprintf(stderr,"%s\n",error.what());return 1;}}}
