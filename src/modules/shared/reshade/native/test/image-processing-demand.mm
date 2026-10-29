#include "graphics.hpp"
#include "fixture-files.hpp"
#include "effects-plan.hpp"
#include "spatial.hpp"
#include "live-controls.hpp"
#include "process-phase.hpp"
#import <Foundation/Foundation.h>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <thread>
#include <unistd.h>

namespace macfx {
std::shared_ptr<ShaderNode> makeShaderNode(const ShaderSpec &){assert(false&&"Demand checks must not prepare shader resources");return {};}
}
namespace {
void settled(){std::this_thread::sleep_for(std::chrono::milliseconds(110));}
void controls(NSString *file,unsigned flags=0,unsigned spatial=0,char revision='c'){
    macfx::LivePacket packet{};memcpy(packet.magic,"MLFXCTL2",8);packet.targetHz=60;packet.multiplier=3;
    packet.flags=flags;packet.spatial=spatial;packet.sharpness=.5;packet.lsfgMode=3;packet.flowScale=.5;
    memset(packet.effectKey,'b',64);memset(packet.revision,revision,64);
    assert(replaceFile([NSData dataWithBytes:&packet length:sizeof(packet)],file));settled();
}
void plan(NSString *file,NSString *mode,NSArray *nodes){
    auto document=@{@"schema":@1,@"mode":mode,@"revision":[@"" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0],@"nodes":nodes};
    assert(replaceFile([NSJSONSerialization dataWithJSONObject:document options:0 error:nil],file));settled();
}
void inactive(){
    assert(!macfx::effectRequested());assert(!macfx::imageProcessingRequested());
    assert(!macfx::automaticPresentationNeeded(0,0,0,0));
    assert(!macfx::automaticPresentationNeeded(1920,1080,1920,1080,{true}));
    const auto &graphics=macfx::graphicsEnvironmentView();assert(graphics.spatialMethod=="off"&&!graphics.generation);
}
bool nativeOwned(unsigned w=1920,unsigned h=1080,unsigned W=1920,unsigned H=1080){
    return macfx::automaticPresentationNeeded(w,h,W,H,{true});
}
// Live, plan and model settings are launch settings. Each block runs as a
// phase with its environment; plan and control files carry over between them.
NSDictionary *shader(){
    return @{@"id":@"crt",@"kind":@"shader",@"enabled":@YES,@"format":@"fx",@"file":@"/unused/prepared.fx",
        @"key":[@"" stringByPaddingToLength:64 withString:@"b" startingAtIndex:0],@"revision":[@"" stringByPaddingToLength:64 withString:@"c" startingAtIndex:0],@"parameters":@{}};
}
int launch(const char *name,NSString *directory,const char *model,bool planned=true){
    NSString *control=[directory stringByAppendingPathComponent:@"controls.bin"],*document=[directory stringByAppendingPathComponent:@"plan.json"];
    return fixture::runPhase(name,{{"RESHADE_EXPLICIT_HOST",nullptr},{"RESHADE_EFFECT",nullptr},{"RESHADE_SPATIAL_METHOD",nullptr},{"RESHADE_FRAME_GENERATION",nullptr},
        {"RESHADE_RENDER_HEIGHT",nullptr},{"RESHADE_RENDER_MAX_HEIGHT",nullptr},{"RESHADE_RENDER_MULTIPLIER",nullptr},
        {"RESHADE_CONTROL_FILE",control.fileSystemRepresentation},{"RESHADE_LIVE_EFFECTS",directory.fileSystemRepresentation},
        {"RESHADE_EFFECT_PLAN",planned?document.fileSystemRepresentation:nullptr},{"RESHADE_LOSSLESS_MODEL",model},{"RESHADE_LSFG_MODE","unused-invalid-mode"}},{directory.UTF8String});
}
}
int main(int argc,char**argv){try{@autoreleasepool{
    if(argc==2&&!std::strcmp(argv[1],"--generation-models")){
        for(const std::string method:{"mlx-interpolation","rife","lsfg"}){
            const auto read=[&](const char*key)->std::string{if(!std::strcmp(key,"RESHADE_FRAME_GENERATION"))return method;if(!std::strcmp(key,"RESHADE_LOSSLESS_MODEL"))return "/owned/models/explicit/model.fgmodel";return {};};
            const auto config=macfx::graphicsConfig(read);assert(config.generation&&config.generationMethod==method&&config.generation->modelPath=="/owned/models/explicit/model.fgmodel");
            for(const std::string missing:{"","relative/model.fgmodel"}){bool rejected=false;try{macfx::graphicsConfig([&](const char*key){return !std::strcmp(key,"RESHADE_LOSSLESS_MODEL")?missing:read(key);});}catch(const std::runtime_error&){rejected=true;}assert(rejected);}
        }
        for(const std::string method:{"metalfx","fsr3","xess"}){const auto config=macfx::graphicsConfig([&](const char*key)->std::string{return !std::strcmp(key,"RESHADE_FRAME_GENERATION")?method:"";});assert(config.generation&&config.generation->modelPath.empty());}
        const auto disabled=macfx::graphicsConfig([](const char*key)->std::string{return !std::strcmp(key,"RESHADE_LOSSLESS_MODEL")?"unused-relative-model":"off";});assert(!disabled.generation);
        std::puts("Generation model configuration: image-pair model identity preserved; missing paths rejected; scene and disabled rows remain model-free");return 0;
    }
    const auto phase=fixture::phase(argc,argv);
    if(phase.name.empty()){
        assert(!macfx::imageProcessingRequested());
        // A retained output must read its final same-size source while an off
        // transition drains. Once that reader is gone, all-off remains dormant.
        assert(macfx::imageProcessingRequested(true));assert(!macfx::imageProcessingRequested(false));
        char scratch[1024];temporaryPath(scratch,"maclauncher-image-demand-XXXXXX");assert(mkdtemp(scratch));auto directory=[NSString stringWithUTF8String:scratch];
        // Optional model settings are deliberately invalid. Dormant live support
        // and CRT-only demand must not validate or prepare their resources.
        int status=launch("relative-model",directory,"unused-relative-model");
        if(!status)status=launch("absolute-model",directory,"/unused/no-file-is-opened.dll");
        // A cold Off launch has no legacy model environment; the graph owns it.
        if(!status)status=launch("unbound-model",directory,nullptr);
        if(!status)status=launch("unavailable-model",directory,"relative-unavailable");
        if(!status)status=launch("no-plan",directory,"relative-unavailable",false);
        [NSFileManager.defaultManager removeItemAtPath:directory error:nil];
        if(!status)std::puts("Image demand: dormant hooks, native FX in-place capability, conservative imported/geometry/NN/FG demand, actual color/readability contracts and empty Advanced");
        return status;
    }
    assert(phase.argc==2);auto directory=[NSString stringWithUTF8String:phase.argv[1]];
    auto control=[directory stringByAppendingPathComponent:@"controls.bin"],document=[directory stringByAppendingPathComponent:@"plan.json"];
    if(phase.name=="relative-model"){
    plan(document,@"simple",@[]);controls(control);assert(macfx::graphicsRequested());inactive();
    controls(control,8);assert(macfx::effectRequested()&&macfx::imageProcessingRequested());
    assert(!macfx::graphicsEnvironmentView().requested());
    // Same-size native FX has real image demand, without a second owner. The
    // conservative policy used by CGL/remote/explicit ingress is unchanged.
    assert(!nativeOwned());assert(macfx::automaticPresentationNeeded(1920,1080,1920,1080));
    assert(macfx::automaticPresentationNeeded(1920,1080,1920,1080,{false}));
    assert(!nativeOwned(960,540));assert(!nativeOwned(1920,1080,2880,1620));assert(nativeOwned(0,0));
    controls(control,8,2);assert(nativeOwned()); // FX plus selected scaling.
    controls(control,8);
    auto revision=[directory stringByAppendingPathComponent:[@"" stringByPaddingToLength:64 withString:@"d" startingAtIndex:0]];
    assert([NSFileManager.defaultManager createDirectoryAtPath:revision withIntermediateDirectories:YES attributes:nil error:nil]);
    auto hook=[revision stringByAppendingPathComponent:@"effect.hook"];
    assert(replaceFile([@"//!HOOK MAIN" dataUsingEncoding:NSUTF8StringEncoding],hook));
    controls(control,8,0,'d');assert(nativeOwned()); // Provider-owned geometry.
    controls(control,8);assert(!nativeOwned());
    controls(control);inactive();
    controls(control,0,1);assert(macfx::imageProcessingRequested());assert(macfx::graphicsEnvironmentView().spatialMethod=="bilinear");
    controls(control);inactive();
    }else if(phase.name=="absolute-model"){
    controls(control,1);
    assert(macfx::imageProcessingRequested()&&macfx::graphicsEnvironmentView().generation);
    assert(nativeOwned());controls(control,9);assert(nativeOwned());
    controls(control);inactive();assert(macfx::graphicsRequested());
    assert(macfx::imageProcessingRequested(true));
    }else if(phase.name=="unbound-model"){
    // Actual publication writes controls before the ordered activation pointer.
    controls(control,1);
    const auto transitional=macfx::presentationGraphicsEnvironment();
    assert(!transitional.generation&&transitional.spatialMethod=="off");
    assert(macfx::automaticPresentationNeeded(1920,1080,1920,1080));
    assert(macfx::imageProcessingRequested()); // Demand never parses models.
    controls(control,9,3); // Independent FSR1 plus CRT survives unbound legacy FG.
    const auto independent=macfx::presentationGraphicsEnvironment();
    assert(independent.spatialMethod=="fsr1"&&!independent.generation);
    auto managedFg=@{@"id":@"fg",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"lsfg",
        @"modelPath":@"/owned/models/selected/Lossless.dll",@"settings":@{@"frameMultiplier":@4}};
    plan(document,@"advanced",@[shader(),managedFg]);
    const auto ordered=macfx::presentationGraphicsEnvironment();
    assert(ordered.spatialMethod=="off"&&!ordered.generation&&!ordered.adaptive);
    assert(macfx::imageProcessingRequested());
    }else if(phase.name=="unavailable-model"){
    const auto shader=::shader();
    // Resources remain per-row even when an optional model later fails. The
    // generic constructor must not inspect or initialize that unused model.
    assert(!macfx::presentationGraphicsEnvironment().requested());
    controls(control);plan(document,@"simple",@[]);inactive();
    controls(control,8);assert(!macfx::presentationGraphicsEnvironment().requested());
    assert(macfx::imageProcessingRequested());controls(control);
    plan(document,@"advanced",@[shader]);assert(macfx::imageProcessingRequested());
    assert(macfx::effectPlanNativeFxOnly());assert(!nativeOwned());
    macfx::EffectPlanState heldPlan;assert(heldPlan.poll().valid);const auto heldFx=heldPlan.snapshot();assert(heldFx);
    auto changed=[shader mutableCopy];changed[@"outputScale"]=@{@"x":@2,@"y":@2};
    plan(document,@"advanced",@[changed]);assert(!macfx::effectPlanNativeFxOnly()&&nativeOwned());
    // Held endpoint classification uses its own validated publication, even
    // while another reader now sees a resizing shader in the active file.
    assert(!macfx::automaticPresentationNeeded(1920,1080,1920,1080,{true},*heldFx));
    changed=[shader mutableCopy];changed[@"outputExtent"]=@"presentation";
    plan(document,@"advanced",@[changed]);assert(!macfx::effectPlanNativeFxOnly()&&nativeOwned());
    changed=[shader mutableCopy];changed[@"format"]=@"libplacebo";
    plan(document,@"advanced",@[changed]);assert(!macfx::effectPlanNativeFxOnly()&&nativeOwned());
    changed=[shader mutableCopy];changed[@"format"]=@"slangp";
    plan(document,@"advanced",@[changed]);assert(!macfx::effectPlanNativeFxOnly()&&nativeOwned());
    changed=[shader mutableCopy];changed[@"requirements"]=@{@"depth":@YES};
    plan(document,@"advanced",@[changed]);assert(!macfx::effectPlanNativeFxOnly()&&nativeOwned());
    changed=[shader mutableCopy];changed[@"requirements"]=@{@"motion":@YES};
    plan(document,@"advanced",@[changed]);assert(!macfx::effectPlanNativeFxOnly()&&nativeOwned());
    auto neural=@{@"id":@"reconstruct",@"kind":@"neural",@"enabled":@YES,@"method":@"mlx-dlss",@"modelPath":@"/unused/model",@"settings":@{}};
    plan(document,@"advanced",@[shader,neural]);assert(!macfx::effectPlanNativeFxOnly()&&nativeOwned());
    for(NSString *kind in @[@"spatial",@"temporal",@"frame-generation"]){
        auto required=@{@"id":@"required",@"kind":kind,@"enabled":@YES,@"method":[kind isEqualToString:@"frame-generation"]?@"lsfg":@"fsr1",@"settings":@{}};
        plan(document,@"advanced",@[shader,required]);assert(!macfx::effectPlanNativeFxOnly()&&nativeOwned());
    }
    changed=[neural mutableCopy];changed[@"enabled"]=@NO;
    plan(document,@"advanced",@[shader,changed]);assert(macfx::effectPlanNativeFxOnly()&&!nativeOwned());
    // These are CPU contract checks, not physical-display hold acceptance.
    // Held admission uses these same demand/format predicates with its actual
    // source and owned target, never the old unknown (0,0) dimensions.
    assert(!nativeOwned());assert(!nativeOwned(960,540));
    assert(macfx::nativeFxColorFormatSupported(MTLPixelFormatRGB10A2Unorm));
    assert(macfx::nativeFxColorFormatSupported(MTLPixelFormatRGBA16Float));
    assert(!macfx::nativeFxColorFormatSupported(MTLPixelFormatBGR10_XR));
    assert(macfx::nativeFxColorFormat(MTLPixelFormatBGRA8Unorm_sRGB)==MTLPixelFormatBGRA8Unorm);
    assert(macfx::nativeMetalSourceReadable(MTLPixelFormatRGB10A2Unorm,false,false));
    assert(macfx::nativeMetalSourceReadable(MTLPixelFormatRGB10A2Unorm,true,true)&&macfx::nativeMetalSourceReadable(MTLPixelFormatRGBA16Float,true,true));
    assert(!macfx::nativeMetalSourceReadable(MTLPixelFormatRGB10A2Unorm,true,false)&&!macfx::nativeMetalSourceReadable(MTLPixelFormatRGBA32Float,true,true));
    assert(macfx::nativeMetalSourceReadable(MTLPixelFormatBGRA8Unorm_sRGB,true,true));
    assert(!macfx::nativeMetalSourceReadable(MTLPixelFormatBGRA8Unorm,true,false));
    assert(macfx::SpatialEncoder::supportsFormat(MTLPixelFormatBGRA8Unorm));
    assert(macfx::SpatialEncoder::supportsFormat(MTLPixelFormatRGBA16Float));
    assert(!macfx::SpatialEncoder::supportsFormat(MTLPixelFormatRGB10A2Unorm));
    // Empty Advanced is explicit passthrough, even if an older legacy packet
    // still selects a shader or generator while activation files are updated.
    controls(control,9);plan(document,@"advanced",@[]);assert(!macfx::imageProcessingRequested());assert(macfx::imageProcessingRequested(true));
    controls(control);plan(document,@"simple",@[]);inactive();
    }else if(phase.name=="no-plan"){
    settled();assert(!macfx::imageProcessingRequested());
    }else return 2;
    return 0;
}}catch(const std::exception &error){std::fprintf(stderr,"Image demand failure: %s\n",error.what());return 1;}}
