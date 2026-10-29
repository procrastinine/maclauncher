// Build-time shader compiler. The selected shaderc headers and library are
// explicit recipe inputs; the resulting SPIR-V/Metal resources run without it.
#include <shaderc/shaderc.h>
#include <dlfcn.h>
#include <fstream>
#include <iostream>
#include <iterator>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

template<class T> T symbol(void *library,const char *name) {
    auto value=reinterpret_cast<T>(dlsym(library,name));
    if(!value)throw std::runtime_error(std::string("Missing shaderc symbol: ")+name);
    return value;
}
#define API(name) auto name=symbol<decltype(&::name)>(library,#name)
int main(int argc,char **argv) {
    try {
        std::map<std::string,std::string> options;
        std::vector<std::string> defines;
        for(int i=1;i<argc;i+=2) {
            if(i+1==argc)throw std::runtime_error("Expected a value after each option.");
            std::string key=argv[i];
            if(key=="--define")defines.emplace_back(argv[i+1]);
            else if(key=="--library"||key=="--input"||key=="--output"||key=="--language"||key=="--stage"||key=="--entry") {
                if(!options.emplace(key,argv[i+1]).second)throw std::runtime_error("Repeated option: "+key);
            } else throw std::runtime_error("Unknown option: "+key);
        }
        for(const auto *key:{"--library","--input","--output"})if(!options.count(key))throw std::runtime_error(std::string("Missing ")+key);
        auto language=options.count("--language")?options["--language"]:"glsl";
        auto stage=options.count("--stage")?options["--stage"]:"compute";
        auto entry=options.count("--entry")?options["--entry"]:"main";
        if(language!="glsl"&&language!="hlsl")throw std::runtime_error("Expected glsl or hlsl source.");
        const std::map<std::string,shaderc_shader_kind> stages={{"compute",shaderc_compute_shader},{"fragment",shaderc_fragment_shader},{"vertex",shaderc_vertex_shader}};
        if(!stages.count(stage))throw std::runtime_error("Expected compute, fragment or vertex stage.");
        void *library=dlopen(options["--library"].c_str(),RTLD_NOW|RTLD_LOCAL);
        if(!library)throw std::runtime_error(dlerror());
        API(shaderc_compiler_initialize);API(shaderc_compiler_release);
        API(shaderc_compile_options_initialize);API(shaderc_compile_options_release);
        API(shaderc_compile_options_set_source_language);API(shaderc_compile_options_set_target_env);
        API(shaderc_compile_options_set_optimization_level);API(shaderc_compile_options_add_macro_definition);
        API(shaderc_compile_options_set_generate_debug_info);
        API(shaderc_compile_options_set_auto_map_locations);API(shaderc_compile_options_set_auto_bind_uniforms);
        API(shaderc_compile_options_set_binding_base);
        API(shaderc_compile_into_spv);API(shaderc_result_get_compilation_status);
        API(shaderc_result_get_error_message);API(shaderc_result_get_bytes);API(shaderc_result_get_length);API(shaderc_result_release);
        std::ifstream input(options["--input"],std::ios::binary);
        if(!input)throw std::runtime_error("Shader input could not be opened.");
        std::string source((std::istreambuf_iterator<char>(input)),{});
        auto compiler=shaderc_compiler_initialize();auto settings=shaderc_compile_options_initialize();
        if(!compiler||!settings)throw std::runtime_error("Shaderc initialization failed.");
        shaderc_compile_options_set_source_language(settings,language=="hlsl"?shaderc_source_language_hlsl:shaderc_source_language_glsl);
        shaderc_compile_options_set_target_env(settings,shaderc_target_env_vulkan,shaderc_env_version_vulkan_1_1);
        shaderc_compile_options_set_optimization_level(settings,shaderc_optimization_level_performance);
        // Resource names are part of the reflected Metal binding contract.
        shaderc_compile_options_set_generate_debug_info(settings);
        shaderc_compile_options_set_auto_map_locations(settings,true);
        shaderc_compile_options_set_auto_bind_uniforms(settings,true);
        if(language=="hlsl") {
            shaderc_compile_options_set_binding_base(settings,shaderc_uniform_kind_texture,32);
            shaderc_compile_options_set_binding_base(settings,shaderc_uniform_kind_unordered_access_view,64);
        }
        for(const auto &define:defines) {
            const auto at=define.find('=');const auto key=define.substr(0,at),value=at==std::string::npos?"1":define.substr(at+1);
            shaderc_compile_options_add_macro_definition(settings,key.data(),key.size(),value.data(),value.size());
        }
        auto result=shaderc_compile_into_spv(compiler,source.data(),source.size(),stages.at(stage),options["--input"].c_str(),entry.c_str(),settings);
        if(!result)throw std::runtime_error("Shader compilation produced no result.");
        const bool success=shaderc_result_get_compilation_status(result)==shaderc_compilation_status_success;
        if(success) {
            std::ofstream output(options["--output"],std::ios::binary);
            output.write(shaderc_result_get_bytes(result),shaderc_result_get_length(result));
            if(!output)throw std::runtime_error("SPIR-V output could not be written.");
        }else std::cerr<<shaderc_result_get_error_message(result);
        shaderc_result_release(result);shaderc_compile_options_release(settings);shaderc_compiler_release(compiler);dlclose(library);
        return success?0:1;
    }catch(const std::exception &error){std::cerr<<error.what()<<'\n';return 1;}
}
