// Copyright (c) MacLauncher contributors. MIT license.
// Real offscreen encoding identities. This fixture makes no display ACK.
#include "frame-depth.hpp"
#include "fixture-files.hpp"
#include "effects-plan.hpp"
#include "live-controls.hpp"
#include "process-phase.hpp"
#import <Foundation/Foundation.h>
#include <CommonCrypto/CommonDigest.h>
#include <array>
#include <cmath>
#include <cstdio>
#include <exception>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <thread>
#include <vector>

namespace {
void require(bool value,const char *reason){if(!value)throw std::runtime_error(reason);}
std::string hex(char value){return std::string(64,value);}
std::string digest(const macfx::LivePacket &packet){
    unsigned char hash[CC_SHA256_DIGEST_LENGTH];CC_SHA256(&packet,CC_LONG(sizeof(packet)),hash);char text[65];
    for(unsigned i=0;i<sizeof(hash);++i)std::snprintf(text+i*2,3,"%02x",hash[i]);return text;
}
struct Files {
    char root[1024]{};bool owned=true;
    std::string controls,plan;
    Files(){require(mkdtemp(temporaryPath(root,"maclauncher-held-frame-XXXXXX")),"Cannot create held-frame directory");controls=std::string(root)+"/controls.bin";plan=std::string(root)+"/plan.json";}
    // The phase uses the directory its parent created and removes.
    explicit Files(const char *existing):owned(false){std::snprintf(root,sizeof(root),"%s",existing);controls=std::string(root)+"/controls.bin";plan=std::string(root)+"/plan.json";}
    ~Files(){std::error_code ignored;if(owned)std::filesystem::remove_all(root,ignored);}
    std::string effect(char revision,const char *colour){
        const auto directory=std::string(root)+"/"+hex(revision);std::filesystem::create_directory(directory);
        const auto file=directory+"/effect.prepared.fx";std::ofstream out(file);
        if(!colour){out<<"This is deliberately invalid ReShadeFX.\n";return file;}
        out<<R"FX(uniform float Gain = 1.0;
texture Source : COLOR;
sampler SourceSampler { Texture = Source; };
void VS(uint id : SV_VertexID,out float4 position : SV_Position,out float2 uv : TEXCOORD0) {
    uv=float2((id<<1)&2,id&2);position=float4(uv*float2(2,-2)+float2(-1,1),0,1);
}
float4 PS(float4 position : SV_Position,float2 uv : TEXCOORD0) : SV_Target {
    float alpha=tex2D(SourceSampler,uv).a;
)FX"<<"    return float4("<<colour<<",alpha);\n"<<R"FX(}
technique Colour { pass { VertexShader=VS; PixelShader=PS; } }
)FX";require(out.good(),"Cannot write real shader");return file;
    }
    macfx::LivePacket packet(char revision,float gain,bool after=false){
        macfx::LivePacket value{};std::memcpy(value.magic,"MLFXCTL2",8);value.targetHz=60;value.multiplier=2;value.flags=8|(after?32:0);
        std::memset(value.effectKey,revision,64);std::memcpy(value.revision,hex(revision).data(),64);value.count=1;value.sharpness=.5f;
        std::strcpy(value.uniforms[0].name,"V__Gain");value.uniforms[0].count=1;value.uniforms[0].values[0]=gain;return value;
    }
    void publishPacket(const macfx::LivePacket &packet){
        const auto temporary=controls+".new";{std::ofstream out(temporary,std::ios::binary);out.write(reinterpret_cast<const char*>(&packet),sizeof(packet));require(out.good(),"Cannot write controls");}
        require(rename(temporary.c_str(),controls.c_str())==0,"Cannot replace controls");
    }
    std::shared_ptr<const macfx::EffectPlanSnapshot> publishPlan(char revision,bool advanced=false,const std::string &file={},bool enabled=true){
        NSArray *nodes=@[];if(advanced)nodes=@[@{@"id":@"colour",@"kind":@"shader",@"enabled":@(enabled),@"format":@"fx",@"file":@(file.c_str()),
            @"key":@(hex('a').c_str()),@"revision":@(hex('a').c_str()),@"parameters":@{@"V__Gain":@[@0.2]},@"preservesCoordinates":@YES}];
        auto bytes=[NSJSONSerialization dataWithJSONObject:@{@"schema":@1,@"revision":@(hex(revision).c_str()),@"mode":advanced?@"advanced":@"simple",@"nodes":nodes}options:0 error:nil];
        require(replaceFile(bytes,@(plan.c_str())),"Cannot replace plan");
        // A forced poll has the process plan reader read the replaced file now.
        macfx::EffectPlanState parsed;const auto result=parsed.poll(true);require(result.valid&&result.error.empty(),"New plan was not parsed");return parsed.snapshot();
    }
};
id<MTLTexture> image(id<MTLDevice>device,unsigned width,unsigned height){
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:width height:height mipmapped:NO];
    descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
    auto texture=[device newTextureWithDescriptor:descriptor];require(texture!=nil,"Cannot create offscreen image");return texture;
}
using Pixels=std::array<unsigned char,32*24*4>;
Pixels upload(id<MTLTexture>texture){Pixels bytes{};for(unsigned i=0;i<bytes.size();i+=4){bytes[i]=204;bytes[i+1]=51;bytes[i+2]=102;bytes[i+3]=255;}
    [texture replaceRegion:MTLRegionMake2D(0,0,32,24)mipmapLevel:0 withBytes:bytes.data()bytesPerRow:128];return bytes;}
