// Copyright (c) MacLauncher contributors. MIT license.
#include "effects-execution.hpp"
#import <Foundation/Foundation.h>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <thread>
#include <unistd.h>
static void require(bool yes,const std::string &why){if(!yes)throw std::runtime_error(why);}
static id<MTLTexture> texture(id<MTLDevice>device){auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:128 height:96 mipmapped:NO];d.storageMode=MTLStorageModeShared;d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;return [device newTextureWithDescriptor:d];}
static void pixels(id<MTLTexture>image,int expected,int tolerance){std::vector<unsigned char> bytes(128*96*4);[image getBytes:bytes.data() bytesPerRow:128*4 fromRegion:MTLRegionMake2D(0,0,128,96) mipmapLevel:0];for(size_t i=0;i<bytes.size();i+=4){for(unsigned c=0;c<3;++c)require(std::abs(int(bytes[i+c])-expected)<=tolerance,"Incorrect prefix/generation/suffix pixel");require(bytes[i+3]==255,"Generation changed opaque alpha");}}
int main(int argc,char **argv){@autoreleasepool{try{
    require(argc==3,"Usage: effects-generation MODEL INCLUDE_DIRECTORY");char temporary[]="/tmp/maclauncher-generation-gpu-XXXXXX";require(mkdtemp(temporary),"Cannot create generation fixture");const std::string root=temporary,add=root+"/add.fx",multiply=root+"/multiply.fx",plan=root+"/plan.json";
    struct Cleanup{std::string root;~Cleanup(){std::filesystem::remove_all(root);}}cleanup{root};
    const char *prefix="#include \"ReShade.fxh\"\nuniform float Amount=.2;uniform float Gain=.5;float4 Filter(float4 p:SV_Position,float2 uv:TEXCOORD):SV_Target{float4 c=tex2D(ReShade::BackBuffer,uv);return float4(";
    std::ofstream(add)<<prefix<<"c.rgb+Amount,c.a);}\ntechnique Main{pass{VertexShader=PostProcessVS;PixelShader=Filter;}}\n";
    std::ofstream(multiply)<<prefix<<"c.rgb*Gain,c.a);}\ntechnique Main{pass{VertexShader=PostProcessVS;PixelShader=Filter;}}\n";
    setenv("RESHADE_EXPLICIT_HOST","1",1);setenv("RESHADE_EFFECT_PLAN",plan.c_str(),1);setenv("RESHADE_INCLUDE_PATH",argv[2],1);
    const auto shader=[&](NSString *id,const std::string &file,float amount,float gain){return @{@"id":id,@"kind":@"shader",@"enabled":@YES,@"format":@"fx",@"file":@(file.c_str()),@"key":[@"" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0],@"revision":[@"" stringByPaddingToLength:64 withString:@"b" startingAtIndex:0],@"parameters":@{@"V__Amount":@[@(amount)],@"V__Gain":@[@(gain)]},@"preservesCoordinates":@YES};};
    const auto publish=[&](float amount,float gain,NSString *revision){NSArray *rows=@[shader(@"prefix",add,amount,.5),@{@"id":@"generation",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"lsfg",@"modelPath":@(argv[1]),@"settings":@{@"frameMultiplier":@2,@"lsfgMode":@"performance",@"lsfgFp16":@YES}},shader(@"suffix",multiply,.2,gain)];NSDictionary *doc=@{@"schema":@1,@"mode":@"advanced",@"revision":[@"" stringByPaddingToLength:64 withString:revision startingAtIndex:0],@"nodes":rows};NSData *data=[NSJSONSerialization dataWithJSONObject:doc options:0 error:nil];require([data writeToFile:@(plan.c_str()) atomically:YES],"Cannot publish generation plan");std::this_thread::sleep_for(std::chrono::milliseconds(120));};
    auto device=MTLCreateSystemDefaultDevice();require(device!=nil,"Metal device unavailable");auto queue=[device newCommandQueue];auto source=texture(device),real=texture(device),generated=texture(device),shownReal=texture(device),shownGenerated=texture(device);
    std::vector<unsigned char> input(128*96*4,64);for(size_t i=3;i<input.size();i+=4)input[i]=255;[source replaceRegion:MTLRegionMake2D(0,0,128,96) mipmapLevel:0 withBytes:input.data() bytesPerRow:128*4];
    macfx::EffectPlanExecutor state;std::shared_ptr<macfx::LsfgEncoder> original;publish(.2,.5,@"c");unsigned actualGenerated=0;
    for(unsigned frameId=1;frameId<=5;++frameId){
        if(frameId==5)publish(.2,.25,@"d");auto commands=[queue commandBuffer];macfx::ShaderFrame frame{commands,source,real,frameId,double(frameId)*16.666,16.666f};
        const auto selected=state.prepare(frame,true);require(selected.active&&selected.execution!=nullptr,selected.error);auto chain=selected.execution;require(chain->generator()!=nullptr,"Generation row has no actual encoder");
        if(!original)original=chain->generator();else require(original==chain->generator(),"Suffix-only uniform edit replaced generation history");
        auto encoded=chain->encode(frame);require(encoded.encoded,encoded.reason);
        const auto result=chain->generator()->encode(commands,real,{generated},frameId);require(result.encoded,result.reason);require(result.graphBuilds==1,"Unchanged generation inputs rebuilt the graph");
        frame.source=real;frame.target=shownReal;encoded=chain->encode(frame,true);require(encoded.encoded,encoded.reason);
        if(result.ready){frame.source=generated;frame.target=shownGenerated;encoded=chain->encode(frame,true,true);require(encoded.encoded,encoded.reason);++actualGenerated;}
        auto done=dispatch_semaphore_create(0);[commands addCompletedHandler:^(id<MTLCommandBuffer>){dispatch_semaphore_signal(done);}];[commands commit];require(!dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_SEC)),"Generation GPU deadline");require(commands.status==MTLCommandBufferStatusCompleted,commands.error.localizedDescription.UTF8String?:"Generation GPU failure");
        pixels(real,115,1);pixels(shownReal,frameId==5?29:58,1);if(result.ready)pixels(shownGenerated,frameId==5?29:58,3);
    }
    require(actualGenerated==3,"Expected actual ready generated frames");
    // Changing the input to generation replaces its history once, while an
    // unchanged suffix control alone preserves that independent owner.
    publish(.4,.25,@"e");auto changed=[queue commandBuffer];const auto next=state.prepare({changed,source,real,6,100,16.666f},true);require(next.execution&&next.execution->generator()!=original,"Upstream shader edit retained stale generation history");
    std::printf("Ordered LSFG: prefix115; real/generated suffix58→29; 3 generated outputs; suffix edit retains graph; upstream edit resets history\n");return 0;
}catch(const std::exception &error){std::fprintf(stderr,"%s\n",error.what());return 1;}}}
