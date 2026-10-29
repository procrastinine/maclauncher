#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#define LIBRA_RUNTIME_METAL
#include <librashader.h>
#include "live-controls.hpp"
#include "retroarch-external.h"
#include "shader-scene-inputs.h"
#include "image-admission.hpp"
#include <dlfcn.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <filesystem>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace macfx {
inline bool retroarchFile(const std::string &file) {
    return std::filesystem::path(file).extension()==".slangp";
}
// Stock C API ownership stays in the original library. No preset, shader,
// framebuffer, LUT, history or feedback implementation is duplicated here.
class RetroarchAPI {
    void *library=nullptr;
    template<class T> T symbol(const char *name) {
        auto value=reinterpret_cast<T>(dlsym(library,name));
        if(!value)throw std::runtime_error(std::string("RetroArch shader API is missing: ")+name);
        return value;
    }
public:
    decltype(&libra_error_write) errorWrite;
    decltype(&libra_error_free) errorFree;
    decltype(&libra_error_free_string) errorStringFree;
    PFN_libra_preset_create presetCreate;
    PFN_libra_preset_free presetFree;
    PFN_libra_preset_get_runtime_params parameters;
    PFN_libra_preset_free_runtime_params parametersFree;
    PFN_libra_mtl_filter_chain_create create;
    PFN_libra_mtl_filter_chain_frame frame;
    PFN_libra_mtl_filter_chain_set_param set;
    PFN_libra_mtl_filter_chain_get_param get;
    PFN_libra_mtl_filter_chain_free free;
    using ExternalAPI=uint32_t(*)();
    using CreateExternal=libra_error_t(*)(libra_shader_preset_t*,void*,const filter_chain_mtl_opt_t*,const LibraMTLExternalDeclarationV1*,size_t,libra_mtl_filter_chain_t*);
    using SetExternal=libra_error_t(*)(libra_mtl_filter_chain_t*,const LibraMTLExternalValueV1*,size_t);
    ExternalAPI externalAPI=nullptr;CreateExternal createExternal=nullptr;SetExternal setExternal=nullptr;
    using UniformSnapshots=uint32_t(*)(libra_mtl_filter_chain_t*);
    UniformSnapshots uniformSnapshots=nullptr;
    using SnapshotBytes=uint64_t(*)(const libra_mtl_filter_chain_t*,size_t);
    using PrepareSnapshots=libra_error_t(*)(libra_mtl_filter_chain_t*,size_t);
    using SnapshotsAvailable=uint32_t(*)(const libra_mtl_filter_chain_t*);
    SnapshotBytes snapshotBytes=nullptr;PrepareSnapshots prepareSnapshots=nullptr;SnapshotsAvailable snapshotsAvailable=nullptr;
    RetroarchAPI() {
        std::string file;
        if(const auto value=std::getenv("RESHADE_LIBRASHADER"))file=value;
        else {
            Dl_info info{};
            if(!dladdr(reinterpret_cast<const void*>(&retroarchFile),&info)||!info.dli_fname)
                throw std::runtime_error("Cannot locate the RetroArch shader library");
            file=(std::filesystem::path(info.dli_fname).parent_path()/"librashader.dylib").string();
        }
        library=dlopen(file.c_str(),RTLD_NOW|RTLD_LOCAL);
        if(!library)throw std::runtime_error(std::string("Cannot load the RetroArch shader library: ")+(dlerror()?:"unknown error"));
        const auto abi=symbol<decltype(&libra_instance_abi_version)>("libra_instance_abi_version");
        const auto api=symbol<decltype(&libra_instance_api_version)>("libra_instance_api_version");
        if(abi()!=LIBRASHADER_CURRENT_ABI||api()<LIBRASHADER_CURRENT_VERSION)
            throw std::runtime_error("The RetroArch shader library has an incompatible C API");
#define MACFX_LIBRA(member,name) member=symbol<decltype(member)>(#name)
        MACFX_LIBRA(errorWrite,libra_error_write);MACFX_LIBRA(errorFree,libra_error_free);MACFX_LIBRA(errorStringFree,libra_error_free_string);
        MACFX_LIBRA(presetCreate,libra_preset_create);MACFX_LIBRA(presetFree,libra_preset_free);
        MACFX_LIBRA(parameters,libra_preset_get_runtime_params);MACFX_LIBRA(parametersFree,libra_preset_free_runtime_params);
        MACFX_LIBRA(create,libra_mtl_filter_chain_create);MACFX_LIBRA(frame,libra_mtl_filter_chain_frame);
        MACFX_LIBRA(set,libra_mtl_filter_chain_set_param);MACFX_LIBRA(get,libra_mtl_filter_chain_get_param);MACFX_LIBRA(free,libra_mtl_filter_chain_free);
#undef MACFX_LIBRA
        externalAPI=reinterpret_cast<ExternalAPI>(dlsym(library,"libra_mtl_external_inputs_api"));
        createExternal=reinterpret_cast<CreateExternal>(dlsym(library,"libra_mtl_filter_chain_create_external"));
        setExternal=reinterpret_cast<SetExternal>(dlsym(library,"libra_mtl_filter_chain_set_external"));
        uniformSnapshots=reinterpret_cast<UniformSnapshots>(dlsym(library,"libra_mtl_filter_chain_uniform_snapshots"));
        snapshotBytes=reinterpret_cast<SnapshotBytes>(dlsym(library,"libra_mtl_filter_chain_uniform_snapshot_bytes"));
        prepareSnapshots=reinterpret_cast<PrepareSnapshots>(dlsym(library,"libra_mtl_filter_chain_prepare_uniform_snapshots"));
        snapshotsAvailable=reinterpret_cast<SnapshotsAvailable>(dlsym(library,"libra_mtl_filter_chain_uniform_snapshots_available"));
    }
    void check(libra_error_t error) {
        if(!error)return;
        char *text=nullptr;errorWrite(error,&text);
        const std::string message=text?text:"RetroArch shader processing failed";
        if(text)errorStringFree(&text);errorFree(&error);
        throw std::runtime_error(message);
    }
    static RetroarchAPI &instance() {static auto *api=new RetroarchAPI;return *api;}
};
struct RetroarchBusy final : std::runtime_error {using std::runtime_error::runtime_error;};
class RetroarchChain {
    RetroarchAPI &api=RetroarchAPI::instance();
    struct Witness {
        __weak id<MTLCommandBuffer> commands=nil;
        // Completion belongs to this buffer, not the newest encoded frame.
        std::atomic<unsigned> outcome{0};
    };
    struct Generation {
        RetroarchAPI &api;
        libra_mtl_filter_chain_t chain=nullptr;
        std::map<std::string,float> defaults;
        uint64_t applied=~uint64_t(0),appliedParameters=~uint64_t(0);
        std::shared_ptr<Witness> previous;
        std::atomic<bool> failed{false};
        bool snapshots=false,retired=false;
        std::shared_ptr<ImageReservation>uniformReservation;
        Generation(RetroarchAPI &api,const std::string &file,id<MTLCommandQueue> queue,const std::map<std::string,uint32_t>&declarations,unsigned capacity):api(api) {
            libra_shader_preset_t preset=nullptr;api.check(api.presetCreate(file.c_str(),&preset));
            try {
                libra_preset_param_list_t params{};api.check(api.parameters(&preset,&params));
                for(uint64_t i=0;i<params.length;++i)defaults.emplace(params.parameters[i].name,params.parameters[i].initial);
                api.check(api.parametersFree(params));
                const filter_chain_mtl_opt_t options{LIBRASHADER_CURRENT_VERSION,false};
                if(declarations.empty())api.check(api.create(&preset,queue,&options,&chain));
                else {
                    if(!api.externalAPI||api.externalAPI()!=1||!api.createExternal||!api.setExternal)
                        throw std::runtime_error("The installed Slang provider has no named scene input interface");
                    std::vector<LibraMTLExternalDeclarationV1>inputs;inputs.reserve(declarations.size());
                    for(const auto&[name,role]:declarations)inputs.push_back({name.c_str(),role>=RS_SHADER_SCENE_VIEW_MATRIX?1u:0u,0});
                    api.check(api.createExternal(&preset,(__bridge void*)queue,&options,inputs.data(),inputs.size(),&chain));
                }
                for(auto &[name,value]:defaults)api.check(api.get(&chain,name.c_str(),&value));
                snapshots=api.uniformSnapshots&&api.uniformSnapshots(&chain)==1;
                if(!snapshots&&api.snapshotBytes&&api.prepareSnapshots&&api.snapshotsAvailable){
                    const auto bytes=api.snapshotBytes(&chain,capacity);
                    if(bytes==UINT64_MAX)throw std::runtime_error("The Slang uniform snapshot footprint is not representable");
                    if(bytes)uniformReservation=reserveImageBytes(queue.device,bytes,reinterpret_cast<uintptr_t>(this),"Slang immutable uniform snapshots");
                    api.check(api.prepareSnapshots(&chain,capacity));
                    const auto actual=api.snapshotBytes(&chain,capacity);
                    if(actual==UINT64_MAX)throw std::runtime_error("The Slang uniform snapshot footprint is invalid");
                    if(uniformReservation)uniformReservation->commit(actual);
                    snapshots=api.uniformSnapshots(&chain)==1;
                }
            }catch(...){if(preset)api.presetFree(&preset);if(chain)api.free(&chain);throw;}
        }
        ~Generation(){if(chain)api.free(&chain);}
    };
    std::string file,key;std::map<std::string,uint32_t>declarations;unsigned capacity=4;
    static dispatch_queue_t resourceQueue(){static auto q=dispatch_queue_create("org.maclauncher.slang.resources",DISPATCH_QUEUE_SERIAL);return q;}
    static std::shared_ptr<Generation>makeGeneration(RetroarchAPI&api,const std::string&file,id<MTLCommandQueue>queue,const std::map<std::string,uint32_t>&declarations,unsigned capacity){return {new Generation(api,file,queue,declarations,capacity),[](Generation*p){dispatch_async(resourceQueue(),^{delete p;});}};}
    std::shared_ptr<Generation>generation;
    struct Replacement {
        std::mutex mutex;id<MTLCommandQueue>wanted=nil,readyQueue=nil,errorQueue=nil;
        std::shared_ptr<Generation>ready;std::string error;uint64_t serial=0;bool working=false;
    };
    std::shared_ptr<Replacement>replacement=std::make_shared<Replacement>();
    bool adoptReplacement(id<MTLCommandQueue>desired){
        const auto state=replacement;std::unique_lock guard(state->mutex,std::try_to_lock);if(!guard)return false;
        if(state->ready&&state->readyQueue==desired){generation=std::move(state->ready);queue=desired;state->readyQueue=nil;state->error.clear();state->errorQueue=nil;return true;}
        // A failed preparation is reported once; the next frame prepares again.
        if(state->errorQueue==desired&&!state->error.empty()){auto error=std::move(state->error);state->error.clear();state->errorQueue=nil;throw std::runtime_error(error);}
        if(state->wanted!=desired){state->wanted=desired;++state->serial;state->error.clear();state->errorQueue=nil;}
        if(state->working)return false;state->working=true;const auto source=file;const auto bindings=declarations;
        auto*library=&api;const auto frames=capacity;const std::weak_ptr<Replacement>weak=state;guard.unlock();
        dispatch_async(resourceQueue(),^{@autoreleasepool{
            auto state=weak.lock();if(!state)return;
            for(;;){id<MTLCommandQueue>queue=nil;uint64_t serial=0;
                {std::lock_guard guard(state->mutex);queue=state->wanted;serial=state->serial;}
                std::shared_ptr<Generation>ready;std::string error;
                try{ready=makeGeneration(*library,source,queue,bindings,frames);}catch(const std::exception&e){error=e.what();}
                {std::lock_guard guard(state->mutex);if(state->serial!=serial)continue;
                    state->ready=std::move(ready);state->readyQueue=state->ready?queue:nil;state->error=std::move(error);
                    state->errorQueue=state->error.empty()?nil:queue;state->working=false;return;}
            }
        }});return false;
    }
    bool replace(id<MTLCommandBuffer> commands)const {
        if(generation->retired||generation->failed.load(std::memory_order_acquire)||commands.commandQueue!=queue)return true;
        const auto previous=generation->previous;if(!previous)return false;
        const auto outcome=previous->outcome.load(std::memory_order_acquire);
        if(outcome)return outcome!=1;
        id<MTLCommandBuffer> buffer=previous->commands;
        if(buffer==commands)return false;
        // Committed work on this queue precedes the next buffer without a CPU
        // wait. Uncommitted work may be dropped or committed in another order.
        return !buffer||buffer.commandQueue!=queue||buffer.status<MTLCommandBufferStatusCommitted||buffer.status==MTLCommandBufferStatusError;
    }
public:
    id<MTLCommandQueue> queue;
    RetroarchChain(const std::string &file,const std::string &effectKey,id<MTLCommandQueue>commands,const std::map<std::string,uint32_t>&bindings={},unsigned frames=4):file(file),key(effectKey),declarations(bindings),capacity(frames),generation(makeGeneration(api,file,commands,bindings,frames)),queue(commands){}
    ~RetroarchChain()=default;
    void validateSceneInputs(const RSShaderSceneInputsV1*inputs)const{
        if(declarations.empty())return;
        if(!inputs||inputs->size<sizeof(*inputs)||inputs->version!=1||inputs->bindingCount!=declarations.size())
            throw std::runtime_error("The Slang shader needs every declared scene input from this frame");
        for(const auto&[name,role]:declarations){const auto*v=rsShaderSceneValue(inputs,name.c_str());
            if(!v||(role>=RS_SHADER_SCENE_VIEW_MATRIX&&!v->matrix)||(role<RS_SHADER_SCENE_VIEW_MATRIX&&!v->texture))
                throw std::runtime_error("The Slang scene input is missing: "+name);
            if(v->texture){auto t=(__bridge id<MTLTexture>)v->texture;
                if(t.device!=queue.device||t.textureType!=MTLTextureType2D||t.sampleCount!=1||t.framebufferOnly)
                    throw std::runtime_error("The Slang scene image must be a readable resolved texture on its processing device: "+name);}
        }
    }
    void encode(id<MTLCommandBuffer> commands,id<MTLTexture> input,id<MTLTexture> output,uint64_t frameId,float frameTime,const std::map<std::string,std::vector<float>> *parameters=nullptr,uint64_t parameterGeneration=0,unsigned totalSubframes=1,unsigned currentSubframe=1,const RSShaderSceneInputsV1*inputs=nullptr) {
        if(!commands||!commands.commandQueue||!commands.retainedReferences||commands.status>=MTLCommandBufferStatusCommitted)
            throw std::runtime_error("RetroArch shaders require an unsubmitted retaining command buffer");
        if(replace(commands)) {
            generation->retired=true;
            if(!adoptReplacement(commands.commandQueue))throw RetroarchBusy("Preparing the Slang queue/history replacement");
        }
        // The stock provider also writes shared/managed uniform buffers while
        // encoding. Queue order protects GPU history, but cannot protect those
        // CPU writes from a previous in-flight read (or a second encode into
        // this same buffer). Keep that generation intact until completion.
        if(const auto previous=generation->previous;!generation->snapshots&&previous&&!previous->outcome.load(std::memory_order_acquire)) {
            id<MTLCommandBuffer> buffer=previous->commands;
            if(buffer&&buffer.status!=MTLCommandBufferStatusCompleted)
                throw RetroarchBusy("RetroArch shader resources are still processing the previous frame");
        }
        const auto retained=generation;
        auto &chain=retained->chain;auto &defaults=retained->defaults;auto &applied=retained->applied;auto &appliedParameters=retained->appliedParameters;
        if(retained->snapshots&&api.snapshotsAvailable&&api.snapshotsAvailable(&chain)!=1)
            throw RetroarchBusy("Slang immutable uniform frame capacity is occupied");
        const auto &state=liveState();const auto packet=state.controls.get();
        if(parameters) {
            if(appliedParameters!=parameterGeneration) {
                for(const auto &[name,value]:defaults)api.check(api.set(&chain,name.c_str(),value));
                for(const auto &[name,value]:*parameters)if(value.size()==1&&std::isfinite(value[0])&&defaults.count(name))api.check(api.set(&chain,name.c_str(),value[0]));
                appliedParameters=parameterGeneration;
            }
        }else if(applied!=state.generation) {
            applied=state.generation;
            for(const auto &[name,value]:defaults)api.check(api.set(&chain,name.c_str(),value));
            if(packet&&key.size()==64&&!std::memcmp(packet->effectKey,key.data(),64))
                for(unsigned i=0;i<packet->count;++i) {
                    const auto &uniform=packet->uniforms[i];
                    if(uniform.count==1&&defaults.count(uniform.name))api.check(api.set(&chain,uniform.name,uniform.values[0]));
                }
        }
        validateSceneInputs(inputs);
        if(!declarations.empty()){
            std::vector<LibraMTLExternalValueV1>values;values.reserve(declarations.size());
            for(const auto&[name,role]:declarations){const auto*value=rsShaderSceneValue(inputs,name.c_str());
                LibraMTLExternalValueV1 bound{};bound.name=name.c_str();bound.kind=role>=RS_SHADER_SCENE_VIEW_MATRIX?1u:0u;
                if(!bound.kind)bound.texture=value->texture;
                else for(unsigned row=0;row<4;++row)for(unsigned col=0;col<4;++col)bound.matrix[col*4+row]=value->matrix[row*4+col];
                values.push_back(bound);
            }
            api.check(api.setExternal(&chain,values.data(),values.size()));
        }
        frame_mtl_opt_t options{};options.version=LIBRASHADER_CURRENT_VERSION;
        options.frame_direction=1;options.total_subframes=std::max(1u,totalSubframes);options.current_subframe=std::clamp(currentSubframe,1u,options.total_subframes);
        options.frames_per_second=frameTime>0?1000.0f/frameTime:60;
        options.frametime_delta=uint32_t(std::max(0.0f,frameTime));options.brightness_nits=200;
        auto witness=std::make_shared<Witness>();witness->commands=commands;retained->previous=witness;
        // librashader rotates history while encoding. Each exact generation
        // remains alive through its own late submission/completion or abandon.
        [commands addCompletedHandler:^(id<MTLCommandBuffer> completed){
            const bool success=completed.status==MTLCommandBufferStatusCompleted;
            if(!success)retained->failed.store(true,std::memory_order_release);
            witness->outcome.store(success?1:2,std::memory_order_release);
        }];
        try {api.check(api.frame(&chain,commands,frameId,input,output,nullptr,nullptr,&options));}
        catch(...) {retained->failed.store(true,std::memory_order_release);throw;}
    }
};
}