void commit(id<MTLCommandBuffer>commands){[commands commit];[commands waitUntilCompleted];require(commands.status==MTLCommandBufferStatusCompleted,"Offscreen GPU processing failed");}
void colour(id<MTLTexture>texture,unsigned channel,float value){
    std::vector<unsigned char>bytes(texture.width*texture.height*4);[texture getBytes:bytes.data()bytesPerRow:texture.width*4 fromRegion:MTLRegionMake2D(0,0,texture.width,texture.height)mipmapLevel:0];
    for(unsigned i=0;i<bytes.size();i+=4){for(unsigned c=0;c<3;++c)require(std::abs(int(bytes[i+c])-(c==channel?int(std::lround(value*255)):0))<=2,"Wrong shader or uniform supplied output pixels");require(bytes[i+3]==255,"Output alpha changed");}
}
void unchanged(id<MTLTexture>texture,const Pixels &expected){Pixels bytes{};[texture getBytes:bytes.data()bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24)mipmapLevel:0];require(bytes==expected,"Source image changed");}
void sourceColour(id<MTLTexture>texture){
    std::vector<unsigned char>bytes(texture.width*texture.height*4);[texture getBytes:bytes.data()bytesPerRow:texture.width*4 fromRegion:MTLRegionMake2D(0,0,texture.width,texture.height)mipmapLevel:0];
    const unsigned char expected[]={204,51,102,255};for(unsigned i=0;i<bytes.size();++i)require(std::abs(int(bytes[i])-int(expected[i%4]))<=1,"Copy/scaling changed the source colour");
}
// Graphics resources prepare off the frame path. A busy frame acknowledges
// nothing, and a later frame retries the same request on a new command buffer.
template<class Encode> auto settled(id<MTLCommandQueue>queue,__strong id<MTLCommandBuffer> &commands,macfx::FrameEncodingReceipt *receipt,Encode encode){
    for(unsigned attempt=0;;++attempt){
        commands=[queue commandBuffer];if(receipt)*receipt={};const auto value=encode();
        if(value.encoded||!value.busy||attempt==400)return value;
        require(!receipt||(receipt->controlsDigest.empty()&&receipt->planRevision.empty()),"A busy frame published an encoded receipt");
        commit(commands);std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
}
macfx::FrameEncodingInputs inputs(const std::shared_ptr<const macfx::EffectPlanSnapshot>&plan,const macfx::LivePacket &packet){return {plan,digest(packet),true};}
void receipt(const macfx::FrameEncodingReceipt &actual,const macfx::FrameEncodingInputs &expected,char revision,bool after){
    require(actual.planRevision==expected.plan->revision&&actual.controlsDigest==expected.controlsDigest&&!actual.advanced,"Receipt does not identify the actual Simple input");
    require(actual.selection.revision==hex(revision)&&actual.selection.key==hex(revision),"Receipt does not identify the real selected shader");
    require(actual.controlsGeneration!=0&&actual.afterScaling==after,"Receipt generation or actual placement is wrong");
}
// Without a plan, ordinary no-FX calls copy or scale and report the accepted
// flags-0 packet under one stable token, without a plan or shader identity.
int withoutPlan(const char *root){
    Files files(root);auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];require(device&&queue,"Metal device unavailable");
    auto source=image(device,32,24),target=image(device,32,24),large=image(device,64,48);const auto original=upload(source);int owner=0;uint64_t frame=0,plainToken=0;
    auto plain=files.packet('c',.8f);plain.flags=0;files.publishPacket(plain);const auto expected=digest(plain);__strong id<MTLCommandBuffer> commands;
    // A load-time reader may already hold the contract phase's last packet for
    // up to one 100 ms poll interval; read the flags-0 packet now.
    const auto *accepted=macfx::refreshLiveState().controls.get();require(accepted&&accepted->flags==0,"The flags-0 packet was not accepted");
    for(auto output:{target,large}){
        macfx::FrameEncodingReceipt copied;
        const auto ordinary=settled(queue,commands,&copied,[&]{return macfx::processFrameWithDepth(&owner,commands,{source,output,++frame,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,true,nullptr,&copied);});
        require(ordinary.encoded&&!ordinary.effects&&ordinary.scaled==(output==large),"Ordinary no-FX copy/scaling branch was not used");
        require(copied.planRevision.empty()&&copied.controlsDigest==expected&&copied.controlsGeneration!=0&&(!plainToken||copied.controlsGeneration==plainToken),"Ordinary no-FX output lost stable accepted digest/token");
        require(copied.selection.revision.empty()&&!copied.advanced,"Ordinary no-FX receipt invented shader/plan identity");commit(commands);sourceColour(output);plainToken=copied.controlsGeneration;
    }
    unchanged(source,original);macfx::releaseFrameOwner(&owner);
    std::puts("Held encoding without a plan: ordinary no-FX copy/scaling receipts keep the accepted digest and token");return 0;
}
}
int main(int argc,char**argv){@autoreleasepool{try{
    // Live directory, controls and plan are launch settings: the contract runs
    // as a phase with them, and the no-effects branch as a phase without a plan.
    const auto phase=fixture::phase(argc,argv);
    if(phase.name.empty()){
        Files files;fixture::Environment environment{{"RESHADE_EXPLICIT_HOST",nullptr},{"RESHADE_LIVE_EFFECTS",files.root},{"RESHADE_CONTROL_FILE",files.controls.c_str()},
            {"RESHADE_EFFECT_PLAN",files.plan.c_str()},{"RESHADE_PRESENTATION_CONTROL_FILE","/not-opened-by-this-offscreen-fixture"}};
        if(const int status=fixture::runPhase("contract",environment,{files.root}))return status;
        environment[3].second=nullptr;return fixture::runPhase("no-plan",environment,{files.root});
    }
    require(phase.argc==2,"Usage: held-frame-contract");
    if(phase.name=="no-plan")return withoutPlan(phase.argv[1]);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,20*NSEC_PER_SEC),dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{std::fputs("Held frame contract timed out\n",stderr);std::_Exit(2);});
    Files files(phase.argv[1]);const auto red=files.effect('a',"Gain,0,0");files.effect('b',nullptr);files.effect('c',"0,Gain,0");
    auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];require(device&&queue,"Metal device unavailable");
    auto source=image(device,32,24),target=image(device,32,24),large=image(device,64,48);const auto original=upload(source);int owner=0,advancedOwner=0;uint64_t frame=0;
    auto a=files.packet('a',.25f);files.publishPacket(a);auto initial=inputs(files.publishPlan('1'),a);macfx::FrameEncodingReceipt originalReceipt;
    auto commands=[queue commandBuffer];auto strict=macfx::processFrameWithDepth(&owner,commands,{source,target,++frame,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,true,initial,originalReceipt);
    require(strict.encoded,"Valid old shader did not initialize");receipt(originalReceipt,initial,'a',false);commit(commands);colour(target,0,.25f);
    auto b=files.packet('b',.75f);files.publishPacket(b);auto requested=inputs(files.publishPlan('2'),b);macfx::FrameEncodingReceipt rejected;
    commands=[queue commandBuffer];strict=macfx::processFrameWithDepth(&owner,commands,{source,target,++frame,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,true,requested,rejected);
    require(!strict.encoded&&!strict.busy&&!strict.reason.empty(),"Strict failed-init candidate was acknowledged");require(rejected.controlsDigest.empty()&&rejected.planRevision.empty(),"Failed candidate published an encoded receipt");commit(commands);colour(target,0,.25f);
    commands=[queue commandBuffer];auto ordinary=macfx::processFrameWithDepth(&owner,commands,{source,target,++frame,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,true);
    require(ordinary.encoded,"Strict rejection removed ordinary old-shader fallback");commit(commands);colour(target,0,.25f);
    // A strict failure must release its pin so a new real packet can be accepted.
    auto c=files.packet('c',.75f);files.publishPacket(c);
    requested=inputs(files.publishPlan('3'),c);macfx::FrameEncodingReceipt good;
    commands=[queue commandBuffer];strict=macfx::processFrameWithDepth(&owner,commands,{source,target,++frame,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,true,requested,good);
    require(strict.encoded,"Valid strict candidate was rejected");receipt(good,requested,'c',false);commit(commands);colour(target,1,.75f);
    const auto firstGeneration=good.controlsGeneration;
    // Reuse the same shader/runtime from another producer thread with new parameters.
    c=files.packet('c',.5f);files.publishPacket(c);requested=inputs(files.publishPlan('4'),c);std::exception_ptr failure;macfx::FrameEncodingReceipt other;
    const auto threadedFrame=++frame;
    std::thread producer([&]{@autoreleasepool{try{auto buffer=[queue commandBuffer];auto value=macfx::processFrameWithDepth(&owner,buffer,{source,target,threadedFrame,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,true,requested,other);require(value.encoded,"Cross-reader strict candidate failed");commit(buffer);}catch(...){failure=std::current_exception();}}});producer.join();if(failure)std::rethrow_exception(failure);
    receipt(other,requested,'c',false);require(other.controlsGeneration!=firstGeneration,"Distinct accepted readers aliased a controls token");colour(target,1,.5f);
    c=files.packet('c',.6f,true);files.publishPacket(c);requested=inputs(files.publishPlan('5'),c);
    strict=settled(queue,commands,&good,[&]{return macfx::processFrameWithDepth(&owner,commands,{source,large,++frame,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,true,requested,good);});
    require(strict.encoded,"After-scaling strict candidate failed");receipt(good,requested,'c',true);commit(commands);colour(large,1,.6f);
    // Restore an earlier accepted packet/revision immediately, without100ms sleep.
    files.publishPacket(a);requested=inputs(files.publishPlan('1'),a);commands=[queue commandBuffer];
    strict=macfx::processFrameWithDepth(&owner,commands,{source,target,++frame,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,true,requested,good);
    require(strict.encoded,"Restored accepted candidate failed");receipt(good,requested,'a',false);commit(commands);colour(target,0,.25f);
    // Prime the actual legacy Runtime::plan, not only the metadata reader.
    files.publishPacket(a);files.publishPlan('6',true,red);
    ordinary=settled(queue,commands,nullptr,[&]{return macfx::processFrameWithDepth(&advancedOwner,commands,{source,target,++frame,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,true);});
    require(ordinary.encoded,"Actual Advanced runtime did not initialize");commit(commands);colour(target,0,.2f);
    // Prime the warm Advanced runtime, then replace its plan with a Simple one.
    std::this_thread::sleep_for(std::chrono::milliseconds(110));commands=[queue commandBuffer];macfx::FrameEncodingReceipt cached;
    ordinary=macfx::processFrameWithDepth(&advancedOwner,commands,{source,target,++frame,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,true,nullptr,&cached);
    require(ordinary.encoded&&cached.advanced&&cached.planRevision==hex('6'),"Warm actual Advanced reader was not primed");commit(commands);colour(target,0,.2f);
    c=files.packet('c',.8f);files.publishPacket(c);requested=inputs(files.publishPlan('7'),c);
    // One process reader serves every consumer: once it has read the
    // replacement, no runtime keeps encoding the replaced Advanced plan.
    ordinary=settled(queue,commands,&cached,[&]{return macfx::processFrameWithDepth(&advancedOwner,commands,{source,target,++frame,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,true,nullptr,&cached);});
    require(ordinary.encoded&&!cached.advanced,"A runtime kept the replaced Advanced plan");commit(commands);
    commands=[queue commandBuffer];
    strict=macfx::processFrameWithDepth(&advancedOwner,commands,{source,target,++frame,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,true,requested,good);
    require(strict.encoded,"Simple candidate did not bypass cached Advanced input");receipt(good,requested,'c',false);commit(commands);colour(target,1,.8f);
    // A receipt can never promote merely desired bytes when the parser kept A.
    const auto token=good.controlsGeneration;auto wrong=requested;wrong.controlsDigest=hex('f');commands=[queue commandBuffer];macfx::FrameEncodingReceipt absent;
    strict=macfx::processFrameWithDepth(&advancedOwner,commands,{source,target,++frame,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,true,wrong,absent);
    require(!strict.encoded&&absent.planRevision.empty()&&absent.controlsDigest.empty(),"Mismatched expected digest produced an accepted receipt");commit(commands);
    commands=[queue commandBuffer];strict=macfx::processFrameWithDepth(&advancedOwner,commands,{source,target,++frame,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,true,requested,good);
    require(strict.encoded&&good.controlsGeneration==token,"Strict rejection leaked a pin or unchanged acceptance allocated another token");receipt(good,requested,'c',false);commit(commands);colour(target,1,.8f);
    // Strict processing of a flags-0 packet keeps its accepted identity. The
    // no-plan phase covers the ordinary no-effects branch.
    auto plain=files.packet('c',.8f);plain.flags=0;files.publishPacket(plain);requested=inputs(files.publishPlan('8'),plain);commands=[queue commandBuffer];
    strict=macfx::processFrameWithDepth(&owner,commands,{source,target,++frame,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,true,requested,good);
    require(strict.encoded&&!strict.effects&&good.planRevision==hex('8')&&good.controlsDigest==requested.controlsDigest&&good.controlsGeneration!=0,"Strict no-FX copy lost its accepted identity");
    require(good.selection.revision.empty()&&!good.advanced,"No-FX receipt invented a shader");commit(commands);sourceColour(target);
    // A pass-through plan retires the accepted Advanced image. While a later
    // plan prepares, no frame presents the earlier processed result.
    files.publishPacket(a);files.publishPlan('9',true,red);int bypassOwner=0;macfx::FrameEncodingReceipt bypassed;
    ordinary=settled(queue,commands,&bypassed,[&]{return macfx::processFrameWithDepth(&bypassOwner,commands,{source,target,++frame,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,true,nullptr,&bypassed);});
    require(ordinary.encoded&&bypassed.advanced&&bypassed.planRevision==hex('9'),"The Advanced image before the bypass was not accepted");commit(commands);colour(target,0,.2f);
    files.publishPlan('0',true,red,false);std::this_thread::sleep_for(std::chrono::milliseconds(110));commands=[queue commandBuffer];
    ordinary=macfx::processFrameWithDepth(&bypassOwner,commands,{source,target,++frame,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,true);
    require(ordinary.encoded&&!ordinary.effects,"The pass-through plan did not bypass processing");commit(commands);sourceColour(target);
    const auto green=files.effect('d',"0,Gain,0");files.publishPlan('e',true,green);std::this_thread::sleep_for(std::chrono::milliseconds(110));
    for(unsigned attempt=0;;++attempt){
        commands=[queue commandBuffer];bypassed={};
        ordinary=macfx::processFrameWithDepth(&bypassOwner,commands,{source,target,++frame,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Bilinear,nullptr,true,nullptr,&bypassed);
        require(!ordinary.encoded||bypassed.planRevision==hex('e'),"A bypassed plan re-presented the earlier processed image");commit(commands);
        if(ordinary.encoded)break;require(ordinary.busy&&attempt<400,"The plan after the bypass did not prepare");sourceColour(target);std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    colour(target,1,.2f);macfx::releaseFrameOwner(&bypassOwner);
    unchanged(source,original);macfx::releaseFrameOwner(&owner);macfx::releaseFrameOwner(&advancedOwner);
    std::puts("Held encoding: failed native init retains ordinary fallback; actual Simple identity/uniforms/placement/rollback; cross-reader tokens; cached Advanced bypass; no-FX copy/scaling receipts; pass-through retirement of the accepted image; source preservation passed (no display ACK)");return 0;
}catch(const std::exception &error){std::fprintf(stderr,"%s\n",error.what());return 1;}}}
