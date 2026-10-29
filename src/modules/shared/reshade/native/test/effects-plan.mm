// Copyright (c) MacLauncher contributors. MIT license.
#import <Foundation/Foundation.h>
#include "fixture-files.hpp"
#include "process-phase.hpp"
#include "effects-plan.hpp"
#include "resolution-scale.hpp"
#include "scene-frame.h"
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>

namespace macfx {
std::shared_ptr<ShaderNode> makeShaderNode(const ShaderSpec &) { return nullptr; }
}
namespace {
struct Fake final:macfx::ShaderNode {
    macfx::ShaderParameters values;
    unsigned updates=0;
    explicit Fake(const macfx::ShaderParameters &value):values(value){}
    void setParameters(const macfx::ShaderParameters &value)override {values=value;++updates;}
    macfx::ShaderResult prepare(const macfx::ShaderFrame &)override {return {true,{},false};}
    macfx::ShaderResult encode(const macfx::ShaderFrame &)override {return {false,"No GPU encoding in parser checks",false};}
};
NSString *hex(NSString *c){return [@"" stringByPaddingToLength:64 withString:c startingAtIndex:0];}
NSMutableDictionary *shader(NSString *id,NSDictionary *parameters){return [@{@"id":id,@"kind":@"shader",@"enabled":@YES,@"format":@"fx",@"file":@"/private/prepared/effect.json",@"key":hex(@"a"),@"revision":hex(@"b"),@"parameters":parameters,@"preservesCoordinates":@YES} mutableCopy];}
void publishDocument(NSString *path,NSDictionary *root){
    NSData *bytes=[NSJSONSerialization dataWithJSONObject:root options:0 error:nil];assert(replaceFile(bytes,path));
    std::this_thread::sleep_for(std::chrono::milliseconds(110));
}
void publish(NSString *path,NSString *mode,NSArray *nodes){publishDocument(path,@{@"schema":@1,@"mode":mode,@"revision":hex(@"c"),@"nodes":nodes});}
// A rejected row stays in place as a disabled row with its reason; the plan
// itself is accepted. With no other row enabled the plan passes frames through.
bool bypassed(macfx::EffectPlanState &state,const char *id){
    const auto result=state.poll();const auto snapshot=state.snapshot();
    return result.valid&&result.active&&result.changed&&result.error.empty()&&snapshot&&snapshot->nodes.size()==1&&snapshot->nodes[0].id==id&&
        !snapshot->nodes[0].enabled&&!snapshot->nodes[0].rejection.empty()&&macfx::effectPlanMode()==2;
}
int lateMode=-1;
// Polls the process reader until done() holds; returns the seconds waited.
double until(macfx::EffectPlanState &state,double seconds,const char *what,const std::function<bool(const macfx::EffectPlanPoll&,const macfx::EffectPlanSnapshot*)> &done){
    const auto start=std::chrono::steady_clock::now();
    for(;;){
        const auto result=state.poll();const auto waited=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
        if(done(result,state.snapshot().get()))return waited;
        if(waited>seconds){std::fprintf(stderr,"Plan reader did not reach %s within %.1f s\n",what,seconds);std::_Exit(1);}
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
}
NSData *document(NSString *revision){return [NSJSONSerialization dataWithJSONObject:@{@"schema":@1,@"mode":@"advanced",@"revision":hex(revision),@"nodes":@[shader(@"row",@{})]} options:0 error:nil];}
// Deletion, atomic replacement, a refused open and a replaced directory under
// the running reader. Each recovers within the launch through events and
// bounded retries, well inside the two-second safety tick.
int watch(NSString *directory){
    NSString *path=[directory stringByAppendingPathComponent:@"plan.json"];
    const auto applied=[](NSString *revision){const std::string expected=hex(revision).UTF8String;
        return [expected](const macfx::EffectPlanPoll &result,const macfx::EffectPlanSnapshot *snapshot){return result.error.empty()&&snapshot&&snapshot->revision==expected;};};
    macfx::EffectPlanState state;until(state,1,"the launch plan",applied(@"1"));
    assert(!unlink(path.fileSystemRepresentation));
    until(state,1,"the deleted plan",[](const auto &result,const auto *snapshot){return result.error=="Effect plan is unavailable"&&snapshot&&snapshot->revision==std::string(64,'1');});
    assert(!macfx::effectPlanReadDenied());
    assert(replaceFile(document(@"2"),path));const double replaced=until(state,1,"the replacement",applied(@"2"));
    assert(replaceFile(document(@"3"),path));until(state,1,"the next edit",applied(@"3"));
    // A refused open keeps the accepted plan; the unchanged file then reads
    // again without a stale error.
    assert(!chmod(directory.fileSystemRepresentation,0));macfx::refreshEffectPlan();
    auto result=state.poll();assert(result.error=="Effect plan is unavailable"&&macfx::effectPlanReadDenied()&&state.snapshot()->revision==std::string(64,'3'));
    assert(!chmod(directory.fileSystemRepresentation,0700));
    const double recovered=until(state,1,"recovery of the unchanged plan",applied(@"3"));assert(!macfx::effectPlanReadDenied());
    // A replaced directory: the watcher is armed again on the new directory.
    NSString *moved=[directory stringByAppendingString:@".moved"];
    assert(!rename(directory.fileSystemRepresentation,moved.fileSystemRepresentation)&&!mkdir(directory.fileSystemRepresentation,0700));
    assert(replaceFile(document(@"4"),path));const double rearmed=until(state,1,"the plan in the replaced directory",applied(@"4"));
    assert(replaceFile(document(@"5"),path));const double next=until(state,1,"the next edit after the replaced directory",applied(@"5"));
    assert([[NSFileManager defaultManager] removeItemAtPath:moved error:nil]);
    std::printf("effects plan watch: replacement %.3f s, refused-open recovery %.3f s, replaced directory %.3f s then %.3f s: pass\n",replaced,recovered,rearmed,next);
    return 0;
}
void sizes(){
    macfx::EffectPlanNode resize;resize.kind="spatial";resize.settings.values["spatialMultiplier"]=2.0;
    auto size=macfx::spatialOutputSize(resize,{480,270},{1920,1080});assert(size.width==960&&size.height==540);
    resize.settings.values["spatialMultiplier"]=4.0;size=macfx::spatialOutputSize(resize,{480,270},{1920,1080});assert(size.width==1920&&size.height==1080);
    resize.settings.values["spatialMultiplier"]=2.0;size=macfx::spatialOutputSize(resize,{480,270},{1920,1080});
    size=macfx::spatialOutputSize(resize,size,{1920,1080});assert(size.width==1920&&size.height==1080);
    resize.settings.values["spatialMultiplier"]=1.5;size=macfx::spatialOutputSize(resize,{853,479},{1920,1080});assert(size.width==1280&&size.height==719);
    resize.settings.values["spatialMultiplier"]=std::monostate{};size=macfx::spatialOutputSize(resize,{480,270},{1920,1080});assert(size.width==1920&&size.height==1080);
    resize.outputWidth=854;resize.outputHeight=480;resize.settings.values["spatialMultiplier"]=2.0;
    size=macfx::spatialOutputSize(resize,{1920,1080},{1920,1080});assert(size.width==854&&size.height==480);
    resize.outputWidth=resize.outputHeight=0;bool excessive=false;try{macfx::spatialOutputSize(resize,{9000,9000},{1920,1080});}catch(const std::exception&){excessive=true;}assert(excessive);
    resize.method="downsample";resize.settings.values.clear();size=macfx::spatialOutputSize(resize,{1920,1080},{1920,1080});assert(size.width==960&&size.height==540);
    resize.settings.values["spatialMultiplier"]=2.0/3;size=macfx::spatialOutputSize(resize,{1920,1080},{1920,1080});assert(size.width==1280&&size.height==720);
    resize.outputHeight=480;size=macfx::spatialOutputSize(resize,{2560,1080},{2560,1080});assert(size.width==1138&&size.height==480);
    size=macfx::spatialOutputSize(resize,{720,1280},{720,1280});assert(size.width==270&&size.height==480);
    size=macfx::spatialOutputSize(resize,{640,360},{1920,1080});assert(size.width==640&&size.height==360);
    resize.outputHeight=0;resize.outputWidth=500;size=macfx::spatialOutputSize(resize,{1920,1080},{1920,1080});assert(size.width==500&&size.height==282);
    resize.outputWidth=0;
    resize.presentationScale=.5;resize.settings.values["spatialMultiplier"]=.25;
    size=macfx::spatialOutputSize(resize,{1920,1080},{1920,1080});assert(size.width==960&&size.height==540);
    size=macfx::spatialOutputSize(resize,{1920,1080},{3840,2160});assert(size.width==1920&&size.height==1080);
    size=macfx::spatialOutputSize(resize,{854,480},{1920,1080});assert(size.width==854&&size.height==480);
    size=macfx::spatialOutputSize(resize,{640,360},{1920,1080});assert(size.width==640&&size.height==360);
    size=macfx::spatialOutputSize(resize,{2560,1080},{1920,1080});assert(size.width==960&&size.height==405);
    size=macfx::spatialOutputSize(resize,{720,1280},{1920,1080});assert(size.width==304&&size.height==540);
    resize.outputHeight=480;size=macfx::spatialOutputSize(resize,{1920,1080},{1920,1080});assert(size.width==854&&size.height==480);
    resize.outputHeight=0;resize.method="bilinear";size=macfx::spatialOutputSize(resize,{640,360},{1920,1080});assert(size.width==960&&size.height==540);
    resize.presentationScale=0;
    resize.method="downsample";resize.outputWidth=3840;resize.outputHeight=2160;size=macfx::spatialOutputSize(resize,{1920,1080},{3840,2160});assert(size.width==1920&&size.height==1080);
    resize.outputWidth=3840;resize.outputHeight=720;size=macfx::spatialOutputSize(resize,{1920,1080},{3840,2160});assert(size.width==1920&&size.height==720);
    resize.outputWidth=resize.outputHeight=0;resize.settings.values["spatialMultiplier"]=3.0;size=macfx::spatialOutputSize(resize,{854,480},{1920,1080});assert(size.width==854&&size.height==480);
    resize.resolutionAuto=true;resize.presentationScale=.5;
    size=macfx::spatialOutputSize(resize,{1920,1080},{1920,1080});assert(size.width==960&&size.height==540);
    size=macfx::spatialOutputSize(resize,{2560,1440},{2560,1440});assert(size.width==854&&size.height==480);
    size=macfx::spatialOutputSize(resize,{3840,2160},{3840,2160});assert(size.width==960&&size.height==540);
    size=macfx::spatialOutputSize(resize,{3024,1964},{3024,1964});assert(size.width==756&&size.height==491);
    size=macfx::spatialOutputSize(resize,{2879,1619},{2879,1619});assert(size.width==960&&size.height==540);
    size=macfx::spatialOutputSize(resize,{1440,2560},{1440,2560});assert(size.width==480&&size.height==854);
    size=macfx::spatialOutputSize(resize,{2560,1080},{1920,1080});assert(size.width==960&&size.height==405);
    size=macfx::spatialOutputSize(resize,{640,360},{3840,2160});assert(size.width==640&&size.height==360);
    size=macfx::spatialOutputSize(resize,{960,540},{3840,2160});assert(size.width==960&&size.height==540);
    size=macfx::spatialOutputSize(resize,{640,360},{640,360});assert(size.width==640&&size.height==360);
    size=macfx::spatialOutputSize(resize,{7680,4320},{7680,4320});assert(size.width==1920&&size.height==1080);
    // Both paths share the physical target. Only processing clamps to pixels
    // already rendered; true source allocation can grow again after resize.
    macfx::RenderSourceRequest automaticSource;automaticSource.automatic=true;
    const auto sourceTarget=macfx::renderSourceSize(automaticSource,7680,4320,640,360);
    assert(sourceTarget.width==1920&&sourceTarget.height==1080);
    size=macfx::spatialOutputSize(resize,{640,360},{7680,4320});assert(size.width==640&&size.height==360);
    resize.resolutionAuto=false;size=macfx::spatialOutputSize(resize,{2560,1440},{2560,1440});assert(size.width==1280&&size.height==720);
}
}
// The plan file is a launch setting, so each launch environment is a phase.
int main(int argc,char **argv){@autoreleasepool {
    const auto phase=fixture::phase(argc,argv);
    if(phase.name.empty()){
        macfx::ShaderFrame unknownFrame{};assert(unknownFrame.opaqueDisplay);
        auto opaqueFrame=unknownFrame;opaqueFrame.opaqueDisplay=true;assert(opaqueFrame.opaqueDisplay);
        auto transparentFrame=unknownFrame;transparentFrame.opaqueDisplay=false;assert(!transparentFrame.opaqueDisplay);
        sizes();
        char scratch[1024];temporaryPath(scratch,"maclauncher-effects-plan-XXXXXX");assert(mkdtemp(scratch));
        NSString *directory=[NSString stringWithUTF8String:scratch];NSString *path=[directory stringByAppendingPathComponent:@"plan.json"];
        NSString *link=[directory stringByAppendingPathComponent:@"link.json"];
        int status=fixture::runPhase("absent",{{"RESHADE_EFFECT_PLAN",nullptr}});
        if(!status)status=fixture::runPhase("plan",{{"RESHADE_EFFECT_PLAN",path.fileSystemRepresentation}},{directory.UTF8String});
        // A relaunch reads the existing plan before its first consumer returns.
        if(!status)status=fixture::runPhase("relaunch",{{"RESHADE_EFFECT_PLAN",path.fileSystemRepresentation}});
        if(!status){assert(!symlink(path.fileSystemRepresentation,link.fileSystemRepresentation));status=fixture::runPhase("link",{{"RESHADE_EFFECT_PLAN",link.fileSystemRepresentation}});}
        NSString *watched=[directory stringByAppendingPathComponent:@"watch"];
        if(!status){assert(!mkdir(watched.fileSystemRepresentation,0700)&&replaceFile(document(@"1"),[watched stringByAppendingPathComponent:@"plan.json"]));
            status=fixture::runPhase("watch",{{"RESHADE_EFFECT_PLAN",[watched stringByAppendingPathComponent:@"plan.json"].fileSystemRepresentation}},{watched.UTF8String});}
        assert([[NSFileManager defaultManager] removeItemAtPath:directory error:nil]);
        if(!status)std::puts("effects plan parser/state: pass");
        return status;
    }
    if(phase.name=="absent"){
        assert(!macfx::effectPlanRequested());assert(macfx::effectPlanMode()==0);assert(!macfx::currentEffectPlan());
        assert(!macfx::effectPlanDemand().flags&&!macfx::effectPlanSceneFrameDemand()&&!macfx::effectPlanSceneAovDemand());
        macfx::EffectPlanState absent;auto result=absent.poll();assert(!result.active&&!result.valid&&!absent.snapshot());
        return 0;
    }
    if(phase.name=="relaunch"){
        macfx::EffectPlanState state;const auto result=state.poll();assert(result.valid&&result.active&&result.error.empty()&&state.snapshot()->nodes.size()==1&&!state.snapshot()->nodes[0].rejection.empty());
        assert(macfx::effectPlanMode()==2);return 0;
    }
    if(phase.name=="watch"){assert(phase.argc==2);return watch([NSString stringWithUTF8String:phase.argv[1]]);}
    if(phase.name=="link"){
        assert(macfx::effectPlanRequested());
        macfx::EffectPlanState linked;const auto result=linked.poll();assert(!result.valid&&!result.error.empty());assert(macfx::effectPlanMode()==0);return 0;
    }
    assert(phase.name=="plan"&&phase.argc==2);
    // Registered before the first plan lookup, this runs during static
    // destruction; the process reader is never destroyed.
    const int lateLookup=std::atexit(+[]{if(macfx::effectPlanMode()!=lateMode){std::fputs("Effects plan mode changed at late shutdown\n",stderr);std::fflush(stderr);std::_Exit(1);}std::puts("effects plan late shutdown lookup: pass");});assert(lateLookup==0);
    NSString *path=[[NSString stringWithUTF8String:phase.argv[1]] stringByAppendingPathComponent:@"plan.json"];
    assert(macfx::effectPlanRequested());
    macfx::EffectPlanState state;auto result=state.poll();assert(!result.valid&&!result.error.empty());assert(macfx::effectPlanMode()==0);
    NSMutableDictionary *many=[NSMutableDictionary dictionary];for(unsigned i=0;i<4096;++i)many[[NSString stringWithFormat:@"Parameter%u",i]]=@[@1,@2];
    auto first=shader(@"first",many);auto second=shader(@"second",@{@"Gain":@[@3]});
    NSDictionary *spatial=@{@"id":@"scale",@"kind":@"spatial",@"enabled":@YES,@"method":@"ls1",@"modelPath":@"/private/prepared/model-a.bin",@"settings":@{@"scale":@2,@"hdr":@NO,@"tag":@"first",@"unused":NSNull.null},@"requirements":@{@"depth":@NO,@"motion":@NO}};
    NSDictionary *generation=@{@"id":@"generate",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"lsfg",@"modelPath":@"/private/prepared/model-b.bin",@"settings":@{}};
    NSDictionary *disabled=@{@"id":@"disabled",@"kind":@"shader",@"enabled":@NO};
    publish(path,@"advanced",@[first,second,spatial,generation,disabled,@{@"id":@"off-scale",@"kind":@"spatial",@"enabled":@NO}]);
    result=state.poll();assert(result.active&&result.valid&&result.changed&&result.error.empty());assert(macfx::effectPlanMode()==1);auto snapshot=state.snapshot();assert(snapshot->mode=="advanced"&&snapshot->nodes.size()==6);
    for(const auto &node:snapshot->nodes)assert(node.rejection.empty());assert(snapshot->outputRejection.empty()&&macfx::currentEffectPlan()==snapshot);
    assert(macfx::effectPlanDemands(macfx::PlanDemandGeneration)&&macfx::effectPlanDemands(macfx::PlanDemandPresentationQueue)&&!macfx::effectPlanDemands(macfx::PlanDemandTemporal)&&!macfx::effectPlanDemands(macfx::PlanDemandDepth));
    assert(snapshot->nodes[0].shader.parameters.size()==4096);assert(snapshot->nodes[2].modelPath=="/private/prepared/model-a.bin"&&snapshot->nodes[3].modelPath=="/private/prepared/model-b.bin");
    assert(snapshot->nodes[2].settings.number("scale")==2&&!snapshot->nodes[2].settings.boolean("hdr",true)&&snapshot->nodes[2].settings.string("tag")=="first");
    unsigned created=0;auto factory=[&](const macfx::EffectPlanNode &node){++created;return std::make_shared<Fake>(node.shader.parameters);};
    auto a=state.shader(snapshot->nodes[0],factory),b=state.shader(snapshot->nodes[1],factory);assert(created==2&&a!=b&&state.shader(snapshot->nodes[0],factory)==a);
    bool rejected=false;try{state.shader(snapshot->nodes[4],factory);}catch(const std::exception&){rejected=true;}assert(rejected&&created==2);
    macfx::EffectPlanState independent;assert(independent.poll().active);assert(independent.shader(independent.snapshot()->nodes[0],factory)!=a&&created==3);
    first[@"parameters"]=@{@"Gain":@[@4],[@"" stringByPaddingToLength:512 withString:@"Uniform" startingAtIndex:0]:@[@5]};publish(path,@"advanced",@[second,first]);assert(state.poll().changed);snapshot=state.snapshot();assert(snapshot->nodes[0].id=="second"&&state.shader(snapshot->nodes[0],factory)==b);assert(state.shader(snapshot->nodes[1],factory)==a&&std::static_pointer_cast<Fake>(a)->updates==1&&created==3);
    // One broken row among good rows: each row is validated alone, and the
    // valid rows keep their order, identities and shader instances.
    NSMutableDictionary *relative=shader(@"relative",@{});relative[@"file"]=@"prepared/effect.json";
    publish(path,@"advanced",@[second,relative,@"not a row",@{@"id":@"second",@"kind":@"shader",@"enabled":@YES},@{@"id":@"future",@"kind":@"future-kind",@"enabled":@YES},spatial]);
    result=state.poll();assert(result.active&&result.valid&&result.changed&&result.error.empty());assert(macfx::effectPlanMode()==1);snapshot=state.snapshot();assert(snapshot->nodes.size()==6);
    assert(snapshot->nodes[0].id=="second"&&snapshot->nodes[0].enabled&&snapshot->nodes[0].rejection.empty()&&state.shader(snapshot->nodes[0],factory)==b);
    assert(snapshot->nodes[1].id=="relative"&&snapshot->nodes[1].kind=="shader"&&!snapshot->nodes[1].enabled&&!snapshot->nodes[1].rejection.empty());
    assert(snapshot->nodes[2].id=="row-3"&&snapshot->nodes[2].kind.empty()&&!snapshot->nodes[2].enabled&&!snapshot->nodes[2].rejection.empty());
    assert(snapshot->nodes[3].id=="row-4"&&!snapshot->nodes[3].enabled&&!snapshot->nodes[3].rejection.empty());
    assert(snapshot->nodes[4].id=="future"&&snapshot->nodes[4].kind.empty()&&!snapshot->nodes[4].enabled&&!snapshot->nodes[4].rejection.empty());
    assert(snapshot->nodes[5].id=="scale"&&snapshot->nodes[5].enabled&&snapshot->nodes[5].rejection.empty());
    rejected=false;try{state.shader(snapshot->nodes[1],factory);}catch(const std::exception&){rejected=true;}assert(rejected&&created==3);
    // A corrupt publication while that chain runs keeps it and reports the error.
    assert(replaceFile([@"{broken" dataUsingEncoding:NSUTF8StringEncoding],path));std::this_thread::sleep_for(std::chrono::milliseconds(110));result=state.poll();assert(result.active&&result.valid&&!result.changed&&!result.error.empty()&&state.snapshot()==snapshot);assert(macfx::effectPlanMode()==1);
    assert(macfx::currentEffectPlan()==snapshot);
    // A newer schema is rejected as a whole, whatever its rows contain.
    publishDocument(path,@{@"schema":@2,@"mode":@"advanced",@"revision":hex(@"e"),@"nodes":@[],@"future":@YES});result=state.poll();
    assert(result.active&&result.valid&&!result.changed&&result.error.find("newer schema")!=std::string::npos&&state.snapshot()==snapshot&&macfx::effectPlanMode()==1);
    NSMutableArray *excessive=[NSMutableArray array];for(unsigned i=0;i<33;++i)[excessive addObject:@{@"id":[NSString stringWithFormat:@"row%u",i],@"kind":@"shader",@"enabled":@NO}];
    publish(path,@"advanced",excessive);result=state.poll();assert(!result.changed&&!result.error.empty()&&state.snapshot()==snapshot);
    // An invalid output block falls back to default output settings; rows still run.
    publishDocument(path,@{@"schema":@1,@"mode":@"advanced",@"revision":hex(@"c"),@"nodes":@[second],@"output":@{@"toneMapping":@"unknown"}});result=state.poll();
    assert(result.changed&&result.error.empty()&&macfx::effectPlanMode()==1);snapshot=state.snapshot();assert(!snapshot->outputRejection.empty()&&snapshot->output.toneMapping=="auto"&&snapshot->nodes[0].enabled);
    first[@"revision"]=hex(@"d");publish(path,@"advanced",@[first]);result=state.poll();assert(result.changed&&result.error.empty());auto replacement=state.shader(state.snapshot()->nodes[0],factory);assert(replacement!=a&&created==4);assert(std::static_pointer_cast<Fake>(a)->values.at("Gain")[0]==4);
    publish(path,@"simple",@[]);result=state.poll();assert(result.valid&&!result.active&&result.changed&&state.snapshot()->mode=="simple");assert(macfx::effectPlanMode()==0&&!macfx::effectPlanDemand().flags);
    publish(path,@"advanced",@[]);result=state.poll();assert(result.valid&&result.active&&state.snapshot()->nodes.empty());assert(macfx::effectPlanMode()==2&&macfx::effectPlanDemands(macfx::PlanDemandPassThrough));
    publish(path,@"advanced",@[disabled]);result=state.poll();assert(result.active&&state.snapshot()->nodes.size()==1&&macfx::effectPlanMode()==2);
    NSMutableDictionary *invalid=[spatial mutableCopy];invalid[@"modelPath"]=@"relative/model.bin";publish(path,@"advanced",@[invalid]);assert(bypassed(state,"scale"));
    assert(state.snapshot()->nodes[0].kind=="spatial"&&state.snapshot()->nodes[0].method=="ls1");
    NSMutableDictionary *sized=[spatial mutableCopy];sized[@"outputSize"]=@{@"width":@854,@"height":@480};publish(path,@"advanced",@[sized]);result=state.poll();assert(result.changed&&result.error.empty());snapshot=state.snapshot();assert(snapshot->nodes[0].outputWidth==854&&snapshot->nodes[0].outputHeight==480);
    for(NSDictionary *bad in @[@{@"width":@0,@"height":@480},@{@"width":@854.5,@"height":@480},@{@"width":@YES,@"height":@480},@{@"width":@16385,@"height":@480}]){
        sized[@"outputSize"]=bad;publish(path,@"advanced",@[sized]);assert(bypassed(state,"scale"));
    }
    sized[@"outputSize"]=@{@"width":@854};publish(path,@"advanced",@[sized]);result=state.poll();assert(result.changed&&result.error.empty());snapshot=state.snapshot();assert(snapshot->nodes[0].outputWidth==854&&!snapshot->nodes[0].outputHeight);
    sized[@"method"]=@"downsample";sized[@"outputSize"]=@{@"height":@480};publish(path,@"advanced",@[sized]);result=state.poll();assert(result.changed&&result.error.empty());snapshot=state.snapshot();assert(!snapshot->nodes[0].outputWidth&&snapshot->nodes[0].outputHeight==480);
    for(NSDictionary *bad in @[@{},@{@"height":@YES},@{@"width":@0}]){sized[@"outputSize"]=bad;publish(path,@"advanced",@[sized]);assert(bypassed(state,"scale"));}
    [sized removeObjectForKey:@"outputSize"];sized[@"presentationScale"]=@0.5;publish(path,@"advanced",@[sized]);result=state.poll();assert(result.changed&&result.error.empty());snapshot=state.snapshot();assert(snapshot->nodes[0].presentationScale==.5);
    for(id bad in @[@0,@17,@YES,NSNull.null]){sized[@"presentationScale"]=bad;publish(path,@"advanced",@[sized]);assert(bypassed(state,"scale"));}
    sized[@"presentationScale"]=@.5;sized[@"resolutionAuto"]=@YES;publish(path,@"advanced",@[sized]);result=state.poll();assert(result.changed&&result.error.empty());snapshot=state.snapshot();assert(snapshot->nodes[0].resolutionAuto);
    for(id bad in @[@NO,@1,NSNull.null]){sized[@"resolutionAuto"]=bad;publish(path,@"advanced",@[sized]);assert(bypassed(state,"scale"));}
    sized[@"resolutionAuto"]=@YES;sized[@"outputSize"]=@{@"height":@480};publish(path,@"advanced",@[sized]);assert(bypassed(state,"scale"));
    [sized removeObjectForKey:@"outputSize"];sized[@"method"]=@"bilinear";publish(path,@"advanced",@[sized]);assert(bypassed(state,"scale"));
    // The chosen filter and the resize direction are independent contracts.
    // Actual Java live editing emitted this form and an older parser silently
    // retained its CRT-only graph because it required method=downsample.
    sized[@"resizeDirection"]=@"downsample";publish(path,@"advanced",@[sized]);result=state.poll();assert(result.changed&&result.error.empty());snapshot=state.snapshot();assert(snapshot->nodes[0].resolutionAuto&&snapshot->nodes[0].method=="bilinear");
    sized[@"method"]=@"area";publish(path,@"advanced",@[sized]);result=state.poll();assert(result.changed&&result.error.empty());assert(state.snapshot()->nodes[0].method=="area");
    NSMutableDictionary *neural=[@{@"id":@"restore",@"kind":@"neural",@"enabled":@YES,@"method":@"mlx-dlss",@"modelPath":@"/private/models/local",@"settings":@{@"intensity":@0.7,@"temporal":@NO}} mutableCopy];
    publish(path,@"advanced",@[neural]);result=state.poll();assert(result.changed&&result.error.empty());snapshot=state.snapshot();assert(snapshot->nodes[0].kind=="neural"&&snapshot->nodes[0].settings.number("intensity")==.7&&!snapshot->nodes[0].settings.boolean("temporal"));
    assert(macfx::effectPlanDemands(macfx::PlanDemandIndependentImageQueue));
    for(NSDictionary *bad in @[@{@"intensity":@2.1},@{@"intensity":@YES},@{@"temporal":@1}]){
        neural[@"settings"]=bad;publish(path,@"advanced",@[neural]);assert(bypassed(state,"restore"));
    }
    NSMutableDictionary *scaled=shader(@"scaled",@{});scaled[@"outputScale"]=@{@"x":@2,@"y":@0.5};publish(path,@"advanced",@[scaled]);result=state.poll();assert(result.changed&&result.error.empty());snapshot=state.snapshot();assert(snapshot->nodes[0].outputScaleX==2&&snapshot->nodes[0].outputScaleY==.5);
    for(NSDictionary *bad in @[@{@"x":@0,@"y":@1},@{@"x":@1,@"y":@17},@{@"x":@1},@{@"x":@YES,@"y":@1}]){
        scaled[@"outputScale"]=bad;publish(path,@"advanced",@[scaled]);assert(bypassed(state,"scaled"));
    }
    [scaled removeObjectForKey:@"outputScale"];scaled[@"outputExtent"]=@"presentation";publish(path,@"advanced",@[scaled]);result=state.poll();assert(result.changed&&result.error.empty());snapshot=state.snapshot();assert(snapshot->nodes[0].outputPresentation);
    scaled[@"outputExtent"]=@"input";publish(path,@"advanced",@[scaled]);assert(bypassed(state,"scaled"));
    neural[@"settings"]=@{@"temporal":@YES};publish(path,@"advanced",@[generation,neural]);result=state.poll();assert(result.changed&&result.error.empty());assert(state.snapshot()->nodes[1].settings.boolean("temporal"));
    assert(!macfx::effectPlanDemands(macfx::PlanDemandIndependentImageQueue));
    publish(path,@"advanced",@[neural,generation]);result=state.poll();assert(result.changed&&result.error.empty());
    neural[@"settings"]=@{@"temporal":@NO};publish(path,@"advanced",@[generation,neural]);result=state.poll();assert(result.changed&&result.error.empty());
    // Demand is derived once per publication; producers read it with one load.
    NSDictionary *temporal=@{@"id":@"temporal",@"kind":@"temporal",@"enabled":@YES,@"method":@"fsr3",@"settings":@{}};
    publish(path,@"advanced",@[second,temporal]);result=state.poll();assert(result.changed&&result.error.empty());
    assert(macfx::effectPlanDemands(macfx::PlanDemandTemporal)&&!macfx::effectPlanDemands(macfx::PlanDemandDepth)&&!macfx::effectPlanDemands(macfx::PlanDemandGeneration));
    assert(macfx::effectPlanSceneFrameDemand()==(RS_SCENE_COLOR|RS_SCENE_DEPTH|RS_SCENE_MOTION|RS_SCENE_JITTER|RS_SCENE_CAMERA));
    NSMutableDictionary *depth=shader(@"depth",@{});depth[@"requirements"]=@{@"depth":@YES};
    publish(path,@"advanced",@[depth]);result=state.poll();assert(result.changed&&result.error.empty());
    assert(macfx::effectPlanDemands(macfx::PlanDemandDepth)&&macfx::effectPlanDemands(macfx::PlanDemandTemporal)&&macfx::effectPlanSceneFrameDemand()==(RS_SCENE_COLOR|RS_SCENE_DEPTH));
    // Projection-bound depth arrives only with a renderer scene. Image frames
    // supply no projection, so they are not asked to copy depth for such a row.
    NSMutableDictionary *projected=shader(@"projected",@{});projected[@"requirements"]=@{@"depth":@YES,@"projectionMatrix":@YES};
    publish(path,@"advanced",@[projected]);result=state.poll();assert(result.changed&&result.error.empty());
    assert(!macfx::effectPlanDemands(macfx::PlanDemandDepth)&&macfx::effectPlanDemands(macfx::PlanDemandTemporal)&&macfx::effectPlanSceneFrameDemand()==(RS_SCENE_COLOR|RS_SCENE_DEPTH|RS_SCENE_PROJECTION_MATRIX));
    publish(path,@"advanced",@[projected,depth]);result=state.poll();assert(result.changed&&result.error.empty()&&macfx::effectPlanDemands(macfx::PlanDemandDepth));
    // Scene frame generation takes depth with motion and camera from its
    // renderer scene; image frames are not asked to copy depth for it.
    NSDictionary *sceneGeneration=@{@"id":@"scene-generation",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"metalfx",@"settings":@{},@"requirements":@{@"depth":@YES,@"motion":@YES,@"camera":@YES}};
    publish(path,@"advanced",@[sceneGeneration]);result=state.poll();assert(result.changed&&result.error.empty());
    assert(!macfx::effectPlanDemands(macfx::PlanDemandDepth)&&macfx::effectPlanDemands(macfx::PlanDemandTemporal)&&macfx::effectPlanDemands(macfx::PlanDemandGeneration)&&
        macfx::effectPlanSceneFrameDemand()==(RS_SCENE_COLOR|RS_SCENE_DEPTH|RS_SCENE_MOTION|RS_SCENE_JITTER|RS_SCENE_CAMERA));
    // A rejected row demands nothing.
    depth[@"file"]=@"relative.json";publish(path,@"advanced",@[depth]);assert(bypassed(state,"depth"));
    assert(!macfx::effectPlanDemands(macfx::PlanDemandDepth)&&!macfx::effectPlanSceneFrameDemand());
    lateMode=2;std::puts("effects plan publication and row rejection: pass");return 0;
}}
