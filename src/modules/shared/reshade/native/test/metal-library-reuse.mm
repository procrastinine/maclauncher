// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "fixture-files.hpp"
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <objc/runtime.h>
#include <array>
#include <atomic>
#include <cstdio>
#include <stdexcept>
#include <unistd.h>

namespace {
void require(bool value,const char *reason){if(!value)throw std::runtime_error(reason);}
std::atomic<unsigned> compilations{0};
using Compile=id<MTLLibrary>(*)(id,SEL,NSString *,MTLCompileOptions *,NSError **);
Compile originalCompile;
id<MTLLibrary> countCompile(id self,SEL selector,NSString *source,MTLCompileOptions *options,NSError **error){++compilations;return originalCompile(self,selector,source,options,error);}
struct ObserveCompiler {
    Method method;
    explicit ObserveCompiler(id<MTLDevice> device){method=class_getInstanceMethod([device class],@selector(newLibraryWithSource:options:error:));require(method,"Metal compilation entry is missing");originalCompile=reinterpret_cast<Compile>(method_setImplementation(method,reinterpret_cast<IMP>(countCompile)));}
    ~ObserveCompiler(){method_setImplementation(method,reinterpret_cast<IMP>(originalCompile));}
};
struct Source {
    char path[1024]{};
    Source(){const int fd=mkstemps(temporaryPath(path,"maclauncher-metal-reuse-XXXXXX.fx"),3);require(fd>=0,"Cannot create effect source");
        const char text[]=R"FX(
texture BackBuffer : COLOR;
sampler BackBufferSampler { Texture = BackBuffer; };
uniform float Gain = 0.0;
void VS(uint id : SV_VertexID, out float4 position : SV_Position, out float2 uv : TEXCOORD0) {
    uv = float2((id << 1) & 2, id & 2); position = float4(uv * float2(2,-2) + float2(-1,1),0,1);
}
float4 PS(float4 position : SV_Position, float2 uv : TEXCOORD0) : SV_Target {
    float4 c = tex2D(BackBufferSampler,uv); float gray = dot(c.rgb,float3(0.299,0.587,0.114));
    return float4(lerp(c.rgb,float3(gray,gray,gray),Gain),c.a);
}
technique Reuse { pass { VertexShader = VS; PixelShader = PS; } }
)FX";
        const auto written=write(fd,text,sizeof(text)-1);close(fd);require(written==sizeof(text)-1,"Cannot write effect source");}
    ~Source(){unlink(path);}
};
using Pixels=std::array<unsigned char,32*24*4>;
Pixels render(const std::shared_ptr<macfx::ShaderNode> &node,id<MTLCommandQueue> queue,id<MTLTexture> source,id<MTLTexture> target){
    auto commands=[queue commandBuffer];macfx::ShaderFrame frame{commands,source,target};
    const auto encoded=node->encode(frame);require(encoded.encoded,encoded.reason.c_str());
    [commands commit];[commands waitUntilCompleted];require(commands.status==MTLCommandBufferStatusCompleted,"Effect command buffer failed");
    Pixels pixels;[target getBytes:pixels.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];return pixels;
}
}
int main(){@autoreleasepool{try{
    auto device=MTLCreateSystemDefaultDevice();require(device!=nil,"Metal device unavailable");auto queue=[device newCommandQueue];require(queue!=nil,"Metal queue unavailable");
    ObserveCompiler observed(device);Source sourceFile;
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:32 height:24 mipmapped:NO];
    descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
    auto input=[device newTextureWithDescriptor:descriptor],a=[device newTextureWithDescriptor:descriptor],b=[device newTextureWithDescriptor:descriptor];
    Pixels pixels;for(unsigned i=0;i<pixels.size();i+=4){pixels[i]=204;pixels[i+1]=51;pixels[i+2]=102;pixels[i+3]=255;}
    [input replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:128];
    macfx::ShaderSpec spec;spec.selection.file=sourceFile.path;spec.selection.technique="Reuse";spec.parameters={{"V__Gain",{0}}};
    auto first=macfx::makeShaderNode(spec);auto prepareCommands=[queue commandBuffer];macfx::ShaderFrame frame{prepareCommands,input,a};
    auto ready=first->prepare(frame);require(ready.encoded,ready.reason.c_str());const auto initial=compilations.load();require(initial==2,"Expected one vertex and one pixel compilation");
    spec.parameters={{"V__Gain",{1}}};auto second=macfx::makeShaderNode(spec);frame.target=b;
    ready=second->prepare(frame);require(ready.encoded,ready.reason.c_str());require(compilations==initial,"Parameter-only fresh node recompiled Metal libraries");
    require(render(first,queue,input,a)==pixels,"First node lost its independent parameters");const auto gray=render(second,queue,input,b);
    for(unsigned i=0;i<gray.size();i+=4)require(abs(int(gray[i])-int(gray[i+1]))<=1&&abs(int(gray[i+1])-int(gray[i+2]))<=1&&gray[i+3]==255,"Second node did not apply independent parameters");
    require(gray!=pixels&&render(first,queue,input,a)==pixels,"Replacement altered retained node state");
    first->setParameters({{"V__Gain",{.25f}}});const auto quarter=render(first,queue,input,a);
    require(quarter!=pixels&&quarter!=gray&&render(second,queue,input,b)==gray,"Parameter update crossed node ownership");
    Pixels unchanged;[input getBytes:unchanged.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];
    require(unchanged==pixels&&compilations==initial,"Source or compiled library changed during parameter updates");
    puts("Fresh Metal shader nodes reused two compiled libraries while retaining independent parameters, outputs and source pixels");return 0;
}catch(const std::exception &error){fprintf(stderr,"%s\n",error.what());return 1;}}}
