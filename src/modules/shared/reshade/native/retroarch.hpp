#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#define LIBRA_RUNTIME_METAL
#include <librashader.h>
#include "live-controls.hpp"
#include <dlfcn.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <filesystem>
#include <map>
#include <memory>
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
        Generation(RetroarchAPI &api,const std::string &file,id<MTLCommandQueue> queue):api(api) {
            libra_shader_preset_t preset=nullptr;api.check(api.presetCreate(file.c_str(),&preset));
            try {
                libra_preset_param_list_t params{};api.check(api.parameters(&preset,&params));
                for(uint64_t i=0;i<params.length;++i)defaults.emplace(params.parameters[i].name,params.parameters[i].initial);
                api.check(api.parametersFree(params));
                const filter_chain_mtl_opt_t options{LIBRASHADER_CURRENT_VERSION,false};
                api.check(api.create(&preset,queue,&options,&chain));
                for(auto &[name,value]:defaults)api.check(api.get(&chain,name.c_str(),&value));
            }catch(...){if(preset)api.presetFree(&preset);if(chain)api.free(&chain);throw;}
        }
        ~Generation(){if(chain)api.free(&chain);}
    };
    std::string file,key;
    std::shared_ptr<Generation> generation;
    bool replace(id<MTLCommandBuffer> commands)const {
        if(generation->failed.load(std::memory_order_acquire)||commands.commandQueue!=queue)return true;
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
    RetroarchChain(const std::string &file,const std::string &effectKey,id<MTLCommandQueue> commands):file(file),key(effectKey),generation(std::make_shared<Generation>(api,file,commands)),queue(commands){}
    ~RetroarchChain()=default;
    void encode(id<MTLCommandBuffer> commands,id<MTLTexture> input,id<MTLTexture> output,uint64_t frameId,float frameTime,const std::map<std::string,std::vector<float>> *parameters=nullptr,uint64_t parameterGeneration=0) {
        if(!commands||!commands.commandQueue||!commands.retainedReferences||commands.status>=MTLCommandBufferStatusCommitted)
            throw std::runtime_error("RetroArch shaders require an unsubmitted retaining command buffer");
        if(replace(commands)) {
            auto next=std::make_shared<Generation>(api,file,commands.commandQueue);
            generation=std::move(next);queue=commands.commandQueue;
        }
        // The stock provider also writes shared/managed uniform buffers while
        // encoding. Queue order protects GPU history, but cannot protect those
        // CPU writes from a previous in-flight read (or a second encode into
        // this same buffer). Keep that generation intact until completion.
        if(const auto previous=generation->previous;previous&&!previous->outcome.load(std::memory_order_acquire)) {
            id<MTLCommandBuffer> buffer=previous->commands;
            if(buffer&&buffer.status!=MTLCommandBufferStatusCompleted)
                throw RetroarchBusy("RetroArch shader resources are still processing the previous frame");
        }
        const auto retained=generation;
        auto &chain=retained->chain;auto &defaults=retained->defaults;auto &applied=retained->applied;auto &appliedParameters=retained->appliedParameters;
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
        frame_mtl_opt_t options{};options.version=LIBRASHADER_CURRENT_VERSION;
        options.frame_direction=1;options.total_subframes=options.current_subframe=1;
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
