// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "image-admission.hpp"
#include "shader-scene-inputs.h"
#import <ISFMSLKit/ISFMSLScene.h>
#import <ISFMSLKit/ISFMSLCache.h>
#import <VVMetalKit/VVMetalKit.h>
#include <dlfcn.h>
#include <filesystem>
#include <mutex>
#include <map>
#include <atomic>
#include <cmath>
#include <stdexcept>
#include <set>
#include <cstring>
namespace {
thread_local std::string lastError;
struct SceneScope {const macfx::ShaderNode*node=nullptr;const RSShaderSceneInputsV1*inputs=nullptr;};
thread_local SceneScope sceneScope;
struct SceneLease {
    void*storage;void(*release)(void*);
    explicit SceneLease(const RSShaderSceneInputsV1&p):storage(p.storage),release(p.release){p.retain(storage);}
    ~SceneLease(){release(storage);}
};
std::mutex globals;
std::filesystem::path directory(){Dl_info info{};if(!dladdr(reinterpret_cast<const void*>(&directory),&info)||!info.dli_fname)throw std::runtime_error("The ISF provider directory is unavailable");return std::filesystem::path(info.dli_fname).parent_path();}
struct DeviceResources {id<MTLDevice>device;VVMTLPool*pool;id<MTLLibrary>library;};
std::map<uint64_t,std::shared_ptr<DeviceResources>>&devices(){static auto*value=new std::map<uint64_t,std::shared_ptr<DeviceResources>>;return *value;}
std::shared_ptr<DeviceResources>resources(id<MTLDevice>device){
    auto&entry=devices()[device.registryID];if(!entry){entry=std::make_shared<DeviceResources>();entry->device=device;entry->pool=[[VVMTLPool alloc]initWithDevice:device];}
    VVMTLPool.global=entry->pool;if(RenderProperties.global.device!=device)[RenderProperties.global configureWithDevice:device];
    if(!ISFMSLCache.primary){
        const char*configured=std::getenv("RESHADE_ISF_CACHE_ROOT");
        NSString*root=configured&&*configured?[NSString stringWithUTF8String:configured]:[NSTemporaryDirectory() stringByAppendingPathComponent:@"MacLauncher-ISF"];
        ISFMSLCache.primary=[[ISFMSLCache alloc]initWithDirectoryPath:root];
    }return entry;
}
struct State {
    id<MTLDevice>device=nil;id<MTLCommandQueue>queue=nil;ISFMSLScene*scene=nil;
    std::shared_ptr<DeviceResources>gpu;std::atomic<unsigned>pending{0};
    unsigned width=0,height=0;uint64_t lastFrame=0;std::mutex lock;
    id<MTLTexture>scratch=nil;id<MTLRenderPipelineState>copyPipeline=nil;MTLPixelFormat copyFormat=MTLPixelFormatInvalid;
};
NSString*copySource=@"#include <metal_stdlib>\nusing namespace metal;struct V{float4 p[[position]];};vertex V v(uint i[[vertex_id]]){float2 p=float2((i<<1)&2,i&2);return{float4(p*2.0-1.0,0,1)};}fragment float4 f(V v[[stage_in]],texture2d<float,access::read> source[[texture(0)]],constant uint&flip[[buffer(0)]]){uint2 p=uint2(v.p.xy);if(flip)p.y=source.get_height()-1-p.y;return source.read(p);}";
class Node final:public macfx::ShaderNode {
    macfx::ShaderSpec spec;macfx::ShaderParameters parameters;std::shared_ptr<State>state=std::make_shared<State>();
    void values(){
        for(id<ISFMSLSceneAttrib> attribute in state->scene.inputs){
            const auto found=parameters.find(attribute.name.UTF8String?:"");if(found==parameters.end()){if(!attribute.shouldHaveImageBuffer&&attribute.defaultVal)[state->scene setValue:attribute.defaultVal forInputNamed:attribute.name];continue;}const auto&v=found->second;
            id<ISFMSLSceneVal>value=nil;
            switch(attribute.type){
                case ISFValType_Event:case ISFValType_Bool:if(v.size()==1)value=[ISFMSLSceneVal createWithBool:v[0]!=0];break;
                case ISFValType_Long:if(v.size()==1&&v[0]>=INT32_MIN&&v[0]<=INT32_MAX)value=[ISFMSLSceneVal createWithLong:int32_t(v[0])];break;
                case ISFValType_Float:if(v.size()==1)value=[ISFMSLSceneVal createWithFloat:v[0]];break;
                case ISFValType_Point2D:if(v.size()==2)value=[ISFMSLSceneVal createWithPoint2D:NSMakePoint(v[0],v[1])];break;
                case ISFValType_Color:if(v.size()==4){double color[]={v[0],v[1],v[2],v[3]};value=[ISFMSLSceneVal createWithColorVals:color];}break;
                default:break;
            }
            if(!value)throw std::runtime_error("The ISF parameter type does not match its declaration");[state->scene setValue:value forInputNamed:attribute.name];
        }
    }
    const RSShaderSceneInputsV1*sceneInputs(const macfx::ShaderFrame&frame)const{
        if(sceneScope.node!=this||!sceneScope.inputs)return nullptr;
        const auto*p=sceneScope.inputs;
        if(p->commandBuffer!=(__bridge void*)frame.commands||p->source!=(__bridge void*)frame.source||p->target!=(__bridge void*)frame.target||p->frameId!=frame.frameId)
            throw std::runtime_error("The ISF scene inputs belong to another frame or command buffer");
        return p;
    }
    void validateInputs(const macfx::ShaderFrame&frame,const RSShaderSceneInputsV1*p)const{
        std::set<std::string>bound;
        if(p)for(unsigned i=0;i<p->bindingCount;++i){
            const auto&binding=p->bindings[i];const auto&value=p->values[binding.role];
            if(binding.role>=RS_SHADER_SCENE_VIEW_MATRIX)throw std::runtime_error("ISF INPUTS have no matrix value type; view and projection matrices need a declared provider uniform interface");
            NSString*name=[NSString stringWithUTF8String:binding.name];auto attribute=[state->scene inputNamed:name];
            if(!attribute)throw std::runtime_error("The scene resource is not a declared ISF input: "+std::string(binding.name));
            if(attribute.type!=ISFValType_Image)throw std::runtime_error("An ISF scene texture requires an image input, including GPU exposure: "+std::string(binding.name));
            id<MTLTexture>texture=(__bridge id<MTLTexture>)value.texture;
            if(!texture||texture.device!=frame.commands.device||texture.textureType!=MTLTextureType2D||texture.sampleCount!=1||texture.width!=value.width||texture.height!=value.height||!value.width||!value.height||value.origin>1||
               (texture.usage!=MTLTextureUsageUnknown&&!(texture.usage&MTLTextureUsageShaderRead)))
                throw std::runtime_error("The ISF scene image has no compatible resolved texture on this frame's device: "+std::string(binding.name));
            bound.insert(binding.name);
        }
        for(id<ISFMSLSceneAttrib>attribute in state->scene.inputs)if(attribute.shouldHaveImageBuffer&&!attribute.isFilterInputImage&&!bound.count(attribute.name.UTF8String?:""))
            throw std::runtime_error("This ISF shader needs an unbound image or audio input: "+std::string(attribute.name.UTF8String?:""));
    }
    NSArray*bindImages(const RSShaderSceneInputsV1*p){
        NSMutableArray*images=[NSMutableArray new];if(!p)return images;
        for(unsigned i=0;i<p->bindingCount;++i){const auto&binding=p->bindings[i];const auto&value=p->values[binding.role];
            auto image=[state->gpu->pool textureForExistingTexture:(__bridge id<MTLTexture>)value.texture];image.flipV=value.origin==1;
            [state->scene setValue:[ISFMSLSceneVal createWithTextureImage:image] forInputNamed:[NSString stringWithUTF8String:binding.name]];[images addObject:image];
        }return images;
    }
public:
    explicit Node(const macfx::ShaderSpec&value):spec(value),parameters(value.parameters){}
    Node(const Node&previous,const macfx::ShaderParameters&values):spec(previous.spec),parameters(values),state(previous.state){}
    void setParameters(const macfx::ShaderParameters&values)override{for(const auto&[name,items]:values)for(float value:items)if(!std::isfinite(value))throw std::runtime_error("ISF parameters must be finite");parameters=values;}
    macfx::ShaderResult prepare(const macfx::ShaderFrame&frame)override{
        try{@autoreleasepool{
            if(!frame.commands||!frame.source||!frame.target||frame.source.device!=frame.commands.device||frame.target.device!=frame.commands.device)throw std::runtime_error("ISF requires textures on the caller's Metal device");
            const auto previous=state;std::scoped_lock guard(globals,previous->lock);resources(frame.commands.device);
            if(!state->scene||state->device!=frame.commands.device||state->queue!=frame.commands.commandQueue){
                auto fresh=std::make_shared<State>();fresh->device=frame.commands.device;fresh->queue=frame.commands.commandQueue;fresh->gpu=resources(frame.commands.device);
                fresh->scene=[[ISFMSLScene alloc]initWithDevice:frame.commands.device];[fresh->scene loadURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:spec.selection.file.c_str()]]];
                if(!fresh->scene||fresh->scene.compilerError||fresh->scene.passes.count==0)throw std::runtime_error("The ISF shader could not be compiled");
                for(id<ISFMSLScenePassTarget> pass in fresh->scene.passes)if(!pass.pso)throw std::runtime_error("The ISF shader pipeline is unavailable");
                state=std::move(fresh);
            }
            validateInputs(frame,sceneInputs(frame));
            const auto format=state->scene.passes.lastObject.float32?MTLPixelFormatRGBA32Float:MTLPixelFormatBGRA8Unorm;
            const bool copy=frame.source==frame.target||frame.origin==macfx::FrameOrigin::BottomLeft||frame.target.pixelFormat!=format;
            if(copy){
                if(!state->scratch||state->scratch.width!=frame.target.width||state->scratch.height!=frame.target.height||state->scratch.pixelFormat!=format){auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:frame.target.width height:frame.target.height mipmapped:NO];descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget;state->scratch=macfx::newAdmittedTexture(frame.commands.device,descriptor);}
                if(!state->copyPipeline||state->copyFormat!=frame.target.pixelFormat){NSError*error=nil;auto library=[frame.commands.device newLibraryWithSource:copySource options:nil error:&error];if(!library)throw std::runtime_error(error.localizedDescription.UTF8String?:"The ISF output conversion could not compile");auto descriptor=[MTLRenderPipelineDescriptor new];descriptor.vertexFunction=[library newFunctionWithName:@"v"];descriptor.fragmentFunction=[library newFunctionWithName:@"f"];descriptor.colorAttachments[0].pixelFormat=frame.target.pixelFormat;state->copyPipeline=[frame.commands.device newRenderPipelineStateWithDescriptor:descriptor error:&error];if(!state->copyPipeline)throw std::runtime_error(error.localizedDescription.UTF8String?:"The ISF output conversion is unavailable");state->copyFormat=frame.target.pixelFormat;}
            }else state->scratch=nil;
            state->width=frame.target.width;state->height=frame.target.height;return {true,{},false};
        }}catch(const std::exception&error){return {false,error.what(),false};}
    }
    macfx::ShaderResult encode(const macfx::ShaderFrame&frame)override{
        try{@autoreleasepool{
            if(!state->scene||state->device!=frame.commands.device||state->queue!=frame.commands.commandQueue)return {false,"Prepare the ISF shader for this queue before rendering",false};
            std::scoped_lock guard(globals,state->lock);resources(frame.commands.device);lastError.clear();
            const auto*p=sceneInputs(frame);validateInputs(frame,p);
            std::shared_ptr<SceneLease>lease;if(p&&p->bindingCount){if(!p->storage||!p->retain||!p->release)throw std::runtime_error("ISF scene images require a retained frame lease");lease=std::make_shared<SceneLease>(*p);}
            // A single queue orders persistent targets. Submitted frames retain
            // the exact scene and targets through the borrowed buffer callback.
            values();auto input=[state->gpu->pool textureForExistingTexture:frame.source];input.flipV=frame.origin==macfx::FrameOrigin::BottomLeft;
            for(id<ISFMSLSceneAttrib> attribute in state->scene.inputs)if(attribute.isFilterInputImage)[state->scene setValue:[ISFMSLSceneVal createWithTextureImage:input] forInputNamed:attribute.name];
            NSArray*images=bindImages(p);
            auto output=[state->gpu->pool textureForExistingTexture:state->scratch?:frame.target];output.flipV=false;
            const auto retained=state;[frame.commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)retained;(void)input;(void)output;(void)images;(void)lease;}];
            [state->scene renderToTexture:output atTime:frame.timeMs/1000.0 inCommandBuffer:frame.commands];
            if(!lastError.empty())throw std::runtime_error(lastError);
            if(state->scratch){auto descriptor=[MTLRenderPassDescriptor renderPassDescriptor];descriptor.colorAttachments[0].texture=frame.target;descriptor.colorAttachments[0].loadAction=MTLLoadActionDontCare;descriptor.colorAttachments[0].storeAction=MTLStoreActionStore;auto encoder=[frame.commands renderCommandEncoderWithDescriptor:descriptor];[encoder setRenderPipelineState:state->copyPipeline];[encoder setFragmentTexture:state->scratch atIndex:0];const uint32_t flip=frame.origin==macfx::FrameOrigin::BottomLeft;[encoder setFragmentBytes:&flip length:sizeof(flip) atIndex:0];[encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];[encoder endEncoding];}
            state->lastFrame=frame.frameId;
            return {true,{},false};
        }}catch(const std::exception&error){return {false,error.what(),false};}
    }
};
}
extern "C" id<MTLLibrary>MCLISFDefaultLibrary(id<MTLDevice>device){
    try{auto gpu=resources(device);if(!gpu->library){NSError*error=nil;gpu->library=[device newLibraryWithURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:(directory()/"default.metallib").c_str()]] error:&error];if(!gpu->library)lastError=error.localizedDescription.UTF8String?:"The ISF Metal helper library is unavailable";}return gpu->library;}catch(const std::exception&error){lastError=error.what();return nil;}
}
extern "C" id<MTLTexture>MCLISFNewTexture(id<MTLDevice>device,MTLTextureDescriptor*descriptor){try{return macfx::newAdmittedTexture(device,descriptor);}catch(const std::exception&error){lastError=error.what();return nil;}}
extern "C" __attribute__((visibility("default"))) uint32_t rsISFNodeABI(){return 1;}
extern "C" __attribute__((visibility("default"))) uint32_t rsISFSceneInputsAPI(){return RS_SHADER_SCENE_ABI_VERSION;}
extern "C" __attribute__((visibility("default"))) int rsISFBindSceneInputs(macfx::ShaderNode*node,const RSShaderSceneInputsV1*p){try{
    if(!p){sceneScope={};lastError.clear();return 0;}
    if(!dynamic_cast<Node*>(node)||p->size<sizeof(*p)||p->version!=RS_SHADER_SCENE_ABI_VERSION||p->bindingCount>128||p->bindingCount&&(!p->bindings||!p->values)||!p->commandBuffer||!p->source||!p->target)
        throw std::runtime_error("The ISF scene input companion is invalid");
    std::set<std::string>names;for(unsigned i=0;i<p->bindingCount;++i){const auto&binding=p->bindings[i];if(!binding.name||!binding.name[0]||strnlen(binding.name,513)>512||binding.role>=RS_SHADER_SCENE_ROLE_COUNT||binding.reserved||!names.insert(binding.name).second)throw std::runtime_error("The ISF scene resource declaration is invalid");}
    sceneScope={node,p};lastError.clear();return 0;
}catch(const std::exception&error){sceneScope={};lastError=error.what();return 1;}}
extern "C" __attribute__((visibility("default"))) macfx::ShaderNode*rsCreateISFShaderNode(const macfx::ShaderSpec*spec){try{if(!spec)throw std::runtime_error("The ISF shader specification is missing");return new Node(*spec);}catch(const std::exception&error){lastError=error.what();return nullptr;}}
extern "C" __attribute__((visibility("default"))) macfx::ShaderNode*rsCloneISFShaderNode(const macfx::ShaderNode*node,const macfx::ShaderParameters*values){try{auto previous=dynamic_cast<const Node*>(node);if(!previous||!values)throw std::runtime_error("The ISF parameter update is invalid");return new Node(*previous,*values);}catch(const std::exception&error){lastError=error.what();return nullptr;}}
extern "C" __attribute__((visibility("default"))) const char*rsISFLastError(){return lastError.c_str();}
