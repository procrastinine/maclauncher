// Copyright (c) MacLauncher contributors. MIT license.
#import <Foundation/Foundation.h>
#include "effects-plan.hpp"
#include "resolution-scale.hpp"
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
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
void publish(NSString *path,NSString *mode,NSArray *nodes){
    NSDictionary *root=@{@"schema":@1,@"mode":mode,@"revision":hex(@"c"),@"nodes":nodes};
    NSData *bytes=[NSJSONSerialization dataWithJSONObject:root options:0 error:nil];assert(bytes&&[bytes writeToFile:path atomically:YES]);
    std::this_thread::sleep_for(std::chrono::milliseconds(110));
}
}
int main(){@autoreleasepool {
    macfx::ShaderFrame unknownFrame{};assert(unknownFrame.opaqueDisplay);
    auto opaqueFrame=unknownFrame;opaqueFrame.opaqueDisplay=true;assert(opaqueFrame.opaqueDisplay);
    auto transparentFrame=unknownFrame;transparentFrame.opaqueDisplay=false;assert(!transparentFrame.opaqueDisplay);
    // Registered before the first global plan lookup, this runs after any
    // destructible function-static plan reader would already be destroyed.
    const int lateLookup=std::atexit(+[]{if(macfx::effectPlanMode()!=0)std::abort();std::puts("effects plan late shutdown lookup: pass");});assert(lateLookup==0);
    char scratch[]="/tmp/maclauncher-effects-plan-XXXXXX";assert(mkdtemp(scratch));
    NSString *directory=[NSString stringWithUTF8String:scratch];NSString *path=[directory stringByAppendingPathComponent:@"plan.json"];
    unsetenv("RESHADE_EFFECT_PLAN");assert(!macfx::effectPlanRequested());assert(macfx::effectPlanMode()==0);
    macfx::EffectPlanState absent;auto result=absent.poll();assert(!result.active&&!result.valid&&!absent.snapshot());
    setenv("RESHADE_EFFECT_PLAN",path.fileSystemRepresentation,1);assert(macfx::effectPlanRequested());
    macfx::EffectPlanState state;result=state.poll();assert(!result.valid&&!result.error.empty());assert(macfx::effectPlanMode()==0);
    NSMutableDictionary *many=[NSMutableDictionary dictionary];for(unsigned i=0;i<4096;++i)many[[NSString stringWithFormat:@"Parameter%u",i]]=@[@1,@2];
    auto first=shader(@"first",many);auto second=shader(@"second",@{@"Gain":@[@3]});
    NSDictionary *spatial=@{@"id":@"scale",@"kind":@"spatial",@"enabled":@YES,@"method":@"ls1",@"modelPath":@"/private/prepared/model-a.bin",@"settings":@{@"scale":@2,@"hdr":@NO,@"tag":@"first",@"unused":NSNull.null},@"requirements":@{@"depth":@NO,@"motion":@NO}};
    NSDictionary *generation=@{@"id":@"generate",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"lsfg",@"modelPath":@"/private/prepared/model-b.bin",@"settings":@{}};
    NSDictionary *disabled=@{@"id":@"disabled",@"kind":@"shader",@"enabled":@NO};
    publish(path,@"advanced",@[first,second,spatial,generation,disabled,@{@"id":@"off-scale",@"kind":@"spatial",@"enabled":@NO}]);
    result=state.poll();assert(result.active&&result.valid&&result.changed&&result.error.empty());assert(macfx::effectPlanMode()==1);auto snapshot=state.snapshot();assert(snapshot->mode=="advanced"&&snapshot->nodes.size()==6);
    assert(snapshot->nodes[0].shader.parameters.size()==4096);assert(snapshot->nodes[2].modelPath=="/private/prepared/model-a.bin"&&snapshot->nodes[3].modelPath=="/private/prepared/model-b.bin");
    assert(snapshot->nodes[2].settings.number("scale")==2&&!snapshot->nodes[2].settings.boolean("hdr",true)&&snapshot->nodes[2].settings.string("tag")=="first");
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
    unsigned created=0;auto factory=[&](const macfx::EffectPlanNode &node){++created;return std::make_shared<Fake>(node.shader.parameters);};
    auto a=state.shader(snapshot->nodes[0],factory),b=state.shader(snapshot->nodes[1],factory);assert(created==2&&a!=b&&state.shader(snapshot->nodes[0],factory)==a);
    bool rejected=false;try{state.shader(snapshot->nodes[4],factory);}catch(const std::exception&){rejected=true;}assert(rejected&&created==2);
    macfx::EffectPlanState independent;assert(independent.poll().active);assert(independent.shader(independent.snapshot()->nodes[0],factory)!=a&&created==3);
    first[@"parameters"]=@{@"Gain":@[@4],[@"" stringByPaddingToLength:512 withString:@"Uniform" startingAtIndex:0]:@[@5]};publish(path,@"advanced",@[second,first]);assert(state.poll().changed);snapshot=state.snapshot();assert(snapshot->nodes[0].id=="second"&&state.shader(snapshot->nodes[0],factory)==b);assert(state.shader(snapshot->nodes[1],factory)==a&&std::static_pointer_cast<Fake>(a)->updates==1&&created==3);
    assert([@"{broken" writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil]);std::this_thread::sleep_for(std::chrono::milliseconds(110));result=state.poll();assert(result.active&&result.valid&&!result.changed&&!result.error.empty()&&state.snapshot()==snapshot);assert(macfx::effectPlanMode()==1);
    first[@"revision"]=hex(@"d");publish(path,@"advanced",@[first]);assert(state.poll().changed);auto replacement=state.shader(state.snapshot()->nodes[0],factory);assert(replacement!=a&&created==4);assert(std::static_pointer_cast<Fake>(a)->values.at("Gain")[0]==4);
    publish(path,@"simple",@[]);result=state.poll();assert(result.valid&&!result.active&&result.changed&&state.snapshot()->mode=="simple");assert(macfx::effectPlanMode()==0);
    publish(path,@"advanced",@[]);result=state.poll();assert(result.valid&&result.active&&state.snapshot()->nodes.empty());assert(macfx::effectPlanMode()==2);
    publish(path,@"advanced",@[disabled]);result=state.poll();assert(result.active&&state.snapshot()->nodes.size()==1&&macfx::effectPlanMode()==2);
    NSMutableDictionary *invalid=[spatial mutableCopy];invalid[@"modelPath"]=@"relative/model.bin";publish(path,@"advanced",@[invalid]);result=state.poll();assert(result.valid&&result.active&&!result.changed&&!result.error.empty()&&state.snapshot()->nodes.size()==1);assert(macfx::effectPlanMode()==2);
    NSMutableDictionary *sized=[spatial mutableCopy];sized[@"outputSize"]=@{@"width":@854,@"height":@480};publish(path,@"advanced",@[sized]);result=state.poll();assert(result.changed&&result.error.empty());snapshot=state.snapshot();assert(snapshot->nodes[0].outputWidth==854&&snapshot->nodes[0].outputHeight==480);
    for(NSDictionary *bad in @[@{@"width":@0,@"height":@480},@{@"width":@854.5,@"height":@480},@{@"width":@854},@{@"width":@YES,@"height":@480},@{@"width":@16385,@"height":@480}]){
        sized[@"outputSize"]=bad;publish(path,@"advanced",@[sized]);result=state.poll();assert(!result.changed&&!result.error.empty()&&state.snapshot()==snapshot);
    }
    sized[@"method"]=@"downsample";sized[@"outputSize"]=@{@"height":@480};publish(path,@"advanced",@[sized]);result=state.poll();assert(result.changed&&result.error.empty());snapshot=state.snapshot();assert(!snapshot->nodes[0].outputWidth&&snapshot->nodes[0].outputHeight==480);
    for(NSDictionary *bad in @[@{},@{@"height":@YES},@{@"width":@0}]){sized[@"outputSize"]=bad;publish(path,@"advanced",@[sized]);result=state.poll();assert(!result.changed&&!result.error.empty()&&state.snapshot()==snapshot);}
    [sized removeObjectForKey:@"outputSize"];sized[@"presentationScale"]=@0.5;publish(path,@"advanced",@[sized]);result=state.poll();assert(result.changed&&result.error.empty());snapshot=state.snapshot();assert(snapshot->nodes[0].presentationScale==.5);
    for(id bad in @[@0,@17,@YES,NSNull.null]){sized[@"presentationScale"]=bad;publish(path,@"advanced",@[sized]);result=state.poll();assert(!result.changed&&!result.error.empty()&&state.snapshot()==snapshot);}
    sized[@"presentationScale"]=@.5;sized[@"resolutionAuto"]=@YES;publish(path,@"advanced",@[sized]);result=state.poll();assert(result.changed&&result.error.empty());snapshot=state.snapshot();assert(snapshot->nodes[0].resolutionAuto);
    for(id bad in @[@NO,@1,NSNull.null]){sized[@"resolutionAuto"]=bad;publish(path,@"advanced",@[sized]);result=state.poll();assert(!result.changed&&!result.error.empty()&&state.snapshot()==snapshot);}
    sized[@"resolutionAuto"]=@YES;sized[@"outputSize"]=@{@"height":@480};publish(path,@"advanced",@[sized]);result=state.poll();assert(!result.changed&&!result.error.empty()&&state.snapshot()==snapshot);
    [sized removeObjectForKey:@"outputSize"];sized[@"method"]=@"bilinear";publish(path,@"advanced",@[sized]);result=state.poll();assert(!result.changed&&!result.error.empty()&&state.snapshot()==snapshot);
    NSMutableDictionary *neural=[@{@"id":@"restore",@"kind":@"neural",@"enabled":@YES,@"method":@"mlx-dlss",@"modelPath":@"/private/models/local",@"settings":@{@"intensity":@0.7,@"temporal":@NO}} mutableCopy];
    publish(path,@"advanced",@[neural]);result=state.poll();assert(result.changed&&result.error.empty());snapshot=state.snapshot();assert(snapshot->nodes[0].kind=="neural"&&snapshot->nodes[0].settings.number("intensity")==.7&&!snapshot->nodes[0].settings.boolean("temporal"));
    for(NSDictionary *bad in @[@{@"intensity":@2.1},@{@"intensity":@YES},@{@"temporal":@1}]){
        neural[@"settings"]=bad;publish(path,@"advanced",@[neural]);result=state.poll();assert(!result.changed&&!result.error.empty()&&state.snapshot()==snapshot);
    }
    NSMutableDictionary *scaled=shader(@"scaled",@{});scaled[@"outputScale"]=@{@"x":@2,@"y":@0.5};publish(path,@"advanced",@[scaled]);result=state.poll();assert(result.changed&&result.error.empty());snapshot=state.snapshot();assert(snapshot->nodes[0].outputScaleX==2&&snapshot->nodes[0].outputScaleY==.5);
    for(NSDictionary *bad in @[@{@"x":@0,@"y":@1},@{@"x":@1,@"y":@17},@{@"x":@1},@{@"x":@YES,@"y":@1}]){
        scaled[@"outputScale"]=bad;publish(path,@"advanced",@[scaled]);result=state.poll();assert(!result.changed&&!result.error.empty()&&state.snapshot()==snapshot);
    }
    [scaled removeObjectForKey:@"outputScale"];scaled[@"outputExtent"]=@"presentation";publish(path,@"advanced",@[scaled]);result=state.poll();assert(result.changed&&result.error.empty());snapshot=state.snapshot();assert(snapshot->nodes[0].outputPresentation);
    scaled[@"outputExtent"]=@"input";publish(path,@"advanced",@[scaled]);result=state.poll();assert(!result.changed&&!result.error.empty()&&state.snapshot()==snapshot);
    neural[@"settings"]=@{@"temporal":@YES};publish(path,@"advanced",@[generation,neural]);result=state.poll();assert(!result.changed&&!result.error.empty()&&state.snapshot()==snapshot);
    publish(path,@"advanced",@[neural,generation]);result=state.poll();assert(result.changed&&result.error.empty());
    neural[@"settings"]=@{@"temporal":@NO};publish(path,@"advanced",@[generation,neural]);result=state.poll();assert(result.changed&&result.error.empty());
    NSString *link=[directory stringByAppendingPathComponent:@"link.json"];assert(!symlink(path.fileSystemRepresentation,link.fileSystemRepresentation));setenv("RESHADE_EFFECT_PLAN",link.fileSystemRepresentation,1);macfx::EffectPlanState linked;result=linked.poll();assert(!result.valid&&!result.error.empty());
    unsetenv("RESHADE_EFFECT_PLAN");std::this_thread::sleep_for(std::chrono::milliseconds(110));assert(macfx::effectPlanMode()==0);assert([[NSFileManager defaultManager] removeItemAtPath:directory error:nil]);
    std::puts("effects plan parser/state: pass");return 0;
}}
