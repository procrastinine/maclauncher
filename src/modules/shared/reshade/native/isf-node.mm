// Copyright (c) MacLauncher contributors. MIT license.
#include "isf-node.hpp"
#include <dlfcn.h>
#include <filesystem>
#include <stdexcept>
namespace macfx {
namespace {
struct Provider {
    using Create=ShaderNode*(*)(const ShaderSpec*);using Clone=ShaderNode*(*)(const ShaderNode*,const ShaderParameters*);using Error=const char*(*)();
    using Bind=int(*)(ShaderNode*,const RSShaderSceneInputsV1*);using SceneABI=uint32_t(*)();
    void*library=nullptr;Create create=nullptr;Clone clone=nullptr;Error error=nullptr;Bind bind=nullptr;SceneABI sceneABI=nullptr;
    Provider(){
        Dl_info info{};if(!dladdr(reinterpret_cast<const void*>(&makeISFShaderNode),&info)||!info.dli_fname)throw std::runtime_error("The graphics provider directory is unavailable");
        const char*configured=std::getenv("RESHADE_ISF_LIBRARY");const auto file=configured&&*configured?std::filesystem::path(configured):std::filesystem::path(info.dli_fname).parent_path()/"isf/libmacfx-isf.dylib";
        if(!file.is_absolute())throw std::runtime_error("The ISF provider requires an absolute library path");
        library=dlopen(file.c_str(),RTLD_NOW|RTLD_LOCAL);if(!library)throw std::runtime_error(std::string("The ISF shader provider is unavailable: ")+(dlerror()?:"unknown loader error"));
        const auto abi=reinterpret_cast<uint32_t(*)()>(dlsym(library,"rsISFNodeABI"));create=reinterpret_cast<Create>(dlsym(library,"rsCreateISFShaderNode"));clone=reinterpret_cast<Clone>(dlsym(library,"rsCloneISFShaderNode"));error=reinterpret_cast<Error>(dlsym(library,"rsISFLastError"));
        if(!abi||abi()!=1||!create||!clone||!error)throw std::runtime_error("The ISF shader provider has an incompatible API");
        sceneABI=reinterpret_cast<SceneABI>(dlsym(library,"rsISFSceneInputsAPI"));bind=reinterpret_cast<Bind>(dlsym(library,"rsISFBindSceneInputs"));
    }
};
std::shared_ptr<Provider>provider(){static auto*const loaded=new std::shared_ptr<Provider>(std::make_shared<Provider>());return *loaded;}
}
std::shared_ptr<ShaderNode>makeISFShaderNode(const ShaderSpec&spec){auto module=provider();auto node=module->create(&spec);if(!node)throw std::runtime_error(module->error()?:"The ISF shader could not be initialized");return std::shared_ptr<ShaderNode>(node,[module](ShaderNode*value){delete value;});}
std::shared_ptr<ShaderNode>forkISFShaderNode(const std::shared_ptr<ShaderNode>&previous,const ShaderSpec&spec){auto module=provider();auto node=module->clone(previous.get(),&spec.parameters);if(!node)throw std::runtime_error(module->error()?:"The ISF shader parameters could not be updated");return std::shared_ptr<ShaderNode>(node,[module](ShaderNode*value){delete value;});}
ShaderResult bindISFSceneInputs(const std::shared_ptr<ShaderNode>&node,const RSShaderSceneInputsV1*p){try{auto module=provider();if(!module->sceneABI||module->sceneABI()!=RS_SHADER_SCENE_ABI_VERSION||!module->bind)return p?ShaderResult{false,"The installed ISF provider has no named scene input interface",false}:ShaderResult{true,{},false};if(module->bind(node.get(),p))return {false,module->error()?:"The ISF scene inputs are unavailable",false};return {true,{},false};}catch(const std::exception&error){return {false,error.what(),false};}}
}
